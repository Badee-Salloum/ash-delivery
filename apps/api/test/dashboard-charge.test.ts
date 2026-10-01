import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, VEHICLE_ID, VEHICLE_TYPE, type Harness, makeHarness, sypStr, today } from './harness.ts'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
  const type = h.deps.directory.vehicleTypes.get(VEHICLE_TYPE)!
  h.deps.directory.vehicleTypes.set(VEHICLE_TYPE, {
    ...type, batterySlots: 1, chargeReadingSource: 'odometer',
  })
})
afterEach(async () => { await h.app.close() })

const post = async (token: string, url: string, payload: Record<string, unknown>) =>
  h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Record<string, unknown>) =>
  h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

async function start() {
  const driver = await h.loginAs('driver1')
  const manager = await h.loginAs('manager')
  const battery = await post(manager, '/batteries', { capacityAh: 50, vehicleId: VEHICLE_ID, slotNo: 1 })
  expect(battery.statusCode, battery.body).toBe(201)
  const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })
  expect(created.statusCode, created.body).toBe(201)
  return { driver, manager, shiftId: created.json().id as string, batteryId: battery.json().id as string }
}

describe('one fixed battery reads charge from the odometer photo', () => {
  it('accepts a single opening photo for distance and charge, with exact media provenance', async () => {
    const { driver, shiftId, batteryId } = await start()
    const photo = await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    const withoutLock = await put(driver, `/shifts/${shiftId}/battery-readings`, {
      package: 'start', readings: [{ batteryId, percent: 84, source: 'ocr' }],
    })
    expect(withoutLock.statusCode).toBe(422)
    const handoff = await put(driver, `/shifts/${shiftId}/battery-readings`, {
      package: 'start', readings: [{ batteryId, percent: null, unavailable: true }],
    })
    expect(handoff.statusCode).toBe(422)

    const saved = await put(driver, `/shifts/${shiftId}/battery-readings`, {
      package: 'start', readings: [{ batteryId, percent: 84, source: 'ocr', expectedMediaId: photo.mediaId,
        ocrRaw: { percent: '84' } }],
    })
    expect(saved.statusCode, saved.body).toBe(200)
    expect((await h.deps.batteryReadings.listByShift(shiftId))[0]).toMatchObject({
      batteryId, percent: 84, mediaId: photo.mediaId, source: 'ocr',
    })
    const submitted = await put(driver, `/shifts/${shiftId}/start-package`, {
      odometerKm: 5, batteryPercent: null, odometerKmOcr: 5,
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(submitted.json().state).toBe('awaiting_open_approval')
    const state = await h.app.inject({ method: 'GET', url: `/shifts/${shiftId}/state`, headers: { cookie: h.cookie(driver) } })
    expect(state.json().startPackage.odometerMediaId).toBe(photo.mediaId)
  })

  it('does not accept a reading from the replaced odometer photo', async () => {
    const { driver, shiftId, batteryId } = await start()
    const first = await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    expect((await put(driver, `/shifts/${shiftId}/battery-readings`, {
      package: 'start', readings: [{ batteryId, percent: 84, expectedMediaId: first.mediaId }],
    })).statusCode).toBe(200)
    const replacement = await h.uploadPhoto(driver, shiftId, 'start', 'odometer', TINY_PNG)
    expect(replacement.mediaId).not.toBe(first.mediaId)
    const staleWrite = await put(driver, `/shifts/${shiftId}/battery-readings`, {
      package: 'start', readings: [{ batteryId, percent: 84, expectedMediaId: first.mediaId }],
    })
    expect(staleWrite.statusCode).toBe(409)
    const blocked = await put(driver, `/shifts/${shiftId}/start-package`, { odometerKm: 5, batteryPercent: null })
    expect(blocked.statusCode).toBe(422)
    expect(blocked.json().detail).toContainEqual({ kind: 'missing_battery_reading', slotNo: 1 })
    expect((await put(driver, `/shifts/${shiftId}/battery-readings`, {
      package: 'start', readings: [{ batteryId, percent: 83, source: 'manual', expectedMediaId: replacement.mediaId }],
    })).statusCode).toBe(200)
    expect((await put(driver, `/shifts/${shiftId}/start-package`, { odometerKm: 5, batteryPercent: null })).statusCode).toBe(200)
  })

  it('keeps the single-photo rule at close and refuses a mid-shift swap', async () => {
    const { driver, manager, shiftId, batteryId } = await start()
    const opening = await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    expect((await put(driver, `/shifts/${shiftId}/battery-readings`, {
      package: 'start', readings: [{ batteryId, percent: 84, expectedMediaId: opening.mediaId }],
    })).statusCode).toBe(200)
    expect((await put(driver, `/shifts/${shiftId}/start-package`, { odometerKm: 5, batteryPercent: null })).statusCode).toBe(200)
    expect((await post(manager, `/shifts/${shiftId}/approve-open`, {
      floatTranches: [sypStr(100)], topupTranches: [],
    })).statusCode).toBe(200)

    const swap = await post(driver, `/shifts/${shiftId}/battery-swap`, {
      slotNo: 1, inBatteryId: 'spare', outReading: {}, inReading: {},
    })
    expect(swap.statusCode).toBe(422)
    expect(swap.json().error).toBe('battery_swap_not_supported_for_vehicle_type')

    h.stageCloseDraftFinancialFixture(shiftId, {
      managerToken: manager,
      orders: [{ clientKey: 'dashboard-charge', providerOrderNo: 'DASH-1', payMode: 'cash',
        fee: sypStr(10), occurredDate: today, occurredMinute: '08:00' }],
    })
    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, shiftId, 'end', slot)
    const ending = (await h.deps.media.listSlots(shiftId)).find((slot) => slot.package === 'end' && slot.slot === 'odometer')!
    const saved = await put(driver, `/shifts/${shiftId}/battery-readings`, {
      package: 'end', readings: [{ batteryId, percent: 72, expectedMediaId: ending.mediaId }],
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const deferred = await h.submitEndPackage(driver, shiftId, {
      odometerKm: 12, batteryPercent: null,
      cashDeclared: sypStr(0), walletDeclared: sypStr(0),
      deferMissingBatteryEvidenceToManager: true,
    })
    expect(deferred.statusCode).toBe(422)
    const closed = await h.submitEndPackage(driver, shiftId, {
      odometerKm: 12, batteryPercent: null,
      cashDeclared: sypStr(0), walletDeclared: sypStr(0),
      deferMissingBatteryEvidenceToManager: false,
    })
    expect(closed.statusCode, closed.body).toBe(200)
    expect((await h.deps.batteryReadings.listByShift(shiftId)).find((row) => row.package === 'end')).toMatchObject({
      percent: 72, mediaId: ending.mediaId, unavailable: false,
    })
  })

  it('requires one fitted battery before starting', async () => {
    const driver = await h.loginAs('driver1')
    const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })
    const shiftId = created.json().id as string
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    const submitted = await put(driver, `/shifts/${shiftId}/start-package`, { odometerKm: 5, batteryPercent: null })
    expect(submitted.statusCode).toBe(422)
    expect(submitted.json().error).toBe('odometer_charge_requires_one_fitted_battery')
  })
})
