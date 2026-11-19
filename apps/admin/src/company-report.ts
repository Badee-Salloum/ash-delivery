import { formatMinor, minor, parseMinor, type Currency } from '@ash/domain'
import { companyCsvCell } from './company-journal-display.ts'

export type CompanyReportView = 'as_booked' | 'current_corrected'
export type CompanyReportDateBasis = 'posting' | 'occurrence'
export interface CompanyReportRow {
  auditState?: 'deleted_expense' | 'expense_deletion'
  id: string; nature: 'business_event' | 'journal_only'; kind: string
  occurredOn: string; occurredPrecision: 'day' | 'month'; occurredMonth: string | null
  occurrenceSource: 'recorded' | 'posting_fallback'; postingDate: string; latestPostingDate: string
  canonicalCommandId: string | null; activeCommandId: string | null
  originalEntryId: number | null; activeEntryId: number | null; sourceEntryId: number | null; relatedEntryIds: number[]; correctionIds: string[]
  version: number; reversed: boolean; currency: Currency | null; grossAmount: string | null; netAmount: string | null
  fromCurrency: Currency | null; fromAmount: string | null; toCurrency: Currency | null; toAmount: string | null
  source: string | null; branchId: string | null; description: string; externalReference: string | null
  receiptReference: string | null; sypMinorPerUsd: string | null; rateBasis: 'documented' | 'estimated' | null
  lines: Array<{ fundCode: string; currency: Currency; side: 'D' | 'C'; role: string | null; grossAmount: string; netAmount: string }>
}
export interface CompanyReport {
  from: string; to: string; view: CompanyReportView; dateBasis: CompanyReportDateBasis; generatedAtMs: number
  periodSemantics: 'immutable_journals' | 'current_snapshot_original_posting_anchor'
  historicalBookCostPolicy: 'not_reclassified'
  availableFrom?: string | null; scope?: 'company_hq'; currencyUnit?: 'SYP_NEW'
  detailCategory?: string
  filters?: { currency: string; branch: string; direction: string }
  cashBalances?: Record<Currency, { opening: string; closing: string }>
  custodyBalances?: Record<Currency, { opening: string; closing: string }>
  totals: Record<Currency, { debits: string; credits: string; cashNet: string; cashReceipts?: string; cashPayments?: string; income: string; expense: string; companyFundedExpense: string; ownerOutsideExpense: string; otherBookExpense: string }>
  rows: CompanyReportRow[]; occurrenceFallbackCount: number; journalOnlyCount: number; pendingRestorationCount: number
}

/** Recompute from the exact visible/exported lines; never total rounded display values. */
export function companyReportTotals(rows: CompanyReportRow[], cashFund = 'company_cash'): CompanyReport['totals'] {
  const totals = { SYP_NEW: { debits: 0n, credits: 0n, cashNet: 0n, cashReceipts: 0n, cashPayments: 0n, income: 0n, expense: 0n, companyFundedExpense: 0n, ownerOutsideExpense: 0n, otherBookExpense: 0n },
    USD: { debits: 0n, credits: 0n, cashNet: 0n, cashReceipts: 0n, cashPayments: 0n, income: 0n, expense: 0n, companyFundedExpense: 0n, ownerOutsideExpense: 0n, otherBookExpense: 0n } }
  for (const row of rows) for (const line of row.lines) {
    const value = parseMinor(line.netAmount), signed = line.side === 'D' ? value : -value, total = totals[line.currency]
    total[line.side === 'D' ? 'debits' : 'credits'] += value
    if (line.fundCode === `${cashFund}:${line.currency}`) {
      total.cashNet += signed; total[line.side === 'D' ? 'cashReceipts' : 'cashPayments'] += value
    }
    if (line.fundCode.startsWith('company_income:')) total.income -= signed
    if (line.fundCode.startsWith('company_expense:')) {
      total.expense += signed
      total[row.source === 'owner_outside' ? 'ownerOutsideExpense' : row.source === 'pocket' || row.source === 'reserve' || row.source === 'owner_custody' ? 'companyFundedExpense' : 'otherBookExpense'] += signed
    }
  }
  return Object.fromEntries((['SYP_NEW', 'USD'] as const).map(currency => [currency,
    Object.fromEntries(Object.entries(totals[currency]).map(([key, value]) => [key, formatMinor(minor(value))]))])) as CompanyReport['totals']
}

export function companyReportRows(rows: CompanyReportRow[], category: string, currency: string, branch: string, direction: string): CompanyReportRow[] {
  return rows.filter(row => {
    if (branch && row.branchId !== branch) return false
    const cash = row.lines.filter(line => line.fundCode === `${category === 'custody' ? 'company_custody' : 'company_cash'}:${line.currency}` && parseMinor(line.netAmount) !== 0n)
    if (category === 'cash' && !cash.length) return false
    if (category === 'custody' && !cash.length) return false
    if (category === 'branch' && (!row.branchId || !cash.length)) return false
    if (category === 'cost_income' && (row.source === 'owner_outside' || !row.lines.some(line => line.fundCode.startsWith('company_expense:') || line.fundCode.startsWith('company_income:')))) return false
    if (category === 'expenses' && (row.source === 'owner_outside' || !row.lines.some(line => line.fundCode.startsWith('company_expense:')))) return false
    if (category === 'income' && !row.lines.some(line => line.fundCode.startsWith('company_income:'))) return false
    if (category === 'assets_debts' && !['asset_payment', 'debt_payment', 'asset_purchase', 'debt_open'].includes(row.kind)) return false
    if (category === 'unclassified' && (row.nature !== 'journal_only' || row.branchId || row.lines.some(line => line.fundCode.startsWith('company_expense:') || line.fundCode.startsWith('company_income:')))) return false
    if (direction === 'income' || direction === 'expenses') {
      if (!row.lines.some(line => line.fundCode.startsWith(direction === 'income' ? 'company_income:' : 'company_expense:') && parseMinor(line.netAmount) !== 0n && (!currency || line.currency === currency))) return false
    } else if (direction && !cash.some(line => line.side === (direction === 'receipts' ? 'D' : 'C') && (!currency || line.currency === currency))) return false
    return true
  }).map(row => currency ? { ...row, lines: row.lines.filter(line => line.currency === currency) } : row)
    .filter(row => !currency || row.lines.length > 0 || row.currency === currency && row.netAmount === '0.00')
}

