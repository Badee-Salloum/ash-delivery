import type { ReactNode } from 'react'
import { formatMinor, isCalendarDate, minor, monthEndFor, parseMinor, type Currency } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { companyCsvCell } from '../company-journal-display.ts'
import { Button, Field, MoneyInput, Select, TextInput } from '../ui.tsx'

export type FinanceFilters = { period: 'all' | 'month' | 'previous' | 'custom'; from: string; to: string; kind: string; source: string; currency: string; category: string; status: string; query: string; min: string; max: string }
export type FinanceFilterRow = { id: string; date: string; dateEnd?: string; datePrecision?: 'day' | 'month'; kind: string; source: string; category: string | null; status: string; description: string; reference: string | null; amounts: Array<{ currency: Currency; amount: string }> }
type Option = { value: string; label: string }
export const defaultFinanceFilters = (today: string): FinanceFilters => ({ period: 'all', from: '2000-01-01', to: today, kind: 'all', source: 'all', currency: 'all', category: 'all', status: 'all', query: '', min: '', max: '' })

export function validFinanceFilters(filters: FinanceFilters, today: string): boolean {
  if (!isCalendarDate(filters.from) || !isCalendarDate(filters.to) || filters.from > filters.to || filters.from < '2000-01-01' || filters.to > today) return false
  try { const low = filters.min ? parseMinor(filters.min) : null, high = filters.max ? parseMinor(filters.max) : null; return (low === null || low >= 0n) && (high === null || high >= 0n) && (low === null || high === null || low <= high) && (!filters.min && !filters.max || filters.currency !== 'all') } catch { return false }
}

/** Filter the complete server-provided scope BEFORE paging or export; no monetary rounding. */
export function filterFinanceRows<T extends FinanceFilterRow>(rows: T[], filters: FinanceFilters, today: string): T[] {
  if (!validFinanceFilters(filters, today)) return []
  const low = filters.min ? parseMinor(filters.min) : null, high = filters.max ? parseMinor(filters.max) : null, query = filters.query.trim().toLocaleLowerCase()
  return rows.filter(row => (row.dateEnd ?? row.date) >= filters.from && row.date <= filters.to && (filters.kind === 'all' || row.kind === filters.kind) && (filters.source === 'all' || row.source === filters.source) && (filters.category === 'all' || row.category === filters.category) && (filters.status === 'all' || row.status === filters.status) && (!query || `${row.description} ${row.reference ?? ''}`.toLocaleLowerCase().includes(query)) && (filters.currency === 'all' || row.amounts.some(value => value.currency === filters.currency)) && (low === null && high === null || row.amounts.some(value => { if (value.currency !== filters.currency) return false; const signed = parseMinor(value.amount), amount = signed < 0n ? -signed : signed; return (low === null || amount >= low) && (high === null || amount <= high) })))
}

export function financeRowTotals(rows: FinanceFilterRow[]): Record<Currency, string> {
  const totals = { SYP_NEW: 0n, USD: 0n }
  for (const row of rows) for (const value of row.amounts) totals[value.currency] += parseMinor(value.amount)
  return { SYP_NEW: formatMinor(minor(totals.SYP_NEW)), USD: formatMinor(minor(totals.USD)) }
}

export function financeRowsCsv(rows: FinanceFilterRow[], filters: FinanceFilters, generatedAtMs: number): string {
  const metadata = JSON.stringify({ ...filters, amountRangeBasis: 'absolute_amount_in_selected_currency', dateRangeBasis: 'month_overlap_when_day_unknown', view: 'current_corrected', dateBasis: 'occurrence', currencyUnit: 'SYP_NEW', generatedAtUtc: new Date(generatedAtMs).toISOString() })
  const header = ['filter_scope', 'source_id', 'occurred_on', 'kind', 'source', 'category_id', 'status', 'reference', 'description', 'currency', 'amount', 'date_precision', 'occurred_range_end']
  const body = rows.flatMap(row => (row.amounts.length ? row.amounts : [{ currency: '', amount: '' }]).map(value => [metadata, row.id, row.datePrecision === 'month' ? row.date.slice(0, 7) : row.date, row.kind, row.source, row.category ?? '', row.status, row.reference ?? '', row.description, value.currency, value.amount, row.datePrecision ?? 'day', row.dateEnd ?? row.date]))
  return [header, ...body].map(row => row.map(companyCsvCell).join(',')).join('\r\n')
}

