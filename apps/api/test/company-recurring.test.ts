import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMPANY_BRANCH, type Harness, makeHarness, sypStr, today } from './harness.ts'

let h: Harness
let gm: string

const post = async (token: string, url: string, payload: Record<string, unknown>) => h.app.inject({
  method: 'POST', url, headers: { cookie: h.cookie(token) }, payload,
})

beforeEach(async () => {
  h = await makeHarness()
  gm = await h.loginAs('gm')
})

afterEach(async () => h.app.close())

describe('company recurring expenses', () => {
  it('stays human-triggered and links one due occurrence to one HQ expense command', async () => {
    const sysadmin = await h.loginAs('sysadmin')
    const category = await post(sysadmin, '/expense-categories', { code: 'HQ-RENT', nameAr: 'إيجار المركز' })
    expect(category.statusCode, category.body).toBe(201)
    const categoryId = category.json().id as string

    const denied = await post(await h.loginAs('manager'), '/company/recurring-expenses', {
      idempotencyKey: crypto.randomUUID(), title: 'HQ rent', categoryId,
      currency: 'SYP_NEW', paidFrom: 'pocket', amount: sypStr(100),
      scheduleKind: 'weekly', weekday: 2, intervalDays: null, startsOn: today, endsOn: null,
    })
    expect(denied.statusCode).toBe(403)

    await post(gm, '/company/deposits', {
      idempotencyKey: crypto.randomUUID(), currency: 'SYP_NEW', amount: sypStr(1_000), reason: 'seed',
    })
    const templateId = crypto.randomUUID()
    const created = await post(gm, '/company/recurring-expenses', {
      idempotencyKey: templateId,
      title: 'HQ rent',
      categoryId,
      costCenterKind: 'general',
      vehicleId: null,
      assetId: null,
      currency: 'SYP_NEW',
      paidFrom: 'pocket',
      amount: sypStr(100),
      scheduleKind: 'weekly',
      weekday: 2,
      intervalDays: null,
      startsOn: today,
      endsOn: null,
    })
    expect(created.statusCode, created.body).toBe(201)

    const due = await h.app.inject({ method: 'GET', url: '/company/recurring-expenses/due', headers: { cookie: h.cookie(gm) } })
    expect(due.statusCode, due.body).toBe(200)
    expect(due.json().due).toContainEqual(expect.objectContaining({ id: templateId, dueDate: today, status: 'today' }))
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(100_000n)

    const expenseId = crypto.randomUUID()
    const payment = {
      idempotencyKey: expenseId, amount: sypStr(100), reason: null, receiptMediaId: null,
    }
    const paid = await post(gm, `/company/recurring-expenses/${templateId}/occurrences/${today}/pay`, payment)
    expect(paid.statusCode, paid.body).toBe(201)
    expect(paid.json()).toMatchObject({ replayed: false, occurrence: { companyExpenseId: expenseId } })
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(90_000n)
    expect((await h.deps.companyLedger.findCommand(expenseId))?.kind).toBe('expense')

    const replay = await post(gm, `/company/recurring-expenses/${templateId}/occurrences/${today}/pay`, payment)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().replayed).toBe(true)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(90_000n)
  })
})
