import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { minor } from '@ash/domain'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * The operations of a shift: what was delivered, what the wallet actually did, and which of it
 * counts.
 *
 * Two things here move real money and both are invisible in the older fields, which is why the
 * review hash had to learn about them:
 *
 *   • an UNCHECKED order is stored and shown but leaves BR1, the tier band and the ledger entirely;
 *   • an UNMATCHED wallet movement — an incentive, a merchant paid, a withdrawal — is money the app
 *     moved on its own, and without it BR1 reports the amount as a discrepancy and blames the driver.
 *
 * The third case is the one that would be silent: a `yalago_cut` row must NEVER be added to the
 * wallet, because the equation already derives that cut from the fee. Counting the logged one too
 * charges it twice.
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
const bal = async (code: string): Promise<bigint> => await h.deps.ledger.fundBalance('branch-damascus', code)

/** A shift open, with `n` cash deliveries of 5,000 on it. */
async function openWithOrders(n: number): Promise<{ id: string; driver: string; manager: string }> {
  const driver = await h.loginAs('driver1')
  const manager = await h.loginAs('manager')
  const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
  await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)] })
  for (let i = 1; i <= n; i++) {
    await post(driver, `/shifts/${id}/orders`, { providerOrderNo: `YAL-${i}`, payMode: 'cash', fee: sypStr(5_000), zone: null })
  }
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  return { id, driver, manager }
}

const exclude = async (id: string, providerOrderNo: string): Promise<void> => {
  const row = (await h.deps.orders.listByShift(id)).find((o) => o.providerOrderNo === providerOrderNo)!
  await h.deps.orders.update({ ...row, included: false })
}

describe('an operation nobody checked', () => {
  it('leaves BR1 — the shift closes at zero on what remains', async () => {
    const { id, driver } = await openWithOrders(10)
    await exclude(id, 'YAL-10')

    // Nine deliveries: cash 100,000 + 45,000; wallet 50,000 − 9,000 of Yallago's 20%.
    const closed = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(145_000),
      walletDeclared: sypStr(41_000),
    })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().br1.difference).toBe('0.00')
  })

  it('is still SHOWN to whoever closes the shift, checked or not', async () => {
    // The owner's rule. An excluded row hidden from a screen is a row nobody can put back.
    const { id, driver, manager } = await openWithOrders(3)
    await exclude(id, 'YAL-2')
    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(110_000),
      walletDeclared: sypStr(48_000),
    })

    for (const [who, url] of [
      [driver, `/shifts/${id}/state`],
      [manager, `/shifts/${id}/review`],
    ] as const) {
      const orders = (await get(who, url)).json().orders as Array<{ providerOrderNo: string; included: boolean }>
      expect(orders).toHaveLength(3)
      expect(orders.find((o) => o.providerOrderNo === 'YAL-2')?.included).toBe(false)
    }
  })

  it('changes the review hash, so it cannot be excluded behind the manager’s back', async () => {
    const { id, driver, manager } = await openWithOrders(3)
    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(115_000),
      walletDeclared: sypStr(47_000),
    })
    const before = (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash as string
    await exclude(id, 'YAL-3')
    const after = (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash as string
    expect(after).not.toBe(before)
  })

  it('and approving on the pre-change hash is refused', async () => {
    // Isolated on the HASH: measuring an order's wallet amount moves money between the cash and
    // wallet sides while leaving the scalar at zero, so the equation still balances and the only
    // thing left standing between the manager and a posting he never reviewed is the digest.
    const { id, driver, manager } = await openWithOrders(3)
    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(115_000),
      walletDeclared: sypStr(47_000),
    })
    const reviewed = (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash as string

    const row = (await h.deps.orders.listByShift(id)).find((o) => o.providerOrderNo === 'YAL-3')!
    await h.deps.orders.update({ ...row, walletAmount: minor(2_000_00n) })

    const stale = await post(manager, `/shifts/${id}/approve-close`, { reviewedOrdersHash: reviewed })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error).toBe('orders_changed_since_review')
  })

  it('reaches neither the ledger nor the tier band', async () => {
    const { id, driver, manager } = await openWithOrders(10)
    await exclude(id, 'YAL-10')
    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(145_000),
      walletDeclared: sypStr(41_000),
    })
    const review = await get(manager, `/shifts/${id}/review`)
    const approved = await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: review.json().br1.ordersHash,
    })
    expect(approved.statusCode, approved.body).toBe(200)

    // Nine orders of 5,000 = 45,000 of fees, and Yallago's 20% of that is 9,000 — not 10,000.
    expect(await bal('yalago_share')).toBe(900_000n)
    // Nine is still the 0–14 band: 35% of 45,000 = 15,750.
    expect(await bal(fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }))).toBe(-1_575_000n)
    expect(await bal(fundCodeOf({ kind: 'driver_cash', driverId: DRIVER_ID }))).toBe(0n)
    expect(await bal(fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID }))).toBe(0n)
  })
})

