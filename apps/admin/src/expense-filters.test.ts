import { describe, expect, it } from 'vitest'
import { expenseAmountFilterError, expenseCsvCell, expenseExportCsv, expenseFilterParams, expenseFiltersFromParams } from './expense-filters.ts'
import { parseHash, formatHash } from './route.ts'
import type { ExpensePage } from '@ash/client'

describe('branch expense hash handoff and exact filter semantics', () => {
  it('preserves dashboard dates, supported expense filters and the page on a round trip', () => {
    const route = parseHash('#expenses?range=custom&from=2026-08-30&to=2026-10-03&category=fuel-1&costCenterKind=vehicle&vehicle=vehicle-1&expenseChannel=office_wallet&q=%D8%A8%D9%86%D8%B2%D9%8A%D9%86&receipt=with&minAmount=0.01&maxAmount=90071992547409.93&page=2')
    expect(route.params.from).toBe('2026-08-30'); expect(route.params.to).toBe('2026-10-03')
    const filter = expenseFiltersFromParams(route.params)
    expect(filter).toEqual({ categoryId: 'fuel-1', costCenterKind: 'vehicle', vehicleId: 'vehicle-1', channel: 'office_wallet', q: 'بنزين', receipt: 'with', minAmount: '0.01', maxAmount: '90071992547409.93' })
    expect(expenseFilterParams(filter, 2)).toMatchObject({ page: '2', category: 'fuel-1' })
    expect(parseHash(`#${formatHash(route)}`).params).toEqual(route.params)
  })
  it('supports operating cost drill-down without inventing a persisted expense kind', () => {
    expect(expenseFiltersFromParams(parseHash('#expenses?costCenterKind=operating').params)).toEqual({ costCenterKind: 'operating' })
  })
  it('drops unsupported and invalid route fields', () => {
    expect(parseHash('#expenses?expenseChannel=owner&receipt=yes&minAmount=-1&maxAmount=0.001&page=0&category=bad%20id&costCenterKind=unknown').params).toEqual({})
  })
  it('compares monetary bounds exactly above the safe Number limit', () => {
    expect(expenseAmountFilterError({ minAmount: '90071992547409.93', maxAmount: '90071992547409.92' })).toBe('amount_order')
    expect(expenseAmountFilterError({ minAmount: '0.01', maxAmount: '0.01' })).toBeNull()
    for (const value of ['-1', '1.001', 'NaN', '92233720368547758.08']) expect(expenseAmountFilterError({ minAmount: value })).toBe('amount_invalid')
  })
})

describe('complete expense CSV is safe and declares its accounting scope', () => {
  it.each(['=SUM(1,2)', '+cmd', '-cmd', '@cmd', '  =SUM(1,2)', '\t=cmd', '\r=cmd'])('neutralises spreadsheet formula injection in %j', (value) => {
    expect(expenseCsvCell(value).startsWith('"\'')).toBe(true)
  })
  it('escapes quotes and preserves Arabic/newlines as quoted CSV data', () => {
    expect(expenseCsvCell('بنزين "موتور"\nفاتورة')).toBe('"بنزين ""موتور""\nفاتورة"')
  })
  it('exports every returned record, with exact amount and explicit registered-total basis', () => {
    const response: ExpensePage = {
      branchId: 'branch-1', from: '2026-07-01', to: '2026-07-21', earliestBusinessDate: '2026-07-01', currency: 'SYP_NEW', totalBasis: 'recorded_expense_rows',
      total: '1.03', count: 2, limit: null, offset: 0, generatedAt: '2026-07-21T12:00:00.000Z', expenses: [
        { id: 'e-1', branchId: 'branch-1', categoryId: 'fuel', categoryNameAr: 'بنزين', costCenterKind: 'general', vehicleId: null, channel: 'office_cash', amount: '1.01', businessDate: '2026-07-01', description: '=danger', receiptMediaId: null, journalEntryId: 1, createdBy: 'u-1' },
        { id: 'e-2', branchId: 'branch-1', categoryId: 'fuel', costCenterKind: 'vehicle', vehicleId: 'v-1', channel: 'office_wallet', amount: '0.02', businessDate: '2026-07-21', description: 'صيانة', receiptMediaId: 'm-1', journalEntryId: 2, createdBy: 'u-1', advanceId: 'advance-1' },
      ],
    }
    const csv = expenseExportCsv(response)
    expect(csv).toContain('"\'=danger"'); expect(csv).toContain('"1.01"')
    expect(csv).toContain('"e-1"'); expect(csv).toContain('"e-2"')
    expect(csv).toContain('المبالغ المسجلة قبل العكس اللاحق')
    expect(csv).toContain('SYP_NEW'); expect(csv).toContain('صرفية ناتجة عن سلفة')
  })
})
