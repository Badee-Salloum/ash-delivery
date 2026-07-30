import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER2_ID, DRIVER_ID, type Harness, OTHER_BRANCH, VEHICLE_ID, makeHarness } from './harness.ts'

/**
 * Driver ↔ vehicle assignments (SRS B-3 / س34), and the shift-release valve that goes with them.
 *
 * The binding is pre-declared by the manager, not chosen by the driver on his phone. Enforcing it
 * only in the driver UI would be theatre — a driver with the API can post any vehicle id — so the
 * rule lives in `createShift` and these tests exercise it there.
 *
 * The release valve exists because of a real trap: a driver who abandons the start screen leaves a
 * shift in `draft`, that shift still holds the bike, and nothing notifies anyone. The bike is then
 * unusable for the rest of the day with no route back short of a DBA.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>
const post = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })
const del = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'DELETE', url, headers: { cookie: h.cookie(token) } })

const startShift = async (token: string, driverId: string, vehicleId: string): Promise<LightMyRequestResponse> =>
  await post(token, '/shifts', { driverId, vehicleId, shiftNo: 1 })

describe('assignments (B-3)', () => {
  it('a manager binds a bike to a driver for today', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/assignments', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })
    expect(res.statusCode, res.body).toBe(201)
    // The business date defaults to the server's Damascus date — the manager never types it.
    expect(res.json().businessDate).toBe('2026-07-21')

    const list = await get(manager, '/assignments')
    expect(list.json().assignments).toHaveLength(1)
  })

  it('refuses a second binding on the same driver or the same bike that day', async () => {
    const manager = await h.loginAs('manager')
    expect((await post(manager, '/assignments', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })).statusCode).toBe(201)

    // Same driver, different bike.
    const dupDriver = await post(manager, '/assignments', { driverId: DRIVER_ID, vehicleId: 'vehicle-2' })
    expect(dupDriver.statusCode).toBe(409)
    expect(dupDriver.json().error).toBe('already_assigned')

    // Same bike, different driver.
    const dupVehicle = await post(manager, '/assignments', { driverId: DRIVER2_ID, vehicleId: VEHICLE_ID })
    expect(dupVehicle.statusCode).toBe(409)
  })

  it('refuses a cross-branch binding', async () => {
    const gm = await h.loginAs('gm')
    const res = await post(gm, '/assignments', {
      driverId: DRIVER_ID, // Damascus
      vehicleId: VEHICLE_ID,
      branchId: OTHER_BRANCH,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('cross_branch_assignment')
  })

  it('an assigned driver may start only his assigned bike', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/assignments', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })

    const driver = await h.loginAs('driver1')
    const wrong = await startShift(driver, DRIVER_ID, 'vehicle-2')
    expect(wrong.statusCode).toBe(409)
    expect(wrong.json().error).toBe('vehicle_not_assigned')
    expect(wrong.json().detail).toEqual({ assignedVehicleId: VEHICLE_ID })

    expect((await startShift(driver, DRIVER_ID, VEHICLE_ID)).statusCode).toBe(201)
  })

  it("an unassigned driver cannot take someone else's assigned bike", async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/assignments', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })

    const driver2 = await h.loginAs('driver2')
    const res = await startShift(driver2, DRIVER2_ID, VEHICLE_ID)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('vehicle_assigned_to_other_driver')

    // …but an unclaimed bike is still his to take. A branch that has not started assigning is not
    // locked out of its own shifts.
    expect((await startShift(driver2, DRIVER2_ID, 'vehicle-2')).statusCode).toBe(201)
  })

  it('with no assignments at all, the old free choice stands', async () => {
    const driver = await h.loginAs('driver1')
    expect((await startShift(driver, DRIVER_ID, VEHICLE_ID)).statusCode).toBe(201)
  })

  it('the driver app is shown his assigned bike and nothing else', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/assignments', { driverId: DRIVER_ID, vehicleId: 'vehicle-2' })

    const driver = await h.loginAs('driver1')
    const me = (await get(driver, '/me/assignment')).json()
    expect(me.assigned).toBe(true)
    expect(me.vehicles.map((v: { id: string }) => v.id)).toEqual(['vehicle-2'])
  })

  it('without an assignment the driver still sees the branch list', async () => {
    const driver = await h.loginAs('driver1')
    const me = (await get(driver, '/me/assignment')).json()
    expect(me.assigned).toBe(false)
    expect(me.vehicles.length).toBeGreaterThan(1)
  })

  it('unassigning frees the driver again', async () => {
    const manager = await h.loginAs('manager')
    const id = (await post(manager, '/assignments', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })).json().id

    expect((await del(manager, `/assignments/${id}`)).statusCode).toBe(200)
    const driver = await h.loginAs('driver1')
    expect((await startShift(driver, DRIVER_ID, 'vehicle-2')).statusCode).toBe(201)
  })

  it('a driver cannot assign bikes to himself', async () => {
    const driver = await h.loginAs('driver1')
    expect((await post(driver, '/assignments', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })).statusCode).toBe(403)
  })
})

describe('releasing a shift that never opened', () => {
  it('a draft shift holds the bike until the manager cancels it', async () => {
    const driver1 = await h.loginAs('driver1')
    const created = await startShift(driver1, DRIVER_ID, VEHICLE_ID)
    expect(created.statusCode).toBe(201)
    const shiftId = created.json().id

    // The bike is now unusable by anyone else — this is the trap.
    const driver2 = await h.loginAs('driver2')
    const blocked = await startShift(driver2, DRIVER2_ID, VEHICLE_ID)
    expect(blocked.statusCode).toBe(409)

    // A draft shift never notifies anyone, so the day's shift list is where it surfaces.
    const manager = await h.loginAs('manager')
    const day = await get(manager, '/shifts')
    expect(day.json().shifts).toEqual([
      expect.objectContaining({ id: shiftId, vehicleId: VEHICLE_ID, state: 'draft' }),
    ])

    expect((await del(manager, `/shifts/${shiftId}`)).statusCode).toBe(200)
    expect((await startShift(driver2, DRIVER2_ID, VEHICLE_ID)).statusCode).toBe(201)
  })

  it('`?live=1` answers "who is out now", ignoring the business date', async () => {
    // «النوبات الجارية» asks a question about NOW, not about today's date. A shift that opened
    // before midnight is still running under YESTERDAY's business date, and the date-filtered list
    // dropped it — the bike looked free and the shift was unreachable from the live screen.
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = (await startShift(driver, DRIVER_ID, VEHICLE_ID)).json().id as string

    // Backdate it, exactly as a shift that ran through the rollover would be.
    const shift = (await h.deps.shifts.findById(shiftId))!
    await h.deps.shifts.update({ ...shift, businessDate: '2026-07-01', state: 'open' })

    expect((await get(manager, '/shifts')).json().shifts).toEqual([]) // today's list: gone
    const live = (await get(manager, '/shifts?live=1')).json().shifts as Array<{ id: string; businessDate: string }>
    expect(live.map((s) => s.id)).toEqual([shiftId])
    expect(live[0]!.businessDate).toBe('2026-07-01') // and it says which day it belongs to
  })

  it('the live list carries what a manager judges a running shift by', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = (await startShift(driver, DRIVER_ID, VEHICLE_ID)).json().id as string
    const shift = (await h.deps.shifts.findById(shiftId))!
    await h.deps.shifts.update({ ...shift, state: 'open', odoStart: 1_234 })

    const row = (await get(manager, '/shifts?live=1')).json().shifts[0] as Record<string, unknown>
    // Money as decimal strings, never JSON numbers; the order count is what he has recorded so far.
    expect(row).toMatchObject({ id: shiftId, odometerStart: 1_234, orderCount: 0, floatTotal: '0.00', topupTotal: '0.00' })
  })

  it('the cancellation is audited', async () => {
    const driver1 = await h.loginAs('driver1')
    const shiftId = (await startShift(driver1, DRIVER_ID, VEHICLE_ID)).json().id
    const manager = await h.loginAs('manager')
    await del(manager, `/shifts/${shiftId}`)

    const rows = await h.deps.audit.list({ tableName: 'shifts' })
    expect(rows.map((r) => r.action)).toContain('DELETE')
    expect(rows.find((r) => r.action === 'DELETE')?.recordId).toBe(shiftId)
  })

  it('refuses to delete a shift that has opened — money may already have posted', async () => {
    const driver1 = await h.loginAs('driver1')
    const shiftId = (await startShift(driver1, DRIVER_ID, VEHICLE_ID)).json().id

    // Drive it to `open` through the real gates.
    await h.uploadPhoto(driver1, shiftId, 'start', 'odometer')
    await h.app.inject({
      method: 'PUT',
      url: `/shifts/${shiftId}/start-package`,
      headers: { cookie: h.cookie(driver1) },
      payload: { odometerKm: 1000, batteryPercent: 90 },
    })
    const manager = await h.loginAs('manager')
    const opened = await post(manager, `/shifts/${shiftId}/approve-open`, {
      floatTranches: ['1000.00'],
      topupTranches: ['500.00'],
    })
    expect(opened.statusCode, opened.body).toBe(200)

    const res = await del(manager, `/shifts/${shiftId}`)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('shift_already_opened')
  })

  it('a driver cannot cancel his own shift', async () => {
    const driver1 = await h.loginAs('driver1')
    const shiftId = (await startShift(driver1, DRIVER_ID, VEHICLE_ID)).json().id
    expect((await del(driver1, `/shifts/${shiftId}`)).statusCode).toBe(403)
  })
})
