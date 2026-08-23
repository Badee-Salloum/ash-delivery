import type { ExpenseCategoryRecord, ExpenseRecord, ExpenseRepo, SettingsRepo } from '@ash/contracts'
import { type CalendarDate, type Minor, minor } from '@ash/domain'

export class MemoryExpenseRepo implements ExpenseRepo {
  readonly categories = new Map<string, ExpenseCategoryRecord>()
  readonly rows = new Map<string, ExpenseRecord>()

  async listCategories(): Promise<ExpenseCategoryRecord[]> {
    return [...this.categories.values()].filter((c) => c.active)
  }
  async createCategory(category: ExpenseCategoryRecord): Promise<void> {
    for (const c of this.categories.values()) {
      if (c.code === category.code) {
        throw Object.assign(new Error(`duplicate category ${category.code}`), { code: 'DUPLICATE_CODE' })
      }
    }
    this.categories.set(category.id, { ...category })
  }
  async get(id: string): Promise<ExpenseRecord | null> {
    const row = this.rows.get(id)
    return row ? { ...row } : null
  }
  async create(expense: ExpenseRecord): Promise<void> {
    if (this.rows.has(expense.id)) {
      throw Object.assign(new Error(`duplicate expense ${expense.id}`), { code: 'DUPLICATE_EXPENSE' })
    }
    this.rows.set(expense.id, { ...expense })
  }
  snapshotRows(): Map<string, ExpenseRecord> {
    return new Map([...this.rows].map(([id, row]) => [id, structuredClone(row)]))
  }
  restoreRows(snapshot: Map<string, ExpenseRecord>): void {
    this.rows.clear()
    for (const [id, row] of snapshot) this.rows.set(id, structuredClone(row))
  }
  async listByBranchAndDate(branchId: string, from: CalendarDate, to: CalendarDate): Promise<ExpenseRecord[]> {
    return [...this.rows.values()]
      .filter((e) => e.branchId === branchId && e.businessDate >= from && e.businessDate <= to)
      .sort((a, b) => (a.businessDate < b.businessDate ? -1 : 1))
  }

  /** G-1's «تُغذي ربحية كل محور» — one row per axis, so vehicle profitability is a subtraction. */
  async totalsByCostCenter(
    branchId: string,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<Array<{ costCenterKind: string; vehicleId: string | null; total: Minor }>> {
    const totals = new Map<string, { costCenterKind: string; vehicleId: string | null; total: bigint }>()
    for (const e of await this.listByBranchAndDate(branchId, from, to)) {
      const key = `${e.costCenterKind}|${e.vehicleId ?? ''}`
      const current = totals.get(key) ?? { costCenterKind: e.costCenterKind, vehicleId: e.vehicleId, total: 0n }
      current.total += e.amount
      totals.set(key, current)
    }
    return [...totals.values()].map((t) => ({ ...t, total: minor(t.total) }))
  }
}

export class MemorySettingsRepo implements SettingsRepo {
  private readonly values = new Map<string, unknown>()

  async receiptRequiredAbove(_branchId: string): Promise<Minor | null> {
    const raw = this.values.get('expense.receipt_required_above_minor')
    return raw === undefined ? null : minor(BigInt(String(raw)))
  }
  async kwhPriceMinor(): Promise<Minor | null> {
    const raw = this.values.get('vehicle.kwh_price_minor')
    return raw === undefined ? null : minor(BigInt(String(raw)))
  }
  async get(key: string): Promise<unknown> {
    return this.values.get(key) ?? null
  }
  async set(key: string, value: unknown, _actorId: string): Promise<void> {
    this.values.set(key, value)
  }
}
