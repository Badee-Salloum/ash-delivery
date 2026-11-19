import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, COMPANY_BRANCH, makeHarness, type Harness, sypStr } from './harness.ts'

let h: Harness
let manager: string
let gm: string
const uuid = () => crypto.randomUUID()
const post = (token: string, url: string, payload: Record<string, unknown>) => h.app.inject({
  method: 'POST', url, headers: { cookie: h.cookie(token) }, payload,
})
const get = (token: string, url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })
const branchFacts = () => structuredClone(h.deps.ledger.entries.filter((entry) => entry.branchId === BRANCH))
const cash = () => h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')

beforeEach(async () => {
  h = await makeHarness({ companyRestorationReviewEnabled: true })
  manager = await h.loginAs('manager')
  gm = await h.loginAs('gm')
  const admin = await h.loginAs('sysadmin')
  const cutover = await post(admin, '/company/cutover', { branchId: BRANCH, expectedOpening: '0.00', reason: 'test reviewed cutover' })
  expect(cutover.statusCode, cutover.body).toBe(201)
  const targets = await h.app.inject({ method: 'PUT', url: '/treasury/capital-targets', headers: { cookie: h.cookie(manager) },
    payload: { cashTarget: sypStr(10_000), walletTarget: sypStr(10_000), reason: 'test targets' } })
  expect(targets.statusCode, targets.body).toBe(200)
})
afterEach(async () => { await h.app.close() })

async function seed(cashAmount = 60_000, walletAmount = 10_000) {
  for (const [fundCode, amount] of [['office_cash', cashAmount], ['office_wallet', walletAmount]] as const) {
    const result = await post(manager, '/journal/manual', { reason: `test ${fundCode}`, lines: [
      { fundCode, side: 'D', amount: sypStr(amount) }, { fundCode: 'opening_balance', side: 'C', amount: sypStr(amount) },
    ] })
    expect(result.statusCode, result.body).toBe(201)
  }
}
async function restore(idempotencyKey = uuid()) {
  const result = await post(manager, '/treasury/restoration', { idempotencyKey, reason: 'actual branch restoration' })
  expect(result.statusCode, result.body).toBe(201)
  return result.json() as { proposalId: string }
}

