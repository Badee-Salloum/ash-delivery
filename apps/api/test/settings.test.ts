import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Harness, makeHarness, sypStr } from './harness.ts'

/**
 * The system-settings surface (SRS A-4): the daily FX rate and the general operating constants —
 * both had endpoints/enforcement but, until now, no screen and (for FX) no read route or audit.
 *
 * These pin the three things that matter: only the system admin may read or write them; the FX
 * write is audited (it gates every day's USD figures and the Sunday close); and a ceiling set
 * through /settings is actually ENFORCED on the expense path, which is the whole point of the
 * "approval-ceiling editor".
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })
const put = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })
const post = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })

describe('the daily FX rate (BR6)', () => {
  it('a system admin enters today’s rate and reads it back as entered', async () => {
    const admin = await h.loginAs('sysadmin')
    const today = (await get(admin, '/fx')).json().businessDate

    // 130.00 SYP/USD = 13000 minor units per USD.
    const set = await put(admin, '/fx', { businessDate: today, sypMinorPerUsd: 13_000 })
    expect(set.statusCode, set.body).toBe(200)

    const read = await get(admin, '/fx')
    expect(read.json().sypMinorPerUsd).toBe(13_000)
    expect(read.json().provisional).toBe(false)
  })

  it('audits the rate change — it gates every day’s USD figures and the Sunday close', async () => {
    const admin = await h.loginAs('sysadmin')
    const today = (await get(admin, '/fx')).json().businessDate
    await put(admin, '/fx', { businessDate: today, sypMinorPerUsd: 13_500 })

    const rows = await h.deps.audit.list({ tableName: 'fx_days' })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.actorId === 'u-sa')).toBe(true)
  })

  it('is refused to a general manager and a branch manager', async () => {
    const today = '2026-07-21'
    expect((await put(await h.loginAs('gm'), '/fx', { businessDate: today, sypMinorPerUsd: 13_000 })).statusCode).toBe(403)
    expect((await put(await h.loginAs('manager'), '/fx', { businessDate: today, sypMinorPerUsd: 13_000 })).statusCode).toBe(403)
    expect((await get(await h.loginAs('gm'), '/fx')).statusCode).toBe(403)
  })
})

describe('general settings', () => {
  it('a system admin sets the receipt ceiling and the kWh price, and reads them back', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await put(admin, '/settings', { receiptCeilingMinor: sypStr(10_000), kwhPriceMinor: sypStr(250) })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().updated).toEqual(
      expect.arrayContaining(['expense.receipt_required_above_minor', 'vehicle.kwh_price_minor']),
    )

    const read = await get(admin, '/settings')
    expect(read.json().receiptCeilingMinor).toBe(sypStr(10_000))
    expect(read.json().kwhPriceMinor).toBe(sypStr(250))
  })

  it('changing one setting leaves the other alone', async () => {
    const admin = await h.loginAs('sysadmin')
    await put(admin, '/settings', { receiptCeilingMinor: sypStr(10_000), kwhPriceMinor: sypStr(250) })
    await put(admin, '/settings', { kwhPriceMinor: sypStr(300) })

    const read = await get(admin, '/settings')
    expect(read.json().receiptCeilingMinor).toBe(sypStr(10_000)) // untouched
    expect(read.json().kwhPriceMinor).toBe(sypStr(300))
  })

  it('is refused to a general manager and a branch manager', async () => {
    expect((await get(await h.loginAs('gm'), '/settings')).statusCode).toBe(403)
    expect((await put(await h.loginAs('manager'), '/settings', { kwhPriceMinor: sypStr(1) })).statusCode).toBe(403)
  })

  it('the write is audited', async () => {
    const admin = await h.loginAs('sysadmin')
    await put(admin, '/settings', { receiptCeilingMinor: sypStr(10_000) })
    const rows = await h.deps.audit.list({ tableName: 'settings' })
    expect(rows.some((r) => r.actorId === 'u-sa')).toBe(true)
  })
})

describe('the ceiling set through /settings is actually enforced', () => {
  const category = async (admin: string): Promise<string> =>
    (await post(admin, '/expense-categories', { code: 'FUEL', nameAr: 'وقود' })).json().id

  it('an over-ceiling expense needs a receipt; under-ceiling does not', async () => {
    // This is the point of the editor: the value it writes is the one the expense path reads.
    const admin = await h.loginAs('sysadmin')
    const categoryId = await category(admin)
    await put(admin, '/settings', { receiptCeilingMinor: sypStr(10_000) })

    const manager = await h.loginAs('manager')
    const base = { categoryId, costCenterKind: 'general', vehicleId: null, description: 'وقود' }

    const over = await post(manager, '/expenses', { ...base, idempotencyKey: crypto.randomUUID(), amount: sypStr(25_000) })
    expect(over.statusCode).toBe(422)
    expect(over.json().error).toBe('receipt_required')

    const withReceipt = await post(manager, '/expenses', {
      ...base,
      idempotencyKey: crypto.randomUUID(),
      amount: sypStr(25_000),
      receiptMediaId: '00000000-0000-4000-8000-000000000abc',
    })
    expect(withReceipt.statusCode, withReceipt.body).toBe(201)

    const under = await post(manager, '/expenses', { ...base, idempotencyKey: crypto.randomUUID(), amount: sypStr(5_000) })
    expect(under.statusCode, under.body).toBe(201)
  })
})
