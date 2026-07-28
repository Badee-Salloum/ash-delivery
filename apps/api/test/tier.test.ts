import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * Tier admin (SRS F-3…F-6). Editing is SYSTEM ADMIN ONLY — not even the GM (س46, BR8, م-5).
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (token: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
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

describe('who may edit the tier table', () => {
  it.each([
    ['sysadmin', 201],
    ['gm', 403], // م-5: explicitly not the GM
    ['manager', 403],
    ['driver1', 403],
  ])('%s → %i', async (user, expected) => {
    const token = await h.loginAs(user)
    expect((await post(token, '/tier-rules', DEFAULT_TABLE)).statusCode, user).toBe(expected)
  })
})

describe('publishing (F-3)', () => {
  it('publishes a dated version and supersedes the incumbent', async () => {
    const admin = await h.loginAs('sysadmin')
    const first = await post(admin, '/tier-rules', DEFAULT_TABLE)
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().status).toBe('active')

    const second = await post(admin, '/tier-rules', {
      bands: [{ from: 0, to: null, driverBps: 4500 }],
      effectiveFrom: '2026-09-01',
    })
    expect(second.statusCode).toBe(201)

    const list = (await get(admin, '/tier-rules')).json().rules as Array<{ id: number; status: string }>
    // The earlier version is superseded, never deleted — a past day still resolves to it.
    const statuses = list.map((r) => r.status).sort()
    expect(statuses).toEqual(['active', 'superseded'])
  })

  it('refuses an invalid band table at publish time, not at 23:00 Saturday', async () => {
    const admin = await h.loginAs('sysadmin')
    const gapped = await post(admin, '/tier-rules', {
      bands: [
        { from: 0, to: 14, driverBps: 3500 },
        { from: 16, to: null, driverBps: 4000 }, // gap at 15
      ],
      effectiveFrom: '2026-08-01',
    })
    expect(gapped.statusCode).toBe(422)
    expect(gapped.json().error).toBe('invalid_band_table')
  })

  it('refuses a band that would eat into Yallago’s fixed 20%', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/tier-rules', {
      bands: [{ from: 0, to: null, driverBps: 8500 }], // > 80%
      effectiveFrom: '2026-08-01',
    })
    expect(res.statusCode).toBe(422)
  })

  it('refuses a non-future effective date — the past is already posted', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/tier-rules', { ...DEFAULT_TABLE, effectiveFrom: '2026-07-21' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('effective_from_must_be_future')
  })
})

describe('the what-if simulation (F-5)', () => {
  /** Approve a real shift so there is history to simulate against. */
  async function approveOneShift(): Promise<void> {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')

    const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })
    const id = created.json().id as string
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    await h.app.inject({
      method: 'PUT', url: `/shifts/${id}/start-package`, headers: { cookie: h.cookie(driver) },
      payload: { odometerKm: 1, batteryPercent: 90, floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)] },
    })
    await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)] })
    // 20 orders, all cash for simplicity of the arithmetic.
    for (let i = 1; i <= 20; i++) {
      await post(driver, `/shifts/${id}/orders`, { providerOrderNo: `S-${i}`, payMode: 'electronic', fee: sypStr(5_000), zone: null })
    }
    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
    const endCash = sypStr(100_000)
    const endWallet = sypStr(50_000 + 20 * 4_000) // topup + 20 electronic blocks
    await h.app.inject({
      method: 'PUT', url: `/shifts/${id}/end-package`, headers: { cookie: h.cookie(driver) },
      payload: { odometerKm: 2, batteryPercent: 20, cashDeclared: endCash, walletDeclared: endWallet },
    })
    const review = await get(manager, `/shifts/${id}/review`)
    await post(manager, `/shifts/${id}/approve-close`, { reviewedOrdersHash: review.json().br1.ordersHash })
  }

  it('shows the per-driver delta of a candidate table WITHOUT touching the ledger', async () => {
    await approveOneShift()
    const admin = await h.loginAs('sysadmin')

    const ledgerBefore = await h.deps.ledger.fundBalance('branch-damascus', 'company_revenue')

    // The shift was 20 orders → the default 40% band. Simulate a flat 45%.
    const res = await post(admin, '/tier-rules/simulate', {
      branchId: 'branch-damascus',
      bands: [{ from: 0, to: null, driverBps: 4500 }],
      from: '2026-07-21',
      to: '2026-07-21',
    })
    expect(res.statusCode, res.body).toBe(200)

    const drivers = res.json().drivers as Array<{ driverId: string; driverDelta: string }>
    const d = drivers.find((x) => x.driverId === DRIVER_ID)
    expect(d).toBeDefined()
    // 45% − 40% of 100,000 in fees = +5,000 to the driver.
    expect(d?.driverDelta).toBe('5000.00')
    expect(res.json().companyTotalDelta).toBe('-5000.00') // the company absorbs it (BR4)

    // The ledger did not move — that is the whole point of a simulation.
    expect(await h.deps.ledger.fundBalance('branch-damascus', 'company_revenue')).toBe(ledgerBefore)
  })

  it('only the sysadmin may simulate', async () => {
    const gm = await h.loginAs('gm')
    const res = await post(gm, '/tier-rules/simulate', {
      branchId: 'branch-damascus',
      bands: [{ from: 0, to: null, driverBps: 4500 }],
      from: '2026-07-21', to: '2026-07-21',
    })
    expect(res.statusCode).toBe(403)
  })
})