describe('actual branch restoration with reviewed HQ counterpart', () => {
  it('accepts JSONB key reordering while still rejecting a changed immutable financial value', async () => {
    await seed()
    const { proposalId } = await restore()
    const originalGet = h.deps.companyRestorationReviews.get.bind(h.deps.companyRestorationReviews)
    const reordered = (value: unknown): unknown => Array.isArray(value) ? value.map(reordered)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).reverse().map(([key, part]) => [key, reordered(part)])) : value
    h.deps.companyRestorationReviews.get = async id => reordered(await originalGet(id)) as Awaited<ReturnType<typeof originalGet>>
    const before = branchFacts()
    const response = await post(gm, `/company/restoration-reviews/${proposalId}/confirm`, { id: uuid(), expectedVersion: 0, reason: 'Persisted JSONB snapshot order' })
    expect(response.statusCode, response.body).toBe(201)
    expect(branchFacts()).toEqual(before)
    h.deps.companyRestorationReviews.get = async id => {
      const row = await originalGet(id)
      if (row) row.legs[0]!.sourceEntry.reason = 'Changed original source'
      return row
    }
    const corrected = await post(gm, `/company/restoration-reviews/${proposalId}/correct`, { id: uuid(), expectedVersion: 1, reason: 'Must reject actual changed source' })
    expect(corrected.statusCode).toBe(409)
    expect(corrected.json().error).toBe('restoration_source_corrected')
    expect(branchFacts()).toEqual(before)
  })

  it('books first approval on the actual receipt day, keeps real audit time, and books later correction today', async () => {
    await seed()
    const { proposalId } = await restore()
    const before = branchFacts()
    h.deps.clock.advance(3 * 24 * 60 * 60 * 1000)
    gm = await h.loginAs('gm')
    const id = uuid()
    const payload = { id, expectedVersion: 0, reason: 'WhatsApp receipt on its actual day', occurredOn: '2026-07-22' }
    const confirmed = await post(gm, `/company/restoration-reviews/${proposalId}/confirm`, payload)
    expect(confirmed.statusCode, confirmed.body).toBe(201)
    const first = h.deps.ledger.entries.filter(entry => entry.branchId === COMPANY_BRANCH && entry.reason === payload.reason)
    expect(first.length).toBeGreaterThan(0)
    expect(first.every(entry => entry.businessDate === '2026-07-22' && entry.postingDate === '2026-07-22' && entry.createdAtMs === h.deps.clock.nowMs())).toBe(true)
    const replay = await post(gm, `/company/restoration-reviews/${proposalId}/confirm`, payload)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().replayed).toBe(true)
    const corrected = await post(gm, `/company/restoration-reviews/${proposalId}/correct`, { id: uuid(), expectedVersion: 1, reason: 'Later audited correction', occurredOn: '2026-07-22' })
    expect(corrected.statusCode, corrected.body).toBe(201)
    const corrections = h.deps.ledger.entries.filter(entry => entry.branchId === COMPANY_BRANCH && entry.reason === 'Later audited correction')
    expect(corrections.length).toBeGreaterThan(0)
    expect(corrections.every(entry => entry.businessDate === '2026-07-24')).toBe(true)
    expect(branchFacts()).toEqual(before)
  })

  it('never backdates a first approval into a sealed company period', async () => {
    await seed()
    const { proposalId } = await restore()
    const week = await h.deps.weekLocks.create({ branchId: COMPANY_BRANCH, weekStartDate: '2026-07-19',
      weekEndDate: '2026-07-25', closedAtMs: null, closedBy: null })
    await h.deps.weekLocks.seal(week.id, 'u-gm', h.deps.clock.nowMs())
    h.deps.clock.advance(7 * 24 * 60 * 60 * 1000)
    gm = await h.loginAs('gm')
    const before = branchFacts()
    const result = await post(gm, `/company/restoration-reviews/${proposalId}/confirm`, { id: uuid(), expectedVersion: 0, reason: 'Old closed receipt' })
    expect(result.statusCode).toBe(409)
    expect(await cash()).toBe(0n)
    expect(branchFacts()).toEqual(before)
  })

  it('executes branch once, creates no HQ cash before review, and replays the original UUID after later activity', async () => {
    await seed()
    const idempotencyKey = uuid()
    const proposal = await restore(idempotencyKey)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(1_000_000n)
    expect(await cash()).toBe(0n)
    expect(await h.deps.companyLedger.listMirrors(BRANCH)).toHaveLength(0)
    const before = branchFacts()
    const replay = await post(manager, '/treasury/restoration', { idempotencyKey, reason: 'actual branch restoration' })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ proposalId: proposal.proposalId, replayed: true })
    expect(branchFacts()).toEqual(before)
    const conflict = await post(manager, '/treasury/restoration', { idempotencyKey, reason: 'different actual intent' })
    expect(conflict.statusCode).toBe(409)
    expect(await h.deps.companyRestorationReviews.list(COMPANY_BRANCH)).toHaveLength(1)
  })

  it('serializes concurrent same-UUID retries and never executes a second branch run', async () => {
    await seed()
    const idempotencyKey = uuid()
    const results = await Promise.all([1, 2, 3].map(() => post(manager, '/treasury/restoration', {
      idempotencyKey, reason: 'concurrent restoration',
    })))
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 200, 201])
    expect(new Set(results.map((result) => result.json().restorationId)).size).toBe(1)
    expect(await h.deps.restorations.runsOnDay(BRANCH, '2026-07-21')).toBe(1)
    expect(await cash()).toBe(0n)
  })

  it('rolls actual branch postings and run back if proposal creation fails', async () => {
    await seed()
    const before = branchFacts()
    h.deps.companyRestorationReviews.create = async () => { throw new Error('late proposal failure') }
    const result = await post(manager, '/treasury/restoration', { idempotencyKey: uuid(), reason: 'must roll back' })
    expect(result.statusCode).toBe(500)
    expect(branchFacts()).toEqual(before)
    expect(await h.deps.restorations.runsOnDay(BRANCH, '2026-07-21')).toBe(0)
    expect(await cash()).toBe(0n)
  })

  it('revision, defer, overridden HQ confirmation, and later correction preserve every branch fact', async () => {
    await seed()
    const { proposalId } = await restore()
    const source = (await h.deps.companyRestorationReviews.get(proposalId))!.legs[0]!
    const before = branchFacts()
    const amounts = [{ sourceEntryId: source.sourceEntryId, amount: sypStr(40_000) }]
    const revised = await post(gm, `/company/restoration-reviews/${proposalId}/revisions`, {
      idempotencyKey: uuid(), expectedVersion: 0, confirmedLegs: amounts, reason: 'counted 40000 only',
    })
    expect(revised.statusCode, revised.body).toBe(201)
    expect(await cash()).toBe(0n)
    const deferred = await post(gm, `/company/restoration-reviews/${proposalId}/defer`, {
      id: uuid(), expectedVersion: 1, reason: 'wait for receipt',
    })
    expect(deferred.statusCode, deferred.body).toBe(201)
    expect(await cash()).toBe(0n)
    const confirmationKey = uuid()
    const confirmed = await post(gm, `/company/restoration-reviews/${proposalId}/confirm`, {
      idempotencyKey: confirmationKey, expectedVersion: 2, reason: 'actual cash received',
    })
    expect(confirmed.statusCode, confirmed.body).toBe(201)
    expect(confirmed.json()).toMatchObject({ confirmedNet: sypStr(40_000), pendingDifference: sypStr(10_000), matched: false })
    expect(await cash()).toBe(4_000_000n)
    const deferConfirmed = await post(gm, `/company/restoration-reviews/${proposalId}/defer`, {
      id: uuid(), expectedVersion: 3, reason: 'confirmed money must use correction, not defer',
    })
    expect(deferConfirmed.statusCode).toBe(409)
    expect(deferConfirmed.json().error).toBe('restoration_use_correction')
    const replay = await post(gm, `/company/restoration-reviews/${proposalId}/confirm`, {
      idempotencyKey: confirmationKey, expectedVersion: 2, reason: 'actual cash received',
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(await cash()).toBe(4_000_000n)
    const corrected = await post(gm, `/company/restoration-reviews/${proposalId}/correct`, {
      id: uuid(), expectedVersion: 3, confirmedLegs: [{ sourceEntryId: source.sourceEntryId, amount: sypStr(45_000) }],
      reason: 'recording error reviewed',
    })
    expect(corrected.statusCode, corrected.body).toBe(201)
    expect(corrected.json()).toMatchObject({ confirmedNet: sypStr(45_000), pendingDifference: sypStr(5_000) })
    expect(await cash()).toBe(4_500_000n)
    expect(branchFacts()).toEqual(before)
    expect(await h.deps.capitalTargets.resolve(BRANCH, '2026-07-21')).toEqual({ office_cash: 1_000_000n, office_wallet: 1_000_000n })
  })

  it('unrelated later branch activity does not invalidate the frozen executed source', async () => {
    await seed()
    const { proposalId } = await restore()
    const added = await post(manager, '/treasury/deposit', { idempotencyKey: uuid(), target: 'cash', amount: sypStr(123), branchId: BRANCH })
    expect(added.statusCode, added.body).toBe(201)
    const before = branchFacts()
    const confirmed = await post(gm, `/company/restoration-reviews/${proposalId}/confirm`, {
      id: uuid(), expectedVersion: 0, reason: 'review earlier valid run',
    })
    expect(confirmed.statusCode, confirmed.body).toBe(201)
    expect(await cash()).toBe(5_000_000n)
    expect(branchFacts()).toEqual(before)
  })

  it('retains both offsetting cash/wallet source legs when net-to-company is zero', async () => {
    await seed(15_000, 5_000)
    const { proposalId } = await restore()
    const proposal = await h.deps.companyRestorationReviews.get(proposalId)
    expect(proposal!.legs).toHaveLength(2)
    expect(new Set(proposal!.legs.map((leg) => leg.fundCode))).toEqual(new Set(['office_cash', 'office_wallet']))
    const confirmed = await post(gm, `/company/restoration-reviews/${proposalId}/confirm`, { id: uuid(), expectedVersion: 0, reason: 'two actual legs' })
    expect(confirmed.statusCode, confirmed.body).toBe(201)
    expect(confirmed.json()).toMatchObject({ originalNet: '0.00', confirmedNet: '0.00', matched: true })
    expect(h.deps.ledger.entries.filter((entry) => entry.occurrenceKey.startsWith('review:'))).toHaveLength(2)
  })

  it('rejects negative amounts, stale revisions and branch-manager HQ access', async () => {
    await seed()
    const { proposalId } = await restore()
    const source = (await h.deps.companyRestorationReviews.get(proposalId))!.legs[0]!
    expect((await get(manager, '/company/restoration-reviews')).statusCode).toBe(403)
    const negative = await post(gm, `/company/restoration-reviews/${proposalId}/confirm`, {
      id: uuid(), expectedVersion: 0, reason: 'negative not valid', confirmedLegs: [{ sourceEntryId: source.sourceEntryId, amount: '-1.00' }],
    })
    expect(negative.statusCode).toBe(400)
    const stale = await post(gm, `/company/restoration-reviews/${proposalId}/confirm`, { id: uuid(), expectedVersion: 10, reason: 'stale revision' })
    expect(stale.statusCode).toBe(409)
    expect(await cash()).toBe(0n)
  })

  it('rolls HQ confirmation back if its immutable revision write fails', async () => {
    await seed()
    const { proposalId } = await restore()
    const before = branchFacts()
    h.deps.companyRestorationReviews.appendRevision = async () => { throw new Error('late revision failure') }
    const confirmed = await post(gm, `/company/restoration-reviews/${proposalId}/confirm`, { id: uuid(), expectedVersion: 0, reason: 'must stay pending' })
    expect(confirmed.statusCode).toBe(500)
    expect(await cash()).toBe(0n)
    expect(branchFacts()).toEqual(before)
    expect(await h.deps.companyRestorationReviews.listRevisions(proposalId)).toHaveLength(0)
  })

  it('allows actual HQ payments to leave its balance negative, but not negative operation amounts', async () => {
    const { proposalId } = await restore()
    const before = branchFacts()
    const confirmed = await post(gm, `/company/restoration-reviews/${proposalId}/confirm`, {
      id: uuid(), expectedVersion: 0, reason: 'actual capital payment confirmed',
    })
    expect(confirmed.statusCode, confirmed.body).toBe(201)
    expect(await cash()).toBe(-2_000_000n)
    expect(branchFacts()).toEqual(before)
  })

  it('blocks the legacy source reversal path rather than manufacture HQ cash for an unconfirmed proposal', async () => {
    await seed()
    const { proposalId } = await restore()
    const source = (await h.deps.companyRestorationReviews.get(proposalId))!.legs[0]!
    const before = branchFacts()
    const reverse = await post(gm, `/journal/${source.sourceEntryId}/reverse?branchId=${BRANCH}`, { reason: 'must use reviewed correction' })
    expect(reverse.statusCode, reverse.body).toBe(409)
    expect(reverse.json().error).toBe('restoration_source_requires_reviewed_correction')
    expect(branchFacts()).toEqual(before)
    expect(await cash()).toBe(0n)
  })
})

