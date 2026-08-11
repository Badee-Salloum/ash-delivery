import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { type Minor, minor, splitDay } from '@ash/domain'
import { BRANCH, DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * The «تسوية شريحة اليوم» true-up must settle against what was POSTED, not against a
 * recomputation of the earlier shifts under the later shift's rule.
 *
 * `approveClose` derives its baseline as `splitDay(priorYallagoFees, rule)` where `rule` is the
 * rule resolved for THIS shift. Whenever that rule differs from the one that actually paid the
 * earlier shifts — a different vehicle type (F-4), or a table withdrawn mid-day — the delta is
 * measured from a number nobody was ever paid, and the difference lands in real cash.
 */

const CAR_TYPE = 'vtype-e-car'
const CAR_VEHICLE = 'vehicle-3'

/** The client's F-1 default (CLAUDE.md), published as the catch-all table. */
const DEFAULT_BANDS_TABLE = [
  { from: 0, to: 14, driverBps: 3500 },
  { from: 15, to: 24, driverBps: 4000 },
  { from: 25, to: 34, driverBps: 4300 },
  { from: 35, to: null, driverBps: 4600 },
] as const

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
  // Seeded LOCALLY, not in makeHarness(): adding a third vehicle to the shared harness breaks
  // fleet-config.test.ts (`/vehicles` code lists) and dashboard.test.ts (`fleet.ready` === 2).
  h.deps.directory.vehicleTypes.set(CAR_TYPE, {
    id: CAR_TYPE, code: 'e_car', nameAr: 'سيارة', nameEn: 'Electric Car',
    typeNo: 2, batterySlots: 1, active: true,
  })
  h.deps.directory.vehicles.set(CAR_VEHICLE, {
    id: CAR_VEHICLE, branchId: BRANCH, vehicleTypeId: CAR_TYPE,
    code: '1-1-2-1', machineNo: 1, plateNo: null, groundNo: null, state: 'ready', active: true,
  })
})
afterEach(async () => {
  await h.app.close()
})

const post = async (t: string, url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(t) }, payload })
const put = async (t: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(t) }, payload })
const get = async (t: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(t) } })

const bal = async (code: string): Promise<Minor> => await h.deps.ledger.fundBalance(BRANCH, code)
const driverFund = fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID })

/** Every posted entry balances (AC #5) — the defect does NOT show up here, which is the point. */
function assertLedgerBalances(): void {
  for (const entry of h.deps.ledger.entries) {
    let d = 0n
    let c = 0n
    for (const l of entry.lines) (l.side === 'D' ? (d += l.amount) : (c += l.amount))
    expect(d, `entry ${entry.eventType}/${entry.occurrenceKey}`).toBe(c)
  }
}

/** Publish the two tables of the F-4 scenario. Via the repo: the ROUTE refuses a past date. */
async function publishBikeAndCarTables(): Promise<void> {
  await h.deps.tiers.publish({
    basis: 'orders', mode: 'whole', vehicleTypeId: null,
    bands: [...DEFAULT_BANDS_TABLE], effectiveFrom: '2026-01-01', createdBy: 'u-sa',
  })
  await h.deps.tiers.publish({
    basis: 'orders', mode: 'whole', vehicleTypeId: CAR_TYPE,
    bands: [{ from: 0, to: null, driverBps: 5000 }], effectiveFrom: '2026-01-01', createdBy: 'u-sa',
  })
}

/**
 * One whole shift, opened and approved: N Yallago electronic orders of 5,000 SYP,
 * plus optional manual jobs. `walletExtra` is added to the declared wallet so BR1 is 0.00.
 */
async function runShift(opts: {
  vehicleId: string
  shiftNo: number
  orderCount: number
  prefix: string
  manual?: { fee: number; driverShare: number; companyShare: number }[]
}): Promise<void> {
  const driver = await h.loginAs('driver1')
  const manager = await h.loginAs('manager')

  const created = await post(driver, '/shifts', {
    driverId: DRIVER_ID, vehicleId: opts.vehicleId, shiftNo: opts.shiftNo,
  })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string

  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, {
    odometerKm: 1, batteryPercent: 90,
    floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)],
  })
  const opened = await post(manager, `/shifts/${id}/approve-open`, {
    floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)],
  })
  expect(opened.statusCode, opened.body).toBe(200)

  for (let i = 1; i <= opts.orderCount; i++) {
    const r = await post(driver, `/shifts/${id}/orders`, {
      providerOrderNo: `${opts.prefix}-${i}`, payMode: 'electronic', fee: sypStr(5_000), zone: null,
    })
    expect(r.statusCode, r.body).toBe(201)
  }
  let manualWallet = 0
  for (const [i, m] of (opts.manual ?? []).entries()) {
    // Manual jobs are priced by the MANAGER (E-3) and carry no Yallago cut: the full fee lands.
    const r = await post(manager, `/shifts/${id}/orders/manual`, {
      providerOrderNo: `${opts.prefix}-MAN-${i + 1}`, payMode: 'electronic', fee: sypStr(m.fee),
      zone: null, kind: 'manual',
      driverShare: sypStr(m.driverShare), companyShare: sypStr(m.companyShare),
      points: [
        { role: 'start', label: 'أ', lat: null, lng: null },
        { role: 'end', label: 'ب', lat: null, lng: null },
      ],
    })
    expect(r.statusCode, r.body).toBe(201)
    manualWallet += m.fee
  }

  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  const end = await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 2, batteryPercent: 20,
    cashDeclared: sypStr(100_000),
    // topup + 80% block per Yallago order + the full fee of every manual job.
    walletDeclared: sypStr(50_000 + opts.orderCount * 4_000 + manualWallet),
  })
  expect(end.statusCode, end.body).toBe(200)

  const review = await get(manager, `/shifts/${id}/review`)
  expect(review.json().br1.difference, review.body).toBe('0.00')
  const closed = await post(manager, `/shifts/${id}/approve-close`, {
    reviewedOrdersHash: review.json().br1.ordersHash,
  })
  expect(closed.statusCode, closed.body).toBe(200)
}

