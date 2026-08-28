import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, type Harness, makeHarness, sypStr } from './harness.ts'

/**
 * «المدخول المباشر» (owner request, 2026-08-28) — money arriving at the branch that is not a
 * delivery fee: a scrap sale, a damage recovery, a sponsor.
 *
 * Until now this was recorded as an uncategorised manual journal entry, which is how a battery sale
 * ends up indistinguishable from a correction.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })
const post = async (token: string, url: string, payload: unknown = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload: payload as object })

const category = async (): Promise<string> => {
  const admin = await h.loginAs('sysadmin')
  const res = await post(admin, '/income-categories', { code: 'SCRAP', nameAr: 'بيع خردة' })
  expect(res.statusCode, res.body).toBe(201)
  return res.json().id as string
}

const body = (categoryId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  idempotencyKey: crypto.randomUUID(),
  categoryId,
  channel: 'office_cash',
  amount: sypStr(25_000),
  description: 'بيع بطارية تالفة',
  ...over,
})

describe('recording a direct income', () => {
  it('posts the row and its journal together, and the entry balances', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/incomes', body(categoryId))
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().amount).toBe(sypStr(25_000))

    // An income row without its journal cannot exist: the column is NOT NULL, unlike an expense's.
    expect(res.json().journalEntryId).toBeGreaterThan(0)
    const entry = h.deps.ledger.entries.find((e) => e.id === res.json().journalEntryId)
    expect(entry?.eventType).toBe('income')
    const debits = entry!.lines.filter((l) => l.side === 'D').reduce((a, l) => a + l.amount, 0n)
    const credits = entry!.lines.filter((l) => l.side === 'C').reduce((a, l) => a + l.amount, 0n)
    expect(debits).toBe(credits)
  })

  it('debits the box the operator named and credits other_income, never company_revenue', async () => {
    // BR4 reserves `company_revenue` for the company's residual share of DELIVERY FEES. Folding a
    // scrap sale into it would overstate the delivery business in /dashboard/profit for ever.
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/incomes', body(categoryId, { channel: 'office_wallet' }))
    expect(res.statusCode, res.body).toBe(201)

    const entry = h.deps.ledger.entries.find((e) => e.id === res.json().journalEntryId)!
    expect(entry.lines.filter((l) => l.side === 'D').map((l) => l.fundCode)).toEqual(['office_wallet'])
    expect(entry.lines.filter((l) => l.side === 'C').map((l) => l.fundCode)).toEqual(['other_income'])
    expect(entry.lines.map((l) => l.fundCode)).not.toContain('company_revenue')
  })

  it('is idempotent: the same key replays the first row instead of posting twice', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    const payload = body(categoryId)

    const first = await post(manager, '/incomes', payload)
    expect(first.statusCode, first.body).toBe(201)
    const second = await post(manager, '/incomes', payload)
    expect(second.statusCode, second.body).toBe(200)

    expect(second.json().id).toBe(first.json().id)
    expect(h.deps.ledger.entries.filter((e) => e.eventType === 'income')).toHaveLength(1)
  })

  it('refuses a replay that changed the CHANNEL — the money would stand against the wrong box', async () => {
    // Without comparing the channel this returns 200 and silently leaves the original cash row in
    // place while the caller believes he recorded a wallet receipt.
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    const payload = body(categoryId, { channel: 'office_cash' })
    expect((await post(manager, '/incomes', payload)).statusCode).toBe(201)

    const flipped = await post(manager, '/incomes', { ...payload, channel: 'office_wallet' })
    expect(flipped.statusCode, flipped.body).toBe(409)
    expect(flipped.json().error).toBe('idempotency_key_conflict')
  })

  it('refuses a replay that changed the amount or the category', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    const payload = body(categoryId)
    expect((await post(manager, '/incomes', payload)).statusCode).toBe(201)

    expect((await post(manager, '/incomes', { ...payload, amount: sypStr(26_000) })).statusCode).toBe(409)
  })

  it('refuses an unknown category rather than posting an unattributed receipt', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/incomes', body('00000000-0000-4000-8000-00000000dead'))
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error).toBe('unknown_income_category')
  })

  it('refuses a zero or negative amount', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    expect((await post(manager, '/incomes', body(categoryId, { amount: sypStr(0) }))).statusCode).toBe(400)
    expect((await post(manager, '/incomes', body(categoryId, { amount: '-100.00' }))).statusCode).toBe(400)
  })

  it('is audited, like every other posted money movement', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await post(manager, '/incomes', body(categoryId))
    const rows = await h.deps.audit.list({ tableName: 'incomes' })
    expect(rows.length).toBeGreaterThan(0)
  })

  it('lists what was recorded, with a total', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await post(manager, '/incomes', body(categoryId, { amount: sypStr(10_000) }))
    await post(manager, '/incomes', body(categoryId, { amount: sypStr(5_000) }))

    const res = await get(manager, '/incomes')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().incomes).toHaveLength(2)
    expect(res.json().total).toBe(sypStr(15_000))
  })
})

describe('who may record an income', () => {
  it('the branch manager may — he already holds expense.write at branch scope', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    expect((await post(manager, '/incomes', body(categoryId))).statusCode).toBe(201)
  })

  it('the system admin may too, per owner decision 9', async () => {
    // The same permission the Expenses screen used to deny him by hardcoding a role list.
    const categoryId = await category()
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/incomes', { ...body(categoryId), branchId: BRANCH })
    expect(res.statusCode, res.body).toBe(201)
  })

  it('a driver may not', async () => {
    const categoryId = await category()
    const driver = await h.loginAs('driver1')
    expect((await post(driver, '/incomes', body(categoryId))).statusCode).toBe(403)
  })

  it('only the system admin defines categories', async () => {
    const manager = await h.loginAs('manager')
    expect((await post(manager, '/income-categories', { code: 'X', nameAr: 'س' })).statusCode).toBe(403)
  })
})
