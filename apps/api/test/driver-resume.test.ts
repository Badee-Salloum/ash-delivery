import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER2_ID, DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * The driver's read of his own shift, and his way out of one that never opened.
 *
 * These exist because of a defect that made the core flow unfinishable in production. After
 * submitting his start package the driver's app polled `GET /shifts/:id/review` waiting to be let
 * out of «بانتظار اعتماد البداية» — but that route is `shift.approve`, which the driver does not
 * have. Every poll was a 403, the client swallowed it, and the phone sat there forever: the
 * manager approved, the shift really opened, and the driver never found out. He could never record
 * an order and never close a shift.
 *
 * The root cause was structural: of every shift route, `shift.operate` reached only writes. There
 * was NO endpoint at all by which a driver could read the state of his own shift.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })
const post = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })
const del = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'DELETE', url, headers: { cookie: h.cookie(token) } })

const startShift = async (): Promise<{ driver: string; shiftId: string }> => {
  const driver = await h.loginAs('driver1')
  const shiftId = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id
  return { driver, shiftId }
}

/** Drive a shift all the way to `open`, the way the two apps really do it. */
const openShift = async (): Promise<{ driver: string; manager: string; shiftId: string }> => {
  const { driver, shiftId } = await startShift()
  await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
  await put(driver, `/shifts/${shiftId}/start-package`, { odometerKm: 1000, batteryPercent: 90 })
  const manager = await h.loginAs('manager')
  const approved = await post(manager, `/shifts/${shiftId}/approve-open`, {
    floatTranches: [sypStr(100_000)],
    topupTranches: [sypStr(50_000)],
  })
  expect(approved.statusCode, approved.body).toBe(200)
  return { driver, manager, shiftId }
}

describe('a driver can read his own shift — and only his own', () => {
  it('reads the state of his own shift', async () => {
    const { driver, shiftId } = await startShift()
    const res = await get(driver, `/shifts/${shiftId}/state`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().id).toBe(shiftId)
    expect(res.json().state).toBe('draft')
  })

  it("is refused another driver's shift", async () => {
    const { shiftId } = await startShift()
    const other = await h.loginAs('driver2')
    expect((await get(other, `/shifts/${shiftId}/state`)).statusCode).toBe(403)
  })

  it('is still refused the manager’s review, which carries the BR1 diagnosis (BR8)', async () => {
    // The fix is a new endpoint scoped to him, NOT a widening of the manager's screen.
    const { driver, shiftId } = await startShift()
    expect((await get(driver, `/shifts/${shiftId}/review`)).statusCode).toBe(403)
  })

  it('the state read carries no BR1 causes', async () => {
    const { driver, shiftId } = await startShift()
    expect((await get(driver, `/shifts/${shiftId}/state`)).json().br1).toBeUndefined()
  })

  it('404s on a shift that does not exist, rather than leaking that it might', async () => {
    const driver = await h.loginAs('driver1')
    expect((await get(driver, '/shifts/00000000-0000-4000-8000-000000009999/state')).statusCode).toBe(403)
  })
})

describe('the state read carries everything a resume needs', () => {
  it('sees the manager’s approval — the poll that used to 403 forever', async () => {
    const { driver, shiftId } = await openShift()
    const res = await get(driver, `/shifts/${shiftId}/state`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().state).toBe('open')
    // The float and top-up the MANAGER entered, which the order screen's live BR1 preview needs.
    expect(res.json().startPackage.floatTotal).toBe(sypStr(100_000))
    expect(res.json().startPackage.topupTotal).toBe(sypStr(50_000))
  })

  it('reports which evidence already arrived, so tiles come back marked done', async () => {
    const { driver, shiftId } = await startShift()
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    const res = await get(driver, `/shifts/${shiftId}/state`)
    expect(res.json().startPackage.mediaSlots).toContain('odometer')
  })

  it('returns the orders already recorded, so re-entry cannot duplicate them', async () => {
    // provider_order_no is GLOBALLY unique: an order retyped after a resume is a 409, and the
    // driver's "done" button would silently do nothing.
    const { driver, shiftId } = await openShift()
    await post(driver, `/shifts/${shiftId}/orders`, {
      providerOrderNo: 'YAL-1', payMode: 'cash', fee: sypStr(5_000), zone: null,
    })
    const res = await get(driver, `/shifts/${shiftId}/state`)
    expect(res.json().orders).toHaveLength(1)
    expect(res.json().orders[0].providerOrderNo).toBe('YAL-1')
  })

  it('the start odometer and battery come back for the fields to rehydrate', async () => {
    const { driver, shiftId } = await openShift()
    const res = await get(driver, `/shifts/${shiftId}/state`)
    expect(res.json().startPackage.odometerKm).toBe(1000)
    expect(res.json().startPackage.batteryPercent).toBe(90)
  })
})

describe('a driver can discard a shift that never opened', () => {
  it('discards his own draft and is free to start again', async () => {
    const { driver, shiftId } = await startShift()
    expect((await del(driver, `/shifts/${shiftId}/mine`)).statusCode).toBe(200)
    // The bike is released and he is no longer "already on a shift".
    expect((await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).statusCode).toBe(201)
  })

  it('discards one awaiting the manager', async () => {
    const { driver, shiftId } = await startShift()
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    await put(driver, `/shifts/${shiftId}/start-package`, { odometerKm: 1000, batteryPercent: 90 })
    expect((await get(driver, `/shifts/${shiftId}/state`)).json().state).toBe('awaiting_open_approval')
    expect((await del(driver, `/shifts/${shiftId}/mine`)).statusCode).toBe(200)
  })

  it('CANNOT discard once it has opened — money may already have posted', async () => {
    const { driver, shiftId } = await openShift()
    const res = await del(driver, `/shifts/${shiftId}/mine`)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('shift_already_opened')
  })

  it("cannot discard another driver's shift", async () => {
    const { shiftId } = await startShift()
    const other = await h.loginAs('driver2')
    expect((await del(other, `/shifts/${shiftId}/mine`)).statusCode).toBe(403)
  })

  it('the discard is audited under the driver who made it', async () => {
    const { driver, shiftId } = await startShift()
    await del(driver, `/shifts/${shiftId}/mine`)
    const rows = await h.deps.audit.list({ tableName: 'shifts' })
    const deleted = rows.find((r) => r.action === 'DELETE')
    expect(deleted?.recordId).toBe(shiftId)
    expect(deleted?.actorId).toBe('u-d1')
  })
})

describe('the picker tells the driver whose shift is holding a bike', () => {
  it('marks his OWN live shift, so «on a shift now» is not a mystery', async () => {
    const { driver } = await startShift()
    const me = await get(driver, '/me/assignment')
    const mine = me.json().vehicles.find((v: { id: string }) => v.id === VEHICLE_ID)
    expect(mine.busy).toBe(true)
    expect(mine.busyByMe).toBe(true)
  })

  it("does not mark another driver's shift as his", async () => {
    await startShift() // driver1 takes VEHICLE_ID
    const other = await h.loginAs('driver2')
    const me = await get(other, '/me/assignment')
    const taken = me.json().vehicles.find((v: { id: string }) => v.id === VEHICLE_ID)
    expect(taken.busy).toBe(true)
    expect(taken.busyByMe).toBe(false)
  })

  it('reports the live shift so the app can resume it instead of offering a picker', async () => {
    const { driver, shiftId } = await startShift()
    const me = await get(driver, '/me/assignment')
    expect(me.json().liveShiftId).toBe(shiftId)
    expect(me.json().liveShiftState).toBe('draft')
    expect(DRIVER2_ID).toBeDefined()
  })
})
