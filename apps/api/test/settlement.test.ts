import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * «كشف التسوية» over HTTP — the manager's answer to «كم يجب ان يسحب و يدخل للصندوق وكم يجب ان
 * يعاد للسائق».
 *
 * The property under test is that it MOVES NOTHING. It is the screen a manager reads before he
 * signs, and a preview that posts is worse than no preview at all.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>
const get = async (t: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(t) } })
const post = async (t: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(t) }, payload })
const put = async (t: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(t) }, payload })

/** A shift driven to `pending_review` with one 5,000 fee, closing exactly at BR1 zero. */
async function shiftAwaitingApproval(): Promise<{ manager: string; shiftId: string }> {
  const driver = await h.loginAs('driver1')
  const manager = await h.loginAs('manager')
  const shiftId = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })).json().id as string

  await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
  await put(driver, `/shifts/${shiftId}/start-package`, { odometerKm: 1000, batteryPercent: 90 })
  await post(manager, `/shifts/${shiftId}/approve-open`, {
    floatTranches: [sypStr(100_000)],
    topupTranches: [sypStr(50_000)],
  })
  await post(driver, `/shifts/${shiftId}/orders`, { providerOrderNo: 'S-1', payMode: 'cash', fee: sypStr(5_000) })
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, shiftId, 'end', slot)
  // cash = float + the whole fee; wallet = top-up − Yallago's 20%. BR1 closes at exactly zero.
  await put(driver, `/shifts/${shiftId}/end-package`, {
    odometerKm: 1_040,
    batteryPercent: 50,
    cashDeclared: sypStr(105_000),
    walletDeclared: sypStr(49_000),
  })
  return { manager, shiftId }
}

describe('كشف التسوية', () => {
  it('distributes the declared cash and leaves the share with the driver', async () => {
    const { manager, shiftId } = await shiftAwaitingApproval()
    const res = await get(manager, `/shifts/${shiftId}/settlement`)
    expect(res.statusCode, res.body).toBe(200)
    const s = res.json()

    // The three destinations must sum back to what he declared — the whole safety property.
    const sum = (...xs: string[]) => xs.reduce((a, b) => a + Number(b), 0)
    expect(sum(s.toOfficeCash, s.paidToDriver, s.keptAsReceivable)).toBeCloseTo(105_000, 2)
    expect(s.feasible).toBe(true)
  })

  it('moves money into the ذمة without touching the share', async () => {
    const { manager, shiftId } = await shiftAwaitingApproval()
    const plain = (await get(manager, `/shifts/${shiftId}/settlement`)).json()
    const kept = (await get(manager, `/shifts/${shiftId}/settlement?keepAsReceivable=40000.00`)).json()

    expect(kept.keptAsReceivable).toBe(sypStr(40_000))
    expect(kept.paidToDriver).toBe(plain.paidToDriver)
    expect(Number(kept.toOfficeCash)).toBeCloseTo(Number(plain.toOfficeCash) - 40_000, 2)
  })

  it('sends everything to the box when the share is not paid tonight', async () => {
    const { manager, shiftId } = await shiftAwaitingApproval()
    const res = await get(manager, `/shifts/${shiftId}/settlement?payShareNow=false`)
    expect(res.json().paidToDriver).toBe(sypStr(0))
    expect(res.json().toOfficeCash).toBe(sypStr(105_000))
  })

  it('refuses a ذمة larger than the cash he is holding', async () => {
    const { manager, shiftId } = await shiftAwaitingApproval()
    const res = await get(manager, `/shifts/${shiftId}/settlement?keepAsReceivable=999999.00`)
    expect(res.json().feasible).toBe(false)
    expect(res.json().refusals).toContain('keep_exceeds_end_cash')
  })

  /** A preview that posts is worse than no preview. Nothing may reach the ledger from a GET. */
  it('POSTS NOTHING — the ledger is untouched by reading it', async () => {
    const { manager, shiftId } = await shiftAwaitingApproval()
    const before = await h.deps.ledger.listByShift(shiftId)
    await get(manager, `/shifts/${shiftId}/settlement?keepAsReceivable=40000.00`)
    await get(manager, `/shifts/${shiftId}/settlement?payShareNow=false`)
    expect(await h.deps.ledger.listByShift(shiftId)).toHaveLength(before.length)
  })

  it('is refused to a driver — it names his share and the branch`s takings', async () => {
    const driver = await h.loginAs('driver1')
    const { shiftId } = await shiftAwaitingApproval()
    expect((await get(driver, `/shifts/${shiftId}/settlement`)).statusCode).toBe(403)
  })
})
