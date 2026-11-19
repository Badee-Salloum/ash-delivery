import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRANCH, COMPANY_BRANCH, OTHER_BRANCH, makeHarness, type Harness } from './harness.ts'
import { readOwnerWithdrawals } from '../src/company-owner-withdrawals.routes.ts'

let h: Harness, gm: string
const request = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, token = gm) =>
  h.app.inject({ method, url, headers: { cookie: h.cookie(token) }, ...(payload ? { payload } : {}) })
async function branchWithdrawal(amount = '70000.00', branchId = BRANCH, target = 'cash') {
  expect((await request('POST', '/treasury/deposit', { branchId, target, amount, note: 'test seed', idempotencyKey: crypto.randomUUID() })).statusCode).toBe(201)
  const payload = { branchId, target, amount, to: 'owner_drawings', reason: 'Personal drawing, not an expense', idempotencyKey: crypto.randomUUID() }
  const response = await request('POST', '/treasury/withdraw', payload)
  expect(response.statusCode, response.body).toBe(201)
  return { payload, entry: structuredClone(h.deps.ledger.entries.at(-1)!) }
}
async function companyWithdrawal(amount = '960.00', currency = 'USD') {
  expect((await request('POST', '/company/deposits', { amount, currency, reason: 'test seed', idempotencyKey: crypto.randomUUID() })).statusCode).toBe(201)
  const payload = { amount, currency, reason: 'Owner personal withdrawal', idempotencyKey: crypto.randomUUID() }
  const response = await request('POST', '/company/withdrawals', payload)
  expect(response.statusCode, response.body).toBe(201)
  return { payload, command: response.json().command }
}
beforeEach(async () => { h = await makeHarness(); gm = await h.loginAs('gm') })
afterEach(async () => { vi.restoreAllMocks(); await h.app.close() })

