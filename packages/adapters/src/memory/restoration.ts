import type { OfficeCapitalTargetRepo, RestorationRecord, RestorationRepo } from '@ash/contracts'
import { type CalendarDate, type Minor, minor } from '@ash/domain'

/**
 * «رأس مال المكتب» in memory — effective-dated, resolved exactly as the Postgres repo resolves it.
 *
 * Seeded with the owner's own figures so a fresh harness behaves like the real branch: كاش المكتب
 * 4,000,000 and محفظة المكتب 1,000,000, effective from the epoch. A test that had to configure
 * capital before it could exercise الترميم would be testing its own setup.
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
    )
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

/** One ترميم per branch per working day — the same rule the unique index enforces in Postgres. */
export class MemoryRestorationRepo implements RestorationRepo {
  private readonly rows: RestorationRecord[] = []

  async create(row: RestorationRecord): Promise<void> {
    if (this.rows.some((r) => r.branchId === row.branchId && r.businessDate === row.businessDate)) {
      throw Object.assign(new Error('already restored today'), { code: 'DUPLICATE_RESTORATION' })
    }
    this.rows.push({ ...row })
  }

  async find(branchId: string, businessDate: CalendarDate): Promise<RestorationRecord | null> {
    return this.rows.find((r) => r.branchId === branchId && r.businessDate === businessDate) ?? null
  }
}
