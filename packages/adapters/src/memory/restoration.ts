import type { OfficeCapitalTargetRepo, RestorationRecord, RestorationRepo } from '@ash/contracts'
import { type CalendarDate, type Minor, minor } from '@ash/domain'

/**
 * «رأس مال المكتب» in memory — effective-dated, resolved exactly as the Postgres repo resolves it.
 *
 * Seeded with the historical figures from the epoch and the owner's 2026-08-23 successor targets:
 * كاش المكتب 50,000 and محفظة المكتب 10,000. Effective dating keeps older restoration fixtures
 * truthful while current-day harnesses resolve exactly like production.
 */
export class MemoryOfficeCapitalTargetRepo implements OfficeCapitalTargetRepo {
  private readonly rows: Array<{
    branchId: string
    fundCode: 'office_cash' | 'office_wallet'
    target: Minor
    effectiveFrom: CalendarDate
  }> = []

  /** Every branch shares the seed: the harness has one, and a second would want its own anyway. */
  seed(branchId: string): void {
    this.rows.push(
      { branchId, fundCode: 'office_cash', target: minor(400_000_000n), effectiveFrom: '2000-01-01' },
      { branchId, fundCode: 'office_wallet', target: minor(100_000_000n), effectiveFrom: '2000-01-01' },
      { branchId, fundCode: 'office_cash', target: minor(5_000_000n), effectiveFrom: '2026-08-23' },
      { branchId, fundCode: 'office_wallet', target: minor(1_000_000n), effectiveFrom: '2026-08-23' },
    )
  }

  snapshotRows(): Array<{
    branchId: string
    fundCode: 'office_cash' | 'office_wallet'
    target: Minor
    effectiveFrom: CalendarDate
  }> {
    return structuredClone(this.rows)
  }

  restoreRows(snapshot: ReturnType<MemoryOfficeCapitalTargetRepo['snapshotRows']>): void {
    this.rows.splice(0, this.rows.length, ...structuredClone(snapshot))
  }

  async resolve(
    branchId: string,
    businessDate: CalendarDate,
  ): Promise<Partial<Record<'office_cash' | 'office_wallet', Minor>>> {
    const out: Partial<Record<'office_cash' | 'office_wallet', Minor>> = {}
    for (const code of ['office_cash', 'office_wallet'] as const) {
      // Latest row on or before the date — the same DISTINCT ON … ORDER BY effective_from DESC the
      // Pg repo performs. No status filter here because nothing in memory is ever withdrawn.
      const applicable = this.rows
        .filter((r) => r.branchId === branchId && r.fundCode === code && r.effectiveFrom <= businessDate)
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))
      if (applicable[0]) out[code] = applicable[0].target
    }
    return out
  }

  async upsert(row: {
    branchId: string
    fundCode: 'office_cash' | 'office_wallet'
    target: Minor
    effectiveFrom: CalendarDate
    createdBy: string
    note: string | null
  }): Promise<void> {
    const existing = this.rows.find(
      (r) => r.branchId === row.branchId && r.fundCode === row.fundCode && r.effectiveFrom === row.effectiveFrom,
    )
    if (existing) existing.target = row.target
    else this.rows.push({ branchId: row.branchId, fundCode: row.fundCode, target: row.target, effectiveFrom: row.effectiveFrom })
  }
}

/**
 * One ترميم per branch per working day — the same rule the unique index enforces in Postgres.
 * `RestorationRecord` preserves both evidence generations: v2 has a cash-count id, while v3 keeps
 * it null and freezes the opening live-ledger balances inside its cloned plan.
 */
export class MemoryRestorationRepo implements RestorationRepo {
  private readonly rows: RestorationRecord[] = []

  snapshotRows(): RestorationRecord[] {
    return structuredClone(this.rows)
  }

  restoreRows(snapshot: readonly RestorationRecord[]): void {
    this.rows.splice(0, this.rows.length, ...structuredClone(snapshot))
  }

  async create(row: RestorationRecord): Promise<void> {
    // Since 0061 a business date may hold several runs; what stays unique is the RUN, mirroring
    // `restorations_run_per_day`. Uniqueness never was the thing that prevented a double posting —
    // the ledger's `(shift_id, event_type, occurrence_key)` key is, and each run has its own.
    const taken = this.rows.some(
      (r) => r.branchId === row.branchId && r.businessDate === row.businessDate && r.runNo === row.runNo,
    )
    if (taken) {
      throw Object.assign(new Error('restoration run already recorded'), { code: 'DUPLICATE_RESTORATION' })
    }
    this.rows.push(structuredClone(row))
  }

  async runsOnDay(branchId: string, businessDate: CalendarDate): Promise<number> {
    return this.rows.filter((r) => r.branchId === branchId && r.businessDate === businessDate).length
  }

  /** The LATEST run of that day, which is what «هل رُمِّم؟» actually asks. */
  async find(branchId: string, businessDate: CalendarDate): Promise<RestorationRecord | null> {
    const found = this.rows
      .filter((r) => r.branchId === branchId && r.businessDate === businessDate)
      .sort((a, b) => b.runNo - a.runNo)[0]
    return found ? structuredClone(found) : null
  }
}
