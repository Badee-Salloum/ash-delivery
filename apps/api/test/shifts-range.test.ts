import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ShiftRecord } from '@ash/contracts'
import { type ShiftState, minor, weekStartFor } from '@ash/domain'
import { BRANCH, DRIVER2_ID, DRIVER_ID, type Harness, VEHICLE_ID, makeHarness } from './harness.ts'

/**
 * P2 — `GET /shifts` as the filtered history screens read it: a vehicle filter beside the driver
 * one, the closing odometer beside the opening one, and a bounded range.
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

async function seedShift(
  id: string,
  overrides: Partial<Pick<ShiftRecord, 'driverId' | 'vehicleId' | 'businessDate' | 'shiftNo' | 'odoStart' | 'odoEnd'>> & {
    state?: ShiftState
  } = {},
): Promise<void> {
  const businessDate = overrides.businessDate ?? '2026-07-21'
  await h.deps.shifts.create({
    id,
    branchId: BRANCH,
    driverId: DRIVER_ID,
    vehicleId: VEHICLE_ID,
    shiftNo: 1,
    businessDate,
    weekStartDate: weekStartFor(businessDate),
    state: overrides.state ?? 'approved',
    floatTranches: [],
    topupTranches: [],
    carriedTranches: [],
    keptAsReceivable: minor(0n),
    driverSharePaid: minor(0n),
    mediaSlotsStart: [],
    mediaSlotsEnd: [],
    odoStart: null,
    odoEnd: null,
    batteryStart: null,
    batteryEnd: null,
    endCashDeclared: null,
    endWalletDeclared: null,
    odoStartOcr: null,
    odoEndOcr: null,
    odoEndAnomalyConfirmedAt: null,
    odoEndAnomalyConfirmedBy: null,
    batteryStartOcr: null,
    endWalletDeclaredOcr: null,
    driverConfirmedAt: null,
    openApprovedAt: null,
    windowOpensAt: null,
    openApprovedBy: null,
    submittedAt: null,
    equationDiff: null,
    cashDiff: null,
    walletDiff: null,
    ordersHash: null,
    approvedBy: null,
    approvedAt: null,
    managerCharge: minor(0n),
    managerChargeReason: null,
    ...overrides,
  }, null)
}

describe('GET /shifts — vehicle filter and closing odometer (P2)', () => {
  it('narrows a range to one bike, and to one driver on one bike', async () => {
    await seedShift('bike-1-driver-1', { odoStart: 1_000, odoEnd: 1_085 })
    await seedShift('bike-2-driver-2', { driverId: DRIVER2_ID, vehicleId: 'vehicle-2' })
    await seedShift('bike-2-driver-1', { vehicleId: 'vehicle-2', shiftNo: 2 })
    const manager = await h.loginAs('manager')

    const bike2 = await get(manager, '/shifts?from=2026-07-21&to=2026-07-21&vehicleId=vehicle-2')
    expect(bike2.statusCode, bike2.body).toBe(200)
    expect((bike2.json().shifts as Array<{ id: string }>).map((s) => s.id).sort()).toEqual([
      'bike-2-driver-1',
      'bike-2-driver-2',
    ])

    const both = await get(manager, `/shifts?from=2026-07-21&to=2026-07-21&vehicleId=vehicle-2&driverId=${DRIVER_ID}`)
    expect((both.json().shifts as Array<{ id: string }>).map((s) => s.id)).toEqual(['bike-2-driver-1'])

    const bike1 = (await get(manager, `/shifts?from=2026-07-21&to=2026-07-21&vehicleId=${VEHICLE_ID}`)).json().shifts
    expect(bike1).toHaveLength(1)
    expect(bike1[0]).toMatchObject({ id: 'bike-1-driver-1', odometerStart: 1_000, odometerEnd: 1_085 })
  })

  it('filters the live list by vehicle as well', async () => {
    await seedShift('live-bike-1', { state: 'open', businessDate: '2026-07-20' })
    await seedShift('live-bike-2', { state: 'suspended', driverId: DRIVER2_ID, vehicleId: 'vehicle-2' })
    const manager = await h.loginAs('manager')
    const live = await get(manager, '/shifts?live=1&vehicleId=vehicle-2')
    expect((live.json().shifts as Array<{ id: string }>).map((s) => s.id)).toEqual(['live-bike-2'])
    // The live and pending lists are not ranges; they are never capped.
    expect((await get(manager, '/shifts?live=1&from=2020-01-01&to=2026-07-21')).statusCode).toBe(200)
    expect((await get(manager, '/shifts?pending=1&from=2020-01-01&to=2026-07-21')).statusCode).toBe(200)
  })
})

describe('GET /shifts — a bounded range (P2)', () => {
  it('reads at most 31 days for the whole branch', async () => {
    const manager = await h.loginAs('manager')
    expect((await get(manager, '/shifts?from=2026-07-01&to=2026-07-31')).statusCode).toBe(200)
    const tooWide = await get(manager, '/shifts?from=2026-07-01&to=2026-08-01')
    expect(tooWide.statusCode).toBe(422)
    expect(tooWide.json()).toEqual({
      error: 'range_too_large',
      detail: { from: '2026-07-01', to: '2026-08-01', days: 32, maxDays: 31 },
    })
  })

  it('reads up to 400 days once a driver or a vehicle narrows it', async () => {
    await seedShift('old-shift', { businessDate: '2025-07-01', odoStart: 5, odoEnd: 9 })
    const manager = await h.loginAs('manager')
    // 2025-06-17 → 2026-07-21 is exactly 400 days.
    const byVehicle = await get(manager, `/shifts?from=2025-06-17&to=2026-07-21&vehicleId=${VEHICLE_ID}`)
    expect(byVehicle.statusCode, byVehicle.body).toBe(200)
    expect((byVehicle.json().shifts as Array<{ id: string }>).map((s) => s.id)).toEqual(['old-shift'])
    expect((await get(manager, `/shifts?from=2025-06-17&to=2026-07-21&driverId=${DRIVER_ID}`)).statusCode).toBe(200)

    const tooWide = await get(manager, `/shifts?from=2025-06-16&to=2026-07-21&driverId=${DRIVER_ID}`)
    expect(tooWide.statusCode).toBe(422)
    expect(tooWide.json().detail).toMatchObject({ days: 401, maxDays: 400 })
  })

  it('refuses impossible and reversed ranges instead of scanning them', async () => {
    const manager = await h.loginAs('manager')
    expect((await get(manager, '/shifts?from=2026-02-30&to=2026-03-01')).statusCode).toBe(400)
    expect((await get(manager, '/shifts?from=2026-07-21&to=2026-07-20')).statusCode).toBe(400)
    expect((await get(manager, '/shifts?from=yesterday&to=2026-07-21')).statusCode).toBe(400)
  })

  it('keeps the single-date and today reads untouched', async () => {
    await seedShift('today-shift')
    const manager = await h.loginAs('manager')
    expect((await get(manager, '/shifts')).json().shifts).toHaveLength(1)
    expect((await get(manager, '/shifts?date=2026-07-21')).json().shifts).toHaveLength(1)
  })
})
