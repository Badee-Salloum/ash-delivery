import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * «الرقم التمييزي على الأرض» — the number marked on the machine and on the pack — and the delete
 * that a manager needs beside it.
 *
 * A vehicle carried two identifiers and neither was legible in the yard: `code` («1-1-1-4») says
 * where the bike sits in the fleet and is painted on nothing, and an electric motorbike here often
 * has no plate. A pack was worse — `serialNo` and `bmsMac` come off the BMS app and can only be
 * read by pairing to the pack over Bluetooth, which is useless to a man holding two packs at a
 * shelf. So the driver picking a bike, and the driver photographing two batteries, were both
 * matching what is in their hands against a number that is not written on it.
 *
 * Delete is the other half. It means two different things and only one of them is a delete: get rid
 * of an asset recorded BY MISTAKE, or take a real one out of the fleet. The second is a state
 * change, and the server must say so rather than fail at a foreign key.
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
const patch = async (t: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PATCH', url, headers: { cookie: h.cookie(t) }, payload })
const put = async (t: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(t) }, payload })
const del = async (t: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'DELETE', url, headers: { cookie: h.cookie(t) } })
const get = async (t: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(t) } })

async function aVehicleType(manager: string): Promise<string> {
  const types = (await get(manager, '/vehicle-types')).json().vehicleTypes as Array<{ id: string }>
  return types[0]!.id
}

