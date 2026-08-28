import type { IncomeCategoryRecord, IncomeRecord, IncomeRepo } from '@ash/contracts'
import type { CalendarDate } from '@ash/domain'

/**
 * «المدخول المباشر» — direct income, in memory.
 *
 * Modelled line for line on `MemoryExpenseRepo`, including the snapshot/restore pair the in-memory
 * unit of work needs to roll a failed transaction back.
 */
export class MemoryIncomeRepo implements IncomeRepo {
  readonly categories = new Map<string, IncomeCategoryRecord>()
  readonly rows = new Map<string, IncomeRecord>()

  async listCategories(): Promise<IncomeCategoryRecord[]> {
    return [...this.categories.values()].filter((c) => c.active)
  }
  async createCategory(category: IncomeCategoryRecord): Promise<void> {
    for (const c of this.categories.values()) {
      if (c.code === category.code) {
        throw Object.assign(new Error(`duplicate category ${category.code}`), { code: 'DUPLICATE_CODE' })
      }
    }
    this.categories.set(category.id, { ...category })
  }
  async get(id: string): Promise<IncomeRecord | null> {
    const row = this.rows.get(id)
    return row ? { ...row } : null
  }
  async create(income: IncomeRecord): Promise<void> {
    if (this.rows.has(income.id)) {
      throw Object.assign(new Error(`duplicate income ${income.id}`), { code: 'DUPLICATE_INCOME' })
    }
    this.rows.set(income.id, { ...income })
  }
  snapshotRows(): Map<string, IncomeRecord> {
    return new Map([...this.rows].map(([id, row]) => [id, structuredClone(row)]))
  }
  restoreRows(snapshot: Map<string, IncomeRecord>): void {
    this.rows.clear()
    for (const [id, row] of snapshot) this.rows.set(id, structuredClone(row))
  }
  async listByBranchAndDate(branchId: string, from: CalendarDate, to: CalendarDate): Promise<IncomeRecord[]> {
    return [...this.rows.values()]
      .filter((e) => e.branchId === branchId && e.businessDate >= from && e.businessDate <= to)
      .sort((a, b) => (a.businessDate < b.businessDate ? -1 : 1))
  }
}
