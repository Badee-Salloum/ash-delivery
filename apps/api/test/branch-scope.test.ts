import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, type Harness, OTHER_BRANCH, VEHICLE_TYPE, makeHarness } from './harness.ts'

/**
 * Organisation-wide roles and the branch they are looking at.
 *
 * The general manager and the system admin have `branchId === null` by design — the §3 matrix
 * grants them `branch_data.view` at scope **'all'**, so the session deliberately cannot pick a
 * branch for them.
 *
 * Every branch-scoped route used to read that branch from the request **body** only. A GET has no
 * body. So scope 'all' was a permission nobody could exercise: the dashboard, the treasury, the
 * fleet and the expense reads all answered 422 `branch_required` to the two roles that own the
 * business — which, on a fresh production install, are the ONLY two accounts that exist. The admin
 * console showed an eternal spinner and the real cause never surfaced.
 *
 * These tests pin the fix: a read may name its branch with `?branchId=`, and the RBAC scope still
 * decides who may name which.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

/** Every branch-scoped read the admin console makes on load. */
const BRANCH_SCOPED_READS = [
  '/dashboard',
  '/drivers',
  '/vehicles',
  '/assignments',
  '/shifts',
  '/treasury/balances',
  '/documents/expiring',
  '/expenses',
]

describe('an organisation-wide role names the branch it is reading', () => {
  it('422s with a hint when the GM names no branch', async () => {
    const gm = await h.loginAs('gm')
    for (const path of BRANCH_SCOPED_READS) {
      const res = await get(gm, path)
      expect(res.statusCode, `${path} -> ${res.body}`).toBe(422)
      expect(res.json().error).toBe('branch_required')
    }
  })

  it('succeeds for the GM once he names one — the whole point of scope "all"', async () => {
    const gm = await h.loginAs('gm')
    for (const path of BRANCH_SCOPED_READS) {
      const res = await get(gm, `${path}?branchId=${BRANCH}`)
      expect(res.statusCode, `${path} -> ${res.body}`).toBe(200)
    }
  })

  it('succeeds for the system admin on the reads his matrix allows', async () => {
    const sa = await h.loginAs('sysadmin')
    // `branch_data.view` is sysadmin 'all'; `cash_count.perform` is NOT his, by design (decision 5).
    for (const path of ['/dashboard', '/drivers', '/vehicles', '/assignments', '/shifts', '/treasury/balances']) {
      const res = await get(sa, `${path}?branchId=${BRANCH}`)
      expect(res.statusCode, `${path} -> ${res.body}`).toBe(200)
    }
  })

  it('the system admin is still refused the cash count — a scope fix is not a permission grant', async () => {
    const sa = await h.loginAs('sysadmin')
    const res = await get(sa, `/cash-counts/sheet?branchId=${BRANCH}`)
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('forbidden')
  })
})

describe('a branch-scoped role cannot read across the fence', () => {
  it('the branch manager needs to name nothing — his session decides', async () => {
    const manager = await h.loginAs('manager')
    for (const path of BRANCH_SCOPED_READS) {
      const res = await get(manager, path)
      expect([200, 403], `${path} -> ${res.body}`).toContain(res.statusCode)
    }
    expect((await get(manager, '/drivers')).statusCode).toBe(200)
  })

  it('naming his OWN branch is the same as naming none', async () => {
    const manager = await h.loginAs('manager')
    expect((await get(manager, `/drivers?branchId=${BRANCH}`)).statusCode).toBe(200)
  })

  it("naming ANOTHER branch is refused, not quietly served his own", async () => {
    const manager = await h.loginAs('manager')
    const res = await get(manager, `/drivers?branchId=${OTHER_BRANCH}`)
    // The subject is what the caller ASKED for, so authorization judges the real target. Serving
    // his own branch instead would be a silent substitution — and a manager reading numbers he
    // believes are Aleppo's is worse than an error.
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('forbidden')
  })

  it('a driver cannot read branch data by naming a branch', async () => {
    const driver = await h.loginAs('driver1')
    expect((await get(driver, `/dashboard?branchId=${BRANCH}`)).statusCode).toBe(403)
  })
})

describe('the GM can fund a branch he names', () => {
  it('deposits into the branch cash box and sees the balance rise', async () => {
    const gm = await h.loginAs('gm')

    const before = await get(gm, `/treasury/balances?branchId=${BRANCH}`)
    expect(before.statusCode, before.body).toBe(200)
    expect(before.json().cash).toBe('0.00')

    const res = await h.app.inject({
      method: 'POST',
      url: '/treasury/deposit',
      headers: { cookie: h.cookie(gm) },
      payload: { target: 'cash', amount: '500000.00', branchId: BRANCH },
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().balance).toBe('500000.00')

    const after = await get(gm, `/treasury/balances?branchId=${BRANCH}`)
    expect(after.json().cash).toBe('500000.00')
  })

  it('without a branch the deposit is refused rather than landing nowhere', async () => {
    const gm = await h.loginAs('gm')
    const res = await h.app.inject({
      method: 'POST',
      url: '/treasury/deposit',
      headers: { cookie: h.cookie(gm) },
      payload: { target: 'cash', amount: '500000.00' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('branch_required')
  })

  it('the system admin still may not deposit — §3 matrix, decision 5', async () => {
    const sa = await h.loginAs('sysadmin')
    const res = await h.app.inject({
      method: 'POST',
      url: '/treasury/deposit',
      headers: { cookie: h.cookie(sa) },
      payload: { target: 'cash', amount: '1.00', branchId: BRANCH },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('organisation-wide writes name their branch too', () => {
  it('the GM onboards a driver into the branch he names', async () => {
    const gm = await h.loginAs('gm')
    const res = await h.app.inject({
      method: 'POST',
      url: '/drivers',
      headers: { cookie: h.cookie(gm) },
      payload: { code: 'DRV-GM', fullNameAr: 'سائق', branchId: OTHER_BRANCH },
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().branchId).toBe(OTHER_BRANCH)
  })

  it('a query param works for a write as well, so one client rule covers both', async () => {
    const gm = await h.loginAs('gm')
    const res = await h.app.inject({
      method: 'POST',
      url: `/vehicles?branchId=${BRANCH}`,
      headers: { cookie: h.cookie(gm) },
      payload: { vehicleTypeId: VEHICLE_TYPE },
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().branchId).toBe(BRANCH)
  })
})
