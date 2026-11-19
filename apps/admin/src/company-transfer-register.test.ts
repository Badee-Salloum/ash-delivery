import { describe, expect, it } from 'vitest'
import { companyReportRows, companyReportTotals, type CompanyReportRow } from './company-report.ts'
import { companyTransferRegister, transferPeriodTotals, type RestorationFeed } from './company-transfer-register.ts'

const row = (id: number, amount: string, side: 'D' | 'C' = 'D', overrides: Partial<CompanyReportRow> = {}): CompanyReportRow => ({
  id: `journal:${id}`, nature: 'business_event', kind: 'branch_receipt', occurredOn: '2026-09-12', occurredPrecision: 'day', occurredMonth: null,
  occurrenceSource: 'recorded', postingDate: '2026-09-12', latestPostingDate: '2026-09-12', canonicalCommandId: null, activeCommandId: null,
  originalEntryId: id, activeEntryId: id, sourceEntryId: null, relatedEntryIds: [id], correctionIds: [], version: 1, reversed: false,
  currency: 'SYP_NEW', grossAmount: amount, netAmount: amount, fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null,
  source: side === 'D' ? 'to_company' : 'from_company', branchId: 'DAM', description: 'Transfer', externalReference: null, receiptReference: null,
  sypMinorPerUsd: null, rateBasis: null, lines: [{ fundCode: 'company_cash:SYP_NEW', currency: 'SYP_NEW', side, grossAmount: amount, netAmount: amount, role: null },
    { fundCode: 'branch_clearing:DAM', currency: 'SYP_NEW', side: side === 'D' ? 'C' : 'D', grossAmount: amount, netAmount: amount, role: null }], ...overrides,
})
const feed: RestorationFeed = { proposals: [], linkedHistorical: [
  { restorationId: 4, branchId: 'DAM', journalEntryId: 11, occurredOn: '2026-09-12', amount: '5250.00', currency: 'SYP_NEW' },
  { restorationId: 4, branchId: 'DAM', journalEntryId: 12, occurredOn: '2026-09-13', amount: '100.00', currency: 'SYP_NEW' },
], historicalGroups: [{ restorationId: 4, branchId: 'DAM', businessDate: '2026-09-11', variance: '-38.00', branchSourceEntries: [
  { sourceEntryId: 5, direction: 'to_company', amount: '6000.00' }, { sourceEntryId: 6, direction: 'from_company', amount: '688.00' },
] }] }

