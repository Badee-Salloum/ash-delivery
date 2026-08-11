import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS } from '@ash/domain'
import { SESSION_IDLE_MS } from '../src/auth.ts'
import { routeRegistry } from '../src/rbac.ts'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

describe('authentication (SRS A-1, §7)', () => {
  it('issues an httpOnly session cookie on success', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'manager', password: 'secret' },
    })
    expect(res.statusCode).toBe(200)
    const cookie = String(res.headers['set-cookie'])
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(res.json().roleKey).toBe('branch_manager')
  })

  it('rejects a wrong password without revealing whether the user exists', async () => {
    const wrongPassword = await h.app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'manager', password: 'nope' },
    })
    const noSuchUser = await h.app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'ghost', password: 'nope' },
    })
    expect(wrongPassword.statusCode).toBe(401)
    expect(noSuchUser.statusCode).toBe(401)
    expect(wrongPassword.json()).toEqual(noSuchUser.json())
  })

  it('locks the account after exactly 5 failed attempts (SRS A-1)', async () => {
    for (let i = 1; i <= 4; i++) {
      const res = await h.app.inject({
        method: 'POST', url: '/auth/login', payload: { username: 'manager', password: 'wrong' },
      })
      expect(res.statusCode, `attempt ${i}`).toBe(401)
    }
    const fifth = await h.app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'manager', password: 'wrong' },
    })
    expect(fifth.statusCode).toBe(423)
    expect(fifth.json().error).toBe('locked')

    // Even the CORRECT password is refused while locked.
    const correct = await h.app.inject({
      method: 'POST', url: '/auth/login', payload: { username: 'manager', password: 'secret' },
    })
    expect(correct.statusCode).toBe(423)
  })

  it('the lockout write is audited even though there is no actor', async () => {
    // The unauthenticated path has no actor by definition. A trigger that raised here would make
    // the lockout impossible to implement and turn every failed login into a 500.
    await h.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'manager', password: 'wrong' } })
    const rows = await h.deps.audit.list({ tableName: 'users' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actorKind).toBe('anonymous')
    expect(rows[0]?.actorId).toBeNull()
  })

  it('a successful login resets the failure counter', async () => {
    for (let i = 0; i < 3; i++) {
      await h.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'manager', password: 'wrong' } })
    }
    await h.loginAs('manager')
    expect((await h.deps.users.findByUsername('manager'))?.failedAttempts).toBe(0)
  })

  it('expires a session after 30 idle minutes', async () => {
    const token = await h.loginAs('manager')
    const before = await h.app.inject({ method: 'GET', url: '/me', headers: { cookie: h.cookie(token) } })
    expect(before.statusCode).toBe(200)

    h.deps.clock.advance(SESSION_IDLE_MS + 1)
    const after = await h.app.inject({ method: 'GET', url: '/me', headers: { cookie: h.cookie(token) } })
    expect(after.statusCode).toBe(401)
  })

  it('slides the window on activity, so a manager mid-review is not logged out', async () => {
    const token = await h.loginAs('manager')
    for (let i = 0; i < 5; i++) {
      h.deps.clock.advance(SESSION_IDLE_MS - 60_000) // active every 29 minutes
      const res = await h.app.inject({ method: 'GET', url: '/me', headers: { cookie: h.cookie(token) } })
      expect(res.statusCode, `poll ${i}`).toBe(200)
    }
  })

  it('logout revokes the session immediately', async () => {
    const token = await h.loginAs('manager')
    await h.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: h.cookie(token) } })
    const res = await h.app.inject({ method: 'GET', url: '/me', headers: { cookie: h.cookie(token) } })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a forged token', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/me', headers: { cookie: h.cookie('made-up') } })
    expect(res.statusCode).toBe(401)
  })
})

describe('the boot assertion — no route can escape RBAC', () => {
  it('every registered route declares a permission (or null, on purpose)', () => {
    const undeclared = routeRegistry().filter((r) => r.permission === undefined)
    expect(undeclared, `undeclared: ${undeclared.map((r) => `${r.method} ${r.url}`).join(', ')}`).toHaveLength(0)
  })

  it('every declared permission is one the domain knows about', () => {
    const known = new Set<string>(ALL_PERMISSIONS)
    for (const route of routeRegistry()) {
      if (route.permission === null || route.permission === undefined) continue
      expect(known.has(route.permission), `${route.method} ${route.url} → ${route.permission}`).toBe(true)
    }
  })

  it('only the routes meant to be public are public', () => {
    const publicRoutes = routeRegistry()
      .filter((r) => r.permission === null)
      .map((r) => `${r.method} ${r.url}`)
      .sort()
    expect(publicRoutes).toEqual(
      [
        'GET /me', 'GET /health', 'POST /auth/login', 'POST /auth/logout',
        'POST /auth/2fa/verify', 'POST /auth/2fa/enroll', 'POST /auth/2fa/confirm',
        'GET /notifications', 'POST /notifications/:id/read',
      ].sort(),
    )
  })
})

