import type {
  ShiftCloseTransactionDeps,
  ShiftCloseUnitOfWork,
  ShiftCloseUnitOfWorkInput,
} from '@ash/contracts'
import { bindPoolToTransaction, type Pool, withTransaction } from './pool.ts'
import {
  PgCashDeductionRepo,
  PgFxRepo,
  PgLedgerRepo,
  PgOperationWindowRepo,
  PgOrderRepo,
  PgWalletMovementRepo,
} from './repos.ts'
import {
  PgBatteryReadingRepo,
  PgBatterySwapRepo,
  PgDirectoryRepo,
  PgMediaRepo,
  PgShiftDecisionRepo,
  PgShiftRepo,
  PgTierRepo,
  PgWeekLockRepo,
} from './repos-shift.ts'

type ShiftIdentity = {
  driver_id: string
  business_date: string
}

const changedIdentity = (shiftId: string): Error & { code: string } =>
  Object.assign(new Error(`shift ${shiftId} identity changed while starting close transaction`), {
    code: 'SHIFT_CLOSE_IDENTITY_CHANGED',
  })

function transactionDeps(pool: Pool): ShiftCloseTransactionDeps {
  return {
    shifts: new PgShiftRepo(pool),
    orders: new PgOrderRepo(pool),
    cashDeductions: new PgCashDeductionRepo(pool),
    operationWindows: new PgOperationWindowRepo(pool),
    movements: new PgWalletMovementRepo(pool),
    ledger: new PgLedgerRepo(pool),
    decisions: new PgShiftDecisionRepo(pool),
    fx: new PgFxRepo(pool),
    tiers: new PgTierRepo(pool),
    directory: new PgDirectoryRepo(pool),
    media: new PgMediaRepo(pool),
    batteryReadings: new PgBatteryReadingRepo(pool),
    batterySwaps: new PgBatterySwapRepo(pool),
    weekLocks: new PgWeekLockRepo(pool),
  }
}

/**
 * One transaction for claiming a close boundary or approving the resulting review.
 *
 * Lock order is intentional:
 *   1. optional driver/day advisory lock (before any row lock),
 *   2. target shift,
 *   3. operation children, each in stable primary-key order.
 *
 * `PgOperationBatchRepo` locks the same shift row, so a batch either commits before this snapshot or
 * waits and is rejected after it. Child locks also serialize manager corrections, whose UPDATEs do
 * not need to touch the parent row.
 */
export class PgShiftCloseUnitOfWork implements ShiftCloseUnitOfWork {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async run<T>(
    input: ShiftCloseUnitOfWorkInput,
    work: (deps: ShiftCloseTransactionDeps) => Promise<T>,
  ): Promise<T> {
    const ctx = { actorId: input.actorId, requestId: input.requestId ?? null }
    return withTransaction(this.pool, ctx, async (client) => {
      const boundPool = bindPoolToTransaction(this.pool, client, ctx)
      const deps = transactionDeps(boundPool)
      // Identity is immutable in repository code. Read it without a row lock solely to derive the
      // common driver/day key before taking the target lock; the locked reread below verifies it.
      const identityResult = await client.query<ShiftIdentity>(
        `SELECT driver_id::text AS driver_id,
                to_char(business_date, 'YYYY-MM-DD') AS business_date
           FROM shifts
          WHERE id = $1`,
        [input.shiftId],
      )
      const identity = identityResult.rows[0]
      // Let the callback's ordinary repository read decide how a missing shift maps at its layer
      // (service commands use `shift_not_found`; the read-only review returns null/404).
      if (!identity) return work(deps)

      if (input.serializeDriverDay) {
        // A collision only serializes unrelated approvals; it cannot weaken correctness. The prefix
        // reserves a namespace so other advisory-lock users do not accidentally share these keys.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `ash:shift-close:${identity.driver_id}:${identity.business_date}`,
        ])
      }

      const lockedResult = await client.query<ShiftIdentity>(
        `SELECT driver_id::text AS driver_id,
                to_char(business_date, 'YYYY-MM-DD') AS business_date
           FROM shifts
          WHERE id = $1
          FOR UPDATE`,
        [input.shiftId],
      )
      const locked = lockedResult.rows[0]
      if (!locked) return work(deps)
      if (locked.driver_id !== identity.driver_id || locked.business_date !== identity.business_date) {
        throw changedIdentity(input.shiftId)
      }

      // Separate statements keep lock acquisition obvious and make deadlock diagnostics name the
      // precise child relation. READ COMMITTED takes a fresh snapshot after any waiter wakes.
      await client.query('SELECT id FROM shift_orders WHERE shift_id = $1 ORDER BY id FOR UPDATE', [input.shiftId])
      await client.query('SELECT id FROM cash_deductions WHERE shift_id = $1 ORDER BY id FOR UPDATE', [input.shiftId])
      await client.query(
        'SELECT id FROM shift_wallet_movements WHERE shift_id = $1 ORDER BY id FOR UPDATE',
        [input.shiftId],
      )

      return work(deps)
    })
  }
}