describe('company transfer register', () => {
  it('groups an approved restoration once, retains each source date and excludes cash-neutral reclassification', () => {
    const correction = row(99, '5350.00', 'D', { kind: 'company_historical_restoration_reclass', lines: [{ fundCode: 'branch_clearing:DAM', currency: 'SYP_NEW', side: 'C', grossAmount: '5350.00', netAmount: '5350.00', role: null }] })
    const groups = companyTransferRegister([row(11, '5250.00'), row(12, '100.00', 'D', { occurredOn: '2026-09-13' }), correction], feed)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ branchDate: '2026-09-11', status: 'variance', variance: '-38.00' })
    expect(groups[0]!.company.map(leg => leg.date)).toEqual(['2026-09-12', '2026-09-13'])
    expect(groups[0]!.branch).toHaveLength(2)
    expect(transferPeriodTotals(groups, '2026-09-01', '2026-09-30').SYP_NEW).toEqual({ receipts: '5350.00', payments: '0.00', net: '5350.00' })
    expect(transferPeriodTotals(groups, '2026-09-13', '2026-09-13').SYP_NEW.receipts).toBe('100.00')
  })
  it('does not hide a zero-net pending restoration or count its gross directions as confirmed cash', () => {
    const groups = companyTransferRegister([], { proposals: [{ id: 'P', branchId: 'DAM', businessDate: '2026-09-12', status: 'pending_review', version: 1,
      legs: [{ sourceEntryId: 1, amount: '5000.00', direction: 'to_company' }, { sourceEntryId: 2, amount: '5000.00', direction: 'from_company' }] }] })
    expect(groups).toHaveLength(1); expect(groups[0]!.status).toBe('pending'); expect(groups[0]!.branch).toHaveLength(2)
    expect(transferPeriodTotals(groups, '2000-01-01', '2026-09-30').SYP_NEW.net).toBe('0.00')
  })
  it('does not infer matching merely from equal amounts or dates and keeps branch totals independent', () => {
    const groups = companyTransferRegister([row(1, '20.00'), row(2, '20.00', 'D', { branchId: 'HOM' })], { proposals: [] })
    expect(groups).toHaveLength(2); expect(groups.every(group => group.branch === null && group.variance === null)).toBe(true)
    expect(transferPeriodTotals(groups, '2000-01-01', '2026-09-30', 'DAM').SYP_NEW.receipts).toBe('20.00')
  })
  it('keeps the actual confirmation date for an approved zero, without fabricating a cash journal', () => {
    const zero = row(1, '0.00', 'D', { kind: 'company_restoration_mirror', canonicalCommandId: 'P', activeEntryId: null, originalEntryId: null, lines: [], occurredOn: '2026-09-20' })
    const groups = companyTransferRegister([zero], { proposals: [{ id: 'P', branchId: 'DAM', businessDate: '2026-09-11', status: 'confirmed', version: 1,
      legs: [{ sourceEntryId: 5, amount: '6.00', direction: 'to_company' }] }] })
    expect(groups[0]).toMatchObject({ confirmedOn: '2026-09-20', status: 'variance', variance: '6.00', company: [] })
    expect(transferPeriodTotals(groups, '2000-01-01', '2026-09-30').SYP_NEW.receipts).toBe('0.00')
  })
})

describe('filtered reporting definitions', () => {
  it('excludes non-cash reclassifications from the branch cash report', () => {
    const journal = row(10, '100.00', 'D', { kind: 'company_historical_restoration_reclass', lines: [] })
    const rows = companyReportRows([row(1, '50.00'), journal], 'branch', '', '', '')
    expect(rows).toHaveLength(1); expect(companyReportTotals(rows).SYP_NEW.cashReceipts).toBe('50.00')
  })
  it('filters currency at money-line level and totals fractional values exactly', () => {
    const exchange = row(1, '0.01', 'D', { currency: null, branchId: null, lines: [
      { fundCode: 'company_cash:SYP_NEW', currency: 'SYP_NEW', side: 'D', grossAmount: '0.01', netAmount: '0.01', role: null },
      { fundCode: 'company_cash:USD', currency: 'USD', side: 'C', grossAmount: '2.00', netAmount: '2.00', role: null },
    ] })
    const rows = companyReportRows([exchange, row(2, '90071992547409.91')], 'cash', 'SYP_NEW', '', 'receipts')
    const totals = companyReportTotals(rows)
    expect(totals.SYP_NEW.cashReceipts).toBe('90071992547409.92'); expect(totals.USD.cashPayments).toBe('0.00')
    expect(rows[0]!.lines).toHaveLength(1)
  })
  it('excludes external owner payments from company costs and drills into the contributing income rows', () => {
    const expense = row(1, '8.00', 'C', { source: 'pocket', lines: [{ fundCode: 'company_expense:rent', currency: 'SYP_NEW', side: 'D', grossAmount: '8.00', netAmount: '8.00', role: null }] })
    const owner = { ...expense, id: 'owner', source: 'owner_outside' }
    const income = row(2, '20.00', 'D', { lines: [{ fundCode: 'company_income:other', currency: 'SYP_NEW', side: 'C', grossAmount: '20.00', netAmount: '20.00', role: null }] })
    expect(companyReportRows([expense, owner, income], 'cost_income', '', '', '')).toHaveLength(2)
    const filtered = companyReportRows([expense, owner, income], 'cost_income', 'SYP_NEW', '', 'income')
    expect(filtered).toHaveLength(1); expect(companyReportTotals(filtered).SYP_NEW.income).toBe('20.00')
    expect(companyReportTotals(filtered).SYP_NEW.companyFundedExpense).toBe('0.00')
  })
})
