import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { minor, minuteKeyForOffset } from '@ash/domain'
import { BRANCH, DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * Live GPS tracking (SRS K). While a shift is open the driver's phone posts location fixes to his
 * OWN shift (shift.operate); the live map reads the latest fix per driver (gps.view) — which is a
 * GM / system-admin view, not a branch manager's.
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
    const gm = await h.loginAs('gm')
    const id = await toOpen(driver, manager)

    const at = h.deps.clock.nowMs()
    const res = await post(driver, `/shifts/${id}/gps`, { lat: 33.5138, lng: 36.2765, accuracyM: 12, capturedAtMs: at })
    expect(res.statusCode, res.body).toBe(202)

    // Stored, stamped with the server's receive time (not the phone's captured_at).
    const ping = h.deps.gps.rows.find((p) => p.shiftId === id)
    expect(ping?.driverId).toBe(DRIVER_ID)
    expect(ping?.receivedAtMs).toBe(h.deps.clock.nowMs())

    const live = (await get(gm, `/gps/live?branchId=${BRANCH}`)).json().drivers as LiveDriver[]
    const d = live.find((x) => x.driverId === DRIVER_ID)!
    expect(d.lat).toBeCloseTo(33.5138)
    expect(d.lng).toBeCloseTo(36.2765)
  })

  it('flags a tracked shift whose tracker has gone silent past the grace, and clears it on a fix', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const gm = await h.loginAs('gm')
    const id = await toOpen(driver, manager)

    // A freshly opened shift is inside the grace: it may not have had time to send its first fix.
    expect((await get(gm, `/gps/live?branchId=${BRANCH}`)).json().silent).toEqual([])

    // Backdate the window so it has been tracked past the grace with nothing received.
    const s = h.deps.shifts.rows.get(id)!
    h.deps.shifts.rows.set(id, { ...s, windowOpensAt: new Date(h.deps.clock.nowMs() - 11 * 60_000).toISOString() })

    const silent = (await get(gm, `/gps/live?branchId=${BRANCH}`)).json().silent as Array<{ shiftId: string; silentMinutes: number }>
    expect(silent.map((x) => x.shiftId)).toContain(id)
    expect(silent.find((x) => x.shiftId === id)!.silentMinutes).toBeGreaterThanOrEqual(11)

    // The moment a fix arrives the driver is on the map, not silent.
    await post(driver, `/shifts/${id}/gps`, { lat: 33.5, lng: 36.2, accuracyM: null, capturedAtMs: h.deps.clock.nowMs() })
    expect((await get(gm, `/gps/live?branchId=${BRANCH}`)).json().silent).toEqual([])
  })

  it('the live map shows the LATEST fix per driver', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const gm = await h.loginAs('gm')
    const id = await toOpen(driver, manager)

    const at = h.deps.clock.nowMs()
    await post(driver, `/shifts/${id}/gps`, { lat: 33.5, lng: 36.2, accuracyM: null, capturedAtMs: at - 60_000 })
    await post(driver, `/shifts/${id}/gps`, { lat: 33.6, lng: 36.3, accuracyM: null, capturedAtMs: at })

    const live = (await get(gm, `/gps/live?branchId=${BRANCH}`)).json().drivers as LiveDriver[]
    expect(live.filter((x) => x.driverId === DRIVER_ID)).toHaveLength(1)
    expect(live.find((x) => x.driverId === DRIVER_ID)!.lat).toBeCloseTo(33.6)
  })

  it('keeps the current shift visible when an older shift has a later captured fix', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const gm = await h.loginAs('gm')
    const id = await toOpen(driver, manager)
    const now = h.deps.clock.nowMs()
    await post(driver, `/shifts/${id}/gps`, { lat: 33.6, lng: 36.3, capturedAtMs: now - 60_000 })
    // A late batch on an already closed shift remains in the raw store. It must not win the
    // driver's latest-position lookup ahead of the current shift's own fix.
    await h.deps.gps.append({
      shiftId: crypto.randomUUID(), driverId: DRIVER_ID, branchId: BRANCH,
      lat: 33.1, lng: 36.1, accuracyM: null, source: 'phone_bg',
      capturedAtMs: now, receivedAtMs: now,
    })
    const live = (await get(gm, `/gps/live?branchId=${BRANCH}`)).json()
    expect((live.drivers as LiveDriver[]).find((row) => row.driverId === DRIVER_ID)?.lat).toBeCloseTo(33.6)
    expect(live.silent).toEqual([])
  })

  it('does not let a late buffered batch replace a newer captured position or mask silence', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const gm = await h.loginAs('gm')
    const id = await toOpen(driver, manager)
    const now = h.deps.clock.nowMs()
    await post(driver, `/shifts/${id}/gps`, { lat: 33.6, lng: 36.3, capturedAtMs: now - 12 * 60_000 })
    await post(driver, `/shifts/${id}/gps`, {
      source: 'phone_bg', fixes: [{ lat: 33.5, lng: 36.2, capturedAtMs: now - 20 * 60_000 }],
    })
    const live = (await get(gm, `/gps/live?branchId=${BRANCH}`)).json()
    expect((live.drivers as LiveDriver[]).find((x) => x.driverId === DRIVER_ID)?.lat).toBeCloseTo(33.6)
    expect(live.silent).toContainEqual({ driverId: DRIVER_ID, shiftId: id, silentMinutes: 12 })
  })

  it('keeps the true last-capture silence duration after the pin leaves the map', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const gm = await h.loginAs('gm')
    const id = await toOpen(driver, manager)
    const now = h.deps.clock.nowMs()
    await post(driver, `/shifts/${id}/gps`, { lat: 33.6, lng: 36.3, capturedAtMs: now - 90 * 60_000 })
    const live = (await get(gm, `/gps/live?branchId=${BRANCH}`)).json()
    expect((live.drivers as LiveDriver[]).find((x) => x.driverId === DRIVER_ID)).toBeUndefined()
    expect(live.silent).toContainEqual({ driverId: DRIVER_ID, shiftId: id, silentMinutes: 90 })
  })

  it('drops a driver off the live map once his shift ends — a voided stuck shift no longer lingers', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const gm = await h.loginAs('gm')
    const id = await toOpen(driver, manager)
    await post(driver, `/shifts/${id}/gps`, { lat: 33.5, lng: 36.2, accuracyM: null, capturedAtMs: h.deps.clock.nowMs() })

    // While the shift is live he is on the map.
    let live = (await get(gm, `/gps/live?branchId=${BRANCH}`)).json().drivers as LiveDriver[]
    expect(live.find((x) => x.driverId === DRIVER_ID)).toBeDefined()

    // End the shift (upper-level void). His last ping stays in gps_pings, but he must leave the map.
    expect((await post(manager, `/shifts/${id}/void`, { reason: 'stuck shift' })).statusCode).toBe(200)
    expect(h.deps.gps.rows.some((p) => p.shiftId === id)).toBe(true) // the ping is still there…

    live = (await get(gm, `/gps/live?branchId=${BRANCH}`)).json().drivers as LiveDriver[]
    expect(live.find((x) => x.driverId === DRIVER_ID)).toBeUndefined() // …but he is off the map
  })

  it('a driver may not post to another driver’s shift (403)', async () => {
    const driver = await h.loginAs('driver1')
    const driver2 = await h.loginAs('driver2')
    const manager = await h.loginAs('manager')
    const id = await toOpen(driver, manager) // driver1's shift

    const res = await post(driver2, `/shifts/${id}/gps`, { lat: 1, lng: 1, capturedAtMs: h.deps.clock.nowMs() })
    expect(res.statusCode).toBe(403)
  })

  it('the live map requires gps.view — a driver is refused', async () => {
    const driver = await h.loginAs('driver1')
    expect((await get(driver, '/gps/live')).statusCode).toBe(403)
  })

  it('a BRANCH MANAGER sees his own branch — he is the one who dispatches', async () => {
    /*
     * Reverses the earlier «upper-level view» decision, on the owner's instruction of 2026-09-08.
     * The branch manager is the person who actually sends a driver to a delivery, and a live map he
     * cannot open is a dispatch tool with no dispatcher.
     *
     * It also restores SRS §3, which granted him this all along («التتبع الحي GPS | BM ✓ (فرعه)»).
     */
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await toOpen(driver, manager)
    await post(driver, `/shifts/${id}/gps`, {
      lat: 33.5, lng: 36.2, accuracyM: null, capturedAtMs: h.deps.clock.nowMs(),
    })

    const res = await get(manager, '/gps/live')
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json().drivers as LiveDriver[]).find((x) => x.driverId === DRIVER_ID)).toBeDefined()
  })

  it('…and only his own branch: naming another one is refused', async () => {
    // The grant is `branch`, so the scope check — not a hidden menu item — is what stops him.
    const manager = await h.loginAs('manager')
    const res = await get(manager, '/gps/live?branchId=00000000-0000-4000-8000-0000000000ff')
    expect(res.statusCode).toBe(403)
  })

  describe('a buffered uploader, which is what background tracking actually produces', () => {
    it('accepts a batch, stores it in CAPTURE order, and counts what was new', async () => {
      const driver = await h.loginAs('driver1')
      const manager = await h.loginAs('manager')
      const id = await toOpen(driver, manager)
      const at = h.deps.clock.nowMs()

      // Deliberately out of order, the way a phone that reconnects mid-flush sends them.
      const res = await post(driver, `/shifts/${id}/gps`, {
        source: 'phone_bg',
        fixes: [
          { lat: 33.52, lng: 36.30, accuracyM: 8, capturedAtMs: at - 30_000 },
          { lat: 33.50, lng: 36.28, accuracyM: 9, capturedAtMs: at - 90_000 },
          { lat: 33.51, lng: 36.29, accuracyM: 7, capturedAtMs: at - 60_000 },
        ],
      })
      expect(res.statusCode, res.body).toBe(202)
      expect(res.json()).toMatchObject({ accepted: 3, duplicates: 0, rejected: 0 })

      /*
       * The whole reason the trail reads by `captured_at`. A batch that arrives late must not sort
       * after fixes it happened before — that zigzag is what inflates the measured distance, and
       * the distance is a number a manager acts on.
       */
      const trail = await h.deps.gps.listForShift(id)
      expect(trail.map((p) => p.capturedAtMs)).toEqual([at - 90_000, at - 60_000, at - 30_000])
      expect(trail.map((p) => p.source)).toEqual(['phone_bg', 'phone_bg', 'phone_bg'])
    })

    it('a replayed batch stores nothing twice — the retry is free', async () => {
      const driver = await h.loginAs('driver1')
      const manager = await h.loginAs('manager')
      const id = await toOpen(driver, manager)
      const at = h.deps.clock.nowMs()
      const batch = {
        fixes: [
          { lat: 33.5, lng: 36.2, accuracyM: 10, capturedAtMs: at - 20_000 },
          { lat: 33.5, lng: 36.2, accuracyM: 10, capturedAtMs: at - 10_000 },
        ],
      }

      expect((await post(driver, `/shifts/${id}/gps`, batch)).json()).toMatchObject({ accepted: 2 })
      // The 202 that never reached the phone. It sends the same bytes again.
      expect((await post(driver, `/shifts/${id}/gps`, batch)).json()).toMatchObject({
        accepted: 0,
        duplicates: 2,
      })
      expect(await h.deps.gps.countForShift(id)).toBe(2)
    })

    it('drops a fix from a broken clock without losing the rest of the batch', async () => {
      const driver = await h.loginAs('driver1')
      const manager = await h.loginAs('manager')
      const id = await toOpen(driver, manager)
      const at = h.deps.clock.nowMs()

      const res = await post(driver, `/shifts/${id}/gps`, {
        fixes: [
          { lat: 33.5, lng: 36.2, accuracyM: 10, capturedAtMs: 1_000 }, // 1970
          { lat: 33.5, lng: 36.2, accuracyM: 10, capturedAtMs: at + 7 * 24 * 60 * 60_000 }, // next week
          { lat: 33.5, lng: 36.2, accuracyM: 10, capturedAtMs: at }, // the real one
        ],
      })
      expect(res.json()).toMatchObject({ accepted: 1, rejected: 2 })
    })

    it('refuses a closed shift with 409 — the uploader’s only reliable stop signal', async () => {
      /*
       * A native service outlives the WebView, so JS may never get to call stop(). This status is
       * what tells it to drop its buffer and shut down, and the client contract turns on it:
       * 409 → clear and stop; a network error → keep and back off. Reverse the two and a phone
       * hammers a closed shift every minute for weeks with nobody watching.
       */
      const driver = await h.loginAs('driver1')
      const manager = await h.loginAs('manager')
      const id = await toOpen(driver, manager)
      expect((await post(manager, `/shifts/${id}/void`, { reason: 'stuck shift' })).statusCode).toBe(200)

      const res = await post(driver, `/shifts/${id}/gps`, {
        lat: 33.5, lng: 36.2, accuracyM: null, capturedAtMs: h.deps.clock.nowMs(),
      })
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json().error).toBe('shift_not_live')
    })

    it('reports shift status when the native queue is empty', async () => {
      const driver = await h.loginAs('driver1')
      const otherDriver = await h.loginAs('driver2')
      const manager = await h.loginAs('manager')
      const id = await toOpen(driver, manager)
      expect((await get(driver, `/shifts/${id}/gps/status`)).json()).toMatchObject({ live: true })
      expect((await get(otherDriver, `/shifts/${id}/gps/status`)).statusCode).toBe(403)
      await post(manager, `/shifts/${id}/void`, { reason: 'stuck shift' })
      expect((await get(driver, `/shifts/${id}/gps/status`)).json()).toMatchObject({ live: false })
    })

    it('still accepts the single-fix body an installed phone keeps sending', async () => {
      // The driver PWA reaches a phone only when its driver taps «تحديث». Assuming otherwise is
      // what let the 2026-08-24 close failures survive their own fix.
      const driver = await h.loginAs('driver1')
      const manager = await h.loginAs('manager')
      const id = await toOpen(driver, manager)

      const res = await post(driver, `/shifts/${id}/gps`, {
        lat: 33.5138, lng: 36.2765, accuracyM: 12, capturedAtMs: h.deps.clock.nowMs(),
      })
      expect(res.statusCode, res.body).toBe(202)
      const trail = await h.deps.gps.listForShift(id)
      expect(trail).toHaveLength(1)
      expect(trail[0]!.source).toBe('phone_fg')
    })
  })

  describe('recorded path — a segment per order by printed time', () => {
    /** Seed an order straight into the repo with a printed minute derived from a real instant. */
    function seedOrder(shiftId: string, providerOrderNo: string, atMs: number, included = true): Promise<void> {
      const [occurredDate, occurredMinute] = minuteKeyForOffset(atMs, h.deps.clock.offsetMinutes()).split(' ')
      return h.deps.orders.create(
        {
          id: `ord-${providerOrderNo}`,
          shiftId,
          providerOrderNo,
          payMode: 'cash',
          fee: minor(5_000n),
          zone: null,
          driverConfirmed: true,
          source: 'manual',
          feeOcr: null,
          kind: 'yallago',
          driverShare: null,
          companyShare: null,
          notes: null,
          createdBy: null,
          points: [],
          included,
          walletAmount: null,
          occurredDate: occurredDate!,
          occurredMinute: occurredMinute!,
          windowStatus: 'in_window',
          decisionReason: null,
          decidedBy: null,
          decidedAt: null,
        },
        null,
      )
    }

    it('splits the trail into before-first / per-order / after, and skips excluded and untimed orders', async () => {
      const driver = await h.loginAs('driver1')
      const manager = await h.loginAs('manager')
      const gm = await h.loginAs('gm')
      const id = await toOpen(driver, manager)

      const now = h.deps.clock.nowMs()
      const M = 60_000
      const tA = now - 15 * M
      const tB = now - 8 * M
      // This fixture injects historic captures directly; its operation window must cover them.
      const shift = h.deps.shifts.rows.get(id)!
      h.deps.shifts.rows.set(id, { ...shift, windowOpensAt: new Date(now - 21 * M).toISOString() })
      await seedOrder(id, 'YAL-A', tA)
      await seedOrder(id, 'YAL-B', tB)
      await seedOrder(id, 'YAL-X', now - 12 * M, false) // excluded → never a segment
      await seedOrder(id, 'YAL-N', now) // timed, but we blank its minute below to make it untimed
      // Blank YAL-N's minute so it becomes an untimed order (no segment), as an illegible clock does.
      const n = h.deps.orders.rows.get('ord-YAL-N')!
      h.deps.orders.rows.set('ord-YAL-N', { ...n, occurredMinute: null })

      const res = await post(driver, `/shifts/${id}/gps`, {
        fixes: [
          { lat: 33.5, lng: 36.2, accuracyM: 8, capturedAtMs: now - 20 * M }, // before A
          { lat: 33.51, lng: 36.21, accuracyM: 8, capturedAtMs: tA }, // A
          { lat: 33.52, lng: 36.22, accuracyM: 8, capturedAtMs: tA + 2 * M }, // A
          { lat: 33.53, lng: 36.23, accuracyM: 8, capturedAtMs: tB }, // B
          { lat: 33.54, lng: 36.24, accuracyM: 8, capturedAtMs: now - 5 * M }, // B
        ],
      })
      expect(res.statusCode, res.body).toBe(202)

      const path = (await get(gm, `/shifts/${id}/gps/path`)).json()
      expect(path.pings).toHaveLength(5)
      // Capture order is preserved, which is the whole point of the trail read.
      expect(path.pings.map((p: { lat: number }) => p.lat)).toEqual([33.5, 33.51, 33.52, 33.53, 33.54])
      expect(path.beforeFirst).toMatchObject({ pingStartIndex: 0, pingEndIndex: 1 })
      expect(
        path.segments.map((s: { providerOrderNo: string; pingStartIndex: number; pingEndIndex: number }) => [
          s.providerOrderNo,
          s.pingStartIndex,
          s.pingEndIndex,
        ]),
      ).toEqual([
        ['YAL-A', 1, 3],
        ['YAL-B', 3, 5],
      ])
      // The shift is still open, so the last order runs to the end and nothing is after-close.
      expect(path.afterClose).toMatchObject({ pingStartIndex: 5, pingEndIndex: 5 })
      expect(path.untimedOrderIds).toEqual(['ord-YAL-N'])

      // No valid consecutive pair is unavailable, not a confirmed zero kilometres.
      expect(path.beforeFirst.distanceMetres).toBeNull()
      expect(path.afterClose.distanceMetres).toBeNull()
      for (const s of path.segments as { distanceMetres: number }[]) {
        expect(s.distanceMetres).toBeGreaterThan(0)
      }
      // A ~0.01°×0.01° hop near Damascus is roughly 1.4 km — a worked sanity bound, not a golden value.
      expect(path.segments[0].distanceMetres).toBeGreaterThan(1000)
      expect(path.segments[0].distanceMetres).toBeLessThan(2000)
      // The whole-trail total covers every hop, so it is at least the longest single order segment.
      const maxSegment = Math.max(...path.segments.map((s: { distanceMetres: number }) => s.distanceMetres))
      expect(path.totalDistanceMetres).toBeGreaterThanOrEqual(maxSegment)
      expect(path.workDistanceMetres).toBeGreaterThanOrEqual(maxSegment)
      expect(path.coverageIncomplete).toBe(true)
    })

    it('keeps the raw trail while excluding break and after-close movement from work', async () => {
      const driver = await h.loginAs('driver1')
      const manager = await h.loginAs('manager')
      const id = await toOpen(driver, manager)
      const now = h.deps.clock.nowMs()
      const M = 60_000
      const shift = h.deps.shifts.rows.get(id)!
      h.deps.shifts.rows.set(id, {
        ...shift,
        windowOpensAt: new Date(now - 8 * M).toISOString(),
        submittedAt: new Date(now - 2 * M).toISOString(),
      })
      await h.deps.breaks.create({
        id: 'path-break', shiftId: id, startedAtMs: now - 6 * M,
        endedAtMs: now - 4 * M, endReason: 'driver_resumed',
        limitMinutes: 60, consumedBeforeMs: 0, overLimitMs: 0,
      }, 'u-driver')
      await h.deps.gps.appendMany([
        [-8, 36.300], [-7, 36.301], [-6, 36.302], [-5, 36.303],
        [-4, 36.304], [-3, 36.305], [-1, 36.306],
      ].map(([minutes, lng]) => ({
        shiftId: id, driverId: DRIVER_ID, branchId: BRANCH,
        lat: 33.5, lng: lng!, accuracyM: 8,
        capturedAtMs: now + minutes! * M, receivedAtMs: now,
        source: 'phone_bg' as const,
      })))
      const response = await get(manager, `/shifts/${id}/gps/path`)
      expect(response.statusCode, response.body).toBe(200)
      const path = response.json()
      expect(path.pings.map((p: { phase: string }) => p.phase)).toEqual([
        'work', 'work', 'break', 'break', 'work', 'work', 'after_close',
      ])
      expect(path.afterClose).toMatchObject({ pingStartIndex: 6, pingEndIndex: 7, distanceMetres: null })
      expect(path.totalDistanceMetres).toBeGreaterThan(path.workDistanceMetres)
      expect(path.workDistanceMetres).toBeGreaterThan(100)
      expect(path.workDistanceMetres).toBeLessThan(300)
      expect(path.beforeFirst.distanceMetres).toBe(path.workDistanceMetres)
      expect(path.coverageIncomplete).toBe(true)
    })

    it('is gps.view only, and 404s an unknown shift', async () => {
      const driver = await h.loginAs('driver1')
      const manager = await h.loginAs('manager')
      const gm = await h.loginAs('gm')
      const id = await toOpen(driver, manager)

      // The driver holds shift.operate on his own shift, but not gps.view.
      expect((await get(driver, `/shifts/${id}/gps/path`)).statusCode).toBe(403)
      // The branch manager reads his own branch's trail.
      expect((await get(manager, `/shifts/${id}/gps/path`)).statusCode).toBe(200)
      // An org-wide viewer on a shift that does not exist gets a clean 404.
      expect((await get(gm, `/shifts/00000000-0000-4000-8000-000000000999/gps/path`)).statusCode).toBe(404)
    })
  })
})
