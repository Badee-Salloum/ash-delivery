import type { CashCountRecord, CashCountRepo } from '@ash/contracts'
import type { CalendarDate } from '@ash/domain'

/**
 * Counts are kept as a LIST, not one row per day.
 *
 * A day may hold several counts once a recount supersedes one or someone withdraws it — only one
 * of them ACTIVE at a time, which is the partial unique index `cash_counts_active_day_uq`. The
 * superseded and cancelled ones stay readable with their proofs, exactly as in PostgreSQL.
 */
export class MemoryCashCountRepo implements CashCountRepo {
  readonly all: CashCountRecord[] = []

  /** Back-compat for tests that reached into `rows`: the ACTIVE count per branch/day. */
  get rows(): Map<string, CashCountRecord> {
    const map = new Map<string, CashCountRecord>()
    for (const r of this.all) {
      if (r.status === 'active') map.set(`${r.branchId}|${r.businessDate}`, r)
    }
    return map
  }

  private activeIndex(branchId: string, businessDate: CalendarDate): number {
    return this.all.findIndex(
      (r) => r.branchId === branchId && r.businessDate === businessDate && r.status === 'active',
    )
  }

  async create(count: CashCountRecord): Promise<CashCountRecord> {
    // One ACTIVE count per branch per day, mirroring the partial unique index. A second live count
    // would make "what did we agree the drawer held" ambiguous for the restoration.
    if (this.activeIndex(count.branchId, count.businessDate) !== -1) {
      throw Object.assign(new Error(`cash count already exists for ${count.businessDate}`), {
        code: 'DUPLICATE_COUNT',
      })
    }
    const stored = structuredClone(count)
    this.all.push(stored)
    return structuredClone(stored)
  }

  async find(branchId: string, businessDate: CalendarDate): Promise<CashCountRecord | null> {
    const index = this.activeIndex(branchId, businessDate)
    return index === -1 ? null : structuredClone(this.all[index]!)
  }

  async listDatesInRange(branchId: string, from: CalendarDate, to: CalendarDate): Promise<CalendarDate[]> {
    // `status === 'active'` is load-bearing: without it a financial week could seal on a count its
    // own author withdrew, and BR7 makes that seal immutable.
    return this.all
      .filter(
        (r) =>
          r.branchId === branchId &&
          r.status === 'active' &&
          r.businessDate >= from &&
          r.businessDate <= to,
      )
      .map((r) => r.businessDate)
      .sort()
  }

  async supersede(input: {
    priorId: string
    replacement: CashCountRecord
    closedBy: string
    closedAtMs: number
    reason: string
  }): Promise<CashCountRecord> {
    const prior = this.all.find((r) => r.id === input.priorId && r.status === 'active')
    if (!prior) throw Object.assign(new Error('prior count not active'), { code: 'COUNT_NOT_ACTIVE' })
    const stored = structuredClone(input.replacement)
    this.all.push(stored)
    prior.status = 'superseded'
    prior.supersededById = stored.id
    prior.closedAtMs = input.closedAtMs
    prior.closedBy = input.closedBy
    prior.closedReason = input.reason
    return structuredClone(stored)
  }

  async cancel(input: {
    id: string
    closedBy: string
    closedAtMs: number
    reason: string
  }): Promise<CashCountRecord | null> {
    const row = this.all.find((r) => r.id === input.id && r.status === 'active')
    if (!row) return null
    row.status = 'cancelled'
    row.closedAtMs = input.closedAtMs
    row.closedBy = input.closedBy
    row.closedReason = input.reason
    return structuredClone(row)
  }
}