describe('the number on the machine', () => {
  it('reaches the driver picking a bike — that is the whole point of recording it', async () => {
    const manager = await h.loginAs('manager')
    const created = await post(manager, '/vehicles', {
      vehicleTypeId: await aVehicleType(manager),
      groundNo: '7',
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().groundNo).toBe('7')

    const driver = await h.loginAs('driver1')
    const mine = (await get(driver, '/me/assignment')).json()
    const bike = mine.vehicles.find((v: { id: string }) => v.id === created.json().id)
    expect(bike.groundNo).toBe('7')
    // The fleet code is still there — it remains the identity, the marking is only how he finds it.
    expect(bike.code).toBeTruthy()
  })

  it('is correctable, and clearing it is a real answer rather than a blank', async () => {
    const manager = await h.loginAs('manager')
    const id = (await post(manager, '/vehicles', { vehicleTypeId: await aVehicleType(manager), groundNo: '7' })).json()
      .id as string

    expect((await patch(manager, `/vehicles/${id}`, { groundNo: '9' })).json().groundNo).toBe('9')
    // Paint wears off. «This bike carries no legible number» is a fact worth recording.
    expect((await patch(manager, `/vehicles/${id}`, { groundNo: null })).json().groundNo).toBeNull()
    // And an omitted key leaves it alone rather than clearing it.
    await patch(manager, `/vehicles/${id}`, { groundNo: '4' })
    expect((await patch(manager, `/vehicles/${id}`, { state: 'charging' })).json().groundNo).toBe('4')
  })

  it('reaches the driver for a battery pack too, fitted and spare', async () => {
    const manager = await h.loginAs('manager')
    const fitted = await post(manager, '/batteries', { capacityAh: 50, vehicleId: VEHICLE_ID, slotNo: 1, groundNo: 'ب-1' })
    expect(fitted.statusCode).toBe(201)
    await post(manager, '/batteries', { capacityAh: 30, groundNo: 'ب-2' })

    const driver = await h.loginAs('driver1')
    const mine = (await get(driver, '/me/assignment')).json()
    const bike = mine.vehicles.find((v: { id: string }) => v.id === VEHICLE_ID)
    expect(bike.batteries.some((b: { groundNo: string | null }) => b.groundNo === 'ب-1')).toBe(true)
    // The shelf is where it matters most — two identical packs in one pair of hands.
    expect(mine.spareBatteries.some((b: { groundNo: string | null }) => b.groundNo === 'ب-2')).toBe(true)
  })
})

describe('deleting a vehicle or a pack', () => {
  it('removes one recorded by mistake', async () => {
    const manager = await h.loginAs('manager')
    const id = (await post(manager, '/vehicles', { vehicleTypeId: await aVehicleType(manager), groundNo: '99' })).json()
      .id as string

    expect((await del(manager, `/vehicles/${id}`)).statusCode).toBe(204)
    const list = (await get(manager, '/vehicles')).json().vehicles as Array<{ id: string }>
    expect(list.map((v) => v.id)).not.toContain(id)
  })

  it('refuses one that has carried a shift — the money hangs off those rows', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shift = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json()
      .id as string
    await h.uploadPhoto(driver, shift, 'start', 'odometer')
    await put(driver, `/shifts/${shift}/start-package`, { odometerKm: 100, batteryPercent: 90 })
    await post(manager, `/shifts/${shift}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })

    const refused = await del(manager, `/vehicles/${VEHICLE_ID}`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toBe('vehicle_has_history')
    // Still there, untouched — a refusal writes nothing.
    expect((await get(manager, '/vehicles')).json().vehicles.map((v: { id: string }) => v.id)).toContain(VEHICLE_ID)
  })

  it('refuses one with packs still fitted rather than orphaning them', async () => {
    const manager = await h.loginAs('manager')
    const id = (await post(manager, '/vehicles', { vehicleTypeId: await aVehicleType(manager) })).json().id as string
    await post(manager, '/batteries', { capacityAh: 50, vehicleId: id, slotNo: 1 })

    const refused = await del(manager, `/vehicles/${id}`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toBe('vehicle_has_batteries')
  })

  it('removes a pack recorded by mistake, and refuses one that has been read', async () => {
    const manager = await h.loginAs('manager')
    const spare = (await post(manager, '/batteries', { capacityAh: 30, groundNo: 'typo' })).json().id as string
    expect((await del(manager, `/batteries/${spare}`)).statusCode).toBe(204)

    // Now one with a reading behind it: that reading is the evidence for a shift.
    const driver = await h.loginAs('driver1')
    const fitted = (await post(manager, '/batteries', { capacityAh: 50, vehicleId: VEHICLE_ID, slotNo: 1 })).json()
      .id as string
    const shift = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json()
      .id as string
    await h.uploadPhoto(driver, shift, 'start', 'bms_1')
    await put(driver, `/shifts/${shift}/battery-readings`, {
      package: 'start',
      readings: [{ batteryId: fitted, slotNo: 1, percent: 90 }],
    })

    const refused = await del(manager, `/batteries/${fitted}`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toBe('battery_has_history')
  })

  /**
   * Taking a bike out of service strands the shift riding on it — and there are two ways to do it.
   *
   * The guard lived INSIDE the `state` branch, so it only ran for a state change. `{active: false}`
   * removed the same bike from every list the drivers and the gates read, mid-shift, without passing
   * a single check. Both mean "this bike is no longer available", so both answer to the same rule.
   */
  it('refuses to deactivate a bike that is out on a shift, not just to change its state', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shift = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json()
      .id as string
    await h.uploadPhoto(driver, shift, 'start', 'odometer')
    await put(driver, `/shifts/${shift}/start-package`, { odometerKm: 100, batteryPercent: 90 })
    await post(manager, `/shifts/${shift}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [] })

    const deactivated = await patch(manager, `/vehicles/${VEHICLE_ID}`, { active: false })
    expect(deactivated.statusCode).toBe(409)
    expect(deactivated.json().error).toBe('vehicle_has_live_shift')

    // The older path still holds too.
    expect((await patch(manager, `/vehicles/${VEHICLE_ID}`, { state: 'maintenance' })).statusCode).toBe(409)

    // And nothing was written: the bike is still active and still ready.
    const still = (await get(manager, '/vehicles')).json().vehicles.find((v: { id: string }) => v.id === VEHICLE_ID)
    expect(still.active).toBe(true)
    expect(still.state).toBe('ready')
  })

  it('is not a driver’s to do', async () => {
    const manager = await h.loginAs('manager')
    const id = (await post(manager, '/vehicles', { vehicleTypeId: await aVehicleType(manager) })).json().id as string

    const driver = await h.loginAs('driver1')
    expect((await del(driver, `/vehicles/${id}`)).statusCode).toBe(403)
  })
})