describe('legacy compatibility remains default', () => {
  it('disabled flag keeps direct old mirrors, shown as already posted without a second receipt', async () => {
    await h.app.close()
    h = await makeHarness()
    manager = await h.loginAs('manager')
    gm = await h.loginAs('gm')
    const admin = await h.loginAs('sysadmin')
    expect((await post(admin, '/company/cutover', { branchId: BRANCH, expectedOpening: '0.00', reason: 'legacy cutover' })).statusCode).toBe(201)
    // Simulate the persisted pre-0094 marker. New link-only markers always use reviewed HQ flow.
    const legacy = (await h.deps.companyLedger.cutoverFor(BRANCH))!
    h.deps.companyLedger.cutovers.set(BRANCH,{ ...legacy,mode: 'cash_opening' })
    const restored = await post(manager, '/treasury/restoration', { reason: 'existing protocol without key' })
    expect(restored.statusCode, restored.body).toBe(201)
    const priorCash = await cash()
    const list = await get(gm, '/company/restoration-reviews')
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json().enabled).toBe(false)
    expect(list.json().proposals).toHaveLength(0)
    expect(list.json().legacy).toHaveLength(2)
    expect(list.json().legacy.every((row: { status: string }) => row.status === 'posted_legacy')).toBe(true)
    expect(await cash()).toBe(priorCash)
  })
})