describe('company-wide owner withdrawal read-only projection', () => {
  it('combines company, branch cash and branch wallet once, without changing any ledger or balance', async () => {
    await companyWithdrawal()
    await branchWithdrawal()
    await branchWithdrawal('10000.00', OTHER_BRANCH, 'wallet')
    const snapshot = structuredClone(h.deps.ledger.entries)
    const commands = await h.deps.companyLedger.listCommands(COMPANY_BRANCH)
    const response = await request('GET', '/company/owner-withdrawals')
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ totals: { SYP_NEW: '80000.00', USD: '960.00' }, basis: 'current_verified_original_withdrawals' })
    expect(response.json().withdrawals).toHaveLength(3)
    expect(response.json().withdrawals).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'company', currency: 'USD', amount: '960.00', sypMinorPerUsd: '13000' }),
      expect.objectContaining({ source: 'branch_cash', branchId: BRANCH, amount: '70000.00' }),
      expect.objectContaining({ source: 'branch_wallet', branchId: OTHER_BRANCH, amount: '10000.00' }),
    ]))
    expect(h.deps.ledger.entries).toEqual(snapshot)
    expect(await h.deps.companyLedger.listCommands(COMPANY_BRANCH)).toEqual(commands)
    expect((await request('GET', '/company/owner-payments')).json().totals).toEqual({ SYP_NEW: '0.00', USD: '0.00' })
    expect((await request('GET', '/company/overview')).json().period.USD).toMatchObject({ expense: '0.00', net: '0.00' })
  })

  it('keeps full-history totals when the detail period is empty, and keeps the original USD rate', async () => {
    await companyWithdrawal()
    h.deps.clock.advance(86400000)
    await h.deps.fx.upsert({ businessDate: '2026-07-22', sypMinorPerUsd: 13900n, provisional: false })
    gm = await h.loginAs('gm')
    const response = await request('GET', '/company/owner-withdrawals?from=2026-07-22&to=2026-07-22')
    expect(response.json()).toMatchObject({ totals: { SYP_NEW: '0.00', USD: '960.00' }, periodTotals: { SYP_NEW: '0.00', USD: '0.00' }, withdrawals: [] })
    expect((await request('GET', '/company/owner-withdrawals')).json().withdrawals[0].sypMinorPerUsd).toBe('13000')
  })

  it('counts idempotent retries once and removes reversed HQ withdrawals from current totals', async () => {
    const { payload, command } = await companyWithdrawal()
    expect((await request('POST', '/company/withdrawals', payload)).statusCode).toBe(200)
    expect((await request('GET', '/company/owner-withdrawals')).json().withdrawals).toHaveLength(1)
    const reversal = await request('POST', '/company/reversals', { idempotencyKey: crypto.randomUUID(), targetId: command.id, reason: 'Test withdrawal was cancelled' })
    expect(reversal.statusCode, reversal.body).toBe(201)
    const snapshot = structuredClone(h.deps.ledger.entries)
    expect((await request('GET', '/company/owner-withdrawals')).json()).toMatchObject({ totals: { USD: '0.00' }, withdrawals: [] })
    expect(h.deps.ledger.entries).toEqual(snapshot)
  })

  it('collapses verified branch reversal chains, preserving all original journal evidence', async () => {
    const { payload, entry } = await branchWithdrawal()
    expect((await request('POST', '/treasury/withdraw', payload)).statusCode).toBe(200)
    expect((await request('POST', `/journal/${entry.id}/reverse`, { branchId: BRANCH, reason: 'Cancel personal withdrawal' })).statusCode).toBe(201)
    const reverse = h.deps.ledger.entries.at(-1)!
    expect((await request('GET', '/company/owner-withdrawals')).json().withdrawals).toHaveLength(0)
    expect((await request('POST', `/journal/${reverse.id}/reverse`, { branchId: BRANCH, reason: 'Restore verified personal withdrawal' })).statusCode).toBe(201)
    const read = (await request('GET', '/company/owner-withdrawals')).json()
    expect(read.totals.SYP_NEW).toBe('70000.00')
    expect(read.withdrawals).toHaveLength(1)
    expect(read.withdrawals[0]).toMatchObject({ status: 'corrected', journalEntryId: entry.id, journalEntryIds: [entry.id, reverse.id, h.deps.ledger.entries.at(-1)!.id] })
  })

  it('counts a replacement withdrawal only once after the original is reversed', async () => {
    const original = await companyWithdrawal('20.00', 'SYP_NEW')
    expect((await request('POST', '/company/reversals', { idempotencyKey: crypto.randomUUID(), targetId: original.command.id, reason: 'Correct the withdrawal amount' })).statusCode).toBe(201)
    const replacement = await request('POST', '/company/withdrawals', { idempotencyKey: crypto.randomUUID(), currency: 'SYP_NEW', amount: '12.34', reason: 'Correct replacement amount' })
    expect(replacement.statusCode, replacement.body).toBe(201)
    const feed = (await request('GET', '/company/owner-withdrawals')).json()
    expect(feed.totals.SYP_NEW).toBe('12.34'); expect(feed.withdrawals).toHaveLength(1)
    expect(feed.withdrawals[0].journalEntryId).toBe(replacement.json().command.journalEntryId)
  })

  it('supports a verified legacy HQ journal without a duplicate command and excludes mixed non-withdrawals', async () => {
    await companyWithdrawal()
    const original = structuredClone(h.deps.ledger.entries.at(-1)!)
    vi.spyOn(h.deps.companyLedger, 'listCommands').mockResolvedValue([])
    const feed = (await request('GET', '/company/owner-withdrawals')).json()
    expect(feed.totals.USD).toBe('960.00')
    expect(feed.withdrawals[0]).toMatchObject({ occurrenceSource: 'business_date', journalEntryId: original.id })
    h.deps.ledger.entries.push({ ...original, id: original.id + 100, lines: [...original.lines, ...original.lines], reason: 'Mixed event, never guess a withdrawal' })
    expect((await request('GET', '/company/owner-withdrawals')).json().withdrawals).toHaveLength(1)
  })

  it('does not classify funding, custody, expenses or company transfers by the description text', async () => {
    await request('POST', '/company/deposits', { idempotencyKey: crypto.randomUUID(), currency: 'SYP_NEW', amount: '1000.00', reason: 'Personal withdrawal in misleading deposit description' })
    const custody = await request('POST', '/company/custody/transfers', { idempotencyKey: crypto.randomUUID(), direction: 'to_custody', currency: 'SYP_NEW', amount: '100.00', occurredOn: '2026-07-21', reason: 'Owner personal withdrawal text, but company custody' })
    expect(custody.statusCode, custody.body).toBe(201)
    await request('POST', '/treasury/deposit', { branchId: BRANCH, target: 'cash', amount: '100.00', note: 'Owner personal withdrawal text, but funding', idempotencyKey: crypto.randomUUID() })
    const seed = structuredClone(h.deps.ledger.entries.at(-1)!)
    h.deps.ledger.entries.push({ ...seed, id: seed.id + 100, eventType: 'manual', lines: [
      { fundCode: 'office_cash', side: 'C', currency: 'SYP_NEW', amount: 100n as typeof seed.lines[0]['amount'] },
      { fundCode: 'company_box', side: 'D', currency: 'SYP_NEW', amount: 100n as typeof seed.lines[0]['amount'] },
    ], reason: 'Owner personal withdrawal text, but branch transfer' })
    expect((await request('GET', '/company/owner-withdrawals')).json()).toMatchObject({ totals: { SYP_NEW: '0.00', USD: '0.00' }, withdrawals: [] })
  })

  it('walks all branch cursor pages, deduplicates repeated evidence, and ignores invalid reversal claims', async () => {
    const { entry } = await branchWithdrawal('12.00')
    const old = { ...entry, id: 1 }, latest = { ...entry, id: 501 }
    const forged = { ...entry, id: 500, eventType: 'correction' as const, occurrenceKey: 'reversal-of-1', lines: entry.lines.map(l => ({ ...l, side: l.side === 'D' ? 'C' as const : 'D' as const, amount: 100n as typeof l.amount })) }
    const spy = vi.spyOn(h.deps.ledger, 'listTreasuryMovements').mockImplementation(async (_branch, filter) => ({
      entries: filter.beforeId === undefined ? [latest, forged] : [old, latest], nextBeforeId: filter.beforeId === undefined ? 500 : null, eventTypes: [], actorIds: [],
    }))
    const company = (await h.deps.directory.companyBranch())!
    vi.spyOn(h.deps.directory, 'listBranches').mockResolvedValue([(await h.deps.directory.branch(BRANCH))!])
    const rows = await readOwnerWithdrawals(h.deps, company, '2026-07-21')
    expect(rows.map(row => row.amount)).toEqual(['12.00', '12.00'])
    expect(new Set(rows.map(row => row.id)).size).toBe(2)
    expect(spy).toHaveBeenCalledTimes(4)
  })

  it('fails explicitly on a non-progressing cursor instead of publishing incomplete totals', async () => {
    vi.spyOn(h.deps.ledger, 'listTreasuryMovements').mockResolvedValue({ entries: [], nextBeforeId: 50, eventTypes: [], actorIds: [] })
    const response = await request('GET', '/company/owner-withdrawals')
    expect(response.statusCode).toBe(500)
    expect(response.json().error).toBe('owner_withdrawal_cursor_invalid')
    expect(response.json().totals).toBeUndefined()
  })

  it('requires company permissions and validates detail dates', async () => {
    const manager = await h.loginAs('manager'), driver = await h.loginAs('driver1'), admin = await h.loginAs('sysadmin')
    for (const token of [manager, driver]) expect((await request('GET', '/company/owner-withdrawals', undefined, token)).statusCode).toBe(403)
    expect((await request('GET', '/company/owner-withdrawals', undefined, admin)).statusCode).toBe(200)
    expect((await h.app.inject({ method: 'GET', url: '/company/owner-withdrawals' })).statusCode).toBe(401)
    for (const [query, status] of [['from=2026-07-22&to=2026-07-21', 422], ['from=2026-02-30', 400], ['to=2026-07-22', 422], ['from=1999-12-31', 422]] as const) {
      expect((await request('GET', `/company/owner-withdrawals?${query}`)).statusCode).toBe(status)
    }
  })
})
