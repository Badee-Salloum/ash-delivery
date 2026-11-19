import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRANCH, COMPANY_BRANCH, OTHER_BRANCH, type Harness, makeHarness } from './harness.ts'
import type { JournalEntryRecord } from '@ash/contracts'
import { minor } from '@ash/domain'

let h: Harness
let gm: string
const post = (url: string, payload: Record<string, unknown>, token = gm) =>
  h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const body = (overrides: Record<string, unknown> = {}) => ({ idempotencyKey: crypto.randomUUID(),
  branchId: BRANCH, direction: 'to_branch', source: 'company', channel: 'cash', currency: 'SYP_NEW',
  amount: '50.00', occurredOn: '2026-07-21', description: 'actual independent live transfer', ...overrides })
const transfer = (overrides: Record<string, unknown> = {}) => post('/company/branch-transfers', body(overrides))
const balance = (branchId: string, fundCode: string) => h.deps.ledger.fundBalance(branchId, fundCode)

beforeEach(async () => {
  h = await makeHarness({ companyRestorationReviewEnabled: true })
  gm = await h.loginAs('gm')
  const admin = await h.loginAs('sysadmin')
  const cutover = await post('/company/cutover', { branchId: BRANCH, expectedOpening: '0.00', reason: 'reviewed test cutover' }, admin)
  expect(cutover.statusCode, cutover.body).toBe(201)
})
afterEach(async () => { vi.restoreAllMocks(); await h.app.close() })

