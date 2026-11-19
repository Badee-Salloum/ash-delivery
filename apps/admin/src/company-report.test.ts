import { describe, expect, it } from 'vitest'
import { companyReportCsv, companyReportRows, companyReportTotals, type CompanyReport, type CompanyReportRow } from './company-report.ts'

const row: CompanyReportRow = {
  id: 'command:original', nature: 'business_event', kind: 'exchange', occurredOn: '2025-06-20', occurredPrecision: 'day', occurredMonth: null,
  occurrenceSource: 'recorded', postingDate: '2026-07-21', latestPostingDate: '2026-07-28', canonicalCommandId: 'original', activeCommandId: 'replacement',
  originalEntryId: 17, activeEntryId: 21, sourceEntryId: null, relatedEntryIds: [17, 20, 21], correctionIds: ['correction-1'], version: 2, reversed: false,
  currency: null, grossAmount: null, netAmount: null, fromCurrency: 'USD', fromAmount: '10.00', toCurrency: 'SYP_NEW', toAmount: '1652.50',
  source: null, branchId: null, description: '=HYPERLINK("https://invalid.example")', externalReference: 'HQ-HIST-ORIGINAL', receiptReference: 'receipt-9',
  sypMinorPerUsd: '16525', rateBasis: 'estimated', lines: [
    { fundCode: 'company_fx_position:USD', currency: 'USD', side: 'D', role: 'fx_sold', grossAmount: '10.00', netAmount: '10.00' },
    { fundCode: 'company_cash:USD', currency: 'USD', side: 'C', role: 'fx_paid', grossAmount: '10.00', netAmount: '10.00' },
    { fundCode: 'company_cash:SYP_NEW', currency: 'SYP_NEW', side: 'D', role: 'fx_received', grossAmount: '1652.50', netAmount: '1652.50' },
    { fundCode: 'company_fx_position:SYP_NEW', currency: 'SYP_NEW', side: 'C', role: 'fx_bought', grossAmount: '1652.50', netAmount: '1652.50' },
  ],
}
const report: CompanyReport = { from: '2025-06-01', to: '2025-06-30', view: 'current_corrected', dateBasis: 'occurrence', generatedAtMs: 0,
  periodSemantics: 'current_snapshot_original_posting_anchor', historicalBookCostPolicy: 'not_reclassified',
  totals: { SYP_NEW: { debits: '1652.50', credits: '1652.50', cashNet: '1652.50', income: '0.00', expense: '0.00', companyFundedExpense: '0.00', ownerOutsideExpense: '0.00', otherBookExpense: '0.00' },
    USD: { debits: '10.00', credits: '10.00', cashNet: '-10.00', income: '0.00', expense: '0.00', companyFundedExpense: '0.00', ownerOutsideExpense: '0.00', otherBookExpense: '0.00' } },
  rows: [row], occurrenceFallbackCount: 0, journalOnlyCount: 0, pendingRestorationCount: 0,
}
const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1]!.replaceAll('""', '"'))
const parsed = (value: string) => { const [header, ...lines] = value.split('\r\n').map(cells); return lines.map(line => Object.fromEntries(header!.map((key, index) => [key, line[index]]))) }

describe('company report audit CSV', () => {
  it('keeps custody payments company-funded and reports custody rather than pocket movements', () => {
    const custodyRow = { ...row, kind: 'expense', source: 'owner_custody', currency: 'USD' as const, lines: [
      { fundCode: 'company_expense:USD:general', currency: 'USD' as const, side: 'D' as const, role: 'expense_cost', grossAmount: '5.00', netAmount: '5.00' },
      { fundCode: 'company_custody:USD', currency: 'USD' as const, side: 'C' as const, role: 'expense_paid', grossAmount: '5.00', netAmount: '5.00' },
    ] }
    expect(companyReportTotals([custodyRow]).USD).toMatchObject({ companyFundedExpense: '5.00', otherBookExpense: '0.00', ownerOutsideExpense: '0.00', cashNet: '0.00' })
    expect(companyReportTotals([custodyRow], 'company_custody').USD.cashNet).toBe('-5.00')
    expect(companyReportRows([custodyRow], 'custody', '', '', '')).toHaveLength(1)
  })
  it('exports every raw money line with explicit view/date basis, signed net, both exchange amounts and correction identity', () => {
    const data = parsed(companyReportCsv(report))
    expect(data).toHaveLength(4)
    expect(data[0]).toMatchObject({ report_view: 'current_corrected', date_basis: 'occurrence', original_posting_date: '2026-07-21', latest_posting_date: '2026-07-28',
      canonical_command_id: 'original', active_command_id: 'replacement', related_entry_ids: '17|20|21', correction_ids: 'correction-1',
      frozen_syp_minor_per_usd: '16525', rate_basis: 'estimated', canonical_audit_reference: 'HQ-HIST-ORIGINAL',
      from_currency: 'USD', from_gross_amount: '10.00', to_currency: 'SYP_NEW', to_gross_amount: '1652.50' })
    expect(data.map(line => line.line_signed_net_amount)).toEqual(['10.00', '-10.00', '1652.50', '-1652.50'])
    expect(data[0]!.description).toBe('\'=HYPERLINK("https://invalid.example")')
    expect(data.every(line => line.line_gross_amount === line.line_net_amount)).toBe(true)
  })
  it('records the detail category in every row of a filtered full-result export', () => {
    const data = parsed(companyReportCsv({ ...report, detailCategory: 'cash' }))
    expect(data.every(line => line.detail_category === 'cash')).toBe(true)
    expect(parsed(companyReportCsv(report)).every(line => line.detail_category === 'all')).toBe(true)
  })
  it('retains gross evidence but zeros every net leg of a reversed current exchange', () => {
    const data = parsed(companyReportCsv({ ...report, rows: [{ ...row, reversed: true, lines: row.lines.map(line => ({ ...line, netAmount: '0.00' })) }] }))
    expect(data.every(line => line.reversed === 'true' && line.from_net_amount === '0.00' && line.to_net_amount === '0.00' && line.line_net_amount === '0.00' && line.line_signed_net_amount === '0.00')).toBe(true)
    expect(data[1]!.line_gross_amount).toBe('10.00')
  })
  it('exports a zero confirmation without inventing an HQ entry from the branch source identity', () => {
    const data = parsed(companyReportCsv({ ...report, rows: [{ ...row, kind: 'company_restoration_mirror', originalEntryId: null, activeEntryId: null, sourceEntryId: 117,
      lines: [], currency: 'SYP_NEW', grossAmount: '0.00', netAmount: '0.00', relatedEntryIds: [], fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null }] }))
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ original_entry_id: '', active_entry_id: '', branch_source_entry_id: '117', operation_net_amount: '0.00', fund_code: '' })
  })
})
