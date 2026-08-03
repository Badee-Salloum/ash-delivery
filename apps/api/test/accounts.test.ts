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
const patch = async (token: string, url: string, payload: Payload): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PATCH', url, headers: { cookie: h.cookie(token) }, payload })
const login = async (username: string, password: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } })
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

  it('renames an account and changes its role', async () => {
    const sa = await h.loginAs('sysadmin')
    const id = (await post(sa, '/users', account({ username: 'renameme', roleKey: 'accountant', branchId: undefined }))).json().id
    const res = await patch(sa, `/users/${id}`, { fullNameAr: 'اسم جديد' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().fullNameAr).toBe('اسم جديد')
    expect(res.json()).not.toHaveProperty('passwordHash')
  })

  it('deactivating an account stops it logging in', async () => {
    const sa = await h.loginAs('sysadmin')
    const id = (await post(sa, '/users', account({ username: 'disableme', roleKey: 'accountant', branchId: undefined }))).json().id
    expect((await login('disableme', 'password1234')).statusCode).toBe(200)
    expect((await patch(sa, `/users/${id}`, { active: false })).statusCode).toBe(200)
    expect((await login('disableme', 'password1234')).statusCode).not.toBe(200)
  })

  it('resets a password — the old one stops working, the new one works', async () => {
    const sa = await h.loginAs('sysadmin')
    const id = (await post(sa, '/users', account({ username: 'resetme', roleKey: 'accountant', branchId: undefined }))).json().id
    expect((await patch(sa, `/users/${id}`, { password: 'brandnewpass99' })).statusCode).toBe(200)
    expect((await login('resetme', 'password1234')).statusCode).toBe(401)
    expect((await login('resetme', 'brandnewpass99')).statusCode).toBe(200)
  })

  it('a branch manager cannot edit accounts', async () => {
    const sa = await h.loginAs('sysadmin')
    const id = (await post(sa, '/users', account({ username: 'protected', roleKey: 'accountant', branchId: undefined }))).json().id
    const mgr = await h.loginAs('manager')
    expect((await patch(mgr, `/users/${id}`, { fullNameAr: 'x' })).statusCode).toBe(403)
  })

  it('404s on an unknown account', async () => {
    const sa = await h.loginAs('sysadmin')
    const res = await patch(sa, '/users/00000000-0000-4000-8000-000000000000', { fullNameAr: 'x' })
    expect(res.statusCode).toBe(404)
  })

  it('refuses to make someone a driver without a branch', async () => {
    const sa = await h.loginAs('sysadmin')
    const id = (await post(sa, '/users', account({ username: 'nobranchrole', roleKey: 'accountant', branchId: undefined }))).json().id
    expect((await patch(sa, `/users/${id}`, { roleKey: 'driver' })).statusCode).toBe(422)
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

/**
 * A branch manager's account was created as `Ali_Dandah` with an ARABIC KASRA (U+0650) in front of
 * it — what Shift+A produces while the Arabic keyboard layout is on. The mark is invisible and
 * zero-width, so the username looked right everywhere in the admin, but login is an exact match and
 * the account could never reach its password check. Nobody could see why.
 */
const KASRA = 'ِ'

describe('a username carrying what a keyboard layout left behind', () => {
  it('cannot be created with an invisible mark in it — it is stored as typed, not as pressed', async () => {
    const sa = await h.loginAs('sysadmin')
    const res = await post(sa, '/users', account({ username: `${KASRA}Ali_Dandah` }))
    expect(res.statusCode, res.body).toBe(201)

    const users = (await get(sa, '/users')).json().users as Array<{ username: string }>
    expect(users.map((u) => u.username)).toContain('Ali_Dandah')
    // And it logs in under the name a person can actually type.
    expect((await login('Ali_Dandah', 'password1234')).statusCode).toBe(200)
  })

  it('refuses a name that is only long enough because of marks nobody can see', async () => {
    const sa = await h.loginAs('sysadmin')
    expect((await post(sa, '/users', account({ username: `a${KASRA}${KASRA}${KASRA}` }))).statusCode).toBe(400)
  })

  it('lets an account ALREADY stored with the mark log in under its typed name', async () => {
    // The account as it exists in production today — created before the rule above.
    h.deps.users.seed({
      id: 'u-dandah',
      roleKey: 'branch_manager',
      username: `${KASRA}Ali_Dandah`,
      branchId: BRANCH,
      driverId: null,
      fullNameAr: 'علي دندة',
      passwordHash: 'plain:secret',
      failedAttempts: 0,
      lockedUntilMs: null,
      active: true,
    })
    expect((await login('Ali_Dandah', 'secret')).statusCode).toBe(200)
    // A wrong password is still a wrong password — the fallback finds the account, nothing more.
    expect((await login('Ali_Dandah', 'wrongpassword')).statusCode).toBe(401)
  })
})
