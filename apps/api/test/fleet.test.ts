import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nullCipher } from '@ash/adapters/crypto'
import { BRANCH, DRIVER_ID, type Harness, OTHER_BRANCH, VEHICLE_ID, VEHICLE_TYPE, makeHarness } from './harness.ts'

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

describe('driver profile fields (B-1)', () => {
  const patch = async (token: string, url: string, payload: Payload): Promise<LightMyRequestResponse> =>
    await h.app.inject({ method: 'PATCH', url, headers: { cookie: h.cookie(token) }, payload })

  it('round-trips phone, English name and hire date on create', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/drivers', {
      code: 'DRV-P', fullNameAr: 'مع ملف', fullNameEn: 'Full Profile', phone: '0999123456', hiredOn: '2026-01-15',
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ fullNameEn: 'Full Profile', phone: '0999123456', hiredOn: '2026-01-15' })

    const listed = (await get(manager, '/drivers')).json().drivers as Array<Record<string, unknown>>
    expect(listed.find((d) => d.code === 'DRV-P')).toMatchObject({ phone: '0999123456', hiredOn: '2026-01-15' })
  })

  it('stores the national ID encrypted and returns only a masked tail', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/drivers', { code: 'DRV-N', fullNameAr: 'رقم وطني', nationalId: '1234567890' })
    expect(res.statusCode, res.body).toBe(201)
    // The wire carries a mask, never the number.
    expect(res.json().nationalId).toBe('••••7890')
    expect(res.body).not.toContain('1234567890')

    // At rest it is ciphertext (a byte array), not the plaintext.
    const stored = h.deps.directory.drivers.get(res.json().id)?.nationalIdEnc
    expect(stored).toBeTruthy()
    expect(Buffer.from(stored!).toString('utf8')).not.toContain('1234567890')
  })

  it('a patch changes one field without disturbing the national ID', async () => {
    const manager = await h.loginAs('manager')
    const id = (await post(manager, '/drivers', { code: 'DRV-E', fullNameAr: 'تعديل', nationalId: '5556667778' })).json().id
    const encBefore = Buffer.from(h.deps.directory.drivers.get(id)!.nationalIdEnc!)

    const res = await patch(manager, `/drivers/${id}`, { phone: '0988000111' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().phone).toBe('0988000111')
    expect(res.json().nationalId).toBe('••••7778') // still on file, untouched

    const encAfter = Buffer.from(h.deps.directory.drivers.get(id)!.nationalIdEnc!)
    expect(encAfter.equals(encBefore)).toBe(true)
  })

  it('fails closed when no encryption key is configured', async () => {
    const manager = await h.loginAs('manager')
    h.deps.cipher = nullCipher() // simulate a deployment with ENCRYPTION_KEY unset
    const res = await post(manager, '/drivers', { code: 'DRV-K', fullNameAr: 'بلا مفتاح', nationalId: '1112223334' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('encryption_unavailable')
    // And nothing was written — the refusal came before the insert.
    const listed = (await get(manager, '/drivers')).json().drivers as Array<{ code: string }>
    expect(listed.some((d) => d.code === 'DRV-K')).toBe(false)
  })

  it('a driver with no national ID reports it as null, not a mask', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/drivers', { code: 'DRV-0', fullNameAr: 'بدون' })
    expect(res.json().nationalId).toBeNull()
  })
})

