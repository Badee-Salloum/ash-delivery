import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { DRIVER2_ID, DRIVER_ID, type Harness, VEHICLE_ID, approveFixedClose, makeHarness, sypStr, today } from './harness.ts'

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
  url.endsWith('/end-package')
    ? await h.submitEndPackage(token, url.split('/')[2]!, payload)
    : await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })
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
const fixtureOrders = new Map<string, Array<{
  clientKey: string
  providerOrderNo: string
  payMode: 'cash' | 'electronic' | 'free'
  fee: string
  occurredDate: string
  occurredMinute: string
}>>()
async function addOrders(driver: string, id: string, payMode: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    seq += 1
    const rows = fixtureOrders.get(id) ?? []
    rows.push({
      clientKey: `tranche-${seq}`,
      providerOrderNo: `YAL-${seq}`,
      payMode: payMode as 'cash' | 'electronic' | 'free',
      fee: sypStr(5_000),
      occurredDate: today,
      occurredMinute: '08:00',
    })
    fixtureOrders.set(id, rows)
  }
}

/** The SRS 12 cash / 6 electronic / 2 free split — an 80,000 block on 20 orders of 5,000. */
async function addTwentyOrders(driver: string, id: string): Promise<void> {
  await addOrders(driver, id, 'cash', 12)
  await addOrders(driver, id, 'electronic', 6)
  await addOrders(driver, id, 'free', 2)
}

async function submitEnd(driver: string, id: string, cash: number, wallet: number): Promise<LightMyRequestResponse> {
  h.stageCloseDraftFinancialFixture(id, {
    managerToken: await h.loginAs('manager'),
    orders: fixtureOrders.get(id) ?? [],
  })
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  return await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 15_412,
    batteryPercent: 22,
    cashDeclared: sypStr(cash),
    walletDeclared: sypStr(wallet),
  })
}

