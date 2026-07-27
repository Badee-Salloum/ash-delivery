import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * The minimal ops dashboard (SRS I-1). Total profit is GM-only (BR8), which is why it is a
 * separate endpoint behind a separate permission rather than a hidden field.
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

/** Run the canonical §2.3 shift to completion so the tiles have real numbers. */
async function runCanonicalShift(): Promise<void> {
  const driver = await h.loginAs('driver1')
  const manager = await h.loginAs('manager')

  const created = await h.app.inject({
    method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
    payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
  })
  const id = created.json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await h.app.inject({
    method: 'PUT', url: `/shifts/${id}/start-package`, headers: { cookie: h.cookie(driver) },
    payload: { odometerKm: 1, batteryPercent: 95 },
  })
  await h.app.inject({
    method: 'POST', url: `/shifts/${id}/approve-open`, headers: { cookie: h.cookie(manager) },
    payload: { floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)] },
  })

  let n = 0
  const add = async (mode: string, count: number) => {
    for (let i = 0; i < count; i++) {
      n += 1
      await h.app.inject({
        method: 'POST', url: `/shifts/${id}/orders`, headers: { cookie: h.cookie(driver) },
        payload: { providerOrderNo: `D-${n}`, payMode: mode, fee: sypStr(5_000), zone: 'المزة' },
      })
    }
  }
  await add('cash', 12)
  await add('electronic', 6)
  await add('free', 2)

  for (const slot of ['dashboard', 'wallet', 'odometer', 'wallet_zeroed']) await h.uploadPhoto(driver, id, 'end', slot)
  await h.app.inject({
    method: 'PUT', url: `/shifts/${id}/end-package`, headers: { cookie: h.cookie(driver) },
    payload: { odometerKm: 92, batteryPercent: 22, cashDeclared: sypStr(160_000), walletDeclared: sypStr(70_000) },
  })
  const review = await get(manager, `/shifts/${id}/review`)
  await h.app.inject({
    method: 'POST', url: `/shifts/${id}/approve-close`, headers: { cookie: h.cookie(manager) },
    payload: { reviewedOrdersHash: review.json().br1.ordersHash },
  })
}

describe('the operational dashboard', () => {
  it('reports today’s revenue, orders and fleet after a completed shift', async () => {
    await runCanonicalShift()
    const manager = await h.loginAs('manager')

    const res = await get(manager, '/dashboard')
    expect(res.statusCode, res.body).toBe(200)

    // 20 orders × 5,000 = 100,000 SYP in fees.
    expect(res.json().revenue.feesSyp).toBe('100000.00')
    expect(res.json().orders.total).toBe(20)
    // Enriched with the driver's name/code so the UI shows a driver, not his UUID.
    const perDriver = res.json().orders.perDriver as Array<Record<string, unknown>>
    expect(perDriver.find((d) => d.driverId === DRIVER_ID)).toMatchObject({
      driverId: DRIVER_ID,
      name: 'سائق ١',
      code: 'DRV-1',
      orders: 20,
      feesSyp: '100000.00',
    })

    // The company's accrued share this week: 40% of 100,000 = 40,000.
    expect(res.json().companyShareSinceSunday).toBe('40000.00')

    // Two vehicles seeded, both ready.
    expect(res.json().fleet.ready).toBe(2)
    expect(res.json().completeness.openShifts).toBe(0)
  })

  it('shows a USD equivalent from the day’s rate (AC #6, the display half)', async () => {
    const admin = await h.loginAs('sysadmin')
    await h.app.inject({
      method: 'PUT', url: '/fx', headers: { cookie: h.cookie(admin) },
      payload: { businessDate: '2026-07-21', sypMinorPerUsd: 13000 },
    })
    await runCanonicalShift()

    const manager = await h.loginAs('manager')
    const res = await get(manager, '/dashboard')
    // 100,000 SYP / 130 ≈ 769.23 USD.
    expect(res.json().revenue.feesUsd).toBe('769.23')
    expect(res.json().revenue.fxProvisional).toBe(false)
  })

  it('counts what still needs a human when a shift is mid-flight', async () => {
    const driver = await h.loginAs('driver1')
    const created = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    await h.uploadPhoto(driver, created.json().id, 'start', 'odometer')
    await h.app.inject({
      method: 'PUT', url: `/shifts/${created.json().id}/start-package`, headers: { cookie: h.cookie(driver) },
      payload: { odometerKm: 1, batteryPercent: 90 },
    })

    const manager = await h.loginAs('manager')
    const res = await get(manager, '/dashboard')
    expect(res.json().completeness.openShifts).toBe(1)
    expect(res.json().completeness.awaitingApproval).toBe(1)
  })
})

describe('total profit is General-Manager-only (BR8, AC #12)', () => {
  it('the GM sees it; the branch manager does not', async () => {
    await runCanonicalShift()

    const gm = await h.loginAs('gm')
    // The GM is org-wide; the seeded GM has no branch, so the endpoint needs one. Give the GM a
    // branch for this assertion to prove the FIGURE, not the fan-out (single branch today).
    h.deps.users.seed({
      id: 'u-gm', branchId: 'branch-damascus', roleKey: 'general_manager', username: 'gm',
      fullNameAr: 'gm', passwordHash: 'plain:secret', driverId: null,
      failedAttempts: 0, lockedUntilMs: null, active: true,
    })
    const scopedGm = await h.loginAs('gm')

    const res = await get(scopedGm, '/dashboard/profit')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().companyShareSyp).toBe('40000.00')
    expect(res.json().driverShareSyp).toBe('40000.00')
    expect(res.json().yalagoShareSyp).toBe('20000.00')
    void gm

    // The branch manager is refused outright.
    const manager = await h.loginAs('manager')
    expect((await get(manager, '/dashboard/profit')).statusCode).toBe(403)
    // ...but still sees the operational dashboard.
    expect((await get(manager, '/dashboard')).statusCode).toBe(200)
  })

  it('a driver sees neither', async () => {
    const driver = await h.loginAs('driver1')
    expect((await get(driver, '/dashboard')).statusCode).toBe(403)
    expect((await get(driver, '/dashboard/profit')).statusCode).toBe(403)
  })
})
