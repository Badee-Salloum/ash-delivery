import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRIVER_ID, VEHICLE_ID, makeHarness, type Harness } from './harness.ts'

let h: Harness
beforeEach(async () => { h = await makeHarness({ minDriverAndroidTrackerBuild: 4 }) })
afterEach(async () => { await h.app.close() })

async function draft() {
  const token = await h.loginAs('driver1')
  const headers = { cookie: h.cookie(token) }
  const id = (await h.app.inject({ method: 'POST', url: '/shifts', headers,
    payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 } })).json().id as string
  const payload = { appBuild: 4, capturedAtMs: h.deps.clock.nowMs(), accuracyM: 12,
    precise: true, locationEnabled: true, backgroundPermission: true, notificationPermission: true,
    batteryOptimizationExempt: true, autostartAcknowledged: true, queueAvailable: true }
  return { id, token, headers, payload,
    send: (body = payload) => h.app.inject({ method: 'POST', url: `/shifts/${id}/gps/readiness`, headers, payload: body }) }
}

describe('coordinate-free GPS readiness timing refusals', () => {
  it.each([[-30_001, 'stale', 30_001], [5_001, 'future', -5_001]] as const)(
    'returns and logs the exact signed time difference (%s)', async (delta, reason, ageMs) => {
      const x = await draft(), now = h.deps.clock.nowMs()
      const shiftBefore = structuredClone(h.deps.shifts.rows.get(x.id))
      const journalsBefore = structuredClone(h.deps.ledger.entries)
      const result = await x.send({ ...x.payload, capturedAtMs: now + delta })
      expect(result.statusCode).toBe(422)
      expect(result.json()).toEqual({ error: 'gps_fix_not_fresh', detail: {
        reason, ageMs, capturedAtMs: now + delta, serverTimeMs: now,
        maxAgeMs: 30_000, maxFutureSkewMs: 5_000, retryable: true,
      } })
      expect(h.deps.gpsHealth.timingRejections).toEqual([{
        shiftId: x.id, atMs: now, capturedAtMs: now + delta, appBuild: 4, reason, ageMs,
      }])
      expect(h.deps.gpsHealth.rows.has(x.id)).toBe(false)
      expect(h.deps.shifts.rows.get(x.id)).toEqual(shiftBefore)
      expect(h.deps.ledger.entries).toEqual(journalsBefore)
      expect(h.deps.gps.rows).toHaveLength(0)
      expect(h.deps.settlements.rows.size).toBe(0)
    },
  )

  it.each([-30_000, 5_000, 0])('preserves the existing inclusive timing boundary (%s)', async delta => {
    const x = await draft()
    expect((await x.send({ ...x.payload, capturedAtMs: h.deps.clock.nowMs() + delta })).statusCode).toBe(202)
    expect(h.deps.gpsHealth.timingRejections).toHaveLength(0)
    expect(h.deps.shifts.rows.get(x.id)?.state).toBe('draft')
  })

  it('can accept a new point after refusing an old one without opening the shift', async () => {
    const x = await draft()
    expect((await x.send({ ...x.payload, capturedAtMs: h.deps.clock.nowMs() - 40_000 })).statusCode).toBe(422)
    expect((await x.send()).statusCode).toBe(202)
    expect(h.deps.shifts.rows.get(x.id)?.driverConfirmedAt).toBeNull()
    expect(h.deps.shifts.rows.get(x.id)?.state).toBe('draft')
    expect(h.deps.ledger.entries).toHaveLength(0)
  })

  it('retains the last accepted readiness when a later timestamp is refused', async () => {
    const x = await draft()
    await x.send()
    const health = structuredClone(h.deps.gpsHealth.rows.get(x.id))
    await x.send({ ...x.payload, capturedAtMs: h.deps.clock.nowMs() + 9_000 })
    expect(h.deps.gpsHealth.rows.get(x.id)).toEqual(health)
  })

  it('a failed diagnostic write still returns the actionable timing refusal', async () => {
    const x = await draft()
    vi.spyOn(h.deps.gpsHealth, 'recordReadinessTimingRejection').mockRejectedValueOnce(new Error('offline'))
    const response = await x.send({ ...x.payload, capturedAtMs: h.deps.clock.nowMs() - 40_000 })
    expect(response.statusCode).toBe(422)
    expect(response.json().detail).toMatchObject({ reason: 'stale', ageMs: 40_000 })
    expect(h.deps.shifts.rows.get(x.id)?.state).toBe('draft')
  })

  it('refuses another driver before writing timing diagnostics', async () => {
    const x = await draft(), other = await h.loginAs('driver2')
    const response = await h.app.inject({ method: 'POST', url: `/shifts/${x.id}/gps/readiness`,
      headers: { cookie: h.cookie(other) }, payload: { ...x.payload, capturedAtMs: h.deps.clock.nowMs() - 40_000 } })
    expect(response.statusCode).toBe(403)
    expect(h.deps.gpsHealth.timingRejections).toHaveLength(0)
  })

  it('does not change or attach a readiness diagnostic to an approved shift', async () => {
    const x = await draft()
    h.deps.shifts.rows.set(x.id, { ...h.deps.shifts.rows.get(x.id)!, state: 'approved' })
    const before = structuredClone(h.deps.shifts.rows.get(x.id))
    const response = await x.send({ ...x.payload, capturedAtMs: h.deps.clock.nowMs() - 40_000 })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('shift_not_draft')
    expect(h.deps.gpsHealth.timingRejections).toHaveLength(0)
    expect(h.deps.shifts.rows.get(x.id)).toEqual(before)
    expect(h.deps.ledger.entries).toHaveLength(0)
  })
})
