import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { DRIVER2_ID, DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * A second (or later) cash-float / wallet top-up disbursed mid-day (SRS C-5). The arrays and the
 * `(shift_id, event_type, occurrence_key)` idempotency already existed; tranches were just set once
 * at open-approval and never appended. Each mid-day tranche posts ONE balanced entry under its own
 * occurrence key, and BR1's expected end cash/wallet move automatically because the equation sums
 * the tranche arrays.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (token: string, url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

/** Open with the SRS §2.3 funds: float 100,000, top-up 50,000. */
async function openShift(driver: string, manager: string): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 15_320, batteryPercent: 95 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)] })
  return id
}

let seq = 0
async function addOrders(driver: string, id: string, payMode: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    seq += 1
    const res = await post(driver, `/shifts/${id}/orders`, { providerOrderNo: `YAL-${seq}`, payMode, fee: sypStr(5_000), zone: 'المزة' })
    expect(res.statusCode, res.body).toBe(201)
  }
}

/** The SRS 12 cash / 6 electronic / 2 free split — an 80,000 block on 20 orders of 5,000. */
async function addTwentyOrders(driver: string, id: string): Promise<void> {
  await addOrders(driver, id, 'cash', 12)
  await addOrders(driver, id, 'electronic', 6)
  await addOrders(driver, id, 'free', 2)
}

async function submitEnd(driver: string, id: string, cash: number, wallet: number): Promise<LightMyRequestResponse> {
  for (const slot of ['dashboard', 'wallet', 'odometer', 'wallet_zeroed']) await h.uploadPhoto(driver, id, 'end', slot)
  return await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 15_412,
    batteryPercent: 22,
    cashDeclared: sypStr(cash),
    walletDeclared: sypStr(wallet),
  })
}

async function approveClose(manager: string, id: string): Promise<LightMyRequestResponse> {
  const hash = (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash as string
  return await post(manager, `/shifts/${id}/approve-close`, { reviewedOrdersHash: hash })
}

const cashOf = async (driverId: string): Promise<bigint> =>
  await h.deps.ledger.fundBalance('branch-damascus', fundCodeOf({ kind: 'driver_cash', driverId }))

describe('mid-day tranche (C-5)', () => {
  beforeEach(() => {
    seq = 0
  })

  it('a second float posts under occurrence_key=2; the shift closes at zero with the summed float', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    const tr = await post(manager, `/shifts/${id}/tranche`, { kind: 'float', amount: sypStr(50_000) })
    expect(tr.statusCode, tr.body).toBe(201)

    // Two float_out postings — occurrence_key 1 (open) and 2 (mid-day) — never one that swallowed the other.
    const floats = h.deps.ledger.entries.filter((e) => e.eventType === 'float_out')
    expect(floats.map((e) => e.occurrenceKey).sort()).toEqual(['1', '2'])
    // The driver is holding 150,000 in office cash.
    expect(await cashOf(DRIVER_ID)).toBe(15_000_000n)

    await addTwentyOrders(driver, id)

    // BR1's expected end cash moved with the tranche: 160,000 + the extra 50,000 = 210,000.
    const end = await submitEnd(driver, id, 210_000, 70_000)
    expect(end.statusCode, end.body).toBe(200)
    expect(end.json().state).toBe('pending_review')
    expect(end.json().br1.balanced).toBe(true)

    expect((await approveClose(manager, id)).json().state).toBe('approved')
  })

  it('a top-up tranche lands in the wallet and the shift still closes balanced', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    expect((await post(manager, `/shifts/${id}/tranche`, { kind: 'topup', amount: sypStr(20_000) })).statusCode).toBe(201)
    const topups = h.deps.ledger.entries.filter((e) => e.eventType === 'wallet_topup')
    expect(topups.map((e) => e.occurrenceKey).sort()).toEqual(['1', '2'])

    await addTwentyOrders(driver, id)

    // Top-up 50,000 + 20,000 = 70,000 in the wallet, so expected end wallet is 70,000 + 20,000 = 90,000.
    const end = await submitEnd(driver, id, 160_000, 90_000)
    expect(end.statusCode, end.body).toBe(200)
    expect(end.json().br1.balanced).toBe(true)

    expect((await approveClose(manager, id)).json().state).toBe('approved')
  })

  it('refuses a driver, a non-open shift and a non-positive amount', async () => {
    const driver = await h.loginAs('driver1')
    const driver2 = await h.loginAs('driver2')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    // A tranche is branch money — `shift.approve`; the driver may not disburse it to himself.
    expect((await post(driver, `/shifts/${id}/tranche`, { kind: 'float', amount: sypStr(10_000) })).statusCode).toBe(403)

    // Zero (or negative) is not a disbursement.
    expect((await post(manager, `/shifts/${id}/tranche`, { kind: 'float', amount: sypStr(0) })).statusCode).toBe(422)

    // A draft shift is not out with any money yet — nothing to top up.
    const draftId = (await post(driver2, '/shifts', { driverId: DRIVER2_ID, vehicleId: 'vehicle-2', shiftNo: 1 })).json().id as string
    const res = await post(manager, `/shifts/${draftId}/tranche`, { kind: 'float', amount: sypStr(10_000) })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('shift_not_open_for_tranche')
  })
})
