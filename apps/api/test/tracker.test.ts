import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * The hardware GPS tracker (SRS K-1) — INFRASTRUCTURE only; no device exists yet. Devices are
 * registered as fleet data (`fleet.manage`); the ingest seam is off until a gateway token is set,
 * authenticates a device by its own secret rather than a driver cookie, resolves the device's bike
 * to its live shift, and forces `source='tracker'`.
 */

const GATEWAY_TOKEN = 'gateway-secret-token-0123456789'
const IMEI = '350000000000009'

describe('tracker device registry (fleet.manage)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
  })
  afterEach(async () => {
    await h.app.close()
  })

  const post = async (token: string, url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
    await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
  const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
    await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

  it('registers a device, hands back its secret once, and lists it without the secret', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/tracker/devices', { imei: IMEI, vehicleId: VEHICLE_ID, label: 'Bike D19 unit' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().secret).toBeTruthy()
    expect(res.json().imei).toBe(IMEI)

    const list = (await get(manager, `/tracker/devices?branchId=${BRANCH}`)).json().devices as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]!.imei).toBe(IMEI)
    expect(list[0]!.vehicleId).toBe(VEHICLE_ID)
    // The secret and its hash never leave the server.
    expect(JSON.stringify(list[0])).not.toContain('secret')
  })

  it('refuses a duplicate imei and a second active tracker on one bike', async () => {
    const manager = await h.loginAs('manager')
    expect((await post(manager, '/tracker/devices', { imei: IMEI, vehicleId: VEHICLE_ID, label: 'A' })).statusCode).toBe(201)
    expect((await post(manager, '/tracker/devices', { imei: IMEI, label: 'B' })).statusCode).toBe(409)
    expect((await post(manager, '/tracker/devices', { imei: '350000000000010', vehicleId: VEHICLE_ID, label: 'C' })).statusCode).toBe(409)
  })

  it('deactivates a device so a replacement can take the bike', async () => {
    const manager = await h.loginAs('manager')
    const id = (await post(manager, '/tracker/devices', { imei: IMEI, vehicleId: VEHICLE_ID, label: 'A' })).json().id as string
    expect((await post(manager, `/tracker/devices/${id}/deactivate`)).statusCode).toBe(200)
    expect((await post(manager, '/tracker/devices', { imei: '350000000000010', vehicleId: VEHICLE_ID, label: 'B' })).statusCode).toBe(201)
  })

  it('is fleet.manage only — a driver cannot register a device', async () => {
    const driver = await h.loginAs('driver1')
    expect((await post(driver, '/tracker/devices', { imei: IMEI, label: 'A' })).statusCode).toBe(403)
  })
})

describe('tracker ingest seam', () => {
  const fix = (nowMs: number) => ({ lat: 33.5138, lng: 36.2765, accuracyM: 10, capturedAtMs: nowMs })

  async function openShiftOnBike(h: Harness, driver: string, manager: string): Promise<string> {
    const inject = (token: string, method: 'POST' | 'PUT', url: string, payload: Record<string, unknown>) =>
      h.app.inject({ method, url, headers: { cookie: h.cookie(token) }, payload })
    const id = (await inject(driver, 'POST', '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    await inject(driver, 'PUT', `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
    await inject(manager, 'POST', `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })
    return id
  }

  it('is 404 while the seam is disabled (no device is exposed on an idle deployment)', async () => {
    const h = await makeHarness()
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/tracker/ingest',
        headers: { 'x-tracker-gateway-token': GATEWAY_TOKEN },
        payload: { deviceImei: IMEI, fixes: [fix(h.deps.clock.nowMs())] },
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await h.app.close()
    }
  })

  it('authenticates the gateway, resolves the bike to its live shift, and stores fixes as tracker', async () => {
    const h = await makeHarness({ trackerIngestEnabled: true, trackerGatewayToken: GATEWAY_TOKEN })
    try {
      const manager = await h.loginAs('manager')
      const driver = await h.loginAs('driver1')
      const reg = await h.app.inject({
        method: 'POST',
        url: '/tracker/devices',
        headers: { cookie: h.cookie(manager) },
        payload: { imei: IMEI, vehicleId: VEHICLE_ID, label: 'A' },
      })
      expect(reg.statusCode, reg.body).toBe(201)

      const ingest = (token: string, imei: string) =>
        h.app.inject({
          method: 'POST',
          url: '/tracker/ingest',
          headers: { 'x-tracker-gateway-token': token },
          payload: { deviceImei: imei, fixes: [fix(h.deps.clock.nowMs())] },
        })

      // A wrong gateway secret is refused; an unknown device is refused.
      expect((await ingest('wrong-token', IMEI)).statusCode).toBe(401)
      expect((await ingest(GATEWAY_TOKEN, '350000000000099')).statusCode).toBe(403)

      // Bound, but the bike has no live shift yet → the fix is dropped, not stored.
      const noShift = await ingest(GATEWAY_TOKEN, IMEI)
      expect(noShift.statusCode).toBe(202)
      expect(noShift.json().reason).toBe('no_live_shift')

      // Open a shift on the bike; now the gateway's fix lands on it, stamped from the shift.
      const shiftId = await openShiftOnBike(h, driver, manager)
      const ok = await ingest(GATEWAY_TOKEN, IMEI)
      expect(ok.statusCode, ok.body).toBe(202)
      expect(ok.json().accepted).toBe(1)

      const trail = await h.deps.gps.listForShift(shiftId)
      expect(trail).toHaveLength(1)
      expect(trail[0]!.source).toBe('tracker')
      // The device carries no driver; the shift does. A tracker measures the BIKE.
      expect(trail[0]!.driverId).toBe(DRIVER_ID)
      expect(trail[0]!.branchId).toBe(BRANCH)
    } finally {
      await h.app.close()
    }
  })

  it('drops a fix from a device that is registered but not yet fitted to a bike', async () => {
    const h = await makeHarness({ trackerIngestEnabled: true, trackerGatewayToken: GATEWAY_TOKEN })
    try {
      const manager = await h.loginAs('manager')
      await h.app.inject({
        method: 'POST',
        url: '/tracker/devices',
        headers: { cookie: h.cookie(manager) },
        payload: { imei: IMEI, label: 'unbound' },
      })
      const res = await h.app.inject({
        method: 'POST',
        url: '/tracker/ingest',
        headers: { 'x-tracker-gateway-token': GATEWAY_TOKEN },
        payload: { deviceImei: IMEI, fixes: [fix(h.deps.clock.nowMs())] },
      })
      expect(res.statusCode).toBe(202)
      expect(res.json().reason).toBe('device_not_bound')
    } finally {
      await h.app.close()
    }
  })
})
