import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMinor, usdToSypMinor } from '@ash/domain'
import { BRANCH, makeHarness, type Harness } from './harness.ts'

let h: Harness, gm: string, categoryId: string
const request = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  h.app.inject({ method, url, headers: { cookie: h.cookie(gm) }, ...(payload ? { payload } : {}) })
const get = async (url: string) => { const res = await request('GET', url); expect(res.statusCode, res.body).toBe(200); return res.json() }
const expense = async (amount: string, extra: Record<string, unknown> = {}) => {
  const res = await request('POST', '/company/expenses', { idempotencyKey: crypto.randomUUID(),
    currency: 'SYP_NEW', amount, categoryId, paidFrom: 'pocket', description: 'Expense fixture', ...extra })
  expect(res.statusCode, res.body).toBe(201); return res.json().command
}
const remove = async (id: string) => {
  const res = await request('POST', '/company/reversals', { idempotencyKey: crypto.randomUUID(), targetId: id, reason: 'Explicit deletion fixture' })
  expect(res.statusCode, res.body).toBe(201)
}
beforeEach(async () => {
  h = await makeHarness(); gm = await h.loginAs('gm'); categoryId = crypto.randomUUID()
  await h.deps.expenses.createCategory({ id: categoryId, code: categoryId, nameAr: 'مصروف', active: true })
  for (const currency of ['SYP_NEW', 'USD']) {
    const deposit = await request('POST', '/company/deposits', { idempotencyKey: crypto.randomUUID(), currency, amount: '20000.00', reason: 'Isolated fixture funds' })
    expect(deposit.statusCode, deposit.body).toBe(201)
  }
})
afterEach(async () => { await h.app.close() })

describe('deleted expenses have one current read model across finance and dashboard', () => {
  it('omits a deleted expense on its original day, reversal day and combined range, never classifies cancellation as income', async () => {
    const deleted = await expense('10000.00'), retained = await expense('9.50')
    h.deps.clock.advance(24 * 60 * 60 * 1000); gm = await h.loginAs('gm')
    await remove(deleted.id)
    const before = structuredClone(h.deps.ledger.entries)
    for (const [from, to, amount] of [['2026-07-21', '2026-07-21', '9.50'], ['2026-07-22', '2026-07-22', '0.00'], ['2026-07-21', '2026-07-22', '9.50']] as const) {
      const range = `from=${from}&to=${to}`
      const current = await get(`/company/reports?${range}&view=current_corrected&dateBasis=occurrence`)
      expect(current.rows.some((row: { canonicalCommandId: string }) => row.canonicalCommandId === deleted.id)).toBe(false)
      expect(current.totals.SYP_NEW).toMatchObject({ expense: amount, income: '0.00', cashPayments: amount })
      const overview = await get(`/company/overview?${range}`)
      expect(overview.expenseSourceBasis).toBe('current_corrected_occurrence')
      expect(overview.period.SYP_NEW).toMatchObject({ expense: amount, income: '0.00', companyFundedExpense: amount })
      const movements = await get(`/company/movements?${range}`)
      expect(movements.effectiveMovements.some((row: { command: { id: string; targetId?: string } | null }) => row.command?.id === deleted.id || row.command?.targetId === deleted.id)).toBe(false)
      const profit = await get(`/dashboard/profit?branchId=${BRANCH}&${range}`)
      expect(profit).toMatchObject({ companyBasis: 'current_corrected_occurrence', companyExpenseSyp: amount, companyIncomeSyp: '0.00' })
      expect(profit.days.reduce((total: bigint, row: { companyNetProfitSyp: string }) => total + parseMinor(row.companyNetProfitSyp), 0n)).toBe(-parseMinor(amount))
      if (amount !== '0.00') expect(current.rows.some((row: { canonicalCommandId: string }) => row.canonicalCommandId === retained.id)).toBe(true)
    }
    const audit = await get('/company/reports?from=2026-07-21&to=2026-07-22&view=as_booked&dateBasis=posting')
    const original = audit.rows.find((row: { canonicalCommandId: string; kind: string }) => row.canonicalCommandId === deleted.id && row.kind === 'expense')
    expect(original).toMatchObject({ grossAmount: '10000.00', netAmount: '10000.00', auditState: 'deleted_expense', postingDate: '2026-07-21' })
    expect(original.relatedEntryIds).toHaveLength(2)
    expect(audit.rows.some((row: { auditState: string }) => row.auditState === 'expense_deletion')).toBe(true)
    expect(h.deps.ledger.entries).toEqual(before)
  })

  it('uses effective corrections and frozen USD rates, excludes outside-owner evidence from company-profit costs, then deletes every replacement', async () => {
    const usd = await expense('2.00', { currency: 'USD' })
    const owner = await expense('7.00', { paidFrom: 'owner_outside' })
    const original = await expense('10.00')
    const draft = await request('POST', '/company/movement-corrections', { idempotencyKey: crypto.randomUUID(), targetId: original.id,
      expectedVersion: 1, reason: 'Checked receipt', values: { amount: '15.00' } })
    expect(draft.statusCode, draft.body).toBe(201)
    const confirmed = await request('POST', `/company/movement-corrections/${draft.json().correction.id}/confirm`, {
      idempotencyKey: crypto.randomUUID(), expectedVersion: 1, acknowledgeCashEffect: true })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const query = 'from=2026-07-21&to=2026-07-21'
    const current = await get(`/company/reports?${query}&view=current_corrected&dateBasis=occurrence`)
    const effective = current.rows.find((row: { canonicalCommandId: string }) => row.canonicalCommandId === original.id)
    const profit = await get(`/dashboard/profit?branchId=${BRANCH}&${query}`)
    expect(parseMinor(profit.companyExpenseSyp)).toBe(parseMinor('15.00') + usdToSypMinor(parseMinor('2.00'), BigInt(usd.sypMinorPerUsd)))
    expect((await get(`/company/owner-payments?${query}`)).totals.SYP_NEW).toBe('7.00')
    await remove(effective.activeCommandId); await remove(usd.id); await remove(owner.id)
    const before = structuredClone(h.deps.ledger.entries)
    const after = await get(`/company/reports?${query}&view=current_corrected`)
    expect(after.rows.filter((row: { kind: string }) => row.kind === 'expense' || row.kind === 'reversal')).toEqual([])
    expect(after.totals.USD.expense).toBe('0.00')
    expect((await get(`/company/owner-payments?${query}`)).totals.SYP_NEW).toBe('0.00')
    expect((await get(`/dashboard/profit?branchId=${BRANCH}&${query}`)).companyExpenseSyp).toBe('0.00')
    const audit = await get(`/company/reports?${query}&view=as_booked`)
    expect(audit.rows.filter((row: { auditState: string }) => row.auditState === 'deleted_expense')).toHaveLength(4)
    expect(h.deps.ledger.entries).toEqual(before)
  })
})
