import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * «تطبيق البطارية لا يعمل على جهازي».
 *
 * Some drivers' phones cannot run the BMS app at all — an old Android, a device the manufacturer's
 * app refuses, Bluetooth that will not pair. The start gate demands a `bms_N` screenshot AND a charge
 * figure for every fitted pack, so such a driver could not open a shift at all. The only way past it
 * was to upload a photograph of something else, which converts a hardware problem into false
 * evidence — the worst available outcome.
 *
 * The declaration does not waive the evidence, it moves who owes it: the driver proceeds, and the
 * branch manager cannot approve until he has read that pack on a device that works.
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

/** A bike with one fitted pack, and a driver at the start gate. */
async function shiftWithOnePack(driver: string, manager: string): Promise<{ id: string; batteryId: string }> {
  const batteryId = (await post(manager, '/batteries', { capacityAh: 50, vehicleId: VEHICLE_ID, slotNo: 1 })).json()
    .id as string
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json()
    .id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  return { id, batteryId }
}

describe('a pack the driver cannot read on his own phone', () => {
  it('lets him start the shift — he is not asked for a screenshot he cannot take', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const { id, batteryId } = await shiftWithOnePack(driver, manager)

    const declared = await put(driver, `/shifts/${id}/battery-readings`, {
      package: 'start',
      readings: [{ batteryId, percent: null, unavailable: true }],
    })
    expect(declared.statusCode).toBe(200)

    // No `bms_1` photo, no charge figure — and the start package still goes through.
    const submitted = await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: null })
    expect(submitted.statusCode).toBe(200)
    expect((await get(manager, `/shifts/${id}/review`)).json().state).toBe('awaiting_open_approval')
  })

  it('but stops the MANAGER approving until he has read the pack himself', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const { id, batteryId } = await shiftWithOnePack(driver, manager)
    await put(driver, `/shifts/${id}/battery-readings`, {
      package: 'start',
      readings: [{ batteryId, percent: null, unavailable: true }],
    })
    await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: null })

    const refused = await post(manager, `/shifts/${id}/approve-open`, {
      floatTranches: [sypStr(100_000)],
      topupTranches: [],
    })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error).toBe('start_package_incomplete')
    expect(refused.json().detail).toContainEqual({ kind: 'awaiting_manager_reading', slotNo: 1 })
  })

  it('opens once the manager supplies the reading, and records that HE produced it', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const { id, batteryId } = await shiftWithOnePack(driver, manager)
    await put(driver, `/shifts/${id}/battery-readings`, {
      package: 'start',
      readings: [{ batteryId, percent: null, unavailable: true }],
    })
    await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: null })

    // The manager reads the pack on a device that works.
    const supplied = await put(manager, `/shifts/${id}/battery-readings/manager`, {
      package: 'start',
      readings: [{ batteryId, percent: 88, unavailable: true, source: 'manager' }],
    })
    expect(supplied.statusCode).toBe(200)

    const opened = await post(manager, `/shifts/${id}/approve-open`, {
      floatTranches: [sypStr(100_000)],
      topupTranches: [],
    })
    expect(opened.statusCode).toBe(200)

    // `manager` is not `manual`: a figure he took after the driver could not is a different fact
    // from one the driver typed, and must not be distinguishable only by reading the audit log.
    const reading = (await get(manager, `/shifts/${id}/review`)).json().startPackage.batteries[0]
    expect(reading.percent).toBe(88)
    expect(reading.source).toBe('manager')
  })

  it('does not waive a pack he simply has not done yet', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const { id } = await shiftWithOnePack(driver, manager)

    // Nothing declared, nothing read — the driver still owes this one, as before.
    const submitted = await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: null })
    expect(submitted.statusCode).toBe(422)
    expect(submitted.json().detail).toContainEqual({ kind: 'missing_battery_reading', slotNo: 1 })
  })
})