async function approveClose(manager: string, id: string): Promise<LightMyRequestResponse> {
  const hash = (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash as string
  return await approveFixedClose(h, manager, id, hash)
}

const cashOf = async (driverId: string): Promise<bigint> =>
  await h.deps.ledger.fundBalance('branch-damascus', fundCodeOf({ kind: 'driver_cash', driverId }))
const trancheJournalKey = (callerKey: string): string => `admin-tranche:${callerKey}`

describe('mid-day tranche (C-5)', () => {
  beforeEach(() => {
    seq = 0
    fixtureOrders.clear()
  })

  it('a second float posts under its caller key; the shift closes at zero with the summed float', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    const tr = await post(manager, `/shifts/${id}/tranche`, {
      kind: 'float', amount: sypStr(50_000), occurrenceKey: 'mid-float-1',
    })
    expect(tr.statusCode, tr.body).toBe(201)

    // Two float_out postings — the open ordinal and the client's mid-day key.
    const floats = h.deps.ledger.entries.filter((e) => e.eventType === 'float_out')
    expect(floats.map((e) => e.occurrenceKey).sort()).toEqual(['1', trancheJournalKey('mid-float-1')])
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

    expect((await post(manager, `/shifts/${id}/tranche`, {
      kind: 'topup', amount: sypStr(20_000), occurrenceKey: 'mid-topup-1',
    })).statusCode).toBe(201)
    const topups = h.deps.ledger.entries.filter((e) => e.eventType === 'wallet_topup')
    expect(topups.map((e) => e.occurrenceKey).sort()).toEqual(['1', trancheJournalKey('mid-topup-1')])

    await addTwentyOrders(driver, id)

    // Top-up 50,000 + 20,000 = 70,000 in the wallet, so expected end wallet is 70,000 + 20,000 = 90,000.
    const end = await submitEnd(driver, id, 160_000, 90_000)
    expect(end.statusCode, end.body).toBe(200)
    expect(end.json().br1.balanced).toBe(true)

    expect((await approveClose(manager, id)).json().state).toBe('approved')
  })

  it('never mistakes a caller key for the numeric key of an opening tranche', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    const response = await post(manager, `/shifts/${id}/tranche`, {
      kind: 'float', amount: sypStr(100_000), occurrenceKey: '1',
    })

    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().replayed).toBe(false)
    expect(h.deps.ledger.entries.filter((entry) => entry.eventType === 'float_out').map((entry) => entry.occurrenceKey))
      .toEqual(['1', trancheJournalKey('1')])
    expect((await h.deps.shifts.findById(id))?.floatTranches).toEqual([10_000_000n, 10_000_000n])
  })

  it('refuses a driver, a non-open shift and a non-positive amount', async () => {
    const driver = await h.loginAs('driver1')
    const driver2 = await h.loginAs('driver2')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    // A tranche is branch money — `shift.approve`; the driver may not disburse it to himself.
    expect((await post(driver, `/shifts/${id}/tranche`, {
      kind: 'float', amount: sypStr(10_000), occurrenceKey: 'driver-forbidden',
    })).statusCode).toBe(403)

    // Zero (or negative) is not a disbursement and is rejected at the request boundary.
    const zero = await post(manager, `/shifts/${id}/tranche`, {
      kind: 'float', amount: sypStr(0), occurrenceKey: 'zero',
    })
    expect(zero.statusCode).toBe(400)
    expect(zero.json().error).toBe('invalid_request')

    // A draft shift is not out with any money yet — nothing to top up.
    const draftId = (await post(driver2, '/shifts', { driverId: DRIVER2_ID, vehicleId: 'vehicle-2', shiftNo: 1 })).json().id as string
    const res = await post(manager, `/shifts/${draftId}/tranche`, {
      kind: 'float', amount: sypStr(10_000), occurrenceKey: 'draft-refused',
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('shift_not_open_for_tranche')
  })

  it('requires a supported admin client with a caller-minted event key', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    const before = await h.deps.shifts.findById(id)
    const response = await post(manager, `/shifts/${id}/tranche`, { kind: 'float', amount: sypStr(10_000) })

    expect(response.statusCode).toBe(428)
    expect(response.json()).toMatchObject({ error: 'admin_update_required', detail: { field: 'occurrenceKey' } })
    expect((await h.deps.shifts.findById(id))?.floatTranches).toEqual(before?.floatTranches)
    expect(h.deps.ledger.entries.filter((entry) => entry.eventType === 'float_out')).toHaveLength(1)
  })
})

/**
 * The retry that used to hand out the cash twice.
 *
 * The occurrence key was derived from `tranches.length + 1`, recomputed on every request — so a
 * SEQUENTIAL retry was never a replay, it was tranche #2. The manager taps twice on a slow office
 * connection, or the app retries a request that timed out after the server committed, and the
 * driver is debited 100,000 for 50,000 he received once. BR1 then expects money back that was
 * never handed over, and the shift cannot be closed at all.
 *
 * SRS C-5 genuinely allows several tranches a day, so the server cannot tell a second
 * disbursement from a repeated one by looking at the amount. Only the caller knows. So the caller
 * says, with a key it mints once per intended disbursement and reuses on every retry.
 */
