import type {
  ExpenseCategoryRecord,
  ExpenseRecord,
  ExpenseReadFilter,
  ExpenseReadResult,
  ExpenseRepo,
  RecurringExpenseOccurrenceRecord,
  RecurringExpenseRepo,
  RecurringExpenseTemplateRecord,
  SettingsRepo,
} from '@ash/contracts'
import { type CalendarDate, type Minor, minor } from '@ash/domain'

export class MemoryExpenseRepo implements ExpenseRepo {
  readonly categories = new Map<string, ExpenseCategoryRecord>()
  readonly rows = new Map<string, ExpenseRecord>()

  async listCategories(includeInactive = false): Promise<ExpenseCategoryRecord[]> {
    return [...this.categories.values()].filter((c) => includeInactive || c.active)
      .sort((a, b) => a.code.localeCompare(b.code)).map((c) => ({ ...c }))
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
  async search(branchId: string, filter: ExpenseReadFilter, page?: { limit: number; offset: number }): Promise<ExpenseReadResult> {
    const branchRows = [...this.rows.values()].filter((row) => row.branchId === branchId)
    const query = filter.query?.toLocaleLowerCase()
    const rows = branchRows.filter((row) =>
      (filter.from === undefined || row.businessDate >= filter.from) && row.businessDate <= filter.to &&
      (filter.categoryId === undefined || row.categoryId === filter.categoryId) &&
      (filter.costCenterKind === undefined || (filter.costCenterKind === 'operating'
        ? row.costCenterKind !== 'vehicle' : row.costCenterKind === filter.costCenterKind)) &&
      (filter.vehicleId === undefined || row.vehicleId === filter.vehicleId) &&
      (filter.channel === undefined || row.channel === filter.channel) &&
      (query === undefined || row.description.toLocaleLowerCase().includes(query) || row.id.toLocaleLowerCase().includes(query) || String(row.journalEntryId ?? '').includes(query)) &&
      (filter.receipt === undefined || (filter.receipt === 'with') === (row.receiptMediaId !== null)) &&
      (filter.minAmount === undefined || row.amount >= filter.minAmount) &&
      (filter.maxAmount === undefined || row.amount <= filter.maxAmount),
    // Memory records have no database created_at; the immutable posting sequence breaks day ties.
    ).sort((a, b) => b.businessDate.localeCompare(a.businessDate) ||
      (b.journalEntryId ?? 0) - (a.journalEntryId ?? 0) || b.id.localeCompare(a.id))
    const earliestBusinessDate = branchRows.reduce<string | null>((first, row) => first === null || row.businessDate < first ? row.businessDate : first, null)
    return {
      expenses: (page ? rows.slice(page.offset, page.offset + page.limit) : rows).map((row) => ({ ...row })),
      count: rows.length,
      total: minor(rows.reduce((sum, row) => sum + row.amount, 0n)),
      earliestBusinessDate,
    }
  }
  async listByBranchAndDate(branchId: string, from: CalendarDate, to: CalendarDate): Promise<ExpenseRecord[]> {
    return [...this.rows.values()]
      .filter((e) => e.branchId === branchId && e.businessDate >= from && e.businessDate <= to)
      .sort((a, b) => (a.businessDate < b.businessDate ? -1 : 1))
  }
  async listByVehicle(branchId: string, vehicleId: string, from: CalendarDate, to: CalendarDate): Promise<ExpenseRecord[]> {
    return [...this.rows.values()]
      .filter((e) => e.branchId === branchId && e.vehicleId === vehicleId && e.businessDate >= from && e.businessDate <= to)
      .sort((a, b) =>
        (a.businessDate < b.businessDate ? -1 : a.businessDate > b.businessDate ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((e) => ({ ...e }))
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

export class MemoryRecurringExpenseRepo implements RecurringExpenseRepo {
  readonly templates = new Map<string, RecurringExpenseTemplateRecord>()
  readonly occurrences = new Map<string, RecurringExpenseOccurrenceRecord>()

  private occurrenceKey(templateId: string, dueDate: CalendarDate): string {
    return `${templateId}|${dueDate}`
  }

  async getTemplate(id: string): Promise<RecurringExpenseTemplateRecord | null> {
    const row = this.templates.get(id)
    return row ? structuredClone(row) : null
  }

  async listTemplates(branchId: string, includeInactive = false): Promise<RecurringExpenseTemplateRecord[]> {
    return [...this.templates.values()]
      .filter((row) => row.branchId === branchId && (includeInactive || row.active))
      .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
      .map((row) => structuredClone(row))
  }

  async createTemplate(template: RecurringExpenseTemplateRecord): Promise<void> {
    if (this.templates.has(template.id)) {
      throw Object.assign(new Error(`duplicate recurring template ${template.id}`), { code: 'DUPLICATE_TEMPLATE' })
    }
    this.templates.set(template.id, structuredClone(template))
  }

  async updateTemplate(template: RecurringExpenseTemplateRecord): Promise<void> {
    if (!this.templates.has(template.id)) {
      throw Object.assign(new Error(`unknown recurring template ${template.id}`), { code: 'TEMPLATE_NOT_FOUND' })
    }
    this.templates.set(template.id, structuredClone(template))
  }

  async getOccurrence(
    templateId: string,
    dueDate: CalendarDate,
  ): Promise<RecurringExpenseOccurrenceRecord | null> {
    const row = this.occurrences.get(this.occurrenceKey(templateId, dueDate))
    return row ? structuredClone(row) : null
  }

  async listOccurrences(
    branchId: string,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<RecurringExpenseOccurrenceRecord[]> {
    return [...this.occurrences.values()]
      .filter((row) => row.branchId === branchId && row.dueDate >= from && row.dueDate <= to)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.templateId.localeCompare(b.templateId))
      .map((row) => structuredClone(row))
  }

  async countOccurrencesBefore(templateId: string, before: CalendarDate): Promise<number> {
    return [...this.occurrences.values()].filter(
      (row) => row.templateId === templateId && row.dueDate < before,
    ).length
  }

  async createOccurrence(occurrence: RecurringExpenseOccurrenceRecord): Promise<void> {
    const key = this.occurrenceKey(occurrence.templateId, occurrence.dueDate)
    if (this.occurrences.has(key)) {
      throw Object.assign(new Error(`duplicate recurring occurrence ${key}`), { code: 'DUPLICATE_OCCURRENCE' })
    }
    if (
      occurrence.expenseId !== null &&
      [...this.occurrences.values()].some((row) => row.expenseId === occurrence.expenseId)
    ) {
      throw Object.assign(new Error(`duplicate recurring expense ${occurrence.expenseId}`), {
        code: 'DUPLICATE_OCCURRENCE_EXPENSE',
      })
    }
    if (
      occurrence.companyExpenseId != null &&
      [...this.occurrences.values()].some((row) => row.companyExpenseId === occurrence.companyExpenseId)
    ) {
      throw Object.assign(new Error(`duplicate recurring company expense ${occurrence.companyExpenseId}`), {
        code: 'DUPLICATE_OCCURRENCE_EXPENSE',
      })
    }
    this.occurrences.set(key, structuredClone(occurrence))
  }

  snapshotState(): {
    templates: Map<string, RecurringExpenseTemplateRecord>
    occurrences: Map<string, RecurringExpenseOccurrenceRecord>
  } {
    return {
      templates: new Map([...this.templates].map(([id, row]) => [id, structuredClone(row)])),
      occurrences: new Map([...this.occurrences].map(([id, row]) => [id, structuredClone(row)])),
    }
  }

  restoreState(snapshot: ReturnType<MemoryRecurringExpenseRepo['snapshotState']>): void {
    this.templates.clear()
    for (const [id, row] of snapshot.templates) this.templates.set(id, structuredClone(row))
    this.occurrences.clear()
    for (const [id, row] of snapshot.occurrences) this.occurrences.set(id, structuredClone(row))
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
