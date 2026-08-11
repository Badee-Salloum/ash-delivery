import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_SHIFTS_PER_DAY } from '@ash/contracts'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * A DRIVER'S SECOND SHIFT OF THE DAY.
 *
 * `shifts_no_uq` is UNIQUE (driver_id, business_date, shift_no), and the driver's app hard-coded
 * `shiftNo: 1`. `canOpenShift` only asks whether a LIVE shift exists, and `cancelled`, `closed` and
 * `approved` are not live — so every gate passed, the INSERT hit the constraint, and the raw
 * DatabaseError fell through to the error handler's last branch as a bare 500. The driver read
 * «internal_error» on «بدء النوبة» with no odometer tile and no battery panel, because both of those
 * hang off a draft shift that was never created.
 *
 * Measured in production on 2026-08-12: five identical failures, one driver unable to work, and a
 * cancelled shift holding number 1 that could not be deleted — it carried four journal entries.
 *
 * The reason it survived: all ~40 API tests pass `shiftNo: 1` literally, and NOT ONE ever started a
 * second shift for the same driver on the same business date. The owner's own book records four to
 * six shifts a day. The suite never expressed the case the business runs daily.
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

/** Start a shift the way the driver's app now does — with no shift number at all. */
const start = async (driver: string, body: Payload = {}): Promise<LightMyRequestResponse> =>
  await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, ...body })

const shiftNoOf = async (driver: string, id: string): Promise<number> =>
  (await get(driver, `/shifts/${id}/state`)).json().shiftNo as number

/** Drive a shift to `open`, then void it — the exact path that produced the production blocker. */
async function openThenVoid(driver: string, manager: string): Promise<string> {
  const id = (await start(driver)).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 1000, batteryPercent: 90 })
  await post(manager, `/shifts/${id}/approve-open`, {
    floatTranches: [sypStr(100_000)],
    topupTranches: [sypStr(50_000)],
  })
  const voided = await post(manager, `/shifts/${id}/void`, { reason: 'انتهت المناوبة قبل بدايتها' })
  expect(voided.statusCode, voided.body).toBe(200)
  expect(voided.json().state).toBe('cancelled')
  return id
}

describe('the server numbers the shift, not the client', () => {
  it('lets a driver start again after his first shift of the day was cancelled', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')

    const first = await openThenVoid(driver, manager)
    expect(await shiftNoOf(driver, first)).toBe(1)

    // THE REGRESSION. This returned 500 «internal_error» in production.
    const second = await start(driver)
    expect(second.statusCode, second.body).toBe(201)
    expect(await shiftNoOf(driver, second.json().id as string)).toBe(2)
  })

  it('keeps climbing — a cancelled shift never gives its number back', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')

    expect(await shiftNoOf(driver, await openThenVoid(driver, manager))).toBe(1)
    // The second is cancelled too; the third must be 3, not 2. Reusing a freed number would collide
    // with the row that is still sitting there — which is the whole point of the unique index.
    expect(await shiftNoOf(driver, await openThenVoid(driver, manager))).toBe(2)

    const third = await start(driver)
    expect(third.statusCode, third.body).toBe(201)
    expect(await shiftNoOf(driver, third.json().id as string)).toBe(3)
  })

  /**
   * A driver mid-deploy is running the OLD bundle, which still sends `shiftNo: 1`. The fix must not
   * require him to reload before he can work — so the field is accepted and deliberately ignored.
   */
  it('ignores a shift number a cached client still sends', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')

    await openThenVoid(driver, manager)
    const second = await start(driver, { shiftNo: 1 })
    expect(second.statusCode, second.body).toBe(201)
    expect(await shiftNoOf(driver, second.json().id as string)).toBe(2)
  })

  /** The guard this change must NOT weaken: one live shift per driver, still refused, still a 409. */
  it('still refuses a driver who already has a live shift', async () => {
    const driver = await h.loginAs('driver1')
    const first = await start(driver)
    expect(first.statusCode).toBe(201)

    const second = await start(driver)
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toBe('cannot_open_shift')
  })

  it('refuses past the daily cap with a code the driver can read, not a 500', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')

    for (let n = 0; n < MAX_SHIFTS_PER_DAY; n++) await openThenVoid(driver, manager)

    const tooMany = await start(driver)
    expect(tooMany.statusCode).toBe(409)
    expect(tooMany.json().error).toBe('too_many_shifts_today')
  })
})
