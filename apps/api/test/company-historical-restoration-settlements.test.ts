import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompanyHistoricalImportReceiptRecord, CompanyHistoricalRestorationSettlement, JournalEntryRecord } from '@ash/contracts'
import { type CalendarDate, type Posting, historicalBranchTransfer, manualKaish, minor, reverse, weekStartFor } from '@ash/domain'
import { BRANCH, COMPANY_BRANCH, OTHER_BRANCH, makeHarness, type Harness } from './harness.ts'

let h: Harness
let gm: string
let sources: CompanyHistoricalImportReceiptRecord[]
let runId: number
let branchEntries: JournalEntryRecord[]
let companyEntries: JournalEntryRecord[]
const DAY: CalendarDate = '2026-07-20'
const BASE = '/company/historical-restoration-settlements'
const request = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, token = gm) =>
  h.app.inject({ method, url, headers: { cookie: h.cookie(token) }, ...(payload ? { payload } : {}) })
const preview = async () => {
  const response = await request('GET', `${BASE}/preview?branchId=${BRANCH}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const intent = (snapshot: Awaited<ReturnType<typeof preview>>, overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: crypto.randomUUID(), branchId: BRANCH, expectedVersion: snapshot.version,
  evidenceHash: snapshot.evidenceHash, reason: 'Reviewed each original receipt and both branch source legs',
  reviewedLinks: true, ...overrides,
})
const meta = (day = DAY, externalReference?: string) => ({ shiftId: null, businessDate: day, postingDate: day,
  weekStartDate: weekStartFor(day), fxDayId: 1, sypMinorPerUsd: null, createdBy: 'u-gm',
  reason: 'Immutable historical fixture', ...(externalReference ? { externalReference } : {}) })
const branchPosting = (office: 'office_cash' | 'office_wallet', direction: 'to_company' | 'from_company', amount: bigint): Posting => ({
  eventType: 'restoration', occurrenceKey: `restoration-fixture-${office}-${crypto.randomUUID()}`,
  lines: [{ fund: { kind: 'company_box' }, side: direction === 'to_company' ? 'D' : 'C', amount: minor(amount) },
    { fund: { kind: office }, side: direction === 'to_company' ? 'C' : 'D', amount: minor(amount) }],
})
const noncash = () => h.deps.ledger.entries.filter(entry => entry.eventType === 'company_historical_restoration_reclass')
const funds = async () => Object.fromEntries(await Promise.all([
  [COMPANY_BRANCH, 'company_cash:SYP_NEW'], [COMPANY_BRANCH, 'company_cash:USD'],
  [COMPANY_BRANCH, 'company_expense:SYP_NEW:general'], [COMPANY_BRANCH, 'company_income:SYP_NEW:general'],
  [COMPANY_BRANCH, 'company_equity:SYP_NEW:owner_funding'], [COMPANY_BRANCH, 'depreciation_reserve:SYP_NEW'],
  [BRANCH, 'company_box'], [BRANCH, 'office_cash'], [BRANCH, 'office_wallet'],
].map(async ([branch, fund]) => [`${branch}|${fund}`, await h.deps.ledger.fundBalance(branch!, fund!)])))

beforeEach(async () => {
  h = await makeHarness({ companyRestorationReviewEnabled: false })
  gm = await h.loginAs('gm')
  await h.deps.fx.upsert({ businessDate: DAY, sypMinorPerUsd: 13_000n, provisional: false })
  branchEntries = await h.deps.ledger.post(BRANCH, [
    branchPosting('office_cash', 'to_company', 20_000n), branchPosting('office_wallet', 'from_company', 10_000n),
  ], meta())
  runId = await h.deps.restorations.create({ branchId: BRANCH, businessDate: DAY, cashCountId: null,
    plan: { schemaVersion: 4, restorationJournalEntryIds: branchEntries.map(entry => entry.id) },
    netToCompany: minor(10_000n), reason: 'One executed restoration, opposing office legs', performedBy: 'u-gm', runNo: 1 })
  companyEntries = []
  sources = []
  for (const [position, amount] of [[79, 7_500n], [80, 1_874n]] as const) {
    const sourceReference = `HQ-SRC-${position}`
    const [entry] = await h.deps.ledger.post(COMPANY_BRANCH,
      [historicalBranchTransfer('to_company', minor(amount), BRANCH, `historical-${position}`)], meta(DAY, sourceReference))
    companyEntries.push(entry!)
    sources.push({ sourceReference, sourcePosition: position, occurredOn: DAY, movementType: 'branch_receipt',
      paidFrom: 'pocket', currency: 'SYP_NEW', amount: minor(amount), description: `Original source ${position}`,
      originalAmount: `${amount} minor units`, originalDescription: `Original source ${position}`,
      sourceFunding: 'صندوق الشركة', originalDeltas: [Number(amount), 0, 0, 0], fromCurrency: null, fromAmount: null,
      toCurrency: null, toAmount: null, rateBasis: null, sypMinorPerUsd: null, sourceBranchId: BRANCH,
      journalEntryId: entry!.id, branchJournalEntryId: null, restorationId: runId,
      linkStatus: 'probable_amount_date', linkNote: 'Original import relationship requires explicit human review' })
  }
  const balance = await h.deps.ledger.fundBalance(BRANCH, 'company_box')
  await h.deps.companyLedger.createCutover({ branchId: BRANCH, companyBranchId: COMPANY_BRANCH,
    openingAmount: balance, openingEntryId: null, mode: 'link_only', baselineDifference: balance,
    watermarkEntryId: await h.deps.companyLedger.latestEntryId(), businessDate: '2026-07-21',
    reason: 'Immutable cash-neutral historical transition', performedBy: 'u-gm', performedAtMs: h.deps.clock.nowMs() })
  vi.spyOn(h.deps.companyLedgerSource, 'listHistoricalImportReceipts').mockImplementation(async () => structuredClone(sources))
})
afterEach(async () => { vi.restoreAllMocks(); await h.app.close() })

describe('protected noncash historical restoration reclassification', () => {
  it('previews whole multi-source groups and opposing branch legs by net, while retaining gross source counts and provenance', async () => {
    const before = structuredClone(h.deps.ledger.entries)
    const snapshot = await preview()
    expect(snapshot).toMatchObject({ eligible: true, version: 0, blockingReasons: [],
      counts: { sourceCount: 2, hqJournalCount: 2, branchSourceCount: 2, groupCount: 1 },
      totals: { currency: 'SYP_NEW', hqNet: '93.74', branchNet: '100.00', amountDifference: '6.26' },
      plan: { before: { historicalTransit: '-93.74', clearing: '0.00', matchingDifference: '100.00' },
        after: { historicalTransit: '0.00', clearing: '-93.74', matchingDifference: '6.26' } },
      impacts: { companyCash: { SYP_NEW: '0.00', USD: '0.00' }, branchCash: { SYP_NEW: '0.00', USD: '0.00' },
        pnl: { SYP_NEW: '0.00', USD: '0.00' } }, unlinkedHistoricalCount: 0 })
    expect(snapshot.groups[0]).toMatchObject({ restorationId: runId, branchEntryIds: branchEntries.map(entry => entry.id),
      sourceReferences: ['HQ-SRC-79', 'HQ-SRC-80'], hqEntryIds: companyEntries.map(entry => entry.id), variance: '6.26' })
    expect(snapshot.groups[0].sources[0]).toMatchObject({ linkStatus: 'probable_amount_date',
      linkNote: 'Original import relationship requires explicit human review' })
    expect(h.deps.ledger.entries).toEqual(before)
    expect(await h.deps.companyLedger.listHistoricalSettlements(COMPANY_BRANCH)).toEqual([])
  })

  it('requires explicit link review, meaningful reason and the GM/admin role on both read and write', async () => {
    const snapshot = await preview()
    const body = intent(snapshot)
    for (const changed of [{ reviewedLinks: false }, { reviewedLinks: undefined }, { reason: ' ' }, { reason: '\u200b' }, { idempotencyKey: 'manual' }]) {
      expect((await request('POST', BASE, { ...body, ...changed })).statusCode).toBe(400)
    }
    for (const username of ['manager', 'driver1']) {
      const token = await h.loginAs(username)
      expect((await request('GET', `${BASE}/preview?branchId=${BRANCH}`, undefined, token)).statusCode).toBe(403)
      expect((await request('POST', BASE, body, token)).statusCode).toBe(403)
    }
    expect(noncash()).toHaveLength(0)
    const admin = await h.loginAs('sysadmin')
    expect((await request('POST', BASE, body, admin)).statusCode).toBe(201)
  })

  it('posts only the HQ noncash counterparts today and preserves every original cash, branch and P&L fact', async () => {
    const oldEntries = structuredClone(h.deps.ledger.entries)
    const oldCutover = await h.deps.companyLedger.cutoverFor(BRANCH)
    const before = await funds()
    const response = await request('POST', BASE, intent(await preview()))
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json()).toMatchObject({ version: 1, groupCount: 1, sourceCount: 2, businessDate: '2026-07-21', replayed: false })
    const writeLocks = [...h.deps.financialUnitOfWork.locks.taken]
    const groupedRead = await request('GET', `/company/restoration-reviews?branchId=${BRANCH}`)
    expect(groupedRead.statusCode, groupedRead.body).toBe(200)
    expect(groupedRead.json().historicalGroups).toEqual([expect.objectContaining({ restorationId: runId,
      branchId: BRANCH, businessDate: DAY, companyNet: '93.74', branchNet: '100.00', variance: '6.26',
      branchSourceEntries: branchEntries.map(entry => expect.objectContaining({ sourceEntryId: entry.id })),
    })])
    expect(await funds()).toEqual(before)
    expect(h.deps.ledger.entries.slice(0, oldEntries.length)).toEqual(oldEntries)
    expect(noncash()).toHaveLength(2)
    expect(noncash().every(entry => entry.branchId === COMPANY_BRANCH && entry.businessDate === '2026-07-21'
      && entry.postingDate === '2026-07-21' && entry.sypMinorPerUsd === null && entry.lines.length === 2
      && entry.lines.every(line => line.currency === 'SYP_NEW' && line.role === 'historical_restoration_reclass'
        && [ `historical_branch_transit:${BRANCH}`, `branch_clearing:${BRANCH}` ].includes(line.fundCode)))).toBe(true)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, `historical_branch_transit:${BRANCH}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, `branch_clearing:${BRANCH}`)).toBe(-9_374n)
    expect(await h.deps.companyLedger.cutoverFor(BRANCH)).toEqual(oldCutover)
    expect(writeLocks).toEqual([`receivables:${BRANCH}`, `receivables:${COMPANY_BRANCH}`])
    const saved = (await h.deps.companyLedger.listHistoricalSettlements(COMPANY_BRANCH))[0]!
    expect(saved).toMatchObject({ version: 1, createdBy: 'u-gm', cutoverWatermarkEntryId: oldCutover!.watermarkEntryId })
    expect(saved.groups[0]).toMatchObject({ branchNet: 10_000n, companyNet: 9_374n, variance: 626n,
      branchSourceEntries: [{ sourceEntryId: branchEntries[0]!.id, direction: 'to_company', amount: 20_000n },
        { sourceEntryId: branchEntries[1]!.id, direction: 'from_company', amount: 10_000n }] })
    expect(saved.legs.map(leg => leg.historicalJournalEntryId)).toEqual(companyEntries.map(entry => entry.id))
    const after = await preview()
    expect(after).toMatchObject({ version: 1, eligible: false, counts: { sourceCount: 0, groupCount: 0 } })
    expect(after.blockingReasons).toContain('historical_settlement_no_unsettled_sources')
  })

  it('discloses the same real variance across all overview ranges and the dashboard without forgiving it or changing profit', async () => {
    const body = intent(await preview())
    expect((await request('POST', BASE, body)).statusCode).toBe(201)
    const before = structuredClone(h.deps.ledger.entries)
    const matching = { companyBox: '100.00', clearing: '-93.74', totalDifference: '6.26',
      historicalSettlementDifference: '6.26', pendingRestorationDifference: '0.00', unexplainedDifference: '0.00',
      settlementStatus: 'variance', balanced: false, confirmedVarianceCount: 1, pendingReviewCount: 0,
      unlinkedHistoricalCount: 0, pendingToCompany: '0.00', pendingFromCompany: '0.00' }
    for (const range of ['from=2000-01-01&to=2026-07-21', 'from=2026-07-20&to=2026-07-20',
      'from=2026-07-21&to=2026-07-21', 'from=2025-01-01&to=2025-01-02']) {
      const response = await request('GET', `/company/overview?${range}`)
      expect(response.statusCode, response.body).toBe(200)
      const row = response.json().branches.find((branch: { branchId: string }) => branch.branchId === BRANCH)
      expect(row).toMatchObject(matching)
      expect(response.json()).toMatchObject({ pockets: { SYP_NEW: '93.74', USD: '0.00' },
        period: { SYP_NEW: { expense: '0.00', income: '0.00', net: '0.00' }, USD: { expense: '0.00', income: '0.00', net: '0.00' } } })
    }
    const dashboard = await request('GET', '/company-fund')
    expect(dashboard.statusCode, dashboard.body).toBe(200)
    expect(dashboard.json()).toMatchObject({ total: '93.74', usd: '0.00' })
    expect(dashboard.json().branches.find((branch: { branchId: string }) => branch.branchId === BRANCH))
      .toMatchObject({ ...matching, balance: '100.00' })
    const reviewFeed = await request('GET', `/company/restoration-reviews?branchId=${BRANCH}`)
    expect(reviewFeed.statusCode, reviewFeed.body).toBe(200)
    expect(reviewFeed.json().branches[0]).toMatchObject({ confirmedVarianceCount: 1, pendingReviewCount: 0,
      unlinkedHistoricalCount: 0, pendingToCompany: '0.00', pendingFromCompany: '0.00' })
    expect(h.deps.ledger.entries).toEqual(before)
    expect(await h.deps.companyLedger.listHistoricalSettlements(COMPANY_BRANCH)).toHaveLength(1)
  })

  it('keeps positive opposing source legs when both nets are zero, rather than producing a zero entry or omitting the group', async () => {
    for (const line of branchEntries[1]!.lines) line.amount = minor(20_000n)
    for (const line of companyEntries[1]!.lines) {
      line.amount = minor(7_500n)
      line.side = line.side === 'D' ? 'C' : 'D'
    }
    sources[1]!.amount = minor(7_500n)
    sources[1]!.movementType = 'branch_payment'
    const runs = h.deps.restorations.snapshotRows()
    runs[0]!.netToCompany = minor(0n)
    h.deps.restorations.restoreRows(runs)
    const cutover = h.deps.companyLedger.cutovers.get(BRANCH)!
    h.deps.companyLedger.cutovers.set(BRANCH, { ...cutover, openingAmount: minor(0n), baselineDifference: minor(0n) })
    const snapshot = await preview()
    expect(snapshot).toMatchObject({ eligible: true, counts: { sourceCount: 2, branchSourceCount: 2, groupCount: 1 },
      totals: { hqNet: '0.00', branchNet: '0.00', amountDifference: '0.00' } })
    const before = await funds()
    const response = await request('POST', BASE, intent(snapshot))
    expect(response.statusCode, response.body).toBe(201)
    expect(noncash()).toHaveLength(2)
    expect(noncash().every(entry => entry.lines.every(line => line.amount === 7_500n))).toBe(true)
    expect(await funds()).toEqual(before)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, `branch_clearing:${BRANCH}`)).toBe(0n)
  })

  it('leaves unlinked old runs outside this batch and excludes later or empty runs from the historical count', async () => {
    const [old] = await h.deps.ledger.post(BRANCH, [branchPosting('office_cash', 'to_company', 2_300n)], meta())
    const unlinkedId = await h.deps.restorations.create({ branchId: BRANCH, businessDate: DAY, cashCountId: null,
      plan: { schemaVersion: 3, restorationJournalEntryIds: [old!.id] }, netToCompany: minor(2_300n),
      reason: 'Old run with no imported HQ receipt', performedBy: 'u-gm', runNo: 2 })
    const cutover = h.deps.companyLedger.cutovers.get(BRANCH)!
    const balance = await h.deps.ledger.fundBalance(BRANCH, 'company_box')
    // Test fixture represents a link-only marker created after the additional old source.
    h.deps.companyLedger.cutovers.set(BRANCH, { ...cutover, watermarkEntryId: old!.id,
      openingAmount: balance, baselineDifference: balance })
    const [later] = await h.deps.ledger.post(BRANCH, [branchPosting('office_cash', 'to_company', 1_700n)], meta('2026-07-21'))
    await h.deps.restorations.create({ branchId: BRANCH, businessDate: '2026-07-21', cashCountId: null,
      plan: { schemaVersion: 4, restorationJournalEntryIds: [later!.id] }, netToCompany: minor(1_700n),
      reason: 'Future run after the frozen cutover watermark', performedBy: 'u-gm', runNo: 1 })
    await h.deps.restorations.create({ branchId: BRANCH, businessDate: '2026-07-21', cashCountId: null,
      plan: { schemaVersion: 4, restorationJournalEntryIds: [] }, netToCompany: minor(0n),
      reason: 'Empty no-op run', performedBy: 'u-gm', runNo: 2 })
    const snapshot = await preview()
    expect(snapshot).toMatchObject({ eligible: true, unlinkedHistoricalCount: 1, counts: { groupCount: 1, sourceCount: 2 } })
    expect((await request('POST', BASE, intent(snapshot))).statusCode).toBe(201)
    const saved = (await h.deps.companyLedger.listHistoricalSettlements(COMPANY_BRANCH))[0]!
    expect(saved.groups.map(group => group.restorationId)).toEqual([runId])
    expect(saved.groups.map(group => group.restorationId)).not.toContain(unlinkedId)
    expect(await h.deps.companyRestorationReviews.list(COMPANY_BRANCH)).toHaveLength(0)
    expect((await preview()).unlinkedHistoricalCount).toBe(1)
  })

  it('replays a UUID after later branch activity and another day without requiring fresh evidence or FX', async () => {
    const body = intent(await preview())
    const first = await request('POST', BASE, body)
    expect(first.statusCode, first.body).toBe(201)
    await h.deps.ledger.post(BRANCH, [manualKaish('office_cash', minor(300n), 'later-activity')], meta('2026-07-21'))
    h.deps.clock.advance(24 * 60 * 60 * 1000)
    gm = await h.loginAs('gm')
    const before = structuredClone(h.deps.ledger.entries)
    const fx = vi.spyOn(h.deps.fx, 'idFor').mockRejectedValue(new Error('retry must not ask for FX'))
    const replay = await request('POST', BASE, { ...body, idempotencyKey: String(body.idempotencyKey).toUpperCase() })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ ...first.json(), replayed: true })
    expect(fx).not.toHaveBeenCalled()
    expect(h.deps.ledger.entries).toEqual(before)
    expect((await request('POST', BASE, { ...body, reason: 'Different approved intent' })).statusCode).toBe(409)
    expect((await request('POST', BASE, body, await h.loginAs('sysadmin'))).statusCode).toBe(409)
  })

  it('refuses stale preview fingerprints after matching funds change or after source provenance changes', async () => {
    const snapshot = await preview()
    await h.deps.ledger.post(BRANCH, [manualKaish('office_cash', minor(1n), 'after-preview')], meta('2026-07-21'))
    const changed = await request('POST', BASE, intent(snapshot))
    expect(changed.statusCode, changed.body).toBe(409)
    expect(changed.json().error).toBe('historical_settlement_source_changed')
    expect(noncash()).toHaveLength(0)
    const refreshed = await preview()
    sources[0]!.linkNote = 'Additional documentary evidence must be reviewed again'
    expect((await request('POST', BASE, intent(refreshed))).json().error).toBe('historical_settlement_source_changed')
  })

  it('serializes same-UUID requests and refuses a competing batch built on the same version', async () => {
    const body = intent(await preview())
    const replies = await Promise.all([1, 2, 3].map(() => request('POST', BASE, body)))
    expect(replies.map(reply => reply.statusCode).sort()).toEqual([200, 200, 201])
    expect(noncash()).toHaveLength(2)
    expect(await h.deps.companyLedger.listHistoricalSettlements(COMPANY_BRANCH)).toHaveLength(1)
    const changed = await request('POST', BASE, { ...body, idempotencyKey: crypto.randomUUID() })
    expect(changed.statusCode).toBe(409)
    expect(changed.json().error).toBe('historical_settlement_version_conflict')
  })

  it('rolls both new journals and an inserted batch back on a late append failure', async () => {
    const body = intent(await preview())
    const before = structuredClone(h.deps.ledger.entries)
    const original = h.deps.companyLedger.createHistoricalSettlement.bind(h.deps.companyLedger)
    const failure = vi.spyOn(h.deps.companyLedger, 'createHistoricalSettlement').mockImplementation(async (row, version) => {
      await original(row, version)
      throw new Error('Late failure after journals and immutable batch')
    })
    expect((await request('POST', BASE, body)).statusCode).toBe(500)
    expect(h.deps.ledger.entries).toEqual(before)
    expect(await h.deps.companyLedger.listHistoricalSettlements(COMPANY_BRANCH)).toEqual([])
    expect(await h.deps.companyLedger.findHistoricalSettlement(body.idempotencyKey as string)).toBeNull()
    failure.mockRestore()
    expect((await request('POST', BASE, body)).statusCode).toBe(201)
    expect(noncash()).toHaveLength(2)
  })

  it('blocks a partially settled multi-source run rather than silently settling its remaining receipt', async () => {
    h.deps.companyLedger.historicalSettlements.set('corrupt-partial-fixture', {
      id: crypto.randomUUID(), companyBranchId: COMPANY_BRANCH, sourceBranchId: BRANCH, version: 1,
      cutoverWatermarkEntryId: companyEntries[1]!.id, evidenceHash: 'a'.repeat(64), requestHash: 'b'.repeat(64),
      businessDate: '2026-07-21', reason: 'Injected impossible legacy partial evidence', groups: [],
      legs: [{ restorationId: runId, sourceReference: sources[0]!.sourceReference, historicalJournalEntryId: companyEntries[0]!.id,
        direction: 'to_company', amount: minor(7_500n), journalEntryId: 999 }], createdBy: 'u-gm', createdAtMs: h.deps.clock.nowMs(),
    } satisfies CompanyHistoricalRestorationSettlement)
    const snapshot = await preview()
    expect(snapshot.eligible).toBe(false)
    expect(snapshot.blockingReasons).toContain('historical_settlement_partial_group')
    expect((await request('POST', BASE, intent(snapshot))).statusCode).toBe(409)
    expect(noncash()).toHaveLength(0)
  })

  it.each([
    ['branch source outside its ledger', () => { branchEntries[0]!.branchId = OTHER_BRANCH }, 'historical_settlement_branch_source_changed'],
    ['branch source changed event', () => { branchEntries[0]!.eventType = 'manual' }, 'historical_settlement_branch_source_changed'],
    ['branch source changed day', () => { branchEntries[0]!.businessDate = '2026-07-19' }, 'historical_settlement_branch_source_changed'],
    ['HQ source outside HQ', () => { companyEntries[0]!.branchId = OTHER_BRANCH }, 'historical_settlement_company_source_changed'],
    ['HQ amount no longer equals source evidence', () => { sources[0]!.amount = minor(7_501n) }, 'historical_settlement_company_source_changed'],
    ['owner-paid source is not historical HQ cash', () => { sources[0]!.paidFrom = 'owner_outside' }, 'historical_settlement_company_source_changed'],
    ['USD source cannot settle SYP matching', () => { sources[0]!.currency = 'USD' }, 'historical_settlement_company_source_changed'],
    ['source is not a branch transfer', () => { sources[0]!.movementType = 'expense' }, 'historical_settlement_company_source_changed'],
    ['duplicate immutable source', () => { sources.push(structuredClone(sources[0]!)) }, 'historical_settlement_duplicate_source'],
  ] as const)('blocks invalid evidence: %s', async (_label, change, reason) => {
    change()
    const snapshot = await preview()
    expect(snapshot.eligible).toBe(false)
    expect(snapshot.blockingReasons).toContain(reason)
    expect((await request('POST', BASE, intent(snapshot))).statusCode).toBe(409)
    expect(noncash()).toHaveLength(0)
  })

  it('blocks both branch and HQ sources with an immutable recorded reversal', async () => {
    await h.deps.ledger.post(BRANCH, [reverse(branchPosting('office_cash', 'to_company', 20_000n),
      `reversal-of-${branchEntries[0]!.id}`)], meta())
    await h.deps.ledger.post(COMPANY_BRANCH, [reverse(historicalBranchTransfer('to_company', minor(7_500n), BRANCH, 'original'),
      `reversal-of-${companyEntries[0]!.id}`)], meta())
    const snapshot = await preview()
    expect(snapshot.blockingReasons).toContain('historical_settlement_branch_source_changed')
    expect(snapshot.blockingReasons).toContain('historical_settlement_company_source_changed')
    expect((await request('POST', BASE, intent(snapshot))).statusCode).toBe(409)
    expect(noncash()).toHaveLength(0)
  })

  it('blocks legacy branch reversal after its historical counterpart has been settled', async () => {
    const response = await request('POST', BASE, intent(await preview()))
    expect(response.statusCode, response.body).toBe(201)
    const before = structuredClone(h.deps.ledger.entries)
    const reversed = await request('POST', `/journal/${branchEntries[0]!.id}/reverse?branchId=${BRANCH}`,
      { reason: 'Must not replay old branch transfer through the legacy cash-mirror path' })
    expect(reversed.statusCode, reversed.body).toBe(409)
    expect(reversed.json().error).toBe('historical_settlement_source_requires_reviewed_correction')
    expect(h.deps.ledger.entries).toEqual(before)
    expect(await h.deps.companyLedger.listMirrors(BRANCH)).toHaveLength(0)
  })

  it('blocks frozen-cutover drift, already reviewed branch sources and mismatched run net', async () => {
    const cutover = h.deps.companyLedger.cutovers.get(BRANCH)!
    h.deps.companyLedger.cutovers.set(BRANCH, { ...cutover, watermarkEntryId: branchEntries[0]!.id })
    expect((await preview()).blockingReasons).toContain('historical_settlement_company_source_changed')
    h.deps.companyLedger.cutovers.set(BRANCH, cutover)
    await h.deps.companyLedger.createMirror({ id: crypto.randomUUID(), sourceBranchId: BRANCH,
      sourceEntryId: branchEntries[0]!.id, mirrorEntryId: 999, direction: 'to_company', amount: minor(20_000n),
      restorationId: runId, createdBy: 'u-gm', createdAtMs: h.deps.clock.nowMs() })
    expect((await preview()).blockingReasons).toContain('historical_settlement_branch_source_changed')
    h.deps.companyLedger.mirrors.clear()
    const runs = h.deps.restorations.snapshotRows()
    runs[0]!.netToCompany = minor(10_001n)
    h.deps.restorations.restoreRows(runs)
    expect((await preview()).blockingReasons).toContain('historical_settlement_run_net_mismatch')
    expect(noncash()).toHaveLength(0)
  })

  it('requires the cash-neutral cutover marker and rejects unknown/company branch scopes', async () => {
    const cutover = h.deps.companyLedger.cutovers.get(BRANCH)!
    h.deps.companyLedger.cutovers.set(BRANCH, { ...cutover, mode: 'cash_opening' })
    const snapshot = await preview()
    expect(snapshot.blockingReasons).toContain('company_link_only_cutover_required')
    expect((await request('POST', BASE, intent(snapshot))).statusCode).toBe(409)
    expect((await request('GET', `${BASE}/preview?branchId=${COMPANY_BRANCH}`)).statusCode).toBe(404)
    expect((await request('GET', `${BASE}/preview?branchId=nonexistent`)).statusCode).toBe(404)
    expect(noncash()).toHaveLength(0)
  })

  it('cannot book the counterpart into a sealed current financial week', async () => {
    const body = intent(await preview())
    const week = await h.deps.weekLocks.create({ branchId: COMPANY_BRANCH, weekStartDate: '2026-07-19',
      weekEndDate: '2026-07-25', closedAtMs: null, closedBy: null })
    await h.deps.weekLocks.seal(week.id, 'u-gm', h.deps.clock.nowMs())
    expect((await request('POST', BASE, body)).statusCode).toBe(409)
    const response = await request('POST', BASE, intent(await preview()))
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error).toBe('week_locked')
    expect(noncash()).toHaveLength(0)
    expect(await h.deps.companyLedger.listHistoricalSettlements(COMPANY_BRANCH)).toEqual([])
  })

  it('supports genuine schema3 historical restoration evidence under the same frozen source checks', async () => {
    const runs = h.deps.restorations.snapshotRows()
    runs[0]!.plan = { schemaVersion: 3, restorationJournalEntryIds: branchEntries.map(entry => entry.id) }
    h.deps.restorations.restoreRows(runs)
    const snapshot = await preview()
    expect(snapshot.eligible).toBe(true)
    expect((await request('POST', BASE, intent(snapshot))).statusCode).toBe(201)
  })

  it('requires the stable HQ external reference to match its linked import source', async () => {
    companyEntries[0]!.externalReference = 'HQ-SRC-UNRELATED'
    const snapshot = await preview()
    expect(snapshot.eligible).toBe(false)
    expect(snapshot.blockingReasons).toContain('historical_settlement_company_source_changed')
    expect((await request('POST', BASE, intent(snapshot))).statusCode).toBe(409)
    expect(noncash()).toHaveLength(0)
  })
})
