import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { minor } from '@ash/domain'
import { DRIVER2_ID, DRIVER_ID, type Harness, VEHICLE_ID, approveFixedClose, makeHarness, sypStr } from './harness.ts'

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
  await h.deps.orders.update({
    ...row,
    included: false,
    decisionReason: 'manager verified this row is outside the shift',
    decidedBy: 'u-bm',
    decidedAt: new Date(h.deps.clock.nowMs()).toISOString(),
  }, 'u-bm')
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
    await h.deps.orders.update({ ...row, walletAmount: minor(2_000_00n) }, 'u-bm')

    const stale = await approveFixedClose(h, manager, id, reviewed)
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error).toBe('orders_changed_since_review')
  })

  it('reaches neither the ledger nor the fixed-share basis', async () => {
    const { id, driver, manager } = await openWithOrders(10)
    await exclude(id, 'YAL-10')
    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(145_000),
      walletDeclared: sypStr(41_000),
    })
    const review = await get(manager, `/shifts/${id}/review`)
    const approved = await approveFixedClose(h, manager, id, review.json().br1.ordersHash)
    expect(approved.statusCode, approved.body).toBe(200)

    // Nine orders of 5,000 = 45,000 of fees, and Yallago's 20% of that is 9,000 — not 10,000.
    expect(await bal('yalago_share')).toBe(900_000n)
    // Fixed share uses the nine included fees only: 40% of 45,000 = 18,000, settled immediately.
    expect((await h.deps.settlements.findByShift(id))?.fixedDriverShare).toBe(1_800_000n)
    expect(await bal(fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }))).toBe(0n)
    expect(await bal(fundCodeOf({ kind: 'driver_cash', driverId: DRIVER_ID }))).toBe(0n)
    expect(await bal(fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID }))).toBe(0n)
  })
})

describe('what the wallet did on its own', () => {
  it('keeps an unmatched payment-log movement as archive without changing BR1', async () => {
    const { id, driver } = await openWithOrders(10)
    // The payment log is evidence, not an accounting input. Its rows remain available for review
    // and training while the dedicated wallet screenshot supplies the closing wallet balance.
    await h.deps.movements.merge(id, [{ amount: minor(300_00n), occurredMinute: '09:24' }], 'u-driver')

    const closed = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(150_000),
      walletDeclared: sypStr(40_000),
    })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().br1.difference).toBe('0.00')
    expect(await h.deps.movements.listByShift(id)).toHaveLength(1)
  })

  it('does not use an archived row to hide a declared-wallet difference', async () => {
    const { id, driver } = await openWithOrders(10)
    await h.deps.movements.merge(id, [{ amount: minor(300_00n), occurredMinute: '09:24' }], 'u-driver')

    const closed = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(150_000),
      walletDeclared: sypStr(40_300),
    })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().br1.difference).toBe('300.00')
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
      'u-driver',
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

  it('posts no payment-log adjustment to the ledger', async () => {
    const { id, driver, manager } = await openWithOrders(10)
    await h.deps.movements.merge(id, [{ amount: minor(300_00n), occurredMinute: '09:24' }], 'u-driver')
    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(150_000),
      walletDeclared: sypStr(40_000),
    })
    const review = await get(manager, `/shifts/${id}/review`)
    const approved = await approveFixedClose(h, manager, id, review.json().br1.ordersHash)
    expect(approved.statusCode, approved.body).toBe(200)

    expect(await bal(fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID }))).toBe(0n)
    expect(await bal('cost_center:wallet_adjustment:branch-damascus')).toBe(0n)
    expect(h.deps.ledger.entries.some((entry) => entry.eventType === 'wallet_adjustment')).toBe(false)
    for (const entry of h.deps.ledger.entries) {
      let d = 0n
      let c = 0n
      for (const l of entry.lines) (l.side === 'D' ? (d += l.amount) : (c += l.amount))
      expect(d, `entry ${entry.eventType}/${entry.occurrenceKey}`).toBe(c)
    }
  })

  it('does not stale a financial review when only archive data arrives', async () => {
    const { id, driver, manager } = await openWithOrders(3)
    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(115_000),
      walletDeclared: sypStr(47_000),
    })
    const reviewed = (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash as string
    await h.deps.movements.merge(
      id,
      [{ amount: minor(300_00n), occurredMinute: '09:24', included: false }],
      'u-driver',
    )

    const approved = await approveFixedClose(h, manager, id, reviewed)
    expect(approved.statusCode, approved.body).toBe(200)
  })
})