describe('vehicles (B-2)', () => {
  it('creates a vehicle in the ready state, numbered from where it sits', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/vehicles', { vehicleTypeId: VEHICLE_TYPE })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().state).toBe('ready')
    // Damascus (1), branch 1, e-motorbike (1) — and machine 3, the lowest free after the two
    // the harness seeds. The caller never sends a code: it is derived, so a vehicle whose
    // printed number disagrees with its branch cannot be created.
    expect(res.json().code).toBe('1-1-1-3')
    expect(res.json().machineNo).toBe(3)
  })

  it('refuses an unknown vehicle type by name instead of 500ing', async () => {
    // This is the production bug: the console sent the literal string 'e_motorbike' for a uuid
    // foreign key, Postgres raised 22P02, and the UI swallowed the 500 and reported success.
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/vehicles', { vehicleTypeId: 'e_motorbike' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('vehicle_type_not_found')
  })

  it('previews the next number before the bike exists', async () => {
    const manager = await h.loginAs('manager')
    const res = await get(manager, `/vehicles/next-number?vehicleTypeId=${VEHICLE_TYPE}`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ code: '1-1-1-3', machineNo: 3 })
  })

  it('an explicit machine number is honoured, and a clash is refused', async () => {
    const manager = await h.loginAs('manager')
    expect((await post(manager, '/vehicles', { vehicleTypeId: VEHICLE_TYPE, machineNo: 7 })).json().code).toBe('1-1-1-7')

    const clash = await post(manager, '/vehicles', { vehicleTypeId: VEHICLE_TYPE, machineNo: 7 })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error).toBe('duplicate_vehicle_code')
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

  it('an expired driver document blocks the shift itself, not just the badge', async () => {
    // The badge was cosmetic until now: createShift fed the gate empty arrays, so a driver whose
    // licence had lapsed could still start. This is the gate actually refusing — the whole point.
    const manager = await h.loginAs('manager')
    await post(manager, '/documents', {
      ownerKind: 'driver', driverId: DRIVER_ID, kind: 'driving_licence', expiresOn: '2026-07-20',
    })
    const driver = await h.loginAs('driver1')
    const res = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('cannot_open_shift')
    expect(res.json().detail).toContain('driver_document_expired')
  })

  it('an expired VEHICLE document blocks the shift too', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/documents', {
      ownerKind: 'vehicle', vehicleId: VEHICLE_ID, kind: 'registration', expiresOn: '2026-07-20',
    })
    const driver = await h.loginAs('driver1')
    const res = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })
    expect(res.statusCode).toBe(409)
    expect(res.json().detail).toContain('vehicle_document_expired')
  })

  it('a still-valid document does not block the shift', async () => {
    // Guards against over-blocking: a document that is merely present, or expiring later, is fine.
    const manager = await h.loginAs('manager')
    await post(manager, '/documents', {
      ownerKind: 'driver', driverId: DRIVER_ID, kind: 'driving_licence', expiresOn: '2027-01-01',
    })
    const driver = await h.loginAs('driver1')
    const res = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })
    expect(res.statusCode, res.body).toBe(201)
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

  it('opening the expiry board rings the branch bell once per document per threshold band', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/documents', {
      ownerKind: 'driver', driverId: DRIVER_ID, kind: 'driving_licence', expiresOn: '2026-07-26', // 5 days → t-7
    })

    const rings = (): typeof h.deps.notifications.rows =>
      h.deps.notifications.rows.filter((r) => r.kind === 'document_expiring')

    await get(manager, '/documents/expiring')
    expect(rings()).toHaveLength(1)
    expect(rings()[0]!.recipientId).toBe(`branch:${BRANCH}`)
    expect(rings()[0]!.dedupeKey).toBe(`${rings()[0]!.payload.documentId}:t-7`)

    // Re-opening the board must not ring again — the bell rings once per band, not per view.
    await get(manager, '/documents/expiring')
    expect(rings()).toHaveLength(1)
  })

  it('does not ring for a document still outside every alert threshold', async () => {
    const manager = await h.loginAs('manager')
    // 2026-09-30 is ~71 days out — beyond the 30-day board horizon, so nothing to alert on yet.
    await post(manager, '/documents', {
      ownerKind: 'driver', driverId: DRIVER_ID, kind: 'national_id', expiresOn: '2026-09-30',
    })
    await get(manager, '/documents/expiring')
    expect(h.deps.notifications.rows.filter((r) => r.kind === 'document_expiring')).toHaveLength(0)
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
