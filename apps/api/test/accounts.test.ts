import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, type Harness, makeHarness } from './harness.ts'

/**
 * Accounts (SRS A-2). `user.manage` is a sysadmin/GM permission, so only those roles reach these
 * routes. A driver-role account also gets a linked driver record, so the login can operate a shift.
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
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

const account = (over: Payload = {}): Payload => ({
  username: 'newuser',
  password: 'password1234',
  roleKey: 'branch_manager',
  fullNameAr: 'مستخدم جديد',
  branchId: BRANCH,
  ...over,
})

describe('accounts (SRS A-2)', () => {
  it('the system admin creates a branch-manager account', async () => {
    const sa = await h.loginAs('sysadmin')
    const res = await post(sa, '/users', account({ username: 'newmgr' }))
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().roleKey).toBe('branch_manager')
    expect(res.json().branchId).toBe(BRANCH)
  })

  it('the general manager may also create accounts', async () => {
    const gm = await h.loginAs('gm')
    const res = await post(gm, '/users', account({ username: 'gmmade', roleKey: 'accountant', branchId: undefined }))
    expect(res.statusCode, res.body).toBe(201)
  })

  it('a driver account is created WITH a linked driver record', async () => {
    const sa = await h.loginAs('sysadmin')
    const res = await post(sa, '/users', account({ username: 'newdrv', roleKey: 'driver' }))
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().driverId).toBeTruthy()
    // and the new account can actually log in
    const login = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'newdrv', password: 'password1234' },
    })
    expect(login.statusCode).toBe(200)
    expect(login.json().roleKey).toBe('driver')
  })

  it('a branch manager CANNOT create accounts — user.manage is sysadmin/GM only', async () => {
    const mgr = await h.loginAs('manager')
    const res = await post(mgr, '/users', account({ username: 'sneaky' }))
    expect(res.statusCode).toBe(403)
  })

  it('a driver role without a branch is refused (422), never a branchless driver', async () => {
    const sa = await h.loginAs('sysadmin')
    const res = await post(sa, '/users', account({ username: 'nobranch', roleKey: 'driver', branchId: undefined }))
    expect(res.statusCode).toBe(422)
  })

  it('rejects a duplicate username rather than shadowing an account', async () => {
    const sa = await h.loginAs('sysadmin')
    await post(sa, '/users', account({ username: 'dupe', roleKey: 'accountant', branchId: undefined }))
    const res = await post(sa, '/users', account({ username: 'dupe', roleKey: 'accountant', branchId: undefined }))
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('duplicate_username')
  })

  it('lists accounts, never leaking a password hash', async () => {
    const sa = await h.loginAs('sysadmin')
    const res = await get(sa, '/users')
    expect(res.statusCode).toBe(200)
    const users = res.json().users as Array<Record<string, unknown>>
    expect(users.length).toBeGreaterThan(0)
    for (const u of users) expect(u).not.toHaveProperty('passwordHash')
  })
})