describe('what the wallet did on its own', () => {
  it('an unmatched movement enters BR1 instead of being blamed on the driver', async () => {
    const { id, driver } = await openWithOrders(10)
    // An incentive Yallago paid: nothing to do with any order, but the wallet really holds it.
    await h.deps.movements.merge(id, [{ amount: minor(300_00n), occurredMinute: '09:24' }])

    const closed = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(150_000),
      // 50,000 topup − 10,000 cut + 300 incentive.
      walletDeclared: sypStr(40_300),
    })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().br1.difference).toBe('0.00')
  })

  it('an EXCLUDED movement does not', async () => {
    const { id, driver } = await openWithOrders(10)
    const [row] = await h.deps.movements.merge(id, [{ amount: minor(300_00n), occurredMinute: '09:24' }])
    await h.deps.movements.update(row!.id, { included: false })

    const closed = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(150_000),
      walletDeclared: sypStr(40_000),
    })
    expect(closed.json().br1.difference).toBe('0.00')
  })

  it('a logged Yallago cut is corroboration, NEVER a second deduction', async () => {
    // The dangerous one. The equation derives the 20% from the fee because the block is a residual;
    // adding the logged row too would take it out of the wallet twice, and the shift would look
    // 10,000 short with nothing on screen to explain it.
    const { id, driver } = await openWithOrders(10)
    await h.deps.movements.merge(
      id,
      Array.from({ length: 10 }, (_, i) => ({
        amount: minor(-1_000_00n),
        occurredMinute: `1${i}:00`,
        role: 'yalago_cut' as const,
        orderId: null,
      })),
    )
    // Deliberately with an order link absent — the constraint only bites in Postgres, and the
    // arithmetic must not depend on it: role alone decides.
    const closed = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(150_000),
      walletDeclared: sypStr(40_000),
    })
    expect(closed.json().br1.difference).toBe('0.00')
  })

  it('posts an unmatched movement to the ledger, so the driver’s wallet still zeroes', async () => {
    const { id, driver, manager } = await openWithOrders(10)
    await h.deps.movements.merge(id, [{ amount: minor(300_00n), occurredMinute: '09:24' }])
    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(150_000),
      walletDeclared: sypStr(40_300),
    })
    const review = await get(manager, `/shifts/${id}/review`)
    const approved = await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: review.json().br1.ordersHash,
    })
    expect(approved.statusCode, approved.body).toBe(200)

    expect(await bal(fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID }))).toBe(0n)
    // Nobody has decided whose money an incentive is, so it waits in a named cost centre for the
    // accounting engine rather than being asserted as anyone's revenue.
    expect(await bal('cost_center:wallet_adjustment:branch-damascus')).toBe(-300_00n)
    for (const entry of h.deps.ledger.entries) {
      let d = 0n
      let c = 0n
      for (const l of entry.lines) (l.side === 'D' ? (d += l.amount) : (c += l.amount))
      expect(d, `entry ${entry.eventType}/${entry.occurrenceKey}`).toBe(c)
    }
  })

  it('changes the review hash even though no order moved', async () => {
    // A row that arrives UNCHECKED changes no money at all — and must still force a re-review,
    // because checking it later would. The digest is the only thing that can see it: every order
    // field is untouched.
    const { id, driver, manager } = await openWithOrders(3)
    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(115_000),
      walletDeclared: sypStr(47_000),
    })
    const reviewed = (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash as string
    await h.deps.movements.merge(id, [{ amount: minor(300_00n), occurredMinute: '09:24', included: false }])

    const stale = await post(manager, `/shifts/${id}/approve-close`, { reviewedOrdersHash: reviewed })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error).toBe('orders_changed_since_review')
  })
})

describe('an order the customer paid partly in cash', () => {
  it('splits between the two funds, and the ledger still zeroes both', async () => {
    const { id, driver, manager } = await openWithOrders(1)
    // 5,000 fee, 2,000 of it settled electronically: the driver holds 3,000 in his hand and the
    // wallet gains 2,000 less Yallago's 1,000.
    const row = (await h.deps.orders.listByShift(id))[0]!
    await h.deps.orders.update({ ...row, walletAmount: minor(2_000_00n), occurredMinute: '18:06' })

    const closed = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(103_000),
      walletDeclared: sypStr(51_000),
    })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().br1.difference).toBe('0.00')

    const review = await get(manager, `/shifts/${id}/review`)
    expect((await post(manager, `/shifts/${id}/approve-close`, { reviewedOrdersHash: review.json().br1.ordersHash })).statusCode).toBe(200)
    expect(await bal(fundCodeOf({ kind: 'driver_cash', driverId: DRIVER_ID }))).toBe(0n)
    expect(await bal(fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID }))).toBe(0n)
  })

  it('is carried to both screens so a manager can see what was measured', async () => {
    const { id, driver, manager } = await openWithOrders(1)
    const row = (await h.deps.orders.listByShift(id))[0]!
    await h.deps.orders.update({ ...row, walletAmount: minor(2_000_00n), occurredMinute: '18:06' })
    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(103_000),
      walletDeclared: sypStr(51_000),
    })
    const order = (await get(manager, `/shifts/${id}/review`)).json().orders[0]
    expect(order.walletAmount).toBe('2000.00')
    expect(order.occurredMinute).toBe('18:06')
  })
})