describe('a tranche sent twice', () => {
  beforeEach(() => {
    seq = 0
  })

  it('disburses ONCE when the client sends the same occurrenceKey', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    const body = { kind: 'float', amount: sypStr(50_000), occurrenceKey: 'tap-abc123' }
    const first = await post(manager, `/shifts/${id}/tranche`, body)
    const retry = await post(manager, `/shifts/${id}/tranche`, body)
    expect(first.statusCode, first.body).toBe(201)
    expect(retry.statusCode, retry.body).toBe(200) // replay success, not a new resource
    expect(retry.json().replayed).toBe(true)

    const floats = h.deps.ledger.entries.filter((e) => e.eventType === 'float_out')
    // Open posted one; the tapped disbursement posted one, however many times it was sent.
    expect(floats).toHaveLength(2)
    // 100,000 at open + 50,000 once. 200,000 here would be the driver owing money he never got.
    expect(await cashOf(DRIVER_ID)).toBe(15_000_000n)
    expect((await h.deps.shifts.findById(id))?.floatTranches).toEqual([10_000_000n, 5_000_000n])

    // BR1 consumes the tranche array, so a retry must leave a normal balanced close possible.
    await addTwentyOrders(driver, id)
    const end = await submitEnd(driver, id, 210_000, 70_000)
    expect(end.statusCode, end.body).toBe(200)
    expect(end.json().br1.balanced).toBe(true)
    const lostResponseRetry = await post(manager, `/shifts/${id}/tranche`, body)
    expect(lostResponseRetry.statusCode, lostResponseRetry.body).toBe(200)
    expect(lostResponseRetry.json().replayed).toBe(true)
    expect((await h.deps.shifts.findById(id))?.state).toBe('pending_review')
    expect((await h.deps.shifts.findById(id))?.floatTranches).toEqual([10_000_000n, 5_000_000n])
    expect((await approveClose(manager, id)).json().state).toBe('approved')
  })

  it('serialises concurrent exact retries into one journal and one shift tranche', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    const body = { kind: 'float', amount: sypStr(50_000), occurrenceKey: 'concurrent-tap' }

    const responses = await Promise.all([
      post(manager, `/shifts/${id}/tranche`, body),
      post(manager, `/shifts/${id}/tranche`, body),
    ])

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201])
    expect(h.deps.ledger.entries.filter((entry) =>
      entry.eventType === 'float_out' && entry.occurrenceKey === trancheJournalKey('concurrent-tap'))).toHaveLength(1)
    expect((await h.deps.shifts.findById(id))?.floatTranches).toEqual([10_000_000n, 5_000_000n])
    expect(await cashOf(DRIVER_ID)).toBe(15_000_000n)
  })

  it('rejects reusing an event key for a different amount without changing either fact', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    expect((await post(manager, `/shifts/${id}/tranche`, {
      kind: 'float', amount: sypStr(50_000), occurrenceKey: 'one-purpose',
    })).statusCode).toBe(201)
    const conflict = await post(manager, `/shifts/${id}/tranche`, {
      kind: 'float', amount: sypStr(30_000), occurrenceKey: 'one-purpose',
    })

    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error).toBe('idempotency_key_conflict')
    expect(h.deps.ledger.entries.filter((entry) =>
      entry.eventType === 'float_out' && entry.occurrenceKey === trancheJournalKey('one-purpose'))).toHaveLength(1)
    expect((await h.deps.shifts.findById(id))?.floatTranches).toEqual([10_000_000n, 5_000_000n])
    expect(await cashOf(DRIVER_ID)).toBe(15_000_000n)
  })

  it('rejects reusing a float event key as a top-up after a lost response', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    expect((await post(manager, `/shifts/${id}/tranche`, {
      kind: 'float', amount: sypStr(50_000), occurrenceKey: 'kind-cannot-change',
    })).statusCode).toBe(201)
    const conflict = await post(manager, `/shifts/${id}/tranche`, {
      kind: 'topup', amount: sypStr(50_000), occurrenceKey: 'kind-cannot-change',
    })

    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error).toBe('idempotency_key_conflict')
    expect(h.deps.ledger.entries.filter((entry) =>
      entry.occurrenceKey === trancheJournalKey('kind-cannot-change'))).toHaveLength(1)
    const stored = await h.deps.shifts.findById(id)
    expect(stored?.floatTranches).toEqual([10_000_000n, 5_000_000n])
    expect(stored?.topupTranches).toEqual([5_000_000n])
  })

  it('still allows a genuine SECOND tranche under its own key', async () => {
    // The fix must not break C-5: two real disbursements are two keys, and both must post.
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    await post(manager, `/shifts/${id}/tranche`, { kind: 'float', amount: sypStr(50_000), occurrenceKey: 'tap-1' })
    await post(manager, `/shifts/${id}/tranche`, { kind: 'float', amount: sypStr(30_000), occurrenceKey: 'tap-2' })

    expect(h.deps.ledger.entries.filter((e) => e.eventType === 'float_out')).toHaveLength(3)
    expect(await cashOf(DRIVER_ID)).toBe(18_000_000n) // 100,000 + 50,000 + 30,000
  })
})
