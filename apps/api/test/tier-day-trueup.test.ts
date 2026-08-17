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
  today,
} from './harness.ts'

/**
 * The fixed policy is per shift. Historical daily/vehicle tier rows may still exist for audit, but
 * neither another shift nor a differently configured vehicle can restate an approved 40% share.
 */

const CAR_TYPE = 'vtype-e-car'
const CAR_VEHICLE = 'vehicle-3'

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
  h.deps.directory.vehicleTypes.set(CAR_TYPE, {
    id: CAR_TYPE,
    code: 'e_car',
    nameAr: 'سيارة',
    nameEn: 'Electric Car',
    typeNo: 2,
    batterySlots: 1,
    active: true,
  })
  h.deps.directory.vehicles.set(CAR_VEHICLE, {
    id: CAR_VEHICLE,
    branchId: BRANCH,
    vehicleTypeId: CAR_TYPE,
    code: '1-1-2-1',
    machineNo: 1,
    plateNo: null,
    groundNo: null,
    state: 'ready',
    active: true,
  })
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
  url.endsWith('/end-package')
    ? await h.submitEndPackage(token, url.split('/')[2]!, payload)
    : await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

const balance = async (code: string): Promise<bigint> =>
  await h.deps.ledger.fundBalance(BRANCH, code)

async function seedHistoricalVehicleRules(): Promise<void> {
  await h.deps.tiers.publish({
    basis: 'orders',
    mode: 'whole',
    vehicleTypeId: null,
    bands: [
      { from: 0, to: 14, driverBps: 3500 },
      { from: 15, to: null, driverBps: 4600 },
    ],
    effectiveFrom: '2026-01-01',
    createdBy: 'u-sa',
  })
  await h.deps.tiers.publish({
    basis: 'orders',
    mode: 'whole',
    vehicleTypeId: CAR_TYPE,
    bands: [{ from: 0, to: null, driverBps: 5000 }],
    effectiveFrom: '2026-01-01',
    createdBy: 'u-sa',
  })
}

async function runShift(options: {
  vehicleId: string
  shiftNo: number
  orderCount: number
  prefix: string
  manual?: Array<{ fee: number; driverShare: number; companyShare: number }>
}): Promise<string> {
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
    floatTranches: [sypStr(100_000)],
    topupTranches: [sypStr(50_000)],
  })
  const opened = await post(manager, `/shifts/${id}/approve-open`, {
    floatTranches: [sypStr(100_000)],
    topupTranches: [sypStr(50_000)],
  })
  expect(opened.statusCode, opened.body).toBe(200)

  h.stageCloseDraftFinancialFixture(id, {
    managerToken: manager,
    orders: Array.from({ length: options.orderCount }, (_, offset) => ({
      clientKey: `tier-day-${options.prefix}-${offset + 1}`,
      providerOrderNo: `${options.prefix}-${offset + 1}`,
      payMode: 'electronic' as const,
      fee: sypStr(5_000),
      occurredDate: today,
      occurredMinute: '08:00',
    })),
  })

  let manualWallet = 0
  for (const [index, manual] of (options.manual ?? []).entries()) {
    const order = await post(manager, `/shifts/${id}/orders/manual`, {
      providerOrderNo: `${options.prefix}-MAN-${index + 1}`,
      payMode: 'electronic',
      fee: sypStr(manual.fee),
      zone: null,
      kind: 'manual',
      driverShare: sypStr(manual.driverShare),
      companyShare: sypStr(manual.companyShare),
      points: [
        { role: 'start', label: 'أ', lat: null, lng: null },
        { role: 'end', label: 'ب', lat: null, lng: null },
      ],
    })
    expect(order.statusCode, order.body).toBe(201)
    manualWallet += manual.fee
  }

  for (const slot of ['dashboard', 'wallet', 'odometer']) {
    await h.uploadPhoto(driver, id, 'end', slot)
  }
  const ended = await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 2,
    batteryPercent: 20,
    cashDeclared: sypStr(100_000),
    walletDeclared: sypStr(50_000 + options.orderCount * 4_000 + manualWallet),
  })
  expect(ended.statusCode, ended.body).toBe(200)
  const review = await get(manager, `/shifts/${id}/review`)
  expect(review.json().br1.difference, review.body).toBe('0.00')
  const approved = await approveFixedClose(h, manager, id, review.json().br1.ordersHash)
  expect(approved.statusCode, approved.body).toBe(200)
  return id
}

function expectBalancedLedger(): void {
  for (const entry of h.deps.ledger.entries) {
    let debits = 0n
    let credits = 0n
    for (const line of entry.lines) {
      if (line.side === 'D') debits += line.amount
      else credits += line.amount
    }
    expect(debits, `entry ${entry.eventType}/${entry.occurrenceKey}`).toBe(credits)
  }
}

describe('historical tier rows cannot restate fixed-policy approvals', () => {
  it('ignores both a 35/46% daily table and a 50% vehicle table', async () => {
    await seedHistoricalVehicleRules()

    const bike = await runShift({
      vehicleId: VEHICLE_ID,
      shiftNo: 1,
      orderCount: 12,
      prefix: 'BIKE',
    })
    const bikeSnapshot = await h.deps.settlements.findByShift(bike)
    expect(bikeSnapshot?.deliveryFeeTotal).toBe(6_000_000n)
    expect(bikeSnapshot?.fixedDriverShare).toBe(2_400_000n)

    const car = await runShift({
      vehicleId: CAR_VEHICLE,
      shiftNo: 2,
      orderCount: 10,
      prefix: 'CAR',
    })
    expect((await h.deps.settlements.findByShift(car))?.fixedDriverShare).toBe(2_000_000n)
    expect((await h.deps.settlements.findByShift(bike))?.fixedDriverShare).toBe(2_400_000n)

    expect(await balance('company_revenue')).toBe(-4_400_000n)
    expect(await balance('yalago_income')).toBe(-2_200_000n)
    expect(await balance(fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }))).toBe(0n)
    expect(await balance(fundCodeOf({ kind: 'driver_cash', driverId: DRIVER_ID }))).toBe(0n)
    expect(await balance(fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID }))).toBe(0n)
    expectBalancedLedger()
  })

  it('adds the manager-entered manual share without putting the manual fee in the 40% basis', async () => {
    await seedHistoricalVehicleRules()
    const shiftId = await runShift({
      vehicleId: VEHICLE_ID,
      shiftNo: 1,
      orderCount: 12,
      prefix: 'MANUAL',
      manual: [{ fee: 5_000, driverShare: 3_000, companyShare: 2_000 }],
    })
    const snapshot = await h.deps.settlements.findByShift(shiftId)
    expect(snapshot).toMatchObject({
      deliveryFeeTotal: 6_000_000n,
      fixedDriverShare: 2_400_000n,
      manualDriverShare: 300_000n,
      grossDriverShare: 2_700_000n,
    })
    expect(await balance('company_revenue')).toBe(-2_600_000n)
    expect(await balance('yalago_income')).toBe(-1_200_000n)
    expect(await balance(fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }))).toBe(0n)
    expectBalancedLedger()
  })
})
