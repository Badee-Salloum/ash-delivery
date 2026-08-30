import { afterAll, describe, expect, it } from 'vitest'
import type { Deps, NewShiftSettlementRecord } from '@ash/contracts'
import { minor } from '@ash/domain'
import { runConformanceSuite } from '@ash/testkit/conformance'
import { assertBigIntParser, createPool } from '../src/pool.ts'
import { migrate } from '../src/migrate.ts'
import { PgShiftCloseUnitOfWork } from '../src/repos-close.ts'
import { PgShiftSettlementRepo } from '../src/repos-settlement.ts'
import { PgCloseDraftRepo } from '../src/repos-close-draft.ts'
import { PgFinancialUnitOfWork } from '../src/repos-financial.ts'
import { PgReceivableEventRepo } from '../src/repos-receivable.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl } from './disposable-database.ts'
import {
  PgAuditRepo,
  PgCashDeductionRepo,
  PgFxRepo,
  PgLedgerRepo,
  PgTreasuryPositionSource,
  PgOfficeCapitalTargetRepo,
  PgOperationBatchRepo,
  PgOperationWindowRepo,
  PgOrderRepo,
  PgRestorationRepo,
  PgSessionRepo,
  PgWalletMovementRepo,
  PgUserRepo,
} from '../src/repos.ts'
import {
  PgCashCountRepo,
  PgNotificationRepo,
  PgPreapprovedShiftRuleRepo,
  PgDirectoryRepo,
  PgExpenseRepo,
  PgIncomeRepo,
  PgMediaRepo,
  PgOcrReadRepo,
  PgSettingsRepo,
  PgTierRepo,
  PgAssignmentRepo,
  PgAttendanceRepo,
  PgCheckInRepo,
  PgBatteryReadingRepo,
  PgBatterySwapRepo,
  PgShiftDecisionRepo,
  PgGpsPingRepo,
  PgShiftRepo,
  PgVehicleEventRepo,
  PgWeekLockRepo,
} from '../src/repos-shift.ts'

/**
 * The PostgreSQL adapters run the SAME conformance suite as the in-memory ones.
 *
 * Skipped when DATABASE_URL is absent, so a laptop without Docker still gets a green suite —
 * but CI always sets it, so the adapters are never merged unproven. A behaviour that differs
 * between the two implementations is a bug in one of them, and this is where it surfaces.
 */
const DATABASE_URL = process.env.DATABASE_URL
const DISPOSABLE_DATABASE = DATABASE_URL ? assertDisposableDatabaseUrl(DATABASE_URL) : null