describe('submitting the list', () => {
  const list = {
    orders: [
      {
        providerOrderNo: 'YAL-A', payMode: 'cash', fee: sypStr(5_000),
        occurredDate: '2026-07-21', occurredMinute: '18:06',
      },
      {
        providerOrderNo: 'YAL-B', payMode: 'cash', fee: sypStr(5_000),
        occurredDate: '2026-07-21', occurredMinute: '17:42',
      },
    ],
    movements: [
      { amount: sypStr(-1_000), occurredMinute: '18:06', role: 'yalago_cut', providerOrderNo: 'YAL-A' },
      { amount: sypStr(300), occurredMinute: '09:24' },
    ],
  }

  it('sending the same list twice changes nothing', async () => {
    // The screenshots overlap and the driver steps back into the close to add one delivery, so the
    // whole list is submitted again. Inserting would 409 on every row that already exists.
    const { id, driver } = await openWithOrders(0)
    expect((await put(driver, `/shifts/${id}/operations`, list)).statusCode).toBe(200)
    const once = await h.deps.orders.listByShift(id)
    expect((await put(driver, `/shifts/${id}/operations`, list)).statusCode).toBe(200)

    expect(await h.deps.orders.listByShift(id)).toHaveLength(once.length)
    expect(await h.deps.movements.listByShift(id)).toHaveLength(2)
  })

  it('corrects a row but ignores a driver attempt to exclude a confirmed in-window operation', async () => {
    const { id, driver } = await openWithOrders(0)
    await put(driver, `/shifts/${id}/operations`, list)
    const fixed = {
      ...list,
      orders: [{ ...list.orders[0]!, fee: sypStr(7_000), included: false }, list.orders[1]!],
      movements: [],
    }
    expect((await put(driver, `/shifts/${id}/operations`, fixed)).statusCode).toBe(200)

    const row = (await h.deps.orders.listByShift(id)).find((o) => o.providerOrderNo === 'YAL-A')!
    expect(row.fee).toBe(minor(7_000_00n))
    expect(row.included).toBe(true)
  })

  it('names the shift that already owns an order, rather than failing blankly', async () => {
    // The dashboard list scrolls back through previous days, so reading further pulls in rows
    // already recorded on an earlier shift. «تعذّر حفظ بعض الطلبات» tells the driver nothing.
    const first = await openWithOrders(0)
    await put(first.driver, `/shifts/${first.id}/operations`, { orders: list.orders, movements: [] })
    await put(first.driver, `/shifts/${first.id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(110_000),
      walletDeclared: sypStr(48_000),
    })

    const driver2 = await h.loginAs('driver2')
    const second = (
      await post(driver2, '/shifts', { driverId: DRIVER2_ID, vehicleId: 'vehicle-2', shiftNo: 1 })
    ).json().id as string
    await h.uploadPhoto(driver2, second, 'start', 'odometer')
    await put(driver2, `/shifts/${second}/start-package`, { odometerKm: 100, batteryPercent: 90 })
    const manager = await h.loginAs('manager')
    const opened = await post(manager, `/shifts/${second}/approve-open`, {
      floatTranches: [sypStr(10_000)],
      topupTranches: [sypStr(10_000)],
    })
    expect(opened.statusCode, opened.body).toBe(200)

    const clash = await put(driver2, `/shifts/${second}/operations`, { orders: [list.orders[0]!], movements: [] })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error).toBe('order_belongs_to_other_shift')
    expect(clash.json().detail.shiftId).toBe(first.id)
  })

  it('links a movement to an order created in the very same call', async () => {
    const { id, driver } = await openWithOrders(0)
    await put(driver, `/shifts/${id}/operations`, list)
    const cut = (await h.deps.movements.listByShift(id)).find((m) => m.role === 'yalago_cut')!
    const order = (await h.deps.orders.listByShift(id)).find((o) => o.providerOrderNo === 'YAL-A')!
    expect(cut.orderId).toBe(order.id)
  })

  it('is refused once the shift has left the driver’s hands', async () => {
    const { id, driver } = await openWithOrders(1)
    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(105_000),
      walletDeclared: sypStr(49_000),
    })
    expect((await put(driver, `/shifts/${id}/operations`, list)).statusCode).toBe(409)
  })
})

describe('the manager revising the list at review', () => {
  const closed = async (): Promise<{ id: string; driver: string; manager: string }> => {
    const s = await openWithOrders(3)
    await put(s.driver, `/shifts/${s.id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(115_000),
      walletDeclared: sypStr(47_000),
    })
    return s
  }

  it('puts a row back without approving or bouncing the shift', async () => {
    const { id, manager } = await closed()
    await exclude(id, 'YAL-2')
    const res = await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'YAL-2', included: true, reason: 'verified against the shift window' }],
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().state).toBe('pending_review')
    expect(res.json().br1.difference).toBe('0.00')
  })

  it('resolves an ambiguous credit by unlinking it from its order', async () => {
    const { id, manager } = await closed()
    const [credit] = await h.deps.movements.merge(id, [
      { amount: minor(300_00n), occurredMinute: '18:06', role: 'order_credit', ambiguous: true },
    ], 'u-driver')
    const res = await post(manager, `/shifts/${id}/operations/revise`, {
      movements: [{ id: credit!.id, role: 'unmatched', providerOrderNo: null, ambiguous: false }],
    })
    expect(res.statusCode, res.body).toBe(200)
    const after = (await h.deps.movements.listByShift(id))[0]!
    expect(after.role).toBe('unmatched')
    expect(after.orderId).toBeNull()
    expect(after.ambiguous).toBe(false)
  })

  it('is a manager’s act, not a driver’s', async () => {
    const { id, driver } = await closed()
    const res = await post(driver, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'YAL-1', included: false, reason: 'verified outside the shift window' }],
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses outside the review', async () => {
    const { id, manager } = await openWithOrders(1)
    const res = await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{ providerOrderNo: 'YAL-1', included: false }],
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('shift_not_under_review')
  })

  it('is audited — it moves the equation', async () => {
    const { id, manager } = await closed()
    await post(manager, `/shifts/${id}/operations/revise`, {
      orders: [{
        providerOrderNo: 'YAL-1',
        included: false,
        reason: 'verified outside the shift window',
      }],
    })
    const trail = await h.deps.audit.list({ tableName: 'shifts', recordId: id })
    expect(trail.some((a) => (a.after as Record<string, unknown>)?.revisedByManager === true)).toBe(true)
  })
})

