import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * The manager corrects a fee.
 *
 * Until now his only move against a fee he disbelieved was to untick the whole delivery — throwing
 * away a real order to fix one wrong number. He is the person verifying against the cash in his
 * hand, so he is the one placed to say what the fee actually was.
 *
 * Two things must hold, and they are what these pin: the correction moves the money, and it moves
 * `orders_hash`, so he cannot approve figures he has not re-read.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (token: string, url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

/** A shift at the close gate with one order, and the cash to match a 5,000 fee. */
async function pendingReview(driver: string, manager: string): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
  await post(driver, `/shifts/${id}/orders`, { providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(5_000) })
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 110,
    batteryPercent: 50,
    // A cash order puts the WHOLE fee in his hand and takes Yallago's 20% out of the wallet:
    // cash 100,000 + 5,000 = 105,000, wallet −1,000. Together 104,000 = float + 0.80 × 5,000. ✔
    cashDeclared: sypStr(105_000),
    walletDeclared: sypStr(-1_000),
  })
  return id
}

describe('a manager corrects a fee', () => {
  it('changes the money — the equation moves with it', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await pendingReview(driver, manager)
    expect((await get(manager, `/shifts/${id}/review`)).json().br1.balanced).toBe(true)

    // He counts the cash and the fee was really 4,000, not 5,000.
    const revised = await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'A-1', fee: sypStr(4_000) }],
    })
    expect(revised.statusCode, revised.body).toBe(200)

    const after = (await get(manager, `/shifts/${id}/review`)).json()
    expect(after.orders[0].fee).toBe(sypStr(4_000))
    // The declared cash no longer matches a smaller fee, so the shift stops balancing — which is
    // the correction doing its job rather than a failure.
    expect(after.br1.balanced).toBe(false)
  })

  it('moves the orders hash, so the approval he was about to make cannot go through', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await pendingReview(driver, manager)
    const staleHash = (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash

    await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'A-1', fee: sypStr(4_000) }],
    })
    const freshHash = (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash

    // The hash moving is the whole mechanism: it is what makes the figures he read stale.
    expect(freshHash).not.toBe(staleHash)

    // And the approval is refused. The close gate checks the equation BEFORE the hash, so a
    // correction that unbalances the shift is caught as `br1_not_zero` rather than as staleness —
    // either way the ledger is not posted from figures nobody re-read.
    const stale = await post(manager, `/shifts/${id}/approve-close`, { reviewedOrdersHash: staleHash })
    expect(stale.statusCode).not.toBe(200)
    expect((await get(manager, `/shifts/${id}/review`)).json().state).toBe('pending_review')
  })

  it('records WHO changed it — a fee is money and money is attributed', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await pendingReview(driver, manager)
    await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'A-1', fee: sypStr(4_000) }],
    })
    const rows = await h.deps.audit.list({ tableName: 'shifts', recordId: id })
    const revised = rows.filter((r) => r.after !== null && 'revisedByManager' in (r.after as object))
    expect(revised.length).toBeGreaterThan(0)
    expect(revised.at(-1)!.actorId).toBeTruthy()
  })

  it('refuses a negative fee — that would turn Yallago’s cut into a credit', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await pendingReview(driver, manager)

    const res = await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'A-1', fee: sypStr(-5_000) }],
    })
    expect(res.statusCode).toBe(400)

    // And the fee is untouched — a rejected request writes nothing.
    const review = (await get(manager, `/shifts/${id}/review`)).json()
    expect(review.orders[0].fee).toBe(sypStr(5_000))
  })

  it('still refuses a driver — correcting a fee is the manager\u2019s power, not his', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await pendingReview(driver, manager)
    const res = await post(driver, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'A-1', fee: sypStr(9_000) }],
    })
    expect([401, 403]).toContain(res.statusCode)
  })
})