if (!DATABASE_URL) {
  describe('PostgreSQL conformance', () => {
    it.skip('skipped: set DATABASE_URL to run against real Postgres (CI always does)', () => {})
  })
} else {
  const pool = createPool(DATABASE_URL)
  let schemaReady: Promise<void> | null = null

  const ensureSchema = async (): Promise<void> => {
    schemaReady ??= (async () => {
      await assertDisposableDatabaseConnection(pool, DISPOSABLE_DATABASE!)
      await assertBigIntParser(pool)
      await migrate(pool)
    })()
    return schemaReady
  }

  const BRANCH = '11111111-1111-1111-1111-111111111111'
  const USER = '22222222-2222-2222-2222-222222222222'
  const SHIFT = '55555555-5555-5555-5555-555555555555'
  const BATTERY = '99999999-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  const MEDIA_1 = '99999999-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
  const MEDIA_2 = '99999999-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

  const makeDeps = async (): Promise<Deps> => {
      await ensureSchema()

      // Truncate rather than re-migrate: orders of magnitude faster, and it exercises the real
      // constraints on every run instead of a freshly-empty database.
      await pool.query(`
        TRUNCATE preapproved_shift_rules, receivable_events, shift_settlements, journal_lines, journal_entries, cash_deductions, shift_orders, shift_media_attachment_history, shift_media, media, float_tranches, expenses, expense_categories, settings, cash_counts, cash_count_lines, tier_rules, notifications,
                 shift_battery_readings, gps_pings, batteries,
                 shifts, funds, fx_days, week_locks, audit_log, sessions, drivers, vehicles,
                 vehicle_types, users, branches, governorates
        RESTART IDENTITY CASCADE
      `)

      await pool.query(
        `INSERT INTO governorates (id, no, name_ar, name_en)
         VALUES ('99999999-9999-9999-9999-999999999999', 1, 'دمشق', 'Damascus')`,
      )
      await pool.query(
        `INSERT INTO branches (id, code, name_ar, name_en, governorate_id, branch_no)
         VALUES ($1, 'DAM', 'دمشق', 'Damascus', '99999999-9999-9999-9999-999999999999', 1)`,
        [BRANCH],
      )
      await pool.query(
        `INSERT INTO roles (key, name_ar, name_en) VALUES ('system_admin','مدير النظام','System Admin')
         ON CONFLICT (key) DO NOTHING`,
      )
      await pool.query(
        `INSERT INTO permissions (key, name_ar, name_en)
         VALUES
           ('journal.manual.write', 'القيد اليدوي', 'Manual journal'),
           ('shift.approve', 'اعتماد النوبة', 'Approve shift')
         ON CONFLICT (key) DO NOTHING`,
      )
      await pool.query(
        `INSERT INTO role_permissions (role_key, permission_key, scope)
         VALUES
           ('system_admin', 'journal.manual.write', 'all'),
           ('system_admin', 'shift.approve', 'all')
         ON CONFLICT (role_key, permission_key) DO UPDATE SET scope = EXCLUDED.scope`,
      )
      await pool.query(
        `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
         VALUES ($1, $2, 'system_admin', 'conformance', 'اختبار', 'x')`,
        [USER, BRANCH],
      )
      await pool.query(
        `INSERT INTO funds (branch_id, type, owner_kind, owner_id, code, name_ar)
         VALUES
           ($1, 'office_cash', 'none', NULL, 'office_cash', 'office cash'),
           ($1, 'office_wallet', 'none', NULL, 'office_wallet', 'office wallet')`,
        [BRANCH],
      )
      await pool.query(
        `INSERT INTO vehicle_types (id, code, name_ar, name_en, type_no)
         VALUES ('66666666-6666-6666-6666-666666666666','e_motorbike','دراجة','E-Motorbike', 1)`,
      )
      await pool.query(
        `INSERT INTO drivers (id, branch_id, code, full_name_ar)
         VALUES
           ('77777777-7777-7777-7777-777777777777', $1, 'DRV-C', 'سائق'),
           ('77777777-7777-7777-7777-777777777778', $1, 'DRV-D', 'سائق 2')`,
        [BRANCH],
      )
      await pool.query(
        `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no)
         VALUES
           ('88888888-8888-8888-8888-888888888888', $1, '66666666-6666-6666-6666-666666666666','1-1-1-1', 1),
           ('88888888-8888-8888-8888-888888888889', $1, '66666666-6666-6666-6666-666666666666','1-1-1-2', 2)`,
        [BRANCH],
      )
      await pool.query(
        `INSERT INTO shifts (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date)
         VALUES ($1, $2, '77777777-7777-7777-7777-777777777777','88888888-8888-8888-8888-888888888888',
                 1, DATE '2026-07-21', DATE '2026-07-19')`,
        [SHIFT, BRANCH],
      )
      await pool.query(
        `INSERT INTO batteries (id, branch_id, serial_no, capacity_ah, vehicle_id, slot_no)
         VALUES ($1, $2, 'CONF-BATTERY-1', 50, '88888888-8888-8888-8888-888888888888', 1)`,
        [BATTERY, BRANCH],
      )
      await pool.query(
        `INSERT INTO media
           (id, branch_id, sha256, byte_size, mime_type, storage_key, received_at, uploaded_by)
         VALUES
           ($1, $3, 'conformance-bms-generation-1', 1, 'image/webp', 'conformance/bms-1.webp', now(), $4),
           ($2, $3, 'conformance-bms-generation-2', 1, 'image/webp', 'conformance/bms-2.webp', now(), $4)`,
        [MEDIA_1, MEDIA_2, BRANCH, USER],
      )
      await pool.query(
        `INSERT INTO fx_days (business_date, syp_minor_per_usd) VALUES (DATE '2026-07-21', 13000)
         ON CONFLICT (business_date) DO NOTHING`,
      )

      /**
       * Ports the suite does not exercise yet. A Proxy that throws on USE rather than a value
       * that throws on construction — so the failure names the exact method, and adding a test
       * for one of these produces a clear message instead of a mystery.
       */
      const notYetImplemented = <T extends object>(name: string): T =>
        new Proxy({} as T, {
          get: (_target, prop) => () => {
            throw new Error(`${name}.${String(prop)}() has no PostgreSQL adapter yet`)
          },
        })

      return {
        clock: { nowMs: () => Date.UTC(2026, 6, 21, 5, 0, 0), offsetMinutes: () => 180, dayStartMinutes: () => 240 },
        ids: { uuid: () => crypto.randomUUID(), token: () => 'token' },
        hasher: { hash: async (p: string) => p, verify: async (p: string, h: string) => p === h },
        // The suite never encrypts (it writes/reads document bytes directly), so a stub suffices.
        cipher: notYetImplemented('Cipher'),
        users: new PgUserRepo(pool),
        sessions: new PgSessionRepo(pool),
        shifts: new PgShiftRepo(pool),
        preapprovedShiftRules: new PgPreapprovedShiftRuleRepo(pool),
        batteryReadings: new PgBatteryReadingRepo(pool),
        batterySwaps: new PgBatterySwapRepo(pool),
        assignments: new PgAssignmentRepo(pool),
        orders: new PgOrderRepo(pool),
        cashDeductions: new PgCashDeductionRepo(pool),
        operationWindows: new PgOperationWindowRepo(pool),
        operationBatches: new PgOperationBatchRepo(pool),
        movements: new PgWalletMovementRepo(pool),
        ledger: new PgLedgerRepo(pool),
        treasuryPosition: new PgTreasuryPositionSource(pool),
        expenses: new PgExpenseRepo(pool),
        incomes: new PgIncomeRepo(pool),
        receivableEvents: new PgReceivableEventRepo(pool),
        financialUnitOfWork: new PgFinancialUnitOfWork(pool),
        cashCounts: new PgCashCountRepo(pool),
        capitalTargets: new PgOfficeCapitalTargetRepo(pool),
        restorations: new PgRestorationRepo(pool),
        tiers: new PgTierRepo(pool),
        notifications: new PgNotificationRepo(pool),
        settings: new PgSettingsRepo(pool),
        media: new PgMediaRepo(pool),
        // Blob storage is not a database concern; the suite exercises MediaRepo, not bytes.
        blobs: notYetImplemented('BlobStore'),
        // A paid vision model is not a database concern either, and a suite that reached for it
        // would bill somebody. Its receipts, however, ARE a table, so that one is real.
        ocr: notYetImplemented('OcrReader'),
        ocrReads: new PgOcrReadRepo(pool),
        fx: new PgFxRepo(pool),
        weekLocks: new PgWeekLockRepo(pool),
        audit: new PgAuditRepo(pool),
        directory: new PgDirectoryRepo(pool),
        vehicleEvents: new PgVehicleEventRepo(pool),
        attendance: new PgAttendanceRepo(pool),
        checkIns: new PgCheckInRepo(pool),
        decisions: new PgShiftDecisionRepo(pool),
        settlements: new PgShiftSettlementRepo(pool),
        closeDrafts: new PgCloseDraftRepo(pool),
        gps: new PgGpsPingRepo(pool),
        closeUnitOfWork: new PgShiftCloseUnitOfWork(pool),
      }
    }

  runConformanceSuite({
    label: 'postgres',
    makeDeps,
  })

  describe('PostgreSQL OCR cache ownership', () => {
    it('keeps a live cross-shift retry and its receipt when either owning shift is deleted', async () => {
      const deps = await makeDeps()
      const retryShift = '55555555-5555-4555-8555-555555555556'
      const sha256 = 'e'.repeat(64)
      const cacheSignature = 'pg-delete-proof:orders-v1'

      await pool.query(
        `INSERT INTO shifts
           (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date)
         VALUES
           ($1, $2, '77777777-7777-7777-7777-777777777778',
            '88888888-8888-8888-8888-888888888889', 1, DATE '2026-07-21', DATE '2026-07-19')`,
        [retryShift, BRANCH],
      )

      const initial = await deps.ocrReads.claimReadAttempt({
        id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccce',
        branchId: BRANCH,
        requestingShiftId: SHIFT,
        field: 'orders',
        sha256,
        byteSize: 123,
        model: 'pg-delete-proof',
        cacheSignature,
        createdAt: 1_784_000_000_000,
        createdBy: USER,
        reservationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddde',
        nowMs: 1_000,
        leaseMs: 100,
        retryFailed: false,
        maxReadsPerShift: 15,
      })
      expect(initial.kind).toBe('call')
      if (initial.kind !== 'call') throw new Error('initial OCR attempt was not reserved')
      await deps.ocrReads.completeReadAttempt({
        branchId: BRANCH,
        field: 'orders',
        sha256,
        cacheSignature,
        reservationId: initial.record.reservationId!,
        result: { ok: false, reason: 'timeout' },
        usage: { tokensIn: 10, tokensOut: 1, latencyMs: 50 },
      })

      const retry = await deps.ocrReads.claimReadAttempt({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccf',
        branchId: BRANCH,
        requestingShiftId: retryShift,
        field: 'orders',
        sha256,
        byteSize: 123,
        model: 'pg-delete-proof',
        cacheSignature,
        createdAt: 1_784_000_000_100,
        createdBy: USER,
        reservationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddf',
        nowMs: 1_100,
        leaseMs: 100,
        retryFailed: true,
        maxReadsPerShift: 15,
      })
      expect(retry).toMatchObject({ kind: 'call', attempt: 2 })
      if (retry.kind !== 'call') throw new Error('OCR retry was not reserved')

      await expect(pool.query('DELETE FROM shifts WHERE id = $1', [SHIFT])).resolves.toMatchObject({ rowCount: 1 })
      expect(await deps.ocrReads.findBySha(BRANCH, sha256, 'orders', cacheSignature)).toMatchObject({
        state: 'running',
        shiftId: null,
        retryShiftId: retryShift,
        retryCreatedAt: expect.any(Number),
        retryCreatedBy: USER,
      })

      const completed = await deps.ocrReads.completeReadAttempt({
        branchId: BRANCH,
        field: 'orders',
        sha256,
        cacheSignature,
        reservationId: retry.record.reservationId!,
        result: { ok: true, rows: [], fields: {}, raw: null },
        usage: { tokensIn: 20, tokensOut: 2, latencyMs: 60 },
      })
      expect(completed).toMatchObject({ result: { ok: true, attemptCount: 2 }, tokensIn: 30, tokensOut: 3 })
      expect(await deps.ocrReads.countBilledForShift(retryShift)).toBe(1)

      await expect(pool.query('DELETE FROM shifts WHERE id = $1', [retryShift])).resolves.toMatchObject({ rowCount: 1 })
      expect(await deps.ocrReads.findBySha(BRANCH, sha256, 'orders', cacheSignature)).toMatchObject({
        state: 'complete',
        shiftId: null,
        retryShiftId: null,
        retryCreatedAt: expect.any(Number),
        retryCreatedBy: USER,
      })
    })
  })

  describe('PostgreSQL shift-settlement state guard', () => {
    it('rejects an open/unsubmitted shift, then accepts the same snapshot under submitted review', async () => {
      const deps = await makeDeps()
      const shift = await deps.shifts.findById(SHIFT)
      expect(shift).not.toBeNull()
      await deps.shifts.update({
        ...shift!,
        state: 'open',
        openApprovedAt: '2026-07-21T04:00:00.000Z',
        openApprovedBy: USER,
        submittedAt: null,
      }, USER)

      const zero = minor(0n)
      const snapshot: NewShiftSettlementRecord = {
        shiftId: SHIFT,
        branchId: BRANCH,
        driverId: '77777777-7777-7777-7777-777777777777',
        businessDate: '2026-07-21',
        policyCode: 'fixed_40_cash_close_v1',
        driverRateBps: 4_000,
        deliveryFeeTotal: zero,
        fixedDriverShare: zero,
        manualDriverShare: zero,
        grossDriverShare: zero,
        cashDeductionTotal: zero,
        baseDriverShare: zero,
        expectedTotal: zero,
        actualCash: zero,
        actualWallet: zero,
        actualTotal: zero,
        variance: zero,
        varianceDirection: 'balanced',
        finalEmployeeCash: zero,
        cashClaimToOffice: zero,
        walletClaimToOffice: zero,
        cashReceivableDeferred: zero,
        walletReceivableDeferred: zero,
        maximumCashShortageReceivable: zero,
        cashShortageReceivable: zero,
        walletToOffice: zero,
        cashToOffice: zero,
        walletAction: 'none',
        walletAmount: zero,
        cashAction: 'none',
        cashAmount: zero,
        reviewedOrdersHash: 'state-guard-orders',
        settlementHash: 'd'.repeat(64),
        walletTransferConfirmed: true,
        cashSettlementConfirmed: true,
        confirmedBy: USER,
        confirmedAtMs: Date.UTC(2026, 6, 21, 5, 0, 0),
        varianceReason: null,
      }

      await expect(deps.settlements.create(snapshot)).rejects.toMatchObject({
        code: '23514',
        constraint: 'shift_settlements_shift_state_guard',
      })
      expect(await deps.settlements.findByShift(SHIFT)).toBeNull()

      const open = await deps.shifts.findById(SHIFT)
      expect(open).not.toBeNull()
      await deps.shifts.update({
        ...open!,
        state: 'pending_review',
        submittedAt: '2026-07-21T05:00:00.000Z',
      }, USER)

      const preparedDecision = await deps.decisions.record({
        shiftId: SHIFT,
        gate: 'close',
        decision: 'force_close_prepared',
        notes: 'manager froze the boundary and actual figures',
        decidedBy: USER,
        decidedAtMs: Date.UTC(2026, 6, 21, 5, 0, 0),
      })
      await expect(
        pool.query("UPDATE shift_decisions SET notes = 'rewritten' WHERE id = $1", [preparedDecision.id]),
      ).rejects.toMatchObject({ code: '55000' })
      await expect(
        pool.query('DELETE FROM shift_decisions WHERE id = $1', [preparedDecision.id]),
      ).rejects.toMatchObject({ code: '55000' })
      expect(await deps.decisions.listByShift(SHIFT)).toContainEqual(preparedDecision)

      const accepted = await deps.closeUnitOfWork.run(
        { shiftId: SHIFT, actorId: USER },
        async (transaction) => {
          const created = await transaction.settlements.create(snapshot)
          const pending = await transaction.shifts.findById(SHIFT)
          if (!pending) throw new Error('state-guard shift disappeared')
          await transaction.shifts.update({
            ...pending,
            state: 'approved',
            approvedBy: USER,
            keptAsReceivable: created.cashReceivableDeferred,
            // A canonical all-zero close has a known zero split difference and deliberately emits
            // no wallet_return/float_return journal. The deferred journal guard accepts that exact
            // empty multiset while still rejecting a missing non-zero close in the PG adversarial
            // suite.
            walletDiff: zero,
          }, USER)
          return created
        },
      )
      expect(accepted).toMatchObject({
        shiftId: SHIFT,
        settlementHash: snapshot.settlementHash,
        confirmedBy: USER,
      })
      await expect(
        pool.query(
          `SELECT id FROM journal_entries
            WHERE shift_id = $1 AND event_type IN ('wallet_return', 'float_return')`,
          [SHIFT],
        ),
      ).resolves.toMatchObject({ rowCount: 0 })
    })

    it.each(['draft', 'awaiting_open_approval'] as const)(
      'keeps decisions append-only while allowing a parent-shift cascade from %s',
      async (state) => {
        const deps = await makeDeps()

        if (state === 'awaiting_open_approval') {
          await pool.query(
            `UPDATE shifts
                SET state = 'awaiting_open_approval', driver_confirmed_at = now()
              WHERE id = $1`,
            [SHIFT],
          )
        }

        const decision = await deps.decisions.record({
          shiftId: SHIFT,
          gate: 'close',
          decision: 'force_close_prepared',
          notes: `cascade proof for ${state}`,
          decidedBy: USER,
          decidedAtMs: Date.UTC(2026, 6, 21, 5, 0, 0),
        })

        await expect(
          pool.query("UPDATE shift_decisions SET notes = 'rewritten' WHERE id = $1", [decision.id]),
        ).rejects.toMatchObject({ code: '55000' })
        await expect(
          pool.query('DELETE FROM shift_decisions WHERE id = $1', [decision.id]),
        ).rejects.toMatchObject({ code: '55000' })
        expect(await deps.decisions.listByShift(SHIFT)).toContainEqual(decision)

        const deleted = await pool.query('DELETE FROM shifts WHERE id = $1', [SHIFT])
        expect(deleted.rowCount).toBe(1)
        const remaining = await pool.query<{ count: number }>(
          'SELECT COUNT(*)::int AS count FROM shift_decisions WHERE id = $1',
          [decision.id],
        )
        expect(remaining.rows[0]?.count).toBe(0)
      },
    )
  })

  afterAll(async () => {
    await pool.end()
  })
}
