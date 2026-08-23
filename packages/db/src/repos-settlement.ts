import type {
  NewShiftSettlementRecord,
  ShiftSettlementRecord,
  ShiftSettlementRepo,
} from '@ash/contracts'
import { minor } from '@ash/domain'
import { PG, type Pool, isPgError, withTransaction } from './pool.ts'

const immutableSettlement = (shiftId: string): Error & { code: string } =>
  Object.assign(new Error(`shift ${shiftId} already has a different immutable settlement`), {
    code: 'SHIFT_SETTLEMENT_IMMUTABLE',
  })

const settlementHashConflict = (hash: string): Error & { code: string } =>
  Object.assign(new Error(`settlement hash ${hash} already belongs to another shift`), {
    code: 'SHIFT_SETTLEMENT_HASH_CONFLICT',
  })

const asMs = (value: unknown): number => {
  const millis = value instanceof Date ? value.getTime() : new Date(String(value)).getTime()
  if (!Number.isFinite(millis)) throw new Error(`invalid settlement confirmation timestamp ${String(value)}`)
  return millis
}

/** PostgreSQL `date` may be returned as text or as a local-time `Date`, depending on the driver. */
const isoDate = (value: unknown): ShiftSettlementRecord['businessDate'] => {
  if (typeof value === 'string') return value.slice(0, 10)
  const date = value as Date
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function rowToSettlement(row: Record<string, unknown>): ShiftSettlementRecord {
  const money = (column: string) => minor(BigInt(String(row[column])))
  return {
    id: Number(row.id),
    shiftId: String(row.shift_id),
    branchId: String(row.branch_id),
    driverId: String(row.driver_id),
    businessDate: isoDate(row.business_date),
    policyCode: 'fixed_40_cash_close_v1',
    driverRateBps: 4_000,
    deliveryFeeTotal: money('delivery_fee_total_minor'),
    fixedDriverShare: money('fixed_driver_share_minor'),
    manualDriverShare: money('manual_driver_share_minor'),
    grossDriverShare: money('gross_driver_share_minor'),
    cashDeductionTotal: money('cash_deduction_total_minor'),
    baseDriverShare: money('base_driver_share_minor'),
    expectedTotal: money('expected_total_minor'),
    actualCash: money('actual_cash_minor'),
    actualWallet: money('actual_wallet_minor'),
    actualTotal: money('actual_total_minor'),
    variance: money('variance_minor'),
    varianceDirection: row.variance_direction as ShiftSettlementRecord['varianceDirection'],
    finalEmployeeCash: money('final_employee_cash_minor'),
    walletToOffice: money('wallet_to_office_minor'),
    cashToOffice: money('cash_to_office_minor'),
    walletAction: row.wallet_action as ShiftSettlementRecord['walletAction'],
    walletAmount: money('wallet_amount_minor'),
    cashAction: row.cash_action as ShiftSettlementRecord['cashAction'],
    cashAmount: money('cash_amount_minor'),
    reviewedOrdersHash: String(row.reviewed_orders_hash),
    settlementHash: String(row.settlement_hash),
    walletTransferConfirmed: Boolean(row.wallet_transfer_confirmed),
    cashSettlementConfirmed: Boolean(row.cash_settlement_confirmed),
    confirmedBy: String(row.confirmed_by),
    confirmedAtMs: asMs(row.confirmed_at),
    varianceReason: row.variance_reason === null ? null : String(row.variance_reason),
  }
}

/** PostgreSQL append-only repository for the manager's signed settlement snapshot. */
export class PgShiftSettlementRepo implements ShiftSettlementRepo {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async create(record: NewShiftSettlementRecord): Promise<ShiftSettlementRecord> {
    return withTransaction(this.pool, { actorId: record.confirmedBy }, async (client) => {
      // Read first so an exact retry remains readable even if the original manager was later
      // deactivated. The INSERT guard protects new decisions; replaying an immutable receipt is not
      // a new decision. The shift row held by the close unit of work serializes the normal path.
      const priorResult = await client.query<Record<string, unknown>>(
        'SELECT * FROM shift_settlements WHERE shift_id = $1',
        [record.shiftId],
      )
      const prior = priorResult.rows[0]
      if (prior) {
        if (String(prior.settlement_hash) !== record.settlementHash) throw immutableSettlement(record.shiftId)
        return rowToSettlement(prior)
      }

      let inserted: { rows: Array<Record<string, unknown>> }
      try {
        inserted = await client.query(
          `INSERT INTO shift_settlements (
             shift_id, branch_id, driver_id, business_date,
             policy_code, driver_rate_bps,
             delivery_fee_total_minor, fixed_driver_share_minor, manual_driver_share_minor,
             gross_driver_share_minor, cash_deduction_total_minor, base_driver_share_minor,
             expected_total_minor, actual_cash_minor, actual_wallet_minor, actual_total_minor,
             variance_minor, variance_direction, final_employee_cash_minor,
             wallet_to_office_minor, cash_to_office_minor,
             wallet_action, wallet_amount_minor, cash_action, cash_amount_minor,
             reviewed_orders_hash, settlement_hash,
             wallet_transfer_confirmed, cash_settlement_confirmed,
             confirmed_by, confirmed_at, variance_reason
           ) VALUES (
             $1, $2, $3, $4::date,
             $5, $6,
             $7, $8, $9,
             $10, $11, $12,
             $13, $14, $15, $16,
             $17, $18, $19,
             $20, $21,
             $22, $23, $24, $25,
             $26, $27,
             $28, $29,
             $30, $31::timestamptz, $32
           )
           ON CONFLICT (shift_id) DO NOTHING
           RETURNING *`,
          [
            record.shiftId,
            record.branchId,
            record.driverId,
            record.businessDate,
            record.policyCode,
            record.driverRateBps,
            record.deliveryFeeTotal.toString(),
            record.fixedDriverShare.toString(),
            record.manualDriverShare.toString(),
            record.grossDriverShare.toString(),
            record.cashDeductionTotal.toString(),
            record.baseDriverShare.toString(),
            record.expectedTotal.toString(),
            record.actualCash.toString(),
            record.actualWallet.toString(),
            record.actualTotal.toString(),
            record.variance.toString(),
            record.varianceDirection,
            record.finalEmployeeCash.toString(),
            record.walletToOffice.toString(),
            record.cashToOffice.toString(),
            record.walletAction,
            record.walletAmount.toString(),
            record.cashAction,
            record.cashAmount.toString(),
            record.reviewedOrdersHash,
            record.settlementHash,
            record.walletTransferConfirmed,
            record.cashSettlementConfirmed,
            record.confirmedBy,
            new Date(record.confirmedAtMs).toISOString(),
            record.varianceReason,
          ],
        )
      } catch (error) {
        if (isPgError(error, PG.UNIQUE_VIOLATION)) throw settlementHashConflict(record.settlementHash)
        throw error
      }

      const created = inserted.rows[0]
      if (created) return rowToSettlement(created)

      const existingResult = await client.query<Record<string, unknown>>(
        'SELECT * FROM shift_settlements WHERE shift_id = $1',
        [record.shiftId],
      )
      const existing = existingResult.rows[0]
      if (!existing) throw new Error(`settlement insert for shift ${record.shiftId} disappeared`)
      if (String(existing.settlement_hash) !== record.settlementHash) throw immutableSettlement(record.shiftId)
      return rowToSettlement(existing)
    })
  }

  async findByShift(shiftId: string): Promise<ShiftSettlementRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM shift_settlements WHERE shift_id = $1',
      [shiftId],
    )
    return result.rows[0] ? rowToSettlement(result.rows[0]) : null
  }

  async listByShiftIds(shiftIds: readonly string[]): Promise<ShiftSettlementRecord[]> {
    if (shiftIds.length === 0) return []
    const result = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM shift_settlements WHERE shift_id = ANY($1::uuid[]) ORDER BY id',
      [shiftIds],
    )
    return result.rows.map(rowToSettlement)
  }
}
