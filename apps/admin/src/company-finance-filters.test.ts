import { describe, expect, it } from 'vitest'
import { defaultFinanceFilters, filterFinanceRows, financeRowTotals, financeRowsCsv, validFinanceFilters, type FinanceFilterRow } from './screens/CompanyFinanceFilters.tsx'
import { formatHash, parseHash } from './route.ts'

const today = '2026-10-04'
const rows: FinanceFilterRow[] = Array.from({ length: 45 }, (_, index) => ({ id: String(index), date: index % 2 ? '2026-09-10' : '2026-10-02', kind: index % 3 ? 'expense' : 'asset_payment', source: index % 2 ? 'owner_outside' : 'pocket', category: index % 3 ? 'rent' : 'unclassified', status: index % 4 ? 'active' : 'corrected', description: index === 1 ? '=HYPERLINK("bad")' : 'مصاريف مكتب', reference: `HQ-SRC-${index}`, amounts: [{ currency: index % 2 ? 'USD' : 'SYP_NEW', amount: index % 2 ? '390.00' : '-51500.00' }] }))

describe('complete-scope company and owner financial filters', () => {
  it('applies compound date, kind, source, currency, category, status, text and exact amount filters', () => {
    const filters = { ...defaultFinanceFilters(today), period: 'custom' as const, from: '2026-09-01', to: '2026-09-30', kind: 'expense', source: 'owner_outside', currency: 'USD', category: 'rent', status: 'active', query: 'HQ-SRC-1', min: '390', max: '390.00' }
    expect(filterFinanceRows(rows, filters, today).map(row => row.id)).toEqual(['1', '11', '13', '17', '19'])
  })
  it('totals the complete matching source before pagination, separately and without floating-point loss', () => {
    const matched = filterFinanceRows(rows, defaultFinanceFilters(today), today)
    expect(matched).toHaveLength(45)
    expect(financeRowTotals(matched)).toEqual({ SYP_NEW: '-1184500.00', USD: '8580.00' })
    expect(financeRowTotals([{ ...rows[0]!, amounts: [{ currency: 'USD', amount: '90071992547409.91' }] }, { ...rows[1]!, amounts: [{ currency: 'USD', amount: '0.01' }] }]).USD).toBe('90071992547409.92')
  })
  it('filters a signed amount by absolute value only in the selected currency', () => {
    expect(filterFinanceRows(rows, { ...defaultFinanceFilters(today), currency: 'SYP_NEW', min: '51500', max: '51500' }, today)).toHaveLength(23)
    expect(validFinanceFilters({ ...defaultFinanceFilters(today), min: '390' }, today)).toBe(false)
  })
  it('rejects invalid dates and ranges instead of displaying stale or false totals', () => {
    for (const patch of [{ from: '2026-02-30' }, { from: '2026-10-04', to: '2026-09-01' }, { to: '2026-10-05' }, { currency: 'USD', min: '-1' }, { currency: 'USD', min: '9', max: '8' }]) expect(filterFinanceRows(rows, { ...defaultFinanceFilters(today), ...patch }, today)).toEqual([])
  })
  it('exports every matching result rather than its first page and prevents spreadsheet formula injection', () => {
    const filters = { ...defaultFinanceFilters(today), currency: 'USD' }, matched = filterFinanceRows(rows, filters, today), csv = financeRowsCsv(matched, filters, 0)
    expect(csv.split('\r\n')).toHaveLength(23)
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).toContain('current_corrected')
    expect(csv).toContain('absolute_amount_in_selected_currency')
    expect(csv).toContain('1970-01-01T00:00:00.000Z')
  })
  it('preserves the HQ dashboard report period and booked posting basis in validated deep links', () => {
    const route = parseHash('#companyFund?tab=reports&range=custom&from=2026-09-01&to=2026-09-30&view=as_booked&dateBasis=posting')
    expect(route.params).toMatchObject({ from: '2026-09-01', to: '2026-09-30', view: 'as_booked', dateBasis: 'posting' })
    expect(formatHash(route)).toContain('view=as_booked&dateBasis=posting')
    expect(parseHash('#companyFund?view=unsafe&dateBasis=unsafe').params).toEqual({})
  })
  it('matches month-only evidence by overlap and never exports a fabricated first-day payment', () => {
    const payment: FinanceFilterRow = { ...rows[1]!, id: 'month-only', date: '2026-06-01', dateEnd: '2026-06-30', datePrecision: 'month', amounts: [{ currency: 'USD', amount: '1540.00' }] }
    const filters = { ...defaultFinanceFilters(today), period: 'custom' as const, from: '2026-06-15', to: '2026-06-18' }
    const matched = filterFinanceRows([payment, { ...payment, id: 'known-day', datePrecision: 'day', dateEnd: '2026-06-01' }], filters, today)
    expect(matched.map(row => row.id)).toEqual(['month-only'])
    expect(financeRowTotals(matched)).toEqual({ SYP_NEW: '0.00', USD: '1540.00' })
    expect(filterFinanceRows([payment], { ...filters, from: '2026-07-01', to: '2026-07-05' }, today)).toEqual([])
    const record = financeRowsCsv(matched, filters, 0).split('\r\n')[1]!
    expect(record).toContain(',"month-only","2026-06",')
    expect(record).toContain(',"1540.00","month","2026-06-30"')
    expect(record).not.toContain(',"2026-06-01",')
    expect(record).toContain('month_overlap_when_day_unknown')
  })
})