describe('ordinary live HQ and branch transfers', () => {
  it('adds a declared unrecorded old transfer on its real day without rewriting any existing branch journal',async()=>{
    const before=structuredClone(h.deps.ledger.entries)
    const old=body({occurredOn:'2026-07-01',notPreviouslyRecorded:true})
    const result=await post('/company/branch-transfers',old)
    expect(result.statusCode,result.body).toBe(201)
    expect(result.json().transfer).toMatchObject({occurredOn:'2026-07-01',postedOn:'2026-07-01',companyCashEffect:'-50.00',branchCashEffect:'50.00'})
    expect((await post('/company/branch-transfers',old)).statusCode).toBe(200)
    expect(h.deps.ledger.entries.slice(0,before.length)).toEqual(before)
    expect(h.deps.ledger.entries.at(-1)?.businessDate).toBe('2026-07-01')
    const future=await transfer({occurredOn:'2026-07-22',notPreviouslyRecorded:true})
    expect(future.statusCode).toBe(422)
  })
  it('links a verified old branch source once, creates only missing HQ and survives concurrency',async()=>{
    const source: JournalEntryRecord={id:50,branchId:BRANCH,shiftId:null,eventType:'manual',externalReference:null,occurrenceKey:'old-branch-receipt',businessDate:'2026-07-01',postingDate:'2026-07-01',weekStartDate:'2026-06-28',fxDayId:1,sypMinorPerUsd:null,weekLockId:null,reason:'Verified previous branch transfer',createdBy:'u-manager',createdAtMs:h.deps.clock.nowMs(),
      lines:[{fundCode:'company_box',side:'D',amount:minor(1000n),currency:'SYP_NEW',role:'kaish'},
        {fundCode:'office_cash',side:'C',amount:minor(1000n),currency:'SYP_NEW'}]}
    h.deps.ledger.entries.push(source)
    const cutover=h.deps.companyLedger.cutovers.get(BRANCH)!
    h.deps.companyLedger.cutovers.set(BRANCH,{...cutover,mode:'link_only',watermarkEntryId:50,baselineDifference:minor(1000n)})
    const branchBefore=structuredClone(h.deps.ledger.entries.filter(row=>row.branchId===BRANCH))
    const input={idempotencyKey:crypto.randomUUID(),branchId:BRANCH,sourceEntryId:50,companyEntryId:null,reason:'Reviewed missing HQ side',acknowledged:true}
    const list=await h.app.inject({method:'GET',url:`/company/branch-transfers/historical-sources?branchId=${BRANCH}`,headers:{cookie:h.cookie(gm)}})
    expect(list.json().sources).toHaveLength(1)
    const results=await Promise.all([post('/company/branch-transfers/historical-link',input),post('/company/branch-transfers/historical-link',input)])
    expect(results.map(row=>row.statusCode).sort()).toEqual([200,201])
    expect(results[0]!.json()).toMatchObject({branchCashEffect:'0.00',companyCashEffect:'10.00'})
    expect(h.deps.ledger.entries.filter(row=>row.branchId===BRANCH)).toEqual(branchBefore)
    expect(await balance(COMPANY_BRANCH,'company_cash:SYP_NEW')).toBe(1000n)
    expect((await post('/company/branch-transfers/historical-link',{...input,idempotencyKey:crypto.randomUUID()})).statusCode).toBe(409)
    expect((await post('/company/branch-transfers/historical-link',{...input,reason:'Different intent'})).statusCode).toBe(409)
  })
  it('does not finance a historical branch withdrawal with a future deposit',async()=>{
    await transfer({source:'owner_outside',amount:'100.00'})
    const result=await transfer({direction:'from_branch',amount:'50.00',occurredOn:'2026-07-01',notPreviouslyRecorded:true})
    expect(result.statusCode,result.body).toBe(422)
    expect(await balance(BRANCH,'office_cash')).toBe(10000n)
  })
  it('posts a manual shahn and one HQ mirror atomically, allows negative HQ and never executes restoration', async () => {
    const result = await transfer()
    expect(result.statusCode, result.body).toBe(201)
    expect(result.json()).toMatchObject({ replayed: false, transfer: { companyCashEffect: '-50.00',
      branchCashEffect: '50.00', expenseEffect: '0.00', source: 'company' } })
    expect(await balance(BRANCH, 'office_cash')).toBe(5000n)
    expect(await balance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(-5000n)
    expect(await balance(BRANCH, 'company_box')).toBe(-5000n)
    expect(await balance(COMPANY_BRANCH, `branch_clearing:${BRANCH}`)).toBe(5000n)
    expect(h.deps.ledger.entries.filter(entry => entry.branchId === BRANCH)).toEqual([
      expect.objectContaining({ eventType: 'manual', lines: expect.arrayContaining([
        expect.objectContaining({ fundCode: 'office_cash', side: 'D', role: 'shahn' }),
        expect.objectContaining({ fundCode: 'company_box', side: 'C' }),
      ]) }),
    ])
    expect(await h.deps.companyLedger.listMirrors(BRANCH)).toHaveLength(1)
    expect(await h.deps.restorations.runsOnDay(BRANCH, '2026-07-21')).toBe(0)
    expect(await h.deps.companyRestorationReviews.list(COMPANY_BRANCH)).toHaveLength(0)
    const overview = await h.app.inject({ method: 'GET', url: '/company/overview', headers: { cookie: h.cookie(gm) } })
    expect(overview.json().period.SYP_NEW).toMatchObject({ income: '0.00', expense: '0.00' })
    expect(overview.json().branches.find((branch: { branchId: string }) => branch.branchId === BRANCH).balanced).toBe(true)
  })

  it('receives branch money in HQ without treating it as operating income', async () => {
    expect((await transfer({ source: 'owner_outside', amount: '80.00', channel: 'wallet' })).statusCode).toBe(201)
    const received = await transfer({ direction: 'from_branch', amount: '30.00', channel: 'wallet' })
    expect(received.statusCode, received.body).toBe(201)
    expect(received.json().transfer).toMatchObject({ branchCashEffect: '-30.00', companyCashEffect: '30.00' })
    expect(await balance(BRANCH, 'office_wallet')).toBe(5000n)
    expect(await balance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(3000n)
    expect(await h.deps.companyLedger.listMirrors(BRANCH)).toHaveLength(1)
    expect(await h.deps.restorations.runsOnDay(BRANCH, '2026-07-21')).toBe(0)
  })

  it('records direct owner funding without a company mirror or expense, even before branch cutover', async () => {
    const result = await transfer({ branchId: OTHER_BRANCH, source: 'owner_outside', amount: '12.00', channel: 'wallet' })
    expect(result.statusCode, result.body).toBe(201)
    expect(result.json().transfer).toMatchObject({ companyCashEffect: '0.00', companyEntryId: null, expenseEffect: '0.00' })
    expect(await balance(OTHER_BRANCH, 'office_wallet')).toBe(1200n)
    expect(await balance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(0n)
    expect(await h.deps.companyLedger.listMirrors(OTHER_BRANCH)).toHaveLength(0)
    const owners = await h.app.inject({ method: 'GET', url: '/company/owner-payments', headers: { cookie: h.cookie(gm) } })
    expect(owners.json()).toMatchObject({ totals: { SYP_NEW: '0.00' }, branchFundingTotals: { SYP_NEW: '12.00' } })
  })

  it('replays one UUID under concurrency, including uppercase UUID input, without duplicating either book', async () => {
    const input = body()
    const results = await Promise.all([input, input, { ...input, idempotencyKey: input.idempotencyKey.toUpperCase() }]
      .map(value => post('/company/branch-transfers', value)))
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 200, 201])
    expect(new Set(results.map(result => result.json().transfer.branchEntryId)).size).toBe(1)
    expect(h.deps.ledger.entries).toHaveLength(2)
    expect(await h.deps.companyLedger.listMirrors(BRANCH)).toHaveLength(1)
  })

  it('replays the original receipt after midnight and closed periods without requiring new FX or reopening history', async () => {
    const input = body()
    expect((await post('/company/branch-transfers', input)).statusCode).toBe(201)
    for (const branchId of [BRANCH, COMPANY_BRANCH]) {
      const week = await h.deps.weekLocks.create({ branchId, weekStartDate: '2026-07-19',
        weekEndDate: '2026-07-25', closedBy: null, closedAtMs: null })
      await h.deps.weekLocks.seal(week.id, 'u-gm', h.deps.clock.nowMs())
    }
    h.deps.clock.advance(24 * 60 * 60 * 1000)
    gm = await h.loginAs('gm')
    const spy = vi.spyOn(h.deps.fx, 'idFor').mockRejectedValue(new Error('replay must use original FX'))
    const replay = await post('/company/branch-transfers', input)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().transfer).toMatchObject({ occurredOn: '2026-07-21', postedOn: '2026-07-21' })
    expect(spy).not.toHaveBeenCalled()
    expect(h.deps.ledger.entries).toHaveLength(2)
    expect((await post('/company/branch-transfers', { ...input, idempotencyKey: crypto.randomUUID() })).json().error)
      .toBe('historical_branch_transfer_requires_matching')
  })

  it('rejects changed money, source, channel, date, description and actor under the same UUID', async () => {
    const input = body()
    expect((await post('/company/branch-transfers', input)).statusCode).toBe(201)
    for (const changes of [{ amount: '51.00' }, { source: 'owner_outside' }, { channel: 'wallet' },
      { occurredOn: '2026-07-20' }, { description: 'different actual transfer' }, { branchId: OTHER_BRANCH }]) {
      expect((await post('/company/branch-transfers', { ...input, ...changes })).statusCode).toBe(409)
    }
    const admin = await h.loginAs('sysadmin')
    expect((await post('/company/branch-transfers', input, admin)).statusCode).toBe(409)
    expect(h.deps.ledger.entries).toHaveLength(2)
  })

  it('serializes withdrawal balance checks and refuses negative branch cash', async () => {
    expect((await transfer({ source: 'owner_outside', amount: '20.00' })).statusCode).toBe(201)
    const results = await Promise.all([1, 2].map(() => transfer({ direction: 'from_branch', amount: '15.00' })))
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 422])
    expect(await balance(BRANCH, 'office_cash')).toBe(500n)
    expect(await balance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(1500n)
    expect(await h.deps.companyLedger.listMirrors(BRANCH)).toHaveLength(1)
  })

  it('rolls both journal entries back if saving their mirror link fails', async () => {
    h.deps.companyLedger.createMirror = async () => { throw new Error('late mirror-link failure') }
    expect((await transfer()).statusCode).toBe(500)
    expect(h.deps.ledger.entries).toHaveLength(0)
    expect(await balance(BRANCH, 'office_cash')).toBe(0n)
    expect(await balance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(0n)
  })

  it('shares the existing treasury UUID receipt and never recreates an already recorded owner deposit', async () => {
    const input = body({ source: 'owner_outside', amount: '12.00' })
    const deposit = await post('/treasury/deposit', { branchId: BRANCH, idempotencyKey: input.idempotencyKey,
      target: 'cash', amount: '12.00', note: input.description })
    expect(deposit.statusCode, deposit.body).toBe(201)
    const replay = await post('/company/branch-transfers', input)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ replayed: true, transfer: { companyEntryId: null, branchCashEffect: '12.00' } })
    expect((await post('/company/branch-transfers', { ...input, source: 'company' })).statusCode).toBe(409)
    expect(h.deps.ledger.entries).toHaveLength(1)
  })

  it('fails closed on a damaged mirror receipt instead of posting an unpaired repair', async () => {
    const input = body()
    expect((await post('/company/branch-transfers', input)).statusCode).toBe(201)
    const existing = h.deps.ledger.entries[1]!
    existing.lines[0]!.amount = existing.lines[0]!.amount + 1n as typeof existing.lines[0]['amount']
    const snapshot = structuredClone(h.deps.ledger.entries)
    const replay = await post('/company/branch-transfers', input)
    expect(replay.statusCode, replay.body).toBe(409)
    expect(replay.json().error).toBe('company_transfer_mirror_integrity_error')
    expect(h.deps.ledger.entries).toEqual(snapshot)
  })

  it('binds one transfer UUID across branches under concurrency', async () => {
    const input = body({ source: 'owner_outside' })
    const results = await Promise.all([BRANCH, OTHER_BRANCH].map(branchId =>
      post('/company/branch-transfers', { ...input, branchId })))
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409])
    expect(h.deps.ledger.entries).toHaveLength(1)
  })

  it('blocks historical branch replay, uncutover company transfers and unauthorized actors', async () => {
    expect((await transfer({ branchId: 'not-an-operating-branch' })).statusCode).toBe(404)
    expect((await transfer({ occurredOn: '2025-06-01' })).json().error).toBe('historical_branch_transfer_requires_matching')
    expect((await transfer({ branchId: OTHER_BRANCH })).json().error).toBe('company_transfer_cutover_required')
    const manager = await h.loginAs('manager')
    expect((await post('/company/branch-transfers', body(), manager)).statusCode).toBe(403)
    expect((await transfer({ amount: '-1.00' })).statusCode).toBe(400)
    expect((await transfer({ currency: 'USD' })).statusCode).toBe(400)
    expect((await transfer({ source: 'owner_outside', direction: 'from_branch' })).statusCode).toBe(400)
    expect(h.deps.ledger.entries).toHaveLength(0)
  })
})