/** Human-readable export; the separate audit CSV below retains all immutable technical evidence. */
export function companyReportSummaryCsv(report: CompanyReport, labels: {
  from: string; to: string; date: string; kind: string; branch: string; description: string; source: string;
  currency: string; receipts: string; payments: string; income: string; expense: string; posting: string; reference: string;
  currencyFilter: string; branchFilter: string; directionFilter: string
}, describe: (row: CompanyReportRow) => { kind: string; branch: string; source: string }, currencyName: (currency: Currency) => string): string {
  const header = [labels.from, labels.to, labels.date, labels.kind, labels.branch, labels.description, labels.source, labels.currency,
    labels.receipts, labels.payments, labels.income, labels.expense, labels.posting, labels.reference, labels.currencyFilter, labels.branchFilter, labels.directionFilter]
  const rows = report.rows.flatMap(row => {
    const info = describe(row), totals = companyReportTotals([row], report.detailCategory === 'custody' ? 'company_custody' : 'company_cash')
    const currencies = new Set(row.lines.map(line => line.currency))
    if (!currencies.size && row.currency) currencies.add(row.currency)
    return [...currencies].map(currency => [report.from, report.to, row.occurredPrecision === 'month' ? row.occurredMonth ?? row.occurredOn : row.occurredOn,
      info.kind, info.branch, row.description, info.source, currencyName(currency), totals[currency].cashReceipts ?? '', totals[currency].cashPayments ?? '',
      totals[currency].income, totals[currency].expense, row.latestPostingDate, row.externalReference ?? '', report.filters?.currency ?? '', report.filters?.branch ?? '', report.filters?.direction ?? ''])
  })
  return [header, ...rows].map(row => row.map(companyCsvCell).join(',')).join('\r\n')
}

/** Stable audit schema. One CSV row per money line: no exchange leg or non-cash book fact is lost. */
export function companyReportCsv(report: CompanyReport): string {
  const header = ['report_view', 'date_basis', 'period_semantics', 'period_from', 'period_to', 'generated_at_utc',
    'event_id', 'row_nature', 'kind', 'occurred_on', 'occurrence_precision', 'occurred_month', 'occurrence_source',
    'original_posting_date', 'latest_posting_date', 'canonical_command_id', 'active_command_id', 'original_entry_id',
    'active_entry_id', 'branch_source_entry_id', 'related_entry_ids', 'correction_ids', 'current_version', 'reversed',
    'operation_currency', 'operation_gross_amount', 'operation_net_amount', 'from_currency', 'from_gross_amount', 'from_net_amount', 'to_currency', 'to_gross_amount', 'to_net_amount',
    'payment_source', 'branch_id', 'frozen_syp_minor_per_usd', 'rate_basis', 'canonical_audit_reference', 'receipt_reference', 'description',
    'line_index', 'fund_code', 'line_currency', 'line_side', 'line_role', 'line_gross_amount', 'line_net_amount', 'line_signed_net_amount', 'detail_category', 'currency_filter', 'branch_filter', 'cash_direction_filter', 'audit_state']
  const rows = report.rows.flatMap(row => (row.lines.length ? row.lines : [null]).map((line, index) => {
    const signed = line ? formatMinor(minor(parseMinor(line.netAmount) * (line.side === 'D' ? 1n : -1n))) : ''
    return [report.view, report.dateBasis, report.periodSemantics, report.from, report.to, new Date(report.generatedAtMs).toISOString(),
      row.id, row.nature, row.kind, row.occurredOn, row.occurredPrecision, row.occurredMonth ?? '', row.occurrenceSource,
      row.postingDate, row.latestPostingDate, row.canonicalCommandId ?? '', row.activeCommandId ?? '', row.originalEntryId === null ? '' : String(row.originalEntryId),
      row.activeEntryId === null ? '' : String(row.activeEntryId), row.sourceEntryId === null ? '' : String(row.sourceEntryId), row.relatedEntryIds.join('|'), row.correctionIds.join('|'), String(row.version), String(row.reversed),
      row.currency ?? '', row.grossAmount ?? '', row.netAmount ?? '', row.fromCurrency ?? '', row.fromAmount ?? '', row.fromAmount === null ? '' : row.reversed ? '0.00' : row.fromAmount, row.toCurrency ?? '', row.toAmount ?? '', row.toAmount === null ? '' : row.reversed ? '0.00' : row.toAmount,
      row.source ?? '', row.branchId ?? '', row.sypMinorPerUsd ?? '', row.rateBasis ?? '', row.externalReference ?? '', row.receiptReference ?? '', row.description,
      line ? String(index + 1) : '', line?.fundCode ?? '', line?.currency ?? '', line?.side ?? '', line?.role ?? '', line?.grossAmount ?? '', line?.netAmount ?? '', signed, report.detailCategory ?? 'all', report.filters?.currency ?? '', report.filters?.branch ?? '', report.filters?.direction ?? '', row.auditState ?? '']
  }))
  return [header, ...rows].map(row => row.map(companyCsvCell).join(',')).join('\r\n')
}