describe('an order the customer paid partly in cash', () => {
  it('splits between the two funds, and the ledger still zeroes both', async () => {
    const { id, driver, manager } = await openWithOrders(1)
    // 5,000 fee, 2,000 of it settled electronically: the driver holds 3,000 in his hand and the
    // wallet gains 2,000 less Yallago's 1,000.
    const row = (await h.deps.orders.listByShift(id))[0]!
    await h.deps.orders.update({ ...row, walletAmount: minor(2_000_00n), occurredMinute: '08:00' }, 'u-bm')

    const closed = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(103_000),
      walletDeclared: sypStr(51_000),
    })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().br1.difference).toBe('0.00')

    const review = await get(manager, `/shifts/${id}/review`)
    expect((await approveFixedClose(h, manager, id, review.json().br1.ordersHash)).statusCode).toBe(200)
    expect(await bal(fundCodeOf({ kind: 'driver_cash', driverId: DRIVER_ID }))).toBe(0n)
    expect(await bal(fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID }))).toBe(0n)
  })

  it('is carried to both screens so a manager can see what was measured', async () => {
    const { id, driver, manager } = await openWithOrders(1)
    const row = (await h.deps.orders.listByShift(id))[0]!
    await h.deps.orders.update({ ...row, walletAmount: minor(2_000_00n), occurredMinute: '08:00' }, 'u-bm')
    await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(103_000),
      walletDeclared: sypStr(51_000),
    })
    const order = (await get(manager, `/shifts/${id}/review`)).json().orders[0]
    expect(order.walletAmount).toBe('2000.00')
    expect(order.occurredMinute).toBe('08:00')
  })
})

