import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompanyHistoricalImportReceiptRecord } from '@ash/contracts'
import { BRANCH, COMPANY_BRANCH, makeHarness, sypStr, type Harness } from './harness.ts'
import { minor, parseMinor } from '@ash/domain'
import { todayFor } from '../src/shifts.service.ts'
// Cross-project parity is a runtime test, not a production dependency of the API's TS project.
const clientProjectionPath = '../../admin/src/company-report.ts'
const { companyReportTotals } = await import(clientProjectionPath)

let h: Harness, gm: string, categoryId: string
const request = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>, token = gm) =>
  h.app.inject({ method, url, headers: { cookie: h.cookie(token) }, ...(payload === undefined ? {} : { payload }) })
const history = (overrides: Record<string, unknown> = {}) => request('POST', '/company/historical-movements', {
  idempotencyKey: crypto.randomUUID(), type: 'expense', currency: 'SYP_NEW', amount: '20.00', categoryId,
  occurredOn: '2025-02-10', description: 'Historical receipt', ...overrides,
})
const report = async (query = '') => {
  const response = await request('GET', `/company/reports?from=2000-01-01&to=2026-07-28${query}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const ownerSource = (position: number, overrides: Partial<CompanyHistoricalImportReceiptRecord> = {}): CompanyHistoricalImportReceiptRecord => ({
  sourceReference: `HQ-SRC-${position}`, sourcePosition: position, occurredOn: '2026-06-01',
  movementType: 'expense', paidFrom: 'owner_outside', currency: 'SYP_NEW', amount: minor(600n),
  description: 'Verified owner payment', originalAmount: '600 old SYP', originalDescription: 'Verified owner payment',
  sourceFunding: 'جيب المالك', originalDeltas: [0, 0, 600, 0],
  fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null, rateBasis: null, sypMinorPerUsd: null,
  sourceBranchId: null, journalEntryId: null, branchJournalEntryId: null, restorationId: null, ...overrides,
})
beforeEach(async () => {
  h = await makeHarness({ companyRestorationReviewEnabled: true }); gm = await h.loginAs('gm')
  categoryId = crypto.randomUUID()
  await h.deps.expenses.createCategory({ id: categoryId, code: `REPORT-${categoryId}`, nameAr: 'مصروف', active: true })
})
afterEach(async () => { vi.restoreAllMocks(); await h.app.close() })

async function correct(targetId: string, values: Record<string, unknown>, expectedVersion = 1) {
  const draft = await request('POST', '/company/movement-corrections', { idempotencyKey: crypto.randomUUID(), targetId,
    expectedVersion, reason: 'Checked original receipt', values })
  expect(draft.statusCode, draft.body).toBe(201)
  const confirmed = await request('POST', `/company/movement-corrections/${draft.json().correction.id}/confirm`, {
    idempotencyKey: crypto.randomUUID(), expectedVersion: 1, acknowledgeCashEffect: true,
  })
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  return draft.json().correction.id as string
}
async function nextWeek() {
  h.deps.clock.advance(7 * 24 * 60 * 60 * 1000); gm = await h.loginAs('gm')
}

describe('explicit read-only company reporting', () => {
  it('reports exact gross cash receipts/payments, the real all-history start, and central scope', async () => {
    expect((await history({ type: 'deposit', categoryId: undefined, amount: '100.00', occurredOn: '2025-02-01' })).statusCode).toBe(201)
    expect((await history({ amount: '20.00', occurredOn: '2025-02-02' })).statusCode).toBe(201)
    expect((await history({ paidFrom: 'owner_outside', amount: '7.00', occurredOn: '2025-02-03' })).statusCode).toBe(201)
    const before = structuredClone(h.deps.ledger.entries)
    const response = await request('GET', `/company/reports?all=true&dateBasis=occurrence&view=current_corrected&branchId=${crypto.randomUUID()}`)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ scope: 'company_hq', from: '2025-02-01', availableFrom: '2025-02-01',
      cashBalances: { SYP_NEW: { opening: '0.00', closing: '80.00' }, USD: { opening: '0.00', closing: '0.00' } },
      totals: { SYP_NEW: { cashReceipts: '100.00', cashPayments: '20.00', cashNet: '80.00', income: '0.00', ownerOutsideExpense: '7.00' } } })
    expect(companyReportTotals(response.json().rows)).toEqual(response.json().totals)
    expect(h.deps.ledger.entries).toEqual(before)
    expect((await request('GET', '/company/reports?all=true&from=2025-01-01')).statusCode).toBe(422)
    expect((await request('GET', '/company/reports?unsupportedFilter=true')).statusCode).toBe(400)
  })

  it('reconciles opening + receipts - payments with closing for each view and date basis, without writing', async () => {
    await history({ type: 'deposit', categoryId: undefined, amount: '100.00', occurredOn: '2025-02-01' })
    const expense = await history({ amount: '20.00', occurredOn: '2025-02-02' })
    await correct(expense.json().command.id, { amount: '25.00', currency: 'SYP_NEW', paidFrom: 'owner_outside', description: 'Owner corrected', occurredOn: '2025-02-03', categoryId })
    const before = structuredClone(h.deps.ledger.entries)
    for (const view of ['as_booked', 'current_corrected']) for (const dateBasis of ['occurrence', 'posting']) {
      const result = await request('GET', `/company/reports?from=2025-02-02&to=${todayFor(h.deps)}&view=${view}&dateBasis=${dateBasis}`)
      expect(result.statusCode, result.body).toBe(200)
      const value = result.json()
      expect(companyReportTotals(value.rows)).toEqual(value.totals)
      for (const currency of ['SYP_NEW', 'USD']) {
        const cash = value.cashBalances[currency], total = value.totals[currency]
        expect(parseMinor(cash.opening) + parseMinor(total.cashReceipts) - parseMinor(total.cashPayments)).toBe(parseMinor(cash.closing))
      }
    }
    expect(h.deps.ledger.entries).toEqual(before)
  })

  it('includes early linked owner-to-branch source occurrences in all-history without importing them into HQ totals', async () => {
    const branchDeposit = await request('POST', '/treasury/deposit', { branchId: BRANCH,
      idempotencyKey: crypto.randomUUID(), target: 'cash', amount: '12.00', note: 'Existing owner-funded branch receipt' })
    expect(branchDeposit.statusCode, branchDeposit.body).toBe(201)
    const branchEntryId = h.deps.ledger.entries.find(entry => entry.branchId === BRANCH)!.id
    vi.spyOn(h.deps.companyLedgerSource, 'listHistoricalImportReceipts').mockResolvedValue([
      ownerSource(98, { occurredOn: '2026-05-01', movementType: 'branch_payment', amount: minor(1200n),
        sourceBranchId: BRANCH, branchJournalEntryId: branchEntryId }),
      ownerSource(10),
      ownerSource(11, { occurredOn: '2026-06-03', movementType: 'asset_payment', amount: minor(900n), currency: 'USD' }),
    ])
    expect((await history({ type: 'deposit', categoryId: undefined, amount: '100.00', occurredOn: '2026-07-20' })).statusCode).toBe(201)
    const before = structuredClone(h.deps.ledger.entries)
    for (const query of ['view=as_booked&dateBasis=posting', 'view=current_corrected&dateBasis=occurrence']) {
      const response = await request('GET', `/company/reports?all=true&${query}`)
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({ from: '2026-05-01', availableFrom: '2026-05-01',
        totals: { SYP_NEW: { cashReceipts: '100.00', cashPayments: '0.00', cashNet: '100.00', expense: '0.00', ownerOutsideExpense: '0.00' },
          USD: { cashNet: '0.00', expense: '0.00' } } })
      expect(response.json().rows).toHaveLength(1)
      const owners = await request('GET', `/company/owner-payments?from=${response.json().from}&to=${response.json().to}`)
      expect(owners.statusCode, owners.body).toBe(200)
      expect(owners.json()).toMatchObject({ combinedTotals: { SYP_NEW: '18.00', USD: '9.00' },
        branchFundingTotals: { SYP_NEW: '12.00', USD: '0.00' }, paymentCount: 3 })
    }
    // Explicit/custom/month ranges retain their requested bounds and financial semantics.
    const custom = await request('GET', '/company/reports?from=2026-07-01&to=2026-07-21')
    expect(custom.json()).toMatchObject({ from: '2026-07-01', availableFrom: '2026-07-21',
      totals: { SYP_NEW: { cashNet: '100.00' } } })
    const month = await request('GET', '/company/reports?from=2026-05-01&to=2026-05-31&dateBasis=occurrence')
    expect(month.json()).toMatchObject({ from: '2026-05-01', to: '2026-05-31', rows: [], totals: { SYP_NEW: { cashNet: '0.00' } } })
    expect(h.deps.ledger.entries).toEqual(before)
  })

  it('starts owner-only all-history at the imported month anchor even when no HQ journal exists', async () => {
    // A source known only as June is represented by 1 June, not a fabricated journal/posting.
    vi.spyOn(h.deps.companyLedgerSource, 'listHistoricalImportReceipts').mockResolvedValue([
      ownerSource(16, { occurredOn: '2026-06-01', movementType: 'asset_payment', currency: 'USD', amount: minor(900n) }),
    ])
    const before = structuredClone(h.deps.ledger.entries)
    const response = await request('GET', '/company/reports?all=true')
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ from: '2026-06-01', availableFrom: '2026-06-01', rows: [],
      totals: { SYP_NEW: { debits: '0.00', credits: '0.00', cashNet: '0.00', expense: '0.00' },
        USD: { debits: '0.00', credits: '0.00', cashNet: '0.00', expense: '0.00' } } })
    const owners = await request('GET', `/company/owner-payments?from=${response.json().from}&to=${response.json().to}`)
    expect(owners.json()).toMatchObject({ combinedTotals: { SYP_NEW: '0.00', USD: '9.00' }, paymentCount: 1 })
    expect(h.deps.ledger.entries).toEqual(before)
  })

  it('uses only active effective owner source dates and ignores invalid, future and out-of-scope evidence', async () => {
    vi.spyOn(h.deps.companyLedgerSource, 'listHistoricalImportReceipts').mockResolvedValue([
      ownerSource(1, { occurredOn: '2026-01-01' }),
      ownerSource(2, { occurredOn: '2026-07-11' }),
      ownerSource(3, { occurredOn: '2026-02-30' }),
      ownerSource(4, { occurredOn: 'not-a-date' }),
      ownerSource(5, { occurredOn: '1999-12-31' }),
      ownerSource(6, { occurredOn: '2026-07-22' }),
      ownerSource(7, { occurredOn: '2026-01-02', paidFrom: 'pocket' }),
      ownerSource(8, { occurredOn: '2026-01-03', movementType: 'branch_receipt' }),
      ownerSource(9, { occurredOn: '2026-01-04', amount: minor(0n) }),
    ])
    for (const [sourceReference, values] of [
      ['HQ-SRC-1', { excluded: true }], ['HQ-SRC-2', { occurredOn: '2026-06-01' }],
    ] as const) {
      const corrected = await request('POST', '/company/historical-source-corrections', {
        idempotencyKey: crypto.randomUUID(), sourceReference, expectedVersion: 1, reason: 'Verified source update',
        values, acknowledgeCashEffect: true,
      })
      expect(corrected.statusCode, corrected.body).toBe(201)
    }
    const before = structuredClone(h.deps.ledger.entries)
    for (const view of ['as_booked', 'current_corrected']) {
      const response = await request('GET', `/company/reports?all=true&view=${view}`)
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({ from: '2026-06-01', availableFrom: '2026-06-01', rows: [],
        totals: { SYP_NEW: { cashNet: '0.00', expense: '0.00' }, USD: { cashNet: '0.00', expense: '0.00' } } })
    }
    expect(h.deps.ledger.entries).toEqual(before)
  })
  it('preserves the old booked period and reports a current corrected event in exactly one posting bucket', async () => {
    const original = await history(); expect(original.statusCode, original.body).toBe(201)
    const week = await h.deps.weekLocks.create({ branchId: COMPANY_BRANCH, weekStartDate: '2026-07-19', weekEndDate: '2026-07-25', closedAtMs: null, closedBy: null })
    await h.deps.weekLocks.seal(week.id, original.json().command.createdBy, h.deps.clock.nowMs())
    await nextWeek()
    const correctionId = await correct(original.json().command.id, { amount: '35.00', paidFrom: 'owner_outside' })
    const before = structuredClone(h.deps.ledger.entries)
    const old = await request('GET', '/company/reports?from=2026-07-21&to=2026-07-21')
    expect(old.json()).toMatchObject({ view: 'as_booked', dateBasis: 'posting', totals: { SYP_NEW: { expense: '20.00', companyFundedExpense: '20.00', ownerOutsideExpense: '0.00' } } })
    const later = await request('GET', '/company/reports?from=2026-07-28&to=2026-07-28')
    expect(later.json()).toMatchObject({ totals: { SYP_NEW: { expense: '15.00', companyFundedExpense: '-20.00', ownerOutsideExpense: '35.00' } } })
    expect(later.json().rows).toHaveLength(2)
    expect(later.json().rows.every((row: { correctionIds: string[]; canonicalCommandId: string; externalReference: string }) =>
      row.correctionIds.includes(correctionId) && row.canonicalCommandId === original.json().command.id && row.externalReference === original.json().externalReference)).toBe(true)
    const current = await request('GET', '/company/reports?from=2026-07-21&to=2026-07-21&view=current_corrected')
    expect(current.json().rows).toHaveLength(1)
    expect(current.json()).toMatchObject({ periodSemantics: 'current_snapshot_original_posting_anchor', totals: { SYP_NEW: { expense: '35.00', cashNet: '0.00', ownerOutsideExpense: '35.00' } },
      rows: [{ version: 2, postingDate: '2026-07-21', latestPostingDate: '2026-07-28', grossAmount: '35.00', netAmount: '35.00', externalReference: original.json().externalReference, correctionIds: [correctionId] }] })
    const currentLater = await request('GET', '/company/reports?from=2026-07-28&to=2026-07-28&view=current_corrected')
    expect(currentLater.json().rows).toEqual([])
    expect(h.deps.ledger.entries).toEqual(before)
    expect((await request('GET', '/company/movements?from=2026-07-28&to=2026-07-28')).json().movements).toHaveLength(2)
  })

  it('groups raw original occurrence separately from a metadata-corrected current occurrence', async () => {
    const original = await history(); expect(original.statusCode).toBe(201)
    await correct(original.json().command.id, { occurredOn: '2025-03-02', description: 'Corrected receipt date only' })
    const raw = await request('GET', '/company/reports?from=2025-02-01&to=2025-02-28&dateBasis=occurrence')
    expect(raw.json().rows).toHaveLength(1); expect(raw.json().rows[0].occurredOn).toBe('2025-02-10')
    const currentFeb = await request('GET', '/company/reports?from=2025-02-01&to=2025-02-28&dateBasis=occurrence&view=current_corrected')
    expect(currentFeb.json().rows).toEqual([])
    const currentMarch = await request('GET', '/company/reports?from=2025-03-01&to=2025-03-31&dateBasis=occurrence&view=current_corrected')
    expect(currentMarch.json().rows).toHaveLength(1)
    expect(currentMarch.json().rows[0]).toMatchObject({ occurredOn: '2025-03-02', version: 2, description: 'Corrected receipt date only' })
    expect(h.deps.ledger.entries).toHaveLength(1)
  })

  it('retains month precision and both actual exchange currencies with every frozen raw money line', async () => {
    const opening = await history({ type: 'deposit', currency: 'USD', amount: '100.00', historicalRate: '165.25', categoryId: undefined, description: 'USD opening',
      occurredOn: '2025-06-01', occurredPrecision: 'month', occurredMonth: '2025-06', rateBasis: 'estimated' })
    expect(opening.statusCode, opening.body).toBe(201)
    const fx = await request('POST', '/company/historical-movements', { idempotencyKey: crypto.randomUUID(), type: 'exchange', occurredOn: '2025-06-20', fromCurrency: 'USD', fromAmount: '10.00', toCurrency: 'SYP_NEW', toAmount: '1652.50', description: 'Actual exchange' })
    expect(fx.statusCode, fx.body).toBe(201)
    const selected = await request('GET', '/company/reports?from=2025-06-15&to=2025-06-30&dateBasis=occurrence')
    expect(selected.json().rows).toHaveLength(2)
    expect(selected.json().rows[0]).toMatchObject({ occurredPrecision: 'month', occurredMonth: '2025-06', sypMinorPerUsd: '16525', rateBasis: 'estimated' })
    expect(selected.json().rows[1]).toMatchObject({ fromCurrency: 'USD', fromAmount: '10.00', toCurrency: 'SYP_NEW', toAmount: '1652.50', sypMinorPerUsd: '16525' })
    expect(selected.json().rows[1].lines).toHaveLength(4)
    expect(selected.json().rows[1].lines.map((line: { grossAmount: string }) => line.grossAmount)).toEqual(['10.00', '10.00', '1652.50', '1652.50'])
  })

  it('removes deleted expenses from current rows and totals, retaining original and cancellation in audit only', async () => {
    const original = await history({ paidFrom: 'owner_outside' }); expect(original.statusCode).toBe(201)
    const reversed = await request('POST', '/company/reversals', { idempotencyKey: crypto.randomUUID(), targetId: original.json().command.id, targetKind: 'expense', reason: 'Cancelled receipt' })
    expect(reversed.statusCode, reversed.body).toBe(201)
    await nextWeek()
    const selected = await report('&view=current_corrected')
    expect(selected.rows).toHaveLength(0)
    expect(selected.totals.SYP_NEW.expense).toBe('0.00')
    const raw = await report(); expect(raw.rows).toHaveLength(2); expect(raw.totals.SYP_NEW.expense).toBe('0.00')
    expect(raw.rows.map((row: { auditState: string }) => row.auditState)).toEqual(['deleted_expense', 'expense_deletion'])
  })

  it('excludes pending restoration proposals and collapses confirmed HQ revisions without changing the branch', async () => {
    const manager = await h.loginAs('manager'), admin = await h.loginAs('sysadmin')
    expect((await request('POST', '/company/cutover', { branchId: BRANCH, expectedOpening: '0.00', reason: 'Reviewed cutover' }, admin)).statusCode).toBe(201)
    expect((await request('PUT', '/treasury/capital-targets', { cashTarget: sypStr(10000), walletTarget: '0.00', reason: 'Targets' }, manager)).statusCode).toBe(200)
    expect((await request('POST', '/journal/manual', { reason: 'Branch funds', lines: [{ fundCode: 'office_cash', side: 'D', amount: sypStr(60000) }, { fundCode: 'opening_balance', side: 'C', amount: sypStr(60000) }] }, manager)).statusCode).toBe(201)
    const restoration = await request('POST', '/treasury/restoration', { idempotencyKey: crypto.randomUUID(), reason: 'Executed branch restoration' }, manager)
    expect(restoration.statusCode, restoration.body).toBe(201)
    const pending = await request('GET', '/company/reports?from=2000-01-01&to=2026-07-21&view=current_corrected')
    expect(pending.json()).toMatchObject({ rows: [], pendingRestorationCount: 1 })
    const proposalId = restoration.json().proposalId, proposal = (await h.deps.companyRestorationReviews.get(proposalId))!
    const sourceEntryId = proposal.legs[0]!.sourceEntryId
    const branchFacts = structuredClone(h.deps.ledger.entries.filter(entry => entry.branchId === BRANCH))
    expect((await request('POST', `/company/restoration-reviews/${proposalId}/confirm`, { id: crypto.randomUUID(), expectedVersion: 0, reason: 'Actual receipt' })).statusCode).toBe(201)
    await nextWeek()
    expect((await request('POST', `/company/restoration-reviews/${proposalId}/correct`, { id: crypto.randomUUID(), expectedVersion: 1, reason: 'Count correction', confirmedLegs: [{ sourceEntryId, amount: sypStr(45000) }] })).statusCode).toBe(201)
    const current = await report('&view=current_corrected')
    expect(current.rows).toHaveLength(1)
    expect(current.rows[0]).toMatchObject({ grossAmount: sypStr(45000), sourceEntryId, postingDate: '2026-07-21', latestPostingDate: '2026-07-28', version: 2 })
    expect(current.totals.SYP_NEW.cashNet).toBe(sypStr(45000))
    const raw = await report(); expect(raw.rows).toHaveLength(3); expect(raw.totals.SYP_NEW.cashNet).toBe(sypStr(45000))
    expect(h.deps.ledger.entries.filter(entry => entry.branchId === BRANCH)).toEqual(branchFacts)
  })

  it('retains other book facts with explicit posting fallback rather than fabricating an occurrence date', async () => {
    expect((await request('POST', '/company/debts', { idempotencyKey: crypto.randomUUID(), direction: 'payable', partyName: 'Known supplier', currency: 'SYP_NEW', principal: '50.00', openedOn: '2025-03-04', origin: 'expense', expenseCategoryId: categoryId, costCenterKind: 'general', note: 'Prior supplier receipt' })).statusCode).toBe(201)
    await nextWeek()
    const selected = await report('&view=current_corrected&dateBasis=occurrence')
    expect(selected.rows).toHaveLength(1)
    expect(selected.rows[0]).toMatchObject({ nature: 'journal_only', occurredOn: '2025-03-04', occurrenceSource: 'recorded' })
    expect(selected.totals.SYP_NEW).toMatchObject({ otherBookExpense: '50.00', companyFundedExpense: '0.00', cashNet: '0.00' })
  })

  it('rejects invalid views/date bases, future and reversed ranges, and enforces permission', async () => {
    const manager = await h.loginAs('manager')
    expect((await request('GET', '/company/reports', undefined, manager)).statusCode).toBe(403)
    expect((await request('GET', '/company/reports?view=unknown')).statusCode).toBe(400)
    expect((await request('GET', '/company/reports?dateBasis=unknown')).statusCode).toBe(400)
    expect((await request('GET', '/company/reports?from=2026-07-21&to=2026-07-22')).statusCode).toBe(422)
    expect((await request('GET', '/company/reports?from=2026-07-21&to=2026-07-20')).statusCode).toBe(422)
    expect((await request('GET', '/company/reports?from=1999-12-31')).statusCode).toBe(400)
    expect((await request('GET', '/company/reports')).json()).toMatchObject({ view: 'as_booked', dateBasis: 'posting', historicalBookCostPolicy: 'not_reclassified', ownerInformation: { dateBasis: 'occurrence', separateFromHqCash: true } })
  })

  it('marks missing occurrence evidence explicitly and retains every non-command journal line', async () => {
    h.deps.ledger.entries.push({ id: 70, branchId: COMPANY_BRANCH, shiftId: null, eventType: 'depreciation_transfer',
      occurrenceKey: 'report-fallback-only', externalReference: null, businessDate: '2026-07-21', postingDate: '2026-07-21',
      weekStartDate: '2026-07-19', fxDayId: 1, sypMinorPerUsd: null, weekLockId: null, reason: 'Legacy book fact without occurrence receipt',
      createdBy: 'gm', createdAtMs: h.deps.clock.nowMs(), lines: [
        { fundCode: 'company_cash:SYP_NEW', currency: 'SYP_NEW', side: 'C', amount: minor(1000n) },
        { fundCode: 'depreciation_reserve:SYP_NEW', currency: 'SYP_NEW', side: 'D', amount: minor(1000n) },
      ] })
    const before = structuredClone(h.deps.ledger.entries)
    const response = await request('GET', '/company/reports?from=2026-07-21&to=2026-07-21&dateBasis=occurrence&view=current_corrected')
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ occurrenceFallbackCount: 1, journalOnlyCount: 1, rows: [{ occurrenceSource: 'posting_fallback', occurredOn: '2026-07-21', nature: 'journal_only', lines: [{ grossAmount: '10.00', netAmount: '10.00' }, { grossAmount: '10.00', netAmount: '10.00' }] }],
      totals: { SYP_NEW: { cashNet: '-10.00', income: '0.00', expense: '0.00' } } })
    expect(h.deps.ledger.entries).toEqual(before)
  })

  it('presents pre-platform branch transfers as dated business events rather than anonymous journals', async () => {
    h.deps.ledger.entries.push({ id: 71, branchId: COMPANY_BRANCH, shiftId: null,
      eventType: 'company_historical_transfer', occurrenceKey: 'f5e28d77-7e26-4e2b-9817-8d5489b8d2fa',
      externalReference: 'HQ-SRC-23', businessDate: '2026-07-21', postingDate: '2026-07-21',
      weekStartDate: '2026-07-19', fxDayId: 1, sypMinorPerUsd: null, weekLockId: null,
      reason: 'كييش من الفرع، دون إعادة قيد الفرع', createdBy: 'gm', createdAtMs: h.deps.clock.nowMs(), lines: [
        { fundCode: 'company_cash:SYP_NEW', currency: 'SYP_NEW', side: 'D', amount: minor(708000n), role: 'historical_branch_transfer' },
        { fundCode: `historical_branch_transit:${BRANCH}`, currency: 'SYP_NEW', side: 'C', amount: minor(708000n), role: 'historical_branch_transfer' },
      ] })
    const selected = await request('GET', '/company/reports?from=2026-07-21&to=2026-07-21&dateBasis=occurrence')
    expect(selected.statusCode, selected.body).toBe(200)
    expect(selected.json()).toMatchObject({ occurrenceFallbackCount: 0, journalOnlyCount: 0,
      totals: { SYP_NEW: { cashNet: '7080.00', income: '0.00', expense: '0.00' } },
      rows: [{ nature: 'business_event', kind: 'branch_receipt', occurredOn: '2026-07-21',
        branchId: BRANCH, source: 'to_company', currency: 'SYP_NEW', grossAmount: '7080.00',
        externalReference: 'HQ-SRC-23' }] })
  })
})
