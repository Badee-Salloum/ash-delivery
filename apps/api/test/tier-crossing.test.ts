import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { BRANCH, DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
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

const bal = async (code: string): Promise<bigint> => await h.deps.ledger.fundBalance(BRANCH, code)

/** One shift of `orderCount` Yallago CASH deliveries at 5,000 SYP. Returns approve-close's response. */
async function runShift(opts: {
  vehicleId: string
  shiftNo: number
  orderCount: number
  prefix: string
  float: number
  topup: number
}): Promise<LightMyRequestResponse> {
  const driver = await h.loginAs('driver1')
  const manager = await h.loginAs('manager')

  const created = await post(driver, '/shifts', {
    driverId: DRIVER_ID,
    vehicleId: opts.vehicleId,
    shiftNo: opts.shiftNo,
  })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string

  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, {
    odometerKm: 1,
    batteryPercent: 90,
    floatTranches: [sypStr(opts.float)],
    topupTranches: [sypStr(opts.topup)],
  })
  const opened = await post(manager, `/shifts/${id}/approve-open`, {
    floatTranches: [sypStr(opts.float)],
    topupTranches: [sypStr(opts.topup)],
  })
  expect(opened.statusCode, opened.body).toBe(200)

  for (let i = 1; i <= opts.orderCount; i++) {
    const r = await post(driver, `/shifts/${id}/orders`, {
      providerOrderNo: `${opts.prefix}-${i}`,
      payMode: 'cash',
      fee: sypStr(5_000),
      zone: null,
    })
    expect(r.statusCode, r.body).toBe(201)
  }

  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  // cash: float + full fee of every cash order. wallet: topup − Yallago's 20% of each.
  const end = await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 2,
    batteryPercent: 20,
    cashDeclared: sypStr(opts.float + opts.orderCount * 5_000),
    walletDeclared: sypStr(opts.topup - opts.orderCount * 1_000),
  })
  expect(end.statusCode, end.body).toBe(200)

  const review = await get(manager, `/shifts/${id}/review`)
  expect(review.json().br1.difference, review.body).toBe('0.00')

  return await post(manager, `/shifts/${id}/approve-close`, {
    reviewedOrdersHash: review.json().br1.ordersHash,
  })
}

describe('a split day whose SECOND, SMALL shift crosses the 14→15 band', () => {
  it('the evening shift can be approved, and the day settles at 40%', async () => {
    // Morning: 14 orders → the 0–14 band, 35%.
    const first = await runShift({
      vehicleId: VEHICLE_ID, shiftNo: 1, orderCount: 14, prefix: 'AM', float: 100_000, topup: 50_000,
    })
    expect(first.statusCode, first.body).toBe(200)
    expect(await bal(fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }))).toBe(-2_450_000n)
    expect(await bal('company_revenue')).toBe(-3_150_000n)
    expect(await bal('yalago_income')).toBe(-1_400_000n)

    // Evening: ONE more order. The day is now 15 → 40% on ALL of it, so the company must GIVE BACK
    // 1,500 SYP. That restatement is a negative company delta on a 5,000 SYP shift.
    const second = await runShift({
      vehicleId: VEHICLE_ID, shiftNo: 2, orderCount: 1, prefix: 'PM', float: 10_000, topup: 10_000,
    })
    expect(second.statusCode, second.body).toBe(200)

    // The whole 75,000 SYP day at 40%.
    expect(await bal(fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }))).toBe(-3_000_000n)
    expect(await bal('company_revenue')).toBe(-3_000_000n)
    expect(await bal('yalago_income')).toBe(-1_500_000n)
    expect(await bal('fee_earned')).toBe(0n)
    // Nothing of the company's money is left recorded in the driver's pocket.
    expect(await bal(fundCodeOf({ kind: 'driver_cash', driverId: DRIVER_ID }))).toBe(0n)
    expect(await bal(fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID }))).toBe(0n)

    for (const entry of h.deps.ledger.entries) {
      let d = 0n
      let c = 0n
      for (const l of entry.lines) (l.side === 'D' ? (d += l.amount) : (c += l.amount))
      expect(d, `entry ${entry.eventType}/${entry.occurrenceKey}`).toBe(c)
    }
  })
})
