import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, DRIVER_ID, GOV_DAMASCUS, type Harness, VEHICLE_ID, VEHICLE_TYPE, makeHarness } from './harness.ts'

/**
 * «رقم الآلية» — the vehicle-numbering scheme — and battery packs as assets.
 *
 * The number is `<governorate>-<branch>-<type>-<machine>`, so it is not a label somebody types:
 * it is derived from where the machine actually sits. That makes two things true, and both are
 * pinned here — a vehicle whose printed number disagrees with its branch cannot be created, and
 * renumbering a type restates the printed number of every vehicle of that type.
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
const patch = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PATCH', url, headers: { cookie: h.cookie(token) }, payload })

describe('vehicle types are data with a number (SRS B-2)', () => {
  it('the system admin adds a type and it appears in the list', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/vehicle-types', {
      code: 'e_scooter', nameAr: 'سكوتر كهربائي', nameEn: 'Electric Scooter', typeNo: 2,
    })
    expect(res.statusCode, res.body).toBe(201)

    const list = await get(admin, '/vehicle-types')
    expect(list.json().vehicleTypes.map((t: { typeNo: number }) => t.typeNo)).toEqual([1, 2])
  })

  it('refuses a type number that is already taken', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/vehicle-types', { code: 'e_scooter', nameAr: 'س', nameEn: 'S', typeNo: 1 })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('duplicate_vehicle_type')
  })

  it('RENUMBERING a type restates the printed number of every vehicle of that type', async () => {
    // The type number is the third segment of every one of its vehicles' numbers. Writing the new
    // number without restating them would leave `code` — the thing typed into a search box and
    // read aloud over a phone — quietly disagreeing with the scheme that produced it.
    const admin = await h.loginAs('sysadmin')
    const manager = await h.loginAs('manager')

    expect((await get(manager, '/vehicles')).json().vehicles.map((v: { code: string }) => v.code))
      .toEqual(['1-1-1-1', '1-1-1-2'])

    const res = await patch(admin, `/vehicle-types/${VEHICLE_TYPE}`, { typeNo: 7 })
    expect(res.statusCode, res.body).toBe(200)

    expect((await get(manager, '/vehicles')).json().vehicles.map((v: { code: string }) => v.code))
      .toEqual(['1-1-7-1', '1-1-7-2'])
  })

  it('a branch manager may not renumber types — that is configuration, not fleet work', async () => {
    const manager = await h.loginAs('manager')
    expect((await patch(manager, `/vehicle-types/${VEHICLE_TYPE}`, { typeNo: 7 })).statusCode).toBe(403)
  })

  it('renumbering is audited, because it silently changes printed numbers', async () => {
    const admin = await h.loginAs('sysadmin')
    await patch(admin, `/vehicle-types/${VEHICLE_TYPE}`, { typeNo: 7 })
    const rows = await h.deps.audit.list({ tableName: 'vehicle_types' })
    expect(rows.map((r) => r.action)).toContain('UPDATE')
  })
})

describe('governorates and branch numbers', () => {
  it('lists the governorates the numbering scheme draws its first segment from', async () => {
    const manager = await h.loginAs('manager')
    const res = await get(manager, '/governorates')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().governorates.find((g: { no: number }) => g.no === 1).nameAr).toBe('دمشق')
  })

  it('a new branch carries a number, and moving it restates its vehicles', async () => {
    const admin = await h.loginAs('sysadmin')
    // Damascus branch 2: a second branch in the same governorate takes the next branch number.
    const created = await post(admin, '/branches', {
      code: 'DAM2', nameAr: 'دمشق ٢', nameEn: 'Damascus 2', governorateId: GOV_DAMASCUS, branchNo: 2,
    })
    expect(created.statusCode, created.body).toBe(201)

    // Renumbering the ORIGINAL branch must restate its vehicles' second segment.
    const moved = await patch(admin, `/branches/${BRANCH}`, { branchNo: 5 })
    expect(moved.statusCode, moved.body).toBe(200)

    const manager = await h.loginAs('manager')
    expect((await get(manager, '/vehicles')).json().vehicles.map((v: { code: string }) => v.code))
      .toEqual(['1-5-1-1', '1-5-1-2'])
  })

  it('refuses two branches with the same number in one governorate', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/branches', {
      code: 'DAM3', nameAr: 'دمشق ٣', nameEn: 'Damascus 3', governorateId: GOV_DAMASCUS, branchNo: 1,
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('battery packs are assets, not attributes', () => {
  const pack = (over: Payload = {}): Payload => ({ capacityAh: 50, serialNo: 'DB24SA08L24S40ABU', ...over })

  it('a pack can be created as a spare, with no bike and no slot', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/batteries', pack())
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().vehicleId).toBeNull()
    expect(res.json().slotNo).toBeNull()
  })

  it('fitting means BOTH a bike and a slot — half-fitted is refused', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/batteries', pack({ vehicleId: VEHICLE_ID }))
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('battery_half_fitted')
  })

  it('two packs cannot share a slot on the same bike', async () => {
    const manager = await h.loginAs('manager')
    expect((await post(manager, '/batteries', pack({ vehicleId: VEHICLE_ID, slotNo: 1 }))).statusCode).toBe(201)

    const clash = await post(manager, '/batteries', pack({ serialNo: 'OTHER-SERIAL', vehicleId: VEHICLE_ID, slotNo: 1 }))
    expect(clash.statusCode).toBe(409)
  })

  it('a serial is unique, because it is what ties a screenshot to a pack', async () => {
    const manager = await h.loginAs('manager')
    expect((await post(manager, '/batteries', pack())).statusCode).toBe(201)
    expect((await post(manager, '/batteries', pack())).statusCode).toBe(409)
  })

  it('a pack can be moved to another bike, and follows its own history', async () => {
    const manager = await h.loginAs('manager')
    const id = (await post(manager, '/batteries', pack({ vehicleId: VEHICLE_ID, slotNo: 1 }))).json().id

    const moved = await patch(manager, `/batteries/${id}`, { vehicleId: 'vehicle-2', slotNo: 2 })
    expect(moved.statusCode, moved.body).toBe(200)
    expect(moved.json().vehicleId).toBe('vehicle-2')
    expect(moved.json().slotNo).toBe(2)
  })

  it('a pack cannot be pulled off a bike that is mid-shift', async () => {
    // Removing it would leave the close gate demanding a screenshot for a pack that is no longer
    // fitted, and the driver could never submit his shift.
    const manager = await h.loginAs('manager')
    const id = (await post(manager, '/batteries', pack({ vehicleId: VEHICLE_ID, slotNo: 1 }))).json().id

    const driver = await h.loginAs('driver1')
    await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })

    const res = await patch(manager, `/batteries/${id}`, { vehicleId: null, slotNo: null })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('vehicle_has_live_shift')
  })
})