describe('RBAC over HTTP (AC #12)', () => {
  it('refuses an unauthenticated request to a protected route', async () => {
    const res = await h.app.inject({ method: 'PUT', url: '/fx', payload: { businessDate: '2026-07-21', sypMinorPerUsd: 13000 } })
    expect(res.statusCode).toBe(401)
  })

  it('only the system admin may set the daily rate (BR6)', async () => {
    const payload = { businessDate: '2026-07-21', sypMinorPerUsd: 13500 }
    for (const [user, expected] of [['sysadmin', 200], ['manager', 403], ['gm', 403], ['driver1', 403]] as const) {
      const token = await h.loginAs(user)
      const res = await h.app.inject({ method: 'PUT', url: '/fx', headers: { cookie: h.cookie(token) }, payload })
      expect(res.statusCode, user).toBe(expected)
    }
  })

  it('only the system admin may close the week (BR7)', async () => {
    for (const [user, expected] of [['manager', 403], ['gm', 403], ['driver1', 403]] as const) {
      const token = await h.loginAs(user)
      const res = await h.app.inject({
        method: 'POST', url: '/weeks/close', headers: { cookie: h.cookie(token) },
        payload: { closeDate: '2026-07-26' },
      })
      expect(res.statusCode, user).toBe(expected)
    }
  })

  it('only the sysadmin and the GM may read the audit log', async () => {
    for (const [user, expected] of [['sysadmin', 200], ['gm', 200], ['manager', 403], ['driver1', 403]] as const) {
      const token = await h.loginAs(user)
      const res = await h.app.inject({ method: 'GET', url: '/audit', headers: { cookie: h.cookie(token) } })
      expect(res.statusCode, user).toBe(expected)
    }
  })

  it('a driver may not approve a shift — not even his own', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const created = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    const id = created.json().id
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    await h.app.inject({
      method: 'PUT', url: `/shifts/${id}/start-package`, headers: { cookie: h.cookie(driver) },
      payload: { odometerKm: 1, batteryPercent: 90 },
    })
    const asDriver = await h.app.inject({
      method: 'POST', url: `/shifts/${id}/approve-open`, headers: { cookie: h.cookie(driver) },
      payload: { floatTranches: [sypStr(1_000)], topupTranches: [sypStr(1_000)] },
    })
    expect(asDriver.statusCode).toBe(403)
    expect(asDriver.json().reason).toBe('no_grant_for_role')

    const asManager = await h.app.inject({
      method: 'POST', url: `/shifts/${id}/approve-open`, headers: { cookie: h.cookie(manager) },
      payload: { floatTranches: [sypStr(1_000)], topupTranches: [sypStr(1_000)] },
    })
    expect(asManager.statusCode).toBe(200)
  })

  it('a branch manager cannot reach another branch’s shift', async () => {
    const driver = await h.loginAs('driver1')
    const otherManager = await h.loginAs('manager2') // Aleppo
    const created = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    const res = await h.app.inject({
      method: 'GET', url: `/shifts/${created.json().id}/review`, headers: { cookie: h.cookie(otherManager) },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().reason).toBe('outside_branch')
  })

  it('a driver cannot create a shift for another driver', async () => {
    const driver = await h.loginAs('driver1')
    const res = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: 'driver-2', vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().reason).toBe('not_owner')
  })
})

describe('assignment rules (SRS B-3)', () => {
  it('a driver cannot hold two live shifts at once', async () => {
    const driver = await h.loginAs('driver1')
    const first = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    expect(first.statusCode).toBe(201)

    const second = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: DRIVER_ID, vehicleId: 'vehicle-2', shiftNo: 2 },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json().detail).toContain('driver_already_on_shift')
  })

  it('a vehicle cannot be in two live shifts at once, though it IS shared across shifts', async () => {
    const d1 = await h.loginAs('driver1')
    const d2 = await h.loginAs('driver2')
    await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(d1) },
      payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    const clash = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(d2) },
      payload: { driverId: 'driver-2', vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().detail).toContain('vehicle_already_on_shift')
  })

  it('refuses a vehicle that is not ready', async () => {
    h.deps.directory.vehicles.set(VEHICLE_ID, {
      id: VEHICLE_ID, branchId: 'branch-damascus', vehicleTypeId: 'e_motorbike', machineNo: 9, plateNo: null,
      groundNo: null,
      code: 'VEH-1', state: 'maintenance', active: true,
    })
    const driver = await h.loginAs('driver1')
    const res = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().detail).toContain('vehicle_not_ready')
  })
})

describe('money on the wire', () => {
  // Float/top-up now cross the wire on approve-open (the manager records them), so the money-schema
  // checks live there.
  it('rejects a JSON number where money is expected', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const created = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    const res = await h.app.inject({
      method: 'POST', url: `/shifts/${created.json().id}/approve-open`,
      headers: { cookie: h.cookie(manager) },
      payload: {
        floatTranches: [100000], // ← a Number, not a decimal string
        topupTranches: [],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
  })

  it('rejects more than two decimal places', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const created = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    const res = await h.app.inject({
      method: 'POST', url: `/shifts/${created.json().id}/approve-open`,
      headers: { cookie: h.cookie(manager) },
      payload: {
        floatTranches: ['100.005'], topupTranches: [],
      },
    })
    expect(res.statusCode).toBe(400)
  })
})
