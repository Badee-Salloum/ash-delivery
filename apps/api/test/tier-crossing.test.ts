import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import {
  BRANCH,
  DRIVER_ID,
  type Harness,
  VEHICLE_ID,
  approveFixedClose,
  makeHarness,
  sypStr,
} from './harness.ts'

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
  payload: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })

const put = async (
  token: string,
  url: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

const balance = async (code: string): Promise<bigint> =>
  await h.deps.ledger.fundBalance(BRANCH, code)

/** Run one shift of Yallago cash deliveries at 5,000 SYP each. */
async function runShift(options: {
  vehicleId: string
  shiftNo: number
  orderCount: number
  prefix: string
  float: number
  topup: number
}): Promise<{ id: string; response: LightMyRequestResponse }> {
  const driver = await h.loginAs('driver1')
  const manager = await h.loginAs('manager')
  const created = await post(driver, '/shifts', {
    driverId: DRIVER_ID,
    vehicleId: options.vehicleId,
    shiftNo: options.shiftNo,
  })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string

  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, {
    odometerKm: 1,
    batteryPercent: 90,
    floatTranches: [sypStr(options.float)],
    topupTranches: [sypStr(options.topup)],
  })
  const opened = await post(manager, `/shifts/${id}/approve-open`, {
    floatTranches: [sypStr(options.float)],
    topupTranches: [sypStr(options.topup)],
  })
  expect(opened.statusCode, opened.body).toBe(200)

  for (let index = 1; index <= options.orderCount; index++) {
    const order = await post(driver, `/shifts/${id}/orders`, {
      providerOrderNo: `${options.prefix}-${index}`,
      payMode: 'cash',
      fee: sypStr(5_000),
      zone: null,
    })
    expect(order.statusCode, order.body).toBe(201)
  }

  for (const slot of ['dashboard', 'wallet', 'odometer']) {
    await h.uploadPhoto(driver, id, 'end', slot)
  }
  const ended = await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 2,
    batteryPercent: 20,
    cashDeclared: sypStr(options.float + options.orderCount * 5_000),
    walletDeclared: sypStr(options.topup - options.orderCount * 1_000),
  })
  expect(ended.statusCode, ended.body).toBe(200)

  const review = await get(manager, `/shifts/${id}/review`)
  expect(review.json().br1.difference, review.body).toBe('0.00')
  const response = await approveFixedClose(h, manager, id, review.json().br1.ordersHash)
  return { id, response }
}

describe('crossing an old daily tier boundary', () => {
  it('settles 14 orders and the fifteenth order independently at fixed 40%', async () => {
    const first = await runShift({
      vehicleId: VEHICLE_ID,
      shiftNo: 1,
      orderCount: 14,
      prefix: 'AM',
      float: 100_000,
      topup: 50_000,
    })
    expect(first.response.statusCode, first.response.body).toBe(200)
    expect((await h.deps.settlements.findByShift(first.id))?.fixedDriverShare).toBe(2_800_000n)
    expect(await balance(fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }))).toBe(0n)
    expect(await balance('company_revenue')).toBe(-2_800_000n)
    expect(await balance('yalago_income')).toBe(-1_400_000n)

    const second = await runShift({
      vehicleId: VEHICLE_ID,
      shiftNo: 2,
      orderCount: 1,
      prefix: 'PM',
      float: 10_000,
      topup: 10_000,
    })
    expect(second.response.statusCode, second.response.body).toBe(200)
    expect((await h.deps.settlements.findByShift(second.id))?.fixedDriverShare).toBe(200_000n)
    // The second approval cannot restate the immutable first-shift snapshot.
    expect((await h.deps.settlements.findByShift(first.id))?.fixedDriverShare).toBe(2_800_000n)

    expect(await balance(fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }))).toBe(0n)
    expect(await balance('company_revenue')).toBe(-3_000_000n)
    expect(await balance('yalago_income')).toBe(-1_500_000n)
    expect(await balance('fee_earned')).toBe(0n)
    expect(await balance(fundCodeOf({ kind: 'driver_cash', driverId: DRIVER_ID }))).toBe(0n)
    expect(await balance(fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID }))).toBe(0n)

    for (const entry of h.deps.ledger.entries) {
      let debits = 0n
      let credits = 0n
      for (const line of entry.lines) {
        if (line.side === 'D') debits += line.amount
        else credits += line.amount
      }
      expect(debits, `entry ${entry.eventType}/${entry.occurrenceKey}`).toBe(credits)
    }
  })
})
