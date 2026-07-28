import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * Live GPS tracking (SRS K). While a shift is open the driver's phone posts location fixes to his
 * OWN shift (shift.operate); the manager's live map reads the latest fix per driver (gps.view).
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

async function toOpen(driver: string, manager: string): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
  return id
}

interface LiveDriver {
  driverId: string
  lat: number
  lng: number
}

describe('live GPS (SRS K)', () => {
  it('a driver posts a ping to his open shift; the manager sees it on the live map', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toOpen(driver, manager)

    const res = await post(driver, `/shifts/${id}/gps`, { lat: 33.5138, lng: 36.2765, accuracyM: 12, capturedAtMs: 1_000 })
    expect(res.statusCode, res.body).toBe(202)

    // Stored, stamped with the server's receive time (not the phone's captured_at).
    const ping = h.deps.gps.rows.find((p) => p.shiftId === id)
    expect(ping?.driverId).toBe(DRIVER_ID)
    expect(ping?.receivedAtMs).toBe(h.deps.clock.nowMs())

    const live = (await get(manager, '/gps/live')).json().drivers as LiveDriver[]
    const d = live.find((x) => x.driverId === DRIVER_ID)!
    expect(d.lat).toBeCloseTo(33.5138)
    expect(d.lng).toBeCloseTo(36.2765)
  })

  it('the live map shows the LATEST fix per driver', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toOpen(driver, manager)

    await post(driver, `/shifts/${id}/gps`, { lat: 33.5, lng: 36.2, accuracyM: null, capturedAtMs: 1_000 })
    await post(driver, `/shifts/${id}/gps`, { lat: 33.6, lng: 36.3, accuracyM: null, capturedAtMs: 2_000 })

    const live = (await get(manager, '/gps/live')).json().drivers as LiveDriver[]
    expect(live.filter((x) => x.driverId === DRIVER_ID)).toHaveLength(1)
    expect(live.find((x) => x.driverId === DRIVER_ID)!.lat).toBeCloseTo(33.6)
  })

  it('a driver may not post to another driver’s shift (403)', async () => {
    const driver = await h.loginAs('driver1')
    const driver2 = await h.loginAs('driver2')
    const manager = await h.loginAs('manager')
    const id = await toOpen(driver, manager) // driver1's shift

    const res = await post(driver2, `/shifts/${id}/gps`, { lat: 1, lng: 1, capturedAtMs: 1 })
    expect(res.statusCode).toBe(403)
  })

  it('the live map requires gps.view — a driver is refused', async () => {
    const driver = await h.loginAs('driver1')
    expect((await get(driver, '/gps/live')).statusCode).toBe(403)
  })
})
