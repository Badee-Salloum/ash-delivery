import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Harness, makeHarness } from './harness.ts'

/**
 * The §3 permission matrix as editable data (SRS A-2). The point of storing grants in a table is
 * that authorisation changes without a deploy — so the load-bearing test is that a grant takes
 * effect on the very next request.
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
const put = async (token: string, url: string, payload: Payload): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

describe('the permission matrix as data (SRS A-2)', () => {
  it('returns the roles, the permissions and the current grants', async () => {
    const sa = await h.loginAs('sysadmin')
    const res = await get(sa, '/permissions')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().roles).toContain('branch_manager')
    expect(res.json().permissions).toContain('user.manage')
  })

  it('granting a permission takes effect on the very next request', async () => {
    const sa = await h.loginAs('sysadmin')
    const mgr = await h.loginAs('manager')
    // A branch manager cannot list accounts today…
    expect((await get(mgr, '/users')).statusCode).toBe(403)
    // …grant it…
    const res = await put(sa, '/role-permissions', {
      roleKey: 'branch_manager',
      permissionKey: 'user.manage',
      scope: 'all',
    })
    expect(res.statusCode, res.body).toBe(200)
    // …and now he can, with no redeploy.
    expect((await get(mgr, '/users')).statusCode).toBe(200)
  })

  it('materialising the defaults on the first write does not strip other permissions', async () => {
    const sa = await h.loginAs('sysadmin')
    // The very first write turns the implicit default table into rows. Everything else must survive.
    await put(sa, '/role-permissions', { roleKey: 'accountant', permissionKey: 'audit.view', scope: 'all' })
    const mgr = await h.loginAs('manager')
    // The branch manager's own long-standing grant still works.
    expect((await get(mgr, '/cash-counts/sheet')).statusCode).toBe(200)
  })

  it('revoking a grant takes effect too', async () => {
    const sa = await h.loginAs('sysadmin')
    await put(sa, '/role-permissions', { roleKey: 'branch_manager', permissionKey: 'user.manage', scope: 'all' })
    const mgr = await h.loginAs('manager')
    expect((await get(mgr, '/users')).statusCode).toBe(200)
    await put(sa, '/role-permissions', { roleKey: 'branch_manager', permissionKey: 'user.manage', scope: null })
    expect((await get(mgr, '/users')).statusCode).toBe(403)
  })

  it('refuses to remove the LAST user.manage grant — that would lock everyone out for good', async () => {
    const sa = await h.loginAs('sysadmin')
    await put(sa, '/role-permissions', { roleKey: 'general_manager', permissionKey: 'user.manage', scope: null })
    const res = await put(sa, '/role-permissions', {
      roleKey: 'system_admin',
      permissionKey: 'user.manage',
      scope: null,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('would_lock_out_admins')
  })

  it('refuses an unknown role or permission rather than writing junk', async () => {
    const sa = await h.loginAs('sysadmin')
    expect(
      (await put(sa, '/role-permissions', { roleKey: 'wizard', permissionKey: 'user.manage', scope: 'all' })).statusCode,
    ).toBe(422)
    expect(
      (await put(sa, '/role-permissions', { roleKey: 'driver', permissionKey: 'fly.helicopter', scope: 'all' }))
        .statusCode,
    ).toBe(422)
  })

  it('a branch manager cannot read or edit the matrix', async () => {
    const mgr = await h.loginAs('manager')
    expect((await get(mgr, '/permissions')).statusCode).toBe(403)
  })
})


/**
 * Found in production while probing the new routes: `GET /nonsense-route` answered
 * `500 route_misconfigured`.
 *
 * `authorize` is a GLOBAL preHandler, and Fastify runs preHandler hooks on its not-found route too
 * — which declares no permission, because nobody wrote it. So every typo, every stale client URL
 * and every scanner probe was the server reporting its own fault for a thing that does not exist.
 * Real 500s are how breakage gets found; burying them under 404s costs exactly that.
 */
describe('a route that does not exist', () => {
  it('is 404, not the server confessing to a misconfiguration', async () => {
    const h = await makeHarness()
    try {
      const anonymous = await h.app.inject({ method: 'GET', url: '/no-such-route' })
      expect(anonymous.statusCode).toBe(404)
      expect(anonymous.json().error).toBe('not_found')

      // Also for a signed-in caller: the old behaviour hit both, since the hook never got as far
      // as looking at who was asking.
      const admin = await h.loginAs('sysadmin')
      const authenticated = await h.app.inject({
        method: 'GET',
        url: '/treasury/restoration',
        headers: { cookie: h.cookie(admin) },
      })
      // `/treasury/restoration` exists as a POST only, so a GET matches no route.
      expect(authenticated.statusCode).toBe(404)

      // The other branch — a REGISTERED route declaring no permission — still fails closed with
      // 500, and is not exercised here because it cannot be reached: `assertEveryRouteDeclaresPermission`
      // refuses to boot in that state, and Fastify will not accept a new route afterwards.
    } finally {
      await h.app.close()
    }
  })

})
