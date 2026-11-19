import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, COMPANY_BRANCH, makeHarness, sypStr, type Harness } from './harness.ts'

let h: Harness
let manager: string
let gm: string
const request = (token: string, path: string, payload: Record<string, unknown>) => h.app.inject({
  method: 'POST', url: path, headers: { cookie: h.cookie(token) }, payload,
})
const restore = (key = crypto.randomUUID()) => request(manager, '/treasury/restoration', {
  idempotencyKey: key, reason: 'direct restoration',
})
const snapshot = () => structuredClone(h.deps.ledger.entries)

beforeEach(async () => {
  h = await makeHarness({ companyRestorationDirectPostingEnabled: true })
  manager = await h.loginAs('manager'); gm = await h.loginAs('gm')
  const admin = await h.loginAs('sysadmin')
  expect((await request(admin, '/company/cutover', { branchId: BRANCH, expectedOpening: '0.00', reason: 'link only' })).statusCode).toBe(201)
  expect((await h.app.inject({ method: 'PUT', url: '/treasury/capital-targets', headers: { cookie: h.cookie(manager) },
    payload: { cashTarget: '10000.00', walletTarget: '10000.00', reason: 'targets' } })).statusCode).toBe(200)
  for (const [fundCode, amount] of [['office_cash', 60000], ['office_wallet', 10000]] as const) {
    expect((await request(manager, '/journal/manual', { reason: 'source cash', lines: [
      { fundCode, side: 'D', amount: sypStr(amount) }, { fundCode: 'opening_balance', side: 'C', amount: sypStr(amount) },
    ] })).statusCode).toBe(201)
  }
})
afterEach(async () => { await h.app.close() })

describe('atomic direct restoration', () => {
  it('posts exact company cash immediately; concurrent retries return one run and receipt', async () => {
    const key = crypto.randomUUID()
    const results = await Promise.all([restore(key), restore(key), restore(key)])
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 200, 201])
    expect(results[0]!.json()).toMatchObject({ companyReviewStatus: 'confirmed' })
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(5000000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(1000000n)
    expect(await h.deps.restorations.runsOnDay(BRANCH, '2026-07-21')).toBe(1)
    const feed = await h.app.inject({ method: 'GET', url: '/company/restoration-reviews', headers: { cookie: h.cookie(gm) } })
    expect(feed.json().branches[0]).toMatchObject({ pendingReviewCount: 0, pendingToCompany: '0.00' })
    const before = snapshot()
    expect((await restore(key)).statusCode).toBe(200)
    expect(snapshot()).toEqual(before)
  })

  it('rolls back both books, source and receipt when company posting fails', async () => {
    const before = snapshot(), original = h.deps.ledger.post.bind(h.deps.ledger)
    h.deps.ledger.post = async (branch, postings, meta) => {
      if (branch === COMPANY_BRANCH) throw new Error('company half failed')
      return original(branch, postings, meta)
    }
    expect((await restore()).statusCode).toBe(500)
    expect(snapshot()).toEqual(before)
    expect(await h.deps.restorations.runsOnDay(BRANCH, '2026-07-21')).toBe(0)
    expect(await h.deps.companyRestorationReviews.list(COMPANY_BRANCH)).toEqual([])
  })

  it('keeps later corrections company-only and rejects another confirmation', async () => {
    const response = await restore()
    expect(response.statusCode, response.body).toBe(201)
    const id = response.json().proposalId
    const source = (await h.deps.companyRestorationReviews.get(id))!.legs[0]!
    const before = snapshot().filter(e => e.branchId === BRANCH)
    const corrected = await request(gm, `/company/restoration-reviews/${id}/correct`, {
      id: crypto.randomUUID(), expectedVersion: 1, reason: 'reviewed difference',
      confirmedLegs: [{ sourceEntryId: source.sourceEntryId, amount: '49000.00' }],
    })
    expect(corrected.statusCode, corrected.body).toBe(201)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(4900000n)
    expect(snapshot().filter(e => e.branchId === BRANCH)).toEqual(before)
    expect((await request(gm, `/company/restoration-reviews/${id}/confirm`, {
      id: crypto.randomUUID(), expectedVersion: 2, reason: 'duplicate',
    })).statusCode).toBe(409)
  })
})
