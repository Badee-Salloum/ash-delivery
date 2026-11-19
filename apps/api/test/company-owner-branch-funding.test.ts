import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRANCH, COMPANY_BRANCH, OTHER_BRANCH, type Harness, makeHarness } from './harness.ts'
import { ownerBranchFundingRead } from '../src/company-movement-read.service.ts'

let h: Harness
let gm: string
const request = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, token = gm) =>
  h.app.inject({ method, url, headers: { cookie: h.cookie(token) }, ...(payload === undefined ? {} : { payload }) })
const deposit = (amount: string, branchId = BRANCH, target = 'cash', key = crypto.randomUUID()) =>
  request('POST', '/treasury/deposit', { branchId, idempotencyKey: key, target, amount, note: 'owner funding received by branch' })

beforeEach(async () => { h = await makeHarness(); gm = await h.loginAs('gm') })
afterEach(async () => { vi.restoreAllMocks(); await h.app.close() })

describe('existing direct owner-to-branch funding read model', () => {
  it('separates branch funding from expenses, capital payments and HQ owner deposits without writing anything', async () => {
    expect((await deposit('12.00')).statusCode).toBe(201)
    expect((await deposit('8.00', OTHER_BRANCH, 'wallet')).statusCode).toBe(201)
    expect((await request('POST', '/company/deposits', { idempotencyKey: crypto.randomUUID(),
      currency: 'SYP_NEW', amount: '50.00', reason: 'actual owner deposit into HQ' })).statusCode).toBe(201)
    const snapshot = structuredClone(h.deps.ledger.entries)
    const feed = await request('GET', '/company/owner-payments')
    expect(feed.statusCode, feed.body).toBe(200)
    expect(feed.json()).toMatchObject({ totals: { SYP_NEW: '0.00', USD: '0.00' },
      expenseTotals: { SYP_NEW: '0.00', USD: '0.00' }, capitalAndDebtTotals: { SYP_NEW: '0.00', USD: '0.00' },
      branchFundingBasis: 'current_verified_receipts_by_business_date',
      branchFundingTotals: { SYP_NEW: '20.00', USD: '0.00' }, payments: [] })
    expect(feed.json().branchFundingPayments).toHaveLength(2)
    expect(feed.json().branchFundingPayments).toEqual(expect.arrayContaining([
      expect.objectContaining({ branchId: BRANCH, branchNameAr: 'دمشق', channel: 'cash', amount: '12.00',
        companyCashEffect: '0.00', expenseEffect: '0.00', occurredOn: '2026-07-21' }),
      expect.objectContaining({ branchId: OTHER_BRANCH, channel: 'wallet', amount: '8.00' }),
    ]))
    expect(h.deps.ledger.entries).toEqual(snapshot)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(5000n)
  })

  it('counts a retried deposit once and collapses verified reversal chains into the original receipt', async () => {
    const key = crypto.randomUUID()
    expect((await deposit('12.00', BRANCH, 'cash', key)).statusCode).toBe(201)
    expect((await deposit('12.00', BRANCH, 'cash', key)).statusCode).toBe(200)
    const original = h.deps.ledger.entries[0]!
    expect((await request('GET', '/company/owner-payments')).json().branchFundingTotals.SYP_NEW).toBe('12.00')
    expect((await request('POST', `/journal/${original.id}/reverse`, { branchId: BRANCH, reason: 'funding not received' })).statusCode).toBe(201)
    const reverse = h.deps.ledger.entries[1]!
    const cancelled = (await request('GET', '/company/owner-payments')).json()
    expect(cancelled.branchFundingTotals.SYP_NEW).toBe('0.00')
    expect(cancelled.branchFundingPayments).toHaveLength(0)
    expect((await request('POST', `/journal/${reverse.id}/reverse`, { branchId: BRANCH, reason: 'funding receipt verified again' })).statusCode).toBe(201)
    const restored = (await request('GET', '/company/owner-payments')).json()
    expect(restored.branchFundingTotals.SYP_NEW).toBe('12.00')
    expect(restored.branchFundingPayments).toHaveLength(1)
    expect(restored.branchFundingPayments[0]).toMatchObject({ journalEntryId: original.id,
      journalEntryIds: h.deps.ledger.entries.map(entry => entry.id), occurredOn: original.businessDate })
  })

  it('uses the original actual deposit day and never exposes company-wide funding to a branch manager', async () => {
    expect((await deposit('12.00')).statusCode).toBe(201)
    h.deps.clock.advance(24 * 60 * 60 * 1000)
    gm = await h.loginAs('gm')
    expect((await request('GET', '/company/owner-payments?from=2026-07-22&to=2026-07-22')).json().branchFundingPayments).toHaveLength(0)
    const originalDay = (await request('GET', '/company/owner-payments?from=2026-07-21&to=2026-07-21')).json()
    expect(originalDay.branchFundingTotals.SYP_NEW).toBe('12.00')
    const manager = await h.loginAs('manager')
    expect((await request('GET', '/company/owner-payments', undefined, manager)).statusCode).toBe(403)
  })

  it('reads every cursor page exactly once and refuses mixed movements and forged reversal references', async () => {
    expect((await deposit('12.00')).statusCode).toBe(201)
    const original = structuredClone(h.deps.ledger.entries[0]!)
    const older = { ...structuredClone(original), id: 1 }
    const newer = { ...structuredClone(original), id: 501, occurrenceKey: 'different-owner-payment' }
    const mixed = { ...structuredClone(original), id: 500, lines: [...original.lines,
      { fundCode: 'company_box', side: 'C' as const, currency: 'SYP_NEW' as const, amount: 1n as typeof original.lines[0]['amount'] }] }
    const forged = { ...structuredClone(original), id: 499, eventType: 'correction' as const,
      occurrenceKey: 'reversal-of-1', lines: original.lines.map(line => ({ ...line,
        side: line.side === 'D' ? 'C' as const : 'D' as const, amount: 100n as typeof line.amount })) }
    const pageRead = vi.spyOn(h.deps.ledger, 'listTreasuryMovements').mockImplementation(async (_branchId, filter) => ({
      entries: filter.beforeId === undefined ? [newer, mixed, forged] : [older],
      nextBeforeId: filter.beforeId === undefined ? 499 : null, eventTypes: [], actorIds: [],
    }))
    const result = await ownerBranchFundingRead(h.deps, [(await h.deps.directory.branch(BRANCH))!],
      '2000-01-01', '2026-07-21', '2026-07-21')
    expect(result.totals.SYP_NEW).toBe('24.00')
    expect(result.payments).toHaveLength(2)
    expect(pageRead).toHaveBeenCalledTimes(4)
    expect(new Set(pageRead.mock.calls.map(call => call[1].eventType))).toEqual(new Set(['manual', 'correction']))
    expect(pageRead.mock.calls[1]![1].beforeId).toBe(499)
  })
})
