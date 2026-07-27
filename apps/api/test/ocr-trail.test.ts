import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness } from './harness.ts'

/**
 * SRS D-3 trail: the pre-correction OCR values follow the shift to the manager's review, so «the
 * manual edit and its difference from the OCR reading» is computable. Here: the start odometer &
 * battery baselines (readDashboard). Wallet (readWallet) and order fee (readOrders) extend this.
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

async function newDraft(driver: string): Promise<string> {
  return (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
}

describe('OCR D-3 trail — start odometer & battery (readDashboard)', () => {
  it('carries the pre-correction OCR reads to the review, distinct from what the driver confirmed', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await newDraft(driver)
    await h.uploadPhoto(driver, id, 'start', 'odometer')

    // The driver confirmed 15,320 km / 95% but OCR had read 15,300 / 90 — a real edit.
    const res = await put(driver, `/shifts/${id}/start-package`, {
      odometerKm: 15_320,
      batteryPercent: 95,
      odometerKmOcr: 15_300,
      batteryPercentOcr: 90,
    })
    expect(res.statusCode, res.body).toBe(200)

    const start = (await get(manager, `/shifts/${id}/review`)).json().startPackage
    expect(start.odometerKm).toBe(15_320)
    expect(start.odometerKmOcr).toBe(15_300)
    expect(start.batteryPercent).toBe(95)
    expect(start.batteryPercentOcr).toBe(90)
  })

  it('echoes null when OCR never ran (the fields are optional)', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await newDraft(driver)
    await h.uploadPhoto(driver, id, 'start', 'odometer')

    const res = await put(driver, `/shifts/${id}/start-package`, { odometerKm: 15_320, batteryPercent: 95 })
    expect(res.statusCode, res.body).toBe(200)

    const start = (await get(manager, `/shifts/${id}/review`)).json().startPackage
    expect(start.odometerKm).toBe(15_320)
    expect(start.odometerKmOcr).toBeNull()
    expect(start.batteryPercentOcr).toBeNull()
  })
})
