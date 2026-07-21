import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, DRIVER_ID, type Harness, OTHER_BRANCH, VEHICLE_ID, makeHarness } from './harness.ts'

/**
 * Fleet management (SRS §B). Without these routes the platform cannot be used at all: there
 * would be no way to create the people and machines every shift is bound to.
 *
 * These tests are also what surfaced a genuine design flaw. Fleet writes were originally guarded
 * by `user.manage`, which the §3 matrix grants to sysadmin and GM — both organisation-wide roles
 * with NO branch. A driver must belong to a branch, so nobody could create one. Hence
 * `fleet.manage` (ASSUMPTION A-27).
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>

const post = async (token: string, url: string, payload: Payload): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const patch = async (token: string, url: string, payload: Payload): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PATCH', url, headers: { cookie: h.cookie(token) }, payload })
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

describe('drivers (B-1)', () => {
  it('a branch manager onboards a driver into his own branch', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/drivers', { code: 'DRV-9', fullNameAr: 'سائق جديد' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().branchId).toBe(BRANCH)
    expect(res.json().active).toBe(true)
  })

  it('an organisation-wide role must name the branch explicitly', async () => {
    const gm = await h.loginAs('gm')
    // The GM has no branch of his own, so defaulting would be a guess.
    expect((await post(gm, '/drivers', { code: 'DRV-A', fullNameAr: 'أ' })).statusCode).toBe(422)
    const named = await post(gm, '/drivers', { code: 'DRV-A', fullNameAr: 'أ', branchId: BRANCH })
    expect(named.statusCode, named.body).toBe(201)
    expect(named.json().branchId).toBe(BRANCH)
  })

  it('a branch manager cannot onboard into ANOTHER branch, even by naming it', async () => {
    const manager = await h.loginAs('manager') // Damascus
    const res = await post(manager, '/drivers', {
      code: 'DRV-X',
      fullNameAr: 'خارج الفرع',
      branchId: OTHER_BRANCH,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().reason).toBe('outside_branch')
  })

  it('refuses a duplicate driver code', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/drivers', { code: 'DRV-1', fullNameAr: 'مكرر' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('duplicate_driver_code')
  })

  it('a driver may not manage the fleet', async () => {
    const driver = await h.loginAs('driver1')
    expect((await post(driver, '/drivers', { code: 'X', fullNameAr: 'x' })).statusCode).toBe(403)
    expect((await get(driver, '/drivers')).statusCode).toBe(403)
  })

  it('lists drivers with their document status', async () => {
    const manager = await h.loginAs('manager')
    const res = await get(manager, '/drivers')
    expect(res.statusCode).toBe(200)
    const drivers = res.json().drivers as Array<{ id: string; blockedByDocuments: boolean }>
    expect(drivers.map((d) => d.id).sort()).toEqual([DRIVER_ID, 'driver-2'])
    expect(drivers.every((d) => d.blockedByDocuments === false)).toBe(true)
  })

  it('refuses to deactivate a driver who is on a live shift', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })

    // Deactivating mid-shift would strand a shift nobody can close.
    const res = await patch(manager, `/drivers/${DRIVER_ID}`, { active: false })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('driver_has_live_shift')
  })

  it('allows deactivation once no shift is live', async () => {
    const manager = await h.loginAs('manager')
    const res = await patch(manager, `/drivers/${DRIVER_ID}`, { active: false })
    expect(res.statusCode).toBe(200)
    expect(res.json().active).toBe(false)
  })
})

describe('vehicles (B-2)', () => {
  it('creates a vehicle in the ready state', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/vehicles', { code: 'VEH-9', vehicleTypeId: 'e_motorbike' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().state).toBe('ready')
  })

  it('honours the vehicle state machine', async () => {
    const manager = await h.loginAs('manager')
    expect((await patch(manager, `/vehicles/${VEHICLE_ID}`, { state: 'charging' })).statusCode).toBe(200)
    // charging → maintenance is legal; maintenance → charging is not.
    expect((await patch(manager, `/vehicles/${VEHICLE_ID}`, { state: 'maintenance' })).statusCode).toBe(200)
    const illegal = await patch(manager, `/vehicles/${VEHICLE_ID}`, { state: 'charging' })
    expect(illegal.statusCode).toBe(422)
    expect(illegal.json().error).toBe('illegal_vehicle_transition')
  })

  it('refuses to take a vehicle out of service mid-shift', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })

    const res = await patch(manager, `/vehicles/${VEHICLE_ID}`, { state: 'maintenance' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('vehicle_has_live_shift')
  })

  it('a manager sees only his own branch’s fleet', async () => {
    const aleppo = await h.loginAs('manager2')
    const res = await get(aleppo, '/vehicles')
    expect(res.statusCode).toBe(200)
    expect(res.json().vehicles).toEqual([]) // Damascus vehicles are invisible
  })
})

describe('documents and expiry (B-1 / س37)', () => {
  it('records a document and reports its status against today', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/documents', {
      ownerKind: 'driver',
      driverId: DRIVER_ID,
      kind: 'driving_licence',
      expiresOn: '2026-07-25', // four days out
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().status).toBe('expiring_soon')
  })

  it('an EXPIRED document blocks the driver from being assigned', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/documents', {
      ownerKind: 'driver',
      driverId: DRIVER_ID,
      kind: 'driving_licence',
      expiresOn: '2026-07-20', // yesterday
    })
    const drivers = (await get(manager, '/drivers')).json().drivers as Array<{
      id: string
      blockedByDocuments: boolean
    }>
    expect(drivers.find((d) => d.id === DRIVER_ID)?.blockedByDocuments).toBe(true)
  })

  it('refuses a document whose owner fields contradict ownerKind', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/documents', {
      ownerKind: 'driver',
      vehicleId: VEHICLE_ID, // a vehicle id on a driver document
      kind: 'registration',
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('document_owner_mismatch')
  })

  it('the expiry board defaults to a 30-day horizon and lists what falls inside it', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/documents', {
      ownerKind: 'driver', driverId: DRIVER_ID, kind: 'national_id', expiresOn: '2026-08-01',
    })
    await post(manager, '/documents', {
      ownerKind: 'driver', driverId: 'driver-2', kind: 'criminal_record', expiresOn: '2026-12-01',
    })

    const res = await get(manager, '/documents/expiring')
    expect(res.statusCode).toBe(200)
    expect(res.json().today).toBe('2026-07-21')
    expect(res.json().through).toBe('2026-08-20')
    const kinds = (res.json().documents as Array<{ kind: string }>).map((d) => d.kind)
    expect(kinds).toContain('national_id')
    expect(kinds).not.toContain('criminal_record') // December is beyond the horizon
  })
})

describe('every fleet mutation is audited (A-5)', () => {
  it('records who created a driver, with before and after', async () => {
    const manager = await h.loginAs('manager')
    const created = await post(manager, '/drivers', { code: 'DRV-AUD', fullNameAr: 'تدقيق' })
    const rows = await h.deps.audit.list({ tableName: 'drivers', recordId: created.json().id })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.action).toBe('INSERT')
    expect(rows[0]?.actorId).toBe('u-bm')
    expect(rows[0]?.before).toBeNull()
    expect((rows[0]?.after as { code: string }).code).toBe('DRV-AUD')
  })
})
