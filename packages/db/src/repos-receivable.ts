import type {
  ReceivableEventRecord,
  ReceivableEventRepo,
} from '@ash/contracts'
import { minor } from '@ash/domain'
import { PG, type Pool, isPgError } from './pool.ts'

const isoDate = (value: unknown): ReceivableEventRecord['businessDate'] => {
  if (typeof value === 'string') return value.slice(0, 10) as ReceivableEventRecord['businessDate']
  const date = value as Date
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` as ReceivableEventRecord['businessDate']
}

const asMs = (value: unknown): number => {
  const millis = value instanceof Date ? value.getTime() : new Date(String(value)).getTime()
  if (!Number.isFinite(millis)) throw new Error(`invalid receivable event timestamp ${String(value)}`)
  return millis
}

const rowToEvent = (row: Record<string, unknown>): ReceivableEventRecord => ({
  id: String(row.id),
  branchId: String(row.branch_id),
  driverId: String(row.driver_id),
  receivableKind: String(row.receivable_kind) as ReceivableEventRecord['receivableKind'],
  channel: String(row.channel) as ReceivableEventRecord['channel'],
  direction: String(row.direction) as ReceivableEventRecord['direction'],
  amount: minor(BigInt(String(row.amount_minor))),
  businessDate: isoDate(row.business_date),
  reason: String(row.reason),
  intent: String(row.intent ?? 'command') as ReceivableEventRecord['intent'],
  priorBalance: row.prior_balance_minor === null || row.prior_balance_minor === undefined
    ? null
    : minor(BigInt(String(row.prior_balance_minor))),
  targetBalance: row.target_balance_minor === null || row.target_balance_minor === undefined
    ? null
    : minor(BigInt(String(row.target_balance_minor))),
  idempotencyKey: String(row.idempotency_key),
  journalEntryId: Number(row.journal_entry_id),
  createdBy: String(row.created_by),
  createdAtMs: asMs(row.created_at),
})

export class PgReceivableEventRepo implements ReceivableEventRepo {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async findByIdempotencyKey(
    branchId: string,
    idempotencyKey: string,
  ): Promise<ReceivableEventRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM receivable_events WHERE branch_id = $1 AND idempotency_key = $2',
      [branchId, idempotencyKey],
    )
    return rows[0] ? rowToEvent(rows[0]) : null
  }

  async create(event: ReceivableEventRecord): Promise<void> {
    // Return the repository-level duplicate contract before the database's actor trigger runs.
    // This also makes a diagnostic replay outside a command UOW deterministic; the UNIQUE catch
    // below remains necessary for two transactions that both pass this read concurrently.
    if (await this.findByIdempotencyKey(event.branchId, event.idempotencyKey)) {
      throw Object.assign(new Error(`duplicate receivable key ${event.idempotencyKey}`), {
        code: 'DUPLICATE_IDEMPOTENCY_KEY',
      })
    }
    try {
      await this.pool.query(
        `INSERT INTO receivable_events (
           id, branch_id, driver_id, receivable_kind, channel, direction, amount_minor,
           business_date, reason, idempotency_key, journal_entry_id, created_by, created_at,
           intent, prior_balance_minor, target_balance_minor
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14,$15,$16)`,
        [
          event.id,
          event.branchId,
          event.driverId,
          event.receivableKind,
          event.channel,
          event.direction,
          event.amount.toString(),
          event.businessDate,
          event.reason,
          event.idempotencyKey,
          event.journalEntryId,
          event.createdBy,
          new Date(event.createdAtMs).toISOString(),
          event.intent,
          event.priorBalance === null ? null : event.priorBalance.toString(),
          event.targetBalance === null ? null : event.targetBalance.toString(),
        ],
      )
    } catch (error) {
      if (isPgError(error, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error(`duplicate receivable key ${event.idempotencyKey}`), {
          code: 'DUPLICATE_IDEMPOTENCY_KEY',
        })
      }
      throw error
    }
  }

  async listByBranchAndDriver(
    branchId: string,
    driverId?: string,
  ): Promise<ReceivableEventRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM receivable_events
        WHERE branch_id = $1
          AND ($2::uuid IS NULL OR driver_id = $2::uuid)
        ORDER BY created_at DESC, id DESC`,
      [branchId, driverId ?? null],
    )
    return rows.map(rowToEvent)
  }
}
