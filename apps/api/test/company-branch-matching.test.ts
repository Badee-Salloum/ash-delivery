import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { BRANCH, COMPANY_BRANCH, makeHarness, sypStr, type Harness } from './harness.ts'

let h: Harness
let admin: string
let manager: string
const post = (url: string, payload: Record<string, unknown>, token = admin) => h.app.inject({ method: 'POST', url, payload, headers: { cookie: h.cookie(token) } })
const get = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(admin) } })
const uuid = () => crypto.randomUUID()
beforeEach(async () => { h = await makeHarness(); admin = await h.loginAs('sysadmin'); manager = await h.loginAs('manager') })
afterEach(async () => { await h.app.close() })

describe('branch matching activates without manufacture of company cash', () => {
  it('freezes a nonzero starting discrepancy and source watermark, with no new journal', async () => {
    expect((await post('/company-fund/legacy-deposit', { idempotencyKey: uuid(), branchId: BRANCH,
      amount: '163558.26', reason: 'existing branch company account' })).statusCode).toBe(201)
    const before = structuredClone(h.deps.ledger.entries)
    const result = await post('/company/cutover', { branchId: BRANCH, expectedOpening: '163558.26', reason: 'link actual historic books' })
    expect(result.statusCode, result.body).toBe(201)
    expect(result.json()).toMatchObject({ mode: 'link_only', openingAmount: '163558.26', openingEntryId: null,
      baselineDifference: '163558.26', replayed: false })
    expect(h.deps.ledger.entries).toEqual(before)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(0n)
    const overview = await get('/company/overview')
    expect(overview.json().branches.find((row: { branchId: string }) => row.branchId === BRANCH)).toMatchObject({
      nameAr: 'دمشق', code: 'DAM', companyBox: '163558.26', clearing: '0.00', totalDifference: '163558.26',
      unexplainedDifference: '163558.26', settlementStatus: 'variance', pendingReviewCount: 0 })
    expect((await get('/company-fund')).json().branches.find((row: { branchId: string }) => row.branchId === BRANCH)).toMatchObject({
      nameAr: 'دمشق', code: 'DAM', companyBox: '163558.26', unexplainedDifference: '163558.26', settlementStatus: 'variance' })
  })

  it('does not label zero old books as matched before activation and checks concurrent retry intent', async () => {
    const unlinked = (await get('/company/overview')).json().branches.find((row: { branchId: string }) => row.branchId === BRANCH)
    expect(unlinked).toMatchObject({ settlementStatus: 'not_linked', balanced: false })
    const body = { branchId: BRANCH, expectedOpening: '0.00', reason: 'reviewed link point' }
    const results = await Promise.all([1, 2, 3].map(() => post('/company/cutover', body)))
    expect(results.map((row) => row.statusCode).sort()).toEqual([200, 200, 201])
    expect(await h.deps.companyLedger.listCutovers()).toHaveLength(1)
    expect(h.deps.ledger.entries.filter((row) => row.eventType === 'company_opening_transfer')).toHaveLength(0)
    expect((await post('/company/cutover', { ...body, reason: 'different intent' })).statusCode).toBe(409)
  })

  it('retains pending gross legs and count when their signed net is zero', async () => {
    await h.app.close(); h.app = await buildApp({ deps: h.deps, companyRestorationReviewEnabled: true, companyRestorationDirectPostingEnabled: false })
    expect((await post('/company/cutover', { branchId: BRANCH, expectedOpening: '0.00', reason: 'reviewed link point' })).statusCode).toBe(201)
    const targets = await h.app.inject({ method: 'PUT', url: '/treasury/capital-targets', headers: { cookie: h.cookie(manager) },
      payload: { cashTarget: '10000.00', walletTarget: '10000.00', reason: 'review targets' } })
    expect(targets.statusCode).toBe(200)
    for (const [fundCode, amount] of [['office_cash', 15000], ['office_wallet', 5000]] as const) {
      expect((await post('/journal/manual', { reason: 'seed live office', lines: [
        { fundCode, side: 'D', amount: sypStr(amount) }, { fundCode: 'opening_balance', side: 'C', amount: sypStr(amount) },
      ] }, manager)).statusCode).toBe(201)
    }
    expect((await post('/treasury/restoration', { idempotencyKey: uuid(), reason: 'actual offsetting sources' }, manager)).statusCode).toBe(201)
    const overview = (await get('/company/overview')).json().branches.find((row: { branchId: string }) => row.branchId === BRANCH)
    expect(overview).toMatchObject({ pendingReviewCount: 1, pendingRestorationDifference: '0.00',
      pendingToCompany: '5000.00', pendingFromCompany: '5000.00', settlementStatus: 'waiting_review' })
  })

  it('adopts an exact old run once without branch execution or HQ cash, then confirms HQ only', async () => {
    const targets = await h.app.inject({ method: 'PUT', url: '/treasury/capital-targets', headers: { cookie: h.cookie(manager) },
      payload: { cashTarget: '10000.00', walletTarget: '10000.00', reason: 'historical target' } })
    expect(targets.statusCode).toBe(200)
    for (const [fundCode, amount] of [['office_cash', 60000], ['office_wallet', 10000]] as const) {
      expect((await post('/journal/manual', { reason: 'actual office balances', lines: [
        { fundCode, side: 'D', amount: sypStr(amount) }, { fundCode: 'opening_balance', side: 'C', amount: sypStr(amount) },
      ] }, manager)).statusCode).toBe(201)
    }
    expect((await post('/treasury/restoration', { reason: 'old actual run' }, manager)).statusCode).toBe(201)
    const run = (await h.deps.restorations.list(BRANCH))[0]!
    expect((await post('/company/cutover', { branchId: BRANCH, expectedOpening: '50000.00', reason: 'link imported history' })).statusCode).toBe(201)
    await h.app.close(); h.app = await buildApp({ deps: h.deps, companyRestorationReviewEnabled: true })
    expect((await get('/company/overview')).json().branches.find((row: { branchId: string }) => row.branchId === BRANCH))
      .toMatchObject({ unlinkedHistoricalCount: 1, balanced: false })
    const preview = await get(`/company/restoration-reviews/adoption-preview/${run.id}`)
    expect(preview.statusCode, preview.body).toBe(200)
    const body = { id: uuid(), restorationId: run.id, reason: 'review existing run with source evidence', evidenceHash: preview.json().evidenceHash }
    const branchBefore = structuredClone(h.deps.ledger.entries.filter((row) => row.branchId === BRANCH))
    const adopted = await post('/company/restoration-reviews/adopt', { ...body, id: undefined, idempotencyKey: body.id })
    expect(adopted.statusCode, adopted.body).toBe(201)
    expect(adopted.json()).toMatchObject({ origin: 'historical', status: 'pending_review', originalNet: '50000.00' })
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(0n)
    expect((await post('/company/restoration-reviews/adopt', body)).statusCode).toBe(200)
    expect((await post('/company/restoration-reviews/adopt', { ...body, idempotencyKey: uuid() })).statusCode).toBe(409)
    expect((await post('/company/restoration-reviews/adopt', { ...body, id: uuid() })).statusCode).toBe(409)
    const confirmed = await post(`/company/restoration-reviews/${body.id}/confirm`, { id: uuid(), expectedVersion: 0, reason: 'cash receipt checked' })
    expect(confirmed.statusCode, confirmed.body).toBe(201)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(5_000_000n)
    expect(h.deps.ledger.entries.filter((row) => row.branchId === BRANCH)).toEqual(branchBefore)
  })

  it('shows stable imported restoration links as already linked and blocks a second proposal', async () => {
    expect((await post('/treasury/restoration', { reason: 'previous funded branch run' }, manager)).statusCode).toBe(201)
    const run = (await h.deps.restorations.list(BRANCH))[0]!
    const existingBranchAmount = await h.deps.ledger.fundBalance(BRANCH, 'company_box')
    const formatted = `${existingBranchAmount / 100n}.00`
    expect((await post('/company/cutover', { branchId: BRANCH, expectedOpening: formatted, reason: 'link actual old sources' })).statusCode).toBe(201)
    await h.app.close(); h.app = await buildApp({ deps: h.deps, companyRestorationReviewEnabled: true })
    h.deps.companyLedgerSource.listHistoricalImportReceipts = async () => [{ sourceReference: 'HQ-SRC-84', sourcePosition: 84,
      occurredOn: '2026-07-21', movementType: 'branch_payment', paidFrom: 'pocket', currency: 'SYP_NEW',
      amount: existingBranchAmount < 0n ? -existingBranchAmount as typeof existingBranchAmount : existingBranchAmount,
      description: 'Known audited source link', originalAmount: '', originalDescription: '', sourceFunding: 'company',
      originalDeltas: [0, 0, 0, 0], fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null,
      rateBasis: null, sypMinorPerUsd: null, sourceBranchId: BRANCH, journalEntryId: 999, branchJournalEntryId: null, restorationId: run.id }]
    const listing = await get('/company/restoration-reviews')
    expect(listing.json().linkedHistorical).toEqual(expect.arrayContaining([expect.objectContaining({ sourceReference: 'HQ-SRC-84', restorationId: run.id })]))
    expect(listing.json().unlinkedHistorical).toHaveLength(0)
    const before = structuredClone(h.deps.ledger.entries)
    const preview = await get(`/company/restoration-reviews/adoption-preview/${run.id}`)
    expect(preview.statusCode).toBe(409)
    expect(preview.json().error).toBe('restoration_source_already_linked')
    expect(h.deps.ledger.entries).toEqual(before)
  })

  it('activates reviewed restoration and HQ approval per branch while the global flag stays off', async () => {
    const legacy = await post('/treasury/restoration',{ reason: 'Unactivated branch still operates' },manager)
    expect(legacy.statusCode,legacy.body).toBe(201)
    expect(await h.deps.companyRestorationReviews.list(COMPANY_BRANCH)).toHaveLength(0)
    const amount = await h.deps.ledger.fundBalance(BRANCH,'company_box')
    expect((await post('/company/cutover',{ branchId: BRANCH,expectedOpening: `${amount/100n}.00`,reason: 'Reviewed-only activation point' })).statusCode).toBe(201)
    const listing = (await get('/company/restoration-reviews')).json()
    expect(listing.enabled).toBe(true)
    expect(listing.branches.find((row: { branchId: string })=>row.branchId===BRANCH).reviewEnabled).toBe(true)
    expect((await post('/journal/manual',{ reason: 'Actual new cash surplus',lines: [
      { fundCode: 'office_cash',side: 'D',amount: '5000.00' },{ fundCode: 'opening_balance',side: 'C',amount: '5000.00' },
    ] },manager)).statusCode).toBe(201)
    const before = structuredClone(h.deps.ledger.entries)
    expect((await post('/treasury/restoration',{ reason: 'UUID required after activation' },manager)).statusCode).toBe(422)
    expect(h.deps.ledger.entries).toEqual(before)
    const body = { idempotencyKey: uuid(),reason: 'Live branch restored, company still reviews' }
    const results = await Promise.all([1,2].map(()=>post('/treasury/restoration',body,manager)))
    expect(results.map(row=>row.statusCode).sort()).toEqual([200,201])
    const proposal = (await h.deps.companyRestorationReviews.list(COMPANY_BRANCH))[0]!
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH,'company_cash:SYP_NEW')).toBe(0n)
    const branchFacts = structuredClone(h.deps.ledger.entries.filter(row=>row.branchId===BRANCH))
    expect((await post(`/company/restoration-reviews/${proposal.id}/confirm`,{ id: uuid(),expectedVersion: 0,reason: 'Actual HQ receipt approved' })).statusCode).toBe(201)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH,'company_cash:SYP_NEW')).toBe(500000n)
    expect(h.deps.ledger.entries.filter(row=>row.branchId===BRANCH)).toEqual(branchFacts)
  })

  it('does not stop an unactivated branch when the global rollout flag is enabled', async () => {
    await h.app.close(); h.app = await buildApp({ deps: h.deps,companyRestorationReviewEnabled: true, companyRestorationDirectPostingEnabled: false })
    const result = await post('/treasury/restoration',{ reason: 'Branch has no activation marker yet' },manager)
    expect(result.statusCode,result.body).toBe(201)
    expect(await h.deps.companyRestorationReviews.list(COMPANY_BRANCH)).toHaveLength(0)
    const targets = await h.deps.capitalTargets.resolve(BRANCH,result.json().businessDate)
    expect(await h.deps.ledger.fundBalance(BRANCH,'office_cash')).toBe(targets.office_cash)
    expect(await h.deps.ledger.fundBalance(BRANCH,'office_wallet')).toBe(targets.office_wallet)
  })
})