describe('the day true-up settles against what was POSTED', () => {
  it('1 — bike then car: the driver is UNDER-paid 9,000 SYP', async () => {
    await publishBikeAndCarTables()

    await runShift({ vehicleId: VEHICLE_ID, shiftNo: 1, orderCount: 12, prefix: 'B' })
    // 12 orders on the bike → the catch-all table's 0–14 band, 35% of 60,000 SYP.
    expect(await bal(driverFund)).toBe(-2_100_000n)
    expect(await bal('company_revenue')).toBe(-2_700_000n)

    await runShift({ vehicleId: CAR_VEHICLE, shiftNo: 2, orderCount: 10, prefix: 'C' })
    // The day is 22 orders / 110,000 SYP under the car table's flat 50%.
    expect(await bal(driverFund)).toBe(-5_500_000n)
    expect(await bal('company_revenue')).toBe(-3_300_000n)
    expect(await bal('yalago_income')).toBe(-2_200_000n)
    expect(await bal('fee_earned')).toBe(0n)
    assertLedgerBalances()
  })

  it('2 — car then bike: the same driver is OVER-paid 9,000 SYP', async () => {
    await publishBikeAndCarTables()

    await runShift({ vehicleId: CAR_VEHICLE, shiftNo: 1, orderCount: 12, prefix: 'C' })
    expect(await bal(driverFund)).toBe(-3_000_000n)

    await runShift({ vehicleId: VEHICLE_ID, shiftNo: 2, orderCount: 10, prefix: 'B' })
    // 22 orders → the catch-all 15–24 band, 40% of 110,000 SYP.
    expect(await bal(driverFund)).toBe(-4_400_000n)
    expect(await bal('company_revenue')).toBe(-4_400_000n)
    expect(await bal('fee_earned')).toBe(0n)
    assertLedgerBalances()
  })

  it('3 — a rule withdrawn mid-day does not restate what was already paid', async () => {
    // ONE catch-all table, both shifts on the SAME vehicle type: no F-4 anywhere in this case.
    const published = await h.deps.tiers.publish({
      basis: 'orders', mode: 'whole', vehicleTypeId: null,
      bands: [{ from: 0, to: null, driverBps: 5000 }],
      effectiveFrom: '2026-01-01', createdBy: 'u-sa',
    })

    await runShift({ vehicleId: VEHICLE_ID, shiftNo: 1, orderCount: 12, prefix: 'W' })
    expect(await bal(driverFund)).toBe(-3_000_000n)

    const admin = await h.loginAs('sysadmin')
    const w = await post(admin, `/tier-rules/${published.id}/withdraw`, {})
    expect(w.statusCode, w.body).toBe(200)

    await runShift({ vehicleId: 'vehicle-2', shiftNo: 2, orderCount: 10, prefix: 'V' })
    // The day now resolves to the F-1 fallback, 22 orders → 40% of 110,000 = 44,000 SYP.
    expect(await bal(driverFund)).toBe(-4_400_000n)
    assertLedgerBalances()
  })

  it('6 — a manual job on the earlier shift is not folded into the day tier basis', async () => {
    await publishBikeAndCarTables()

    await runShift({
      vehicleId: VEHICLE_ID, shiftNo: 1, orderCount: 12, prefix: 'B',
      manual: [{ fee: 5_000, driverShare: 3_000, companyShare: 2_000 }],
    })
    // 12 YALLAGO orders → 35% of 60,000 = 21,000, plus the typed 3,000 of the manual job.
    expect(await bal(driverFund)).toBe(-2_400_000n)

    await runShift({ vehicleId: CAR_VEHICLE, shiftNo: 2, orderCount: 10, prefix: 'C' })
    // The day's 22 Yallago orders settle to 55,000; the manual 3,000 is never restated.
    expect(await bal(driverFund)).toBe(-5_800_000n)
    assertLedgerBalances()
  })
})

describe('fix-neutral: the day was paid at a rate that exists in no table', () => {
  it('the posted day share equals a whole-day split under ONE of the published tables', async () => {
    await publishBikeAndCarTables()
    await runShift({ vehicleId: VEHICLE_ID, shiftNo: 1, orderCount: 12, prefix: 'B' })
    await runShift({ vehicleId: CAR_VEHICLE, shiftNo: 2, orderCount: 10, prefix: 'C' })

    const dayFees = Array.from({ length: 22 }, () => minor(500_000n))
    const underCatchAll = splitDay(dayFees, {
      basis: 'orders', mode: 'whole', vehicleTypeId: null,
      bands: [...DEFAULT_BANDS_TABLE], effectiveFrom: '2026-01-01',
    }).driverShare
    const underCar = splitDay(dayFees, {
      basis: 'orders', mode: 'whole', vehicleTypeId: CAR_TYPE,
      bands: [{ from: 0, to: null, driverBps: 5000 }], effectiveFrom: '2026-01-01',
    }).driverShare

    const paid = minor(-(await bal(driverFund)))
    // Whichever table the product owner rules governs a mixed-vehicle day, the answer must be one
    // of these two. Today it is 4,600,000 — 4,181 bps, a rate no published band contains.
    expect([underCatchAll, underCar]).toContain(paid)
  })
})
