import type { ExpenseFilter, ExpensePage } from '@ash/client'
import { parseMinor } from '@ash/domain'
import type { RouteParams } from './route.ts'

export const EXPENSE_PAGE_SIZE = 50

export function expenseFiltersFromParams(params: RouteParams): ExpenseFilter {
  return {
    ...(params.category ? { categoryId: params.category } : {}),
    ...(params.costCenterKind ? { costCenterKind: params.costCenterKind } : {}),
    ...(params.vehicle ? { vehicleId: params.vehicle, costCenterKind: 'vehicle' } : {}),
    ...(params.expenseChannel ? { channel: params.expenseChannel } : {}),
    ...(params.receipt ? { receipt: params.receipt } : {}),
    ...(params.q ? { q: params.q } : {}),
    ...(params.minAmount ? { minAmount: params.minAmount } : {}),
    ...(params.maxAmount ? { maxAmount: params.maxAmount } : {}),
  }
}

/** Validate ranges with exact minor units, never Number/parseFloat. */
export function expenseAmountFilterError(filter: ExpenseFilter): 'amount_invalid' | 'amount_order' | null {
  try {
    const read = (value: string | undefined): bigint | null => {
      if (value === undefined || value === '') return null
      if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('amount')
      const minor = parseMinor(value)
      if (minor > 9_223_372_036_854_775_807n) throw new Error('amount')
      return minor
    }
    const min = read(filter.minAmount), max = read(filter.maxAmount)
    return min !== null && max !== null && min > max ? 'amount_order' : null
  } catch { return 'amount_invalid' }
}

export function expenseFilterParams(filter: ExpenseFilter, page: number): RouteParams {
  return {
    ...(filter.categoryId ? { category: filter.categoryId } : {}),
    ...(filter.costCenterKind ? { costCenterKind: filter.costCenterKind } : {}),
    ...(filter.vehicleId ? { vehicle: filter.vehicleId } : {}),
    ...(filter.channel ? { expenseChannel: filter.channel } : {}),
    ...(filter.receipt ? { receipt: filter.receipt } : {}),
    ...(filter.q?.trim() ? { q: filter.q.trim() } : {}),
    ...(filter.minAmount ? { minAmount: filter.minAmount } : {}),
    ...(filter.maxAmount ? { maxAmount: filter.maxAmount } : {}),
    ...(page > 1 ? { page: String(page) } : {}),
  }
}

/** Spreadsheets must treat untrusted descriptions and names as data, not formulas. */
export function expenseCsvCell(value: string): string {
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(value) || /^[\u0000-\u001f]/.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/g, '""')}"`
}

export function expenseExportCsv(result: ExpensePage): string {
  const headings = ['معرّف الصرفية', 'الفرع', 'يوم العمل', 'الفئة', 'مركز الكلفة', 'الآلية', 'قناة الدفع', 'الوصف', 'المبلغ المسجل', 'العملة', 'مستند', 'القيد', 'صرفية ناتجة عن سلفة', 'من', 'إلى', 'وقت التصدير', 'أساس المجموع']
  const rows = result.expenses.map((expense) => [
    expense.id, result.branchId, expense.businessDate, expense.categoryNameAr ?? expense.categoryId,
    expense.costCenterKind === 'vehicle' ? 'آلية' : expense.costCenterKind === 'branch' ? 'فرع' : 'عام',
    expense.vehicleCode ?? expense.vehicleId ?? '', expense.channel === 'office_wallet' ? 'محفظة الفرع' : 'صندوق الفرع',
    expense.description, expense.amount, result.currency, expense.receiptMediaId ? 'نعم' : 'لا',
    String(expense.journalEntryId ?? ''), expense.advanceId ? 'نعم' : 'لا',
    result.from, result.to, result.generatedAt, 'المبالغ المسجلة قبل العكس اللاحق',
  ])
  return [headings, ...rows].map((row) => row.map(expenseCsvCell).join(',')).join('\r\n')
}
