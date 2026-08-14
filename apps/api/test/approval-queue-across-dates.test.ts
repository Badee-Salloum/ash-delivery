import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, approveFixedClose, makeHarness, sypStr, today } from './harness.ts'

/**
 * A shift waiting for approval does not stop waiting at midnight.
 *
 * The approval queue read `GET /shifts`, which is date-filtered and defaults to TODAY, and filtered
 * the states client-side. So a close the driver submitted on Saturday evening and the manager did
 * not approve before midnight left the queue on its own: the shift stayed `pending_review`, its
 * money stayed unposted, no ledger line existed, and the single screen whose job is to show him
 * outstanding work no longer listed it. It was found in production — a shift the owner had closed
 * two days earlier was simply not there.
 *
 * `?pending=1` asks the question the queue is actually asking, which is not about a date.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (t: string, url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(t) }, payload })
const put = async (t: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(t) }, payload })
const get = async (t: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(t) } })

/** Two days before the harness clock — a close the manager did not get to before midnight. */
const PAST_DAY = '2026-07-19'

/** A shift at the close gate, balanced, whose business date is then back-dated to a past day. */
async function pendingReviewOnAnEarlierDay(driver: string, manager: string): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json()
    .id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
  await post(driver, `/shifts/${id}/orders`, { providerOrderNo: 'A-1', payMode: 'cash', fee: sypStr(5_000) })
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 110,
    batteryPercent: 50,
    cashDeclared: sypStr(105_000),
    walletDeclared: sypStr(-1_000),
  })

  // Move it into the past exactly as a night rolling over would. The day needs its own FX rate:
  // `resolveFxDay` carries the nearest EARLIER one forward, and there is none before the seed.
  await h.deps.fx.upsert({ businessDate: PAST_DAY, sypMinorPerUsd: 13_000n, provisional: false })
  const shift = await h.deps.shifts.findById(id)
  await h.deps.shifts.update({ ...shift!, businessDate: PAST_DAY }, 'u-bm')
  return id
}

describe('the approval queue across dates', () => {
  it('still lists a shift submitted on an earlier day — an approval does not expire at midnight', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await pendingReviewOnAnEarlierDay(driver, manager)

    // The old read: today's shifts. This is what made it disappear, and it is still date-filtered
    // for every other caller — the regression is only that the QUEUE used it.
    const byDate = (await get(manager, '/shifts')).json()
    expect(byDate.businessDate).toBe(today)
    expect(byDate.shifts.map((s: { id: string }) => s.id)).not.toContain(id)

    // The queue's read: what is waiting, whenever it arrived.
    const pending = (await get(manager, '/shifts?pending=1')).json()
    const row = pending.shifts.find((s: { id: string }) => s.id === id)
    expect(row).toBeDefined()
    expect(row.state).toBe('pending_review')
    // And it still carries what the manager triages on.
    expect(row.equationDiff).toBe('0.00')
    expect(row.orderCount).toBe(1)
  })

  it('lists an open gate from an earlier day too — a driver cannot start until it is cleared', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json()
      .id as string
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
    const shift = await h.deps.shifts.findById(id)
    await h.deps.shifts.update({ ...shift!, businessDate: PAST_DAY }, 'u-bm')

    const pending = (await get(manager, '/shifts?pending=1')).json()
    expect(pending.shifts.map((s: { id: string }) => s.id)).toContain(id)
  })

  it('leaves the list the moment it is decided — the queue is outstanding work, not history', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await pendingReviewOnAnEarlierDay(driver, manager)

    const hash = (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash
    const approved = await approveFixedClose(h, manager, id, hash)
    expect(approved.statusCode).toBe(200)

    const pending = (await get(manager, '/shifts?pending=1')).json()
    expect(pending.shifts.map((s: { id: string }) => s.id)).not.toContain(id)
  })

  it('stays inside the branch — a pending shift elsewhere is not this manager’s to see', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await pendingReviewOnAnEarlierDay(driver, manager)

    const other = await h.loginAs('manager2')
    const pending = await get(other, '/shifts?pending=1')
    // Either he is scoped to his own branch and sees none of this one's, or he cannot ask at all.
    if (pending.statusCode === 200) {
      expect(pending.json().shifts).toHaveLength(0)
    } else {
      expect(pending.statusCode).toBeGreaterThanOrEqual(400)
    }
  })
})
