import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { minor } from '@ash/domain'
import type { CompanyHistoricalImportReceiptRecord } from '@ash/contracts'
import { BRANCH, makeHarness, type Harness } from './harness.ts'

let h: Harness, gm: string
beforeEach(async () => { h = await makeHarness(); gm = await h.loginAs('gm') })
afterEach(async () => { await h.app.close() })
const get = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(gm) } })

const evidence: CompanyHistoricalImportReceiptRecord[] = [
  { sourceReference: 'HQ-SRC-1', sourcePosition: 1, occurredOn: '2026-04-22', movementType: 'expense',
    paidFrom: 'owner_outside', currency: 'USD', amount: minor(210000n), description: 'إيجار من جيب المالك',
    originalAmount: '2,100$', originalDescription: 'إيجار', sourceFunding: 'جيب المالك', originalDeltas: [0,0,0,2100],
    fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null, rateBasis: 'estimated',
    sypMinorPerUsd: 13300n, sourceBranchId: null, journalEntryId: null, branchJournalEntryId: null, restorationId: null },
  { sourceReference: 'HQ-SRC-23', sourcePosition: 23, occurredOn: '2026-07-21', movementType: 'branch_receipt',
    paidFrom: 'pocket', currency: 'SYP_NEW', amount: minor(708000n), description: 'كييش من الفرع',
    originalAmount: '708,000 ل.س', originalDescription: 'كييش', sourceFunding: 'صندوق الشركة', originalDeltas: [708000,0,0,0],
    fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null, rateBasis: null,
    sypMinorPerUsd: null, sourceBranchId: BRANCH, journalEntryId: 70, branchJournalEntryId: null, restorationId: null },
]

describe('final historical source register', () => {
  it('shows every accepted source row and computes only HQ cash columns into the running balance', async () => {
    h.deps.companyLedgerSource.listHistoricalImportReceipts = async () => evidence
    const result = await get('/company/historical-imports')
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ balanceBasis: 'original_source_as_booked',
      sourceClosing: { SYP_NEW: '7080.00', USD: '0.00' },
      rows: [{ sourceReference: 'HQ-SRC-1', amount: '2100.00', financialStatus: 'owner_direct_outside_company_books',
        balanceAfter: { SYP_NEW: '0.00', USD: '0.00' } },
      { sourceReference: 'HQ-SRC-23', financialStatus: 'posted_financial_day',
        balanceAfter: { SYP_NEW: '7080.00', USD: '0.00' } }] })
    const owner = await get('/company/owner-payments')
    expect(owner.statusCode, owner.body).toBe(200)
    expect(owner.json()).toMatchObject({ totals: { USD: '2100.00' }, historicalOwnerPaymentsOutsideCompanyPnl: true,
      payments: [{ externalReference: 'HQ-SRC-1', companyCashEffect: '0.00', companyPnlEffect: '0.00' }] })
  })

  it('filters by real occurrence date, movement type and source reference without changing the closing control', async () => {
    h.deps.companyLedgerSource.listHistoricalImportReceipts = async () => evidence
    const result = await get('/company/historical-imports?from=2026-07-01&to=2026-07-21&type=branch_receipt&reference=SRC-23')
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().rows).toHaveLength(1)
    expect(result.json().sourceClosing).toEqual({ SYP_NEW: '7080.00', USD: '0.00' })
  })
})
