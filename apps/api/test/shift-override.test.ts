import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * Upper-level override for a stuck shift a driver can't finish (SRS ops escape hatch). VOID reverses
 * the float/top-up and discards the orders (→ cancelled); FORCE-CLOSE settles it, sending any
 * declared-vs-expected gap to a `shift_variance` cost centre (→ approved). Both are shift.approve.
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

async function openShift(driver: string, manager: string): Promise<string> {
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)] })
  return id
}
let seq = 0
async function addOrders(driver: string, id: string, payMode: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    seq += 1
    expect((await post(driver, `/shifts/${id}/orders`, { providerOrderNo: `YAL-${seq}`, payMode, fee: sypStr(5_000), zone: null })).statusCode).toBe(201)
  }
}
const bal = async (code: string): Promise<bigint> => await h.deps.ledger.fundBalance('branch-damascus', code)
const driverCash = fundCodeOf({ kind: 'driver_cash', driverId: DRIVER_ID })
const driverWallet = fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID })
const variance = fundCodeOf({ kind: 'cost_center', costCenterId: 'shift_variance:branch-damascus' })
const sharePayable = fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID })
const receivable = fundCodeOf({ kind: 'driver_receivable_cash', driverId: DRIVER_ID })

/** Every posted entry must balance (AC #5). */
function assertLedgerBalances(): void {
  for (const entry of h.deps.ledger.entries) {
    let d = 0n
    let c = 0n
    for (const l of entry.lines) (l.side === 'D' ? (d += l.amount) : (c += l.amount))
    expect(d, `entry ${entry.eventType}/${entry.occurrenceKey}`).toBe(c)
  }
}

describe('shift override (stuck shift)', () => {
  beforeEach(() => {
    seq = 0
  })

  it('VOID reverses the float/top-up, discards the orders, and cancels the shift', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    await addOrders(driver, id, 'cash', 3)

    // At open the driver holds the float + top-up.
    expect(await bal(driverCash)).toBeGreaterThan(0n)

    const res = await post(manager, `/shifts/${id}/void`, { reason: 'الدراجة تعطلت والسائق غادر' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().state).toBe('cancelled')

    // Money nets to zero: driver funds emptied, office funds restored, and the orders are gone.
    expect(await bal(driverCash)).toBe(0n)
    expect(await bal(driverWallet)).toBe(0n)
    expect(await bal(fundCodeOf({ kind: 'office_cash' }))).toBe(0n)
    expect(await bal(fundCodeOf({ kind: 'office_wallet' }))).toBe(0n)
    expect(await h.deps.orders.listByShift(id)).toHaveLength(0)
    assertLedgerBalances()
  })

  it('FORCE-CLOSE with the correct figures settles like a normal close — no variance', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    await addOrders(driver, id, 'cash', 12)
    await addOrders(driver, id, 'electronic', 6)
    await addOrders(driver, id, 'free', 2)

    // The §2.3 expected close: 160,000 cash / 70,000 wallet.
    const res = await post(manager, `/shifts/${id}/force-close`, { reason: 'lost his phone', cashDeclared: sypStr(160_000), walletDeclared: sypStr(70_000) })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().state).toBe('approved')

    expect(await bal(driverCash)).toBe(0n)
    expect(await bal(driverWallet)).toBe(0n)
    expect(await bal(variance)).toBe(0n) // declared == expected
    expect(await bal('yalago_share')).toBe(2_000_000n) // 20% of 100,000 fees
    assertLedgerBalances()
  })

  /**
   * «اي نقص يرمم من حصة السائق» — owner decision (k), 2026-08-12.
   *
   * This used to book the whole gap to `shift_variance:<branch>`, an account that records THAT
   * money was missing and nothing about WHOSE shift it was. The owner settles it against the man:
   * his share absorbs it first. Force-close is the only path that admits a gap at all — an ordinary
   * approval is refused unless BR1 is exactly zero.
   */
  it('FORCE-CLOSE with a cash shortfall takes it from the driver`s share, not a nameless account', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    await addOrders(driver, id, 'cash', 12)
    await addOrders(driver, id, 'electronic', 6)
    await addOrders(driver, id, 'free', 2)

    // The driver handed over 150,000, not the expected 160,000 — a 10,000 shortfall.
    const res = await post(manager, `/shifts/${id}/force-close`, { reason: 'cash short, driver owes it', cashDeclared: sypStr(150_000), walletDeclared: sypStr(70_000) })
    expect(res.statusCode, res.body).toBe(200)

    expect(await bal(driverCash)).toBe(0n)
    // The 10,000 came off his share — the payable is reduced by exactly that, and the branch
    // variance centre carries nothing, because the money is no longer unattributed.
    expect(await bal(sharePayable)).toBe(-3_000_000n) // 40,000 earned − 10,000 withheld, credit-side
    expect(await bal(variance)).toBe(0n)
    assertLedgerBalances()
  })

  /** Beyond his whole share it is not forgiven and not a branch loss — it is a ذمة on him. */
  it('books only the part beyond his entire share as a receivable', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    await addOrders(driver, id, 'cash', 12)
    await addOrders(driver, id, 'electronic', 6)
    await addOrders(driver, id, 'free', 2)

    // 100,000 handed over against 160,000 expected — a 60,000 gap, well past his 40,000 share.
    const res = await post(manager, `/shifts/${id}/force-close`, { reason: 'large shortfall', cashDeclared: sypStr(100_000), walletDeclared: sypStr(70_000) })
    expect(res.statusCode, res.body).toBe(200)

    expect(await bal(sharePayable)).toBe(0n) // the whole share absorbed
    expect(await bal(receivable)).toBe(2_000_000n) // the remaining 20,000 is owed
    expect(await bal(variance)).toBe(0n)
    assertLedgerBalances()
  })

  it('a driver may not void or force-close (shift.approve only)', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    expect((await post(driver, `/shifts/${id}/void`, { reason: 'x' })).statusCode).toBe(403)
    expect((await post(driver, `/shifts/${id}/force-close`, { reason: 'x' })).statusCode).toBe(403)
  })
})