export function downloadFinanceRows(rows: FinanceFilterRow[], filters: FinanceFilters, name: string): void {
  const url = URL.createObjectURL(new Blob(['\ufeff', financeRowsCsv(rows, filters, Date.now())], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = `${name}-${filters.from}-${filters.to}.csv`; link.click(); URL.revokeObjectURL(url)
}

export function CompanyFinanceFilters({ filters, onChange, today, kinds, categories = [], sources = [], statuses = [] }: { filters: FinanceFilters; onChange: (value: FinanceFilters) => void; today: string; kinds: Option[]; categories?: Option[]; sources?: Option[]; statuses?: Option[] }): ReactNode {
  const { t } = useApp(), r = t.financeReview
  const set = (key: keyof FinanceFilters, value: string): void => onChange({ ...filters, [key]: value, ...(key === 'currency' && value === 'all' ? { min: '', max: '' } : {}) })
  const allLabel = { kind: r.allCategories, category: r.allExpenseCategories, source: r.allSources, currency: r.allCurrencies, status: r.allStatuses }
  const select = (key: keyof typeof allLabel, label: string, options: Option[]): ReactNode => <Field label={label}><Select value={filters[key]} onChange={event => set(key, event.target.value)} aria-label={label}><option value="all">{allLabel[key]}</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></Field>
  const choosePeriod = (period: FinanceFilters['period']): void => { const next = { ...filters, period }; if (period === 'all') { next.from = '2000-01-01'; next.to = today } else if (period === 'month') { next.from = `${today.slice(0, 7)}-01`; next.to = today } else if (period === 'previous') { const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7)), previous = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`; next.from = `${previous}-01`; next.to = monthEndFor(next.from) } onChange(next) }
  const chips = (['kind', 'category', 'source', 'currency', 'status', 'query', 'min', 'max'] as const).filter(key => filters[key] && filters[key] !== 'all')
  const labels = { kind: t.companyFinance.kind, category: t.expenses.category, source: r.source, currency: t.companyFinance.currency, status: t.accounts.status, query: r.filterSearch, min: r.filterAmountFrom, max: r.filterAmountTo }
  return <div className="my-3 rounded-lg border border-line p-3"><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"><Field label={r.reportPeriod}><Select value={filters.period} aria-label={r.reportPeriod} onChange={event => choosePeriod(event.target.value as FinanceFilters['period'])}><option value="all">{r.allPeriod}</option><option value="month">{r.thisMonth}</option><option value="previous">{r.previousMonth}</option><option value="custom">{r.customPeriod}</option></Select></Field>{select('kind', t.companyFinance.kind, kinds)}{categories.length ? select('category', t.expenses.category, categories) : null}<Field label={r.filterSearch}><TextInput value={filters.query} aria-label={r.filterSearch} onChange={event => set('query', event.target.value)} /></Field></div><p className="my-2 text-label text-ink-muted"><bdi>{filters.from}</bdi> — <bdi>{filters.to}</bdi> · {r.occurrenceDates}</p>{filters.period === 'custom' ? <div className="my-3 grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label={t.companyFinance.from}><TextInput type="date" value={filters.from} min="2000-01-01" max={today} aria-label={t.companyFinance.from} onChange={event => set('from', event.target.value)} /></Field><Field label={t.companyFinance.to}><TextInput type="date" value={filters.to} min="2000-01-01" max={today} aria-label={t.companyFinance.to} onChange={event => set('to', event.target.value)} /></Field></div> : null}<details><summary className="cursor-pointer text-brand">{r.additionalFilters}</summary><div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{select('currency', t.companyFinance.currency, [{ value: 'SYP_NEW', label: t.currency.SYP_NEW }, { value: 'USD', label: t.currency.USD }])}{sources.length > 1 ? select('source', r.source, sources) : null}{statuses.length ? select('status', t.accounts.status, statuses) : null}<Field label={r.filterAmountFrom} hint={r.selectAmountCurrency}><MoneyInput disabled={filters.currency === 'all'} value={filters.min} aria-label={r.filterAmountFrom} onChange={event => set('min', event.target.value)} /></Field><Field label={r.filterAmountTo} hint={r.selectAmountCurrency}><MoneyInput disabled={filters.currency === 'all'} value={filters.max} aria-label={r.filterAmountTo} onChange={event => set('max', event.target.value)} /></Field></div></details>{chips.length ? <div className="mt-3 flex flex-wrap gap-2">{chips.map(key => <Button key={key} size="sm" variant="ghost" onClick={() => set(key, key === 'query' || key === 'min' || key === 'max' ? '' : 'all')}>{labels[key]}: {key === 'kind' ? kinds.find(option => option.value === filters[key])?.label : key === 'category' ? categories.find(option => option.value === filters[key])?.label : key === 'source' ? sources.find(option => option.value === filters[key])?.label : key === 'currency' ? t.currency[filters[key] as Currency] : key === 'status' ? statuses.find(option => option.value === filters[key])?.label : filters[key]} ×</Button>)}</div> : null}<div className="mt-3"><Button variant="ghost" onClick={() => onChange(defaultFinanceFilters(today))}>{r.resetFilters}</Button></div>{!validFinanceFilters(filters, today) ? <p role="alert" className="mt-3 text-danger-ink">{r.invalidFilters}</p> : null}</div>
}