/**
 * The route and the day an order carries — what identifies it, now that nothing invents a number.
 *
 * «الطلبات الحديثة» prints no order number. It prints a fee, two places and a clock, under a day
 * header. All four are read from the screenshot and all four are stored; the wire key is a UUID
 * nobody reads. These tests pin the two that can go wrong SILENTLY.
 */
describe('what a scanned order records', () => {
  it('stores the route as the order\u2019s points and the day the screen said', async () => {
    const { id, driver } = await openWithOrders(0)
    const r = await put(driver, `/shifts/${id}/operations`, {
      orders: [
        {
          providerOrderNo: 'YAL-route-1',
          payMode: 'cash',
          fee: sypStr(5_000),
          occurredMinute: '15:19',
          occurredDate: '2026-08-06',
          pointA: 'صيدلية سلمى الوليد بن عبد الملك',
          pointB: 'المدخل جامع الرحمن',
        },
      ],
      movements: [],
    })
    expect(r.statusCode, r.body).toBe(200)
    const stored = (await h.deps.orders.listByShift(id)).find((o) => o.providerOrderNo === 'YAL-route-1')!
    expect(stored.occurredDate).toBe('2026-08-06')
    expect(stored.points.map((p) => [p.role, p.label])).toEqual([
      ['start', 'صيدلية سلمى الوليد بن عبد الملك'],
      ['end', 'المدخل جامع الرحمن'],
    ])
  })

  it('BACKFILLS a route onto an order stored without one', async () => {
    // Every order recorded before the reader could read routes has none, and re-submitting the
    // shift is the only chance it will ever get one. Without this the UPDATE path dropped
    // pointA/pointB on the floor and a fixed reader could never repair a single old row.
    const { id, driver } = await openWithOrders(0)
    const send = async (points: Record<string, unknown>): Promise<LightMyRequestResponse> =>
      await put(driver, `/shifts/${id}/operations`, {
        orders: [{ providerOrderNo: 'YAL-backfill', payMode: 'cash', fee: sypStr(5_000), ...points }],
        movements: [],
      })
    await send({})
    expect((await h.deps.orders.listByShift(id))[0]!.points).toEqual([])

    await send({ pointA: 'مطعم الربيع', pointB: 'الشيخ سعد' })
    expect((await h.deps.orders.listByShift(id))[0]!.points.map((p) => p.label)).toEqual(['مطعم الربيع', 'الشيخ سعد'])
  })

  it('never OVERWRITES a route already stored — a manager\u2019s correction survives a re-read', async () => {
    const { id, driver } = await openWithOrders(0)
    const send = async (points: Record<string, unknown>): Promise<LightMyRequestResponse> =>
      await put(driver, `/shifts/${id}/operations`, {
        orders: [{ providerOrderNo: 'YAL-keep', payMode: 'cash', fee: sypStr(5_000), ...points }],
        movements: [],
      })
    await send({ pointA: 'المكان الصحيح', pointB: 'الوجهة الصحيحة' })
    await send({ pointA: 'قراءة مشوّشة', pointB: 'قراءة مشوّشة' })
    expect((await h.deps.orders.listByShift(id))[0]!.points.map((p) => p.label)).toEqual([
      'المكان الصحيح',
      'الوجهة الصحيحة',
    ])
  })

  it('shows the day and the route on the review, where the manager decides', async () => {
    const { id, driver, manager } = await openWithOrders(0)
    await put(driver, `/shifts/${id}/operations`, {
      orders: [
        {
          providerOrderNo: 'YAL-review',
          payMode: 'cash',
          fee: sypStr(5_000),
          occurredMinute: '13:10',
          occurredDate: '2026-08-05',
          pointA: 'عمر الخيام',
          pointB: 'الشيخ سعد',
        },
      ],
      movements: [],
    })
    const view = (await get(manager, `/shifts/${id}/review`)).json() as {
      orders: Array<{ occurredDate: string | null; points: Array<{ role: string; label: string }> }>
    }
    expect(view.orders[0]!.occurredDate).toBe('2026-08-05')
    expect(view.orders[0]!.points.map((p) => p.label)).toEqual(['عمر الخيام', 'الشيخ سعد'])
  })
})
