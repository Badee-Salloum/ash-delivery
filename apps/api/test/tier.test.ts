import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DRIVER_ID,
  type Harness,
  VEHICLE_ID,
  approveFixedClose,
  makeHarness,
  sypStr,
} from './harness.ts'

/** Historical tier data is readable/simulatable; live settlement is fixed at 40%. */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (
  token: string,
  url: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })

const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

const DEFAULT_TABLE = {
  bands: [
    { from: 0, to: 14, driverBps: 3500 },
    { from: 15, to: 24, driverBps: 4000 },
    { from: 25, to: 34, driverBps: 4300 },
    { from: 35, to: null, driverBps: 4600 },
  ],
  effectiveFrom: '2026-08-01',
}

describe('fixed-share policy blocks tier mutations', () => {
  it.each([
    ['sysadmin', 409],
    ['gm', 403],
    ['manager', 403],
    ['driver1', 403],
  ])('%s receives %i when publishing', async (user, expected) => {
    const token = await h.loginAs(user)
    const response = await post(token, '/tier-rules', DEFAULT_TABLE)
    expect(response.statusCode, user).toBe(expected)
    if (user === 'sysadmin') expect(response.json().error).toBe('fixed_share_policy_active')
  })

  it('does not validate or persist a candidate because publishing itself is disabled', async () => {
    const admin = await h.loginAs('sysadmin')
    const malformed = await post(admin, '/tier-rules', {
      bands: [
        { from: 0, to: 14, driverBps: 3500 },
        { from: 16, to: null, driverBps: 8500 },
      ],
      effectiveFrom: '2026-07-21',
    })
    expect(malformed.statusCode, malformed.body).toBe(409)
    expect(malformed.json().error).toBe('fixed_share_policy_active')
    expect((await get(admin, '/tier-rules')).json().rules).toEqual([])
  })

  it('refuses withdrawal and preserves a historical repository rule', async () => {
    const stored = await h.deps.tiers.publish({
      basis: 'orders',
      mode: 'whole',
      vehicleTypeId: null,
      bands: [...DEFAULT_TABLE.bands],
      effectiveFrom: '2026-01-01',
      createdBy: 'u-sa',
    })
    const admin = await h.loginAs('sysadmin')
    const response = await post(admin, `/tier-rules/${stored.id}/withdraw`, {})
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error).toBe('fixed_share_policy_active')
    expect((await h.deps.tiers.list()).find((rule) => rule.id === stored.id)?.status).toBe('active')
  })
})

describe('historical what-if simulation remains read-only', () => {
  async function approveOneShift(): Promise<void> {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const created = await post(driver, '/shifts', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      shiftNo: 1,
    })
    const id = created.json().id as string
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/start-package`,
      headers: { cookie: h.cookie(driver) },
      payload: {
        odometerKm: 1,
        batteryPercent: 90,
        floatTranches: [sypStr(100_000)],
        topupTranches: [sypStr(50_000)],
      },
    })
    await post(manager, `/shifts/${id}/approve-open`, {
      floatTranches: [sypStr(100_000)],
      topupTranches: [sypStr(50_000)],
    })
    for (let i = 1; i <= 20; i++) {
      await post(driver, `/shifts/${id}/orders`, {
        providerOrderNo: `S-${i}`,
        payMode: 'electronic',
        fee: sypStr(5_000),
        zone: null,
      })
    }
    for (const slot of ['dashboard', 'wallet', 'odometer']) {
      await h.uploadPhoto(driver, id, 'end', slot)
    }
    await h.app.inject({
      method: 'PUT',
      url: `/shifts/${id}/end-package`,
      headers: { cookie: h.cookie(driver) },
      payload: {
        odometerKm: 2,
        batteryPercent: 20,
        cashDeclared: sypStr(100_000),
        walletDeclared: sypStr(50_000 + 20 * 4_000),
      },
    })
    const review = await get(manager, `/shifts/${id}/review`)
    const approved = await approveFixedClose(h, manager, id, review.json().br1.ordersHash)
    expect(approved.statusCode, approved.body).toBe(200)
  }

  it('shows a hypothetical delta without changing the fixed-policy ledger', async () => {
    await approveOneShift()
    const admin = await h.loginAs('sysadmin')
    const ledgerBefore = await h.deps.ledger.fundBalance('branch-damascus', 'company_revenue')
    const response = await post(admin, '/tier-rules/simulate', {
      branchId: 'branch-damascus',
      bands: [{ from: 0, to: null, driverBps: 4500 }],
      from: '2026-07-21',
      to: '2026-07-21',
    })
    expect(response.statusCode, response.body).toBe(200)
    const driver = (
      response.json().drivers as Array<{ driverId: string; driverDelta: string }>
    ).find((row) => row.driverId === DRIVER_ID)
    expect(driver?.driverDelta).toBe('5000.00')
    expect(response.json().companyTotalDelta).toBe('-5000.00')
    expect(await h.deps.ledger.fundBalance('branch-damascus', 'company_revenue')).toBe(ledgerBefore)
  })

  it('keeps simulation restricted to the system administrator', async () => {
    const gm = await h.loginAs('gm')
    const response = await post(gm, '/tier-rules/simulate', {
      branchId: 'branch-damascus',
      bands: [{ from: 0, to: null, driverBps: 4500 }],
      from: '2026-07-21',
      to: '2026-07-21',
    })
    expect(response.statusCode).toBe(403)
  })
})
