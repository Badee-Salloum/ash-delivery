import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import {
  DRIVER_ID,
  type Harness,
  VEHICLE_ID,
  approveFixedClose,
  fixedApprovalPayload,
  makeHarness,
  sypStr,
  today,
} from './harness.ts'

/**
 * The full shift lifecycle over real HTTP, via fastify.inject() — no network, no database.
 *
 * This is the SRS §2.3 example driven through the actual API surface a driver and a branch
 * manager will use: float 100,000 + top-up 50,000, twenty orders at 5,000 (12 cash, 6
 * electronic, 2 free), closing at 160,000 cash and 70,000 wallet with a difference of zero.
 *
 * Traceability: acceptance criteria #1, #2, #3, #4, #5, #7.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const START_MEDIA = ['odometer']
const END_MEDIA = ['dashboard', 'wallet', 'odometer']

/** Evidence is now REAL: the gates read what was uploaded, not what the client claimed. */
async function uploadStart(shiftId: string, token: string) {
  for (const slot of START_MEDIA) await h.uploadPhoto(token, shiftId, 'start', slot)
}
async function uploadEnd(shiftId: string, token: string, slots: readonly string[] = END_MEDIA) {
  for (const slot of slots) await h.uploadPhoto(token, shiftId, 'end', slot)
}

async function openShift(driverToken: string, managerToken: string, vehicleId = VEHICLE_ID) {
  const created = await h.app.inject({
    method: 'POST',
    url: '/shifts',
    headers: { cookie: h.cookie(driverToken) },
    payload: { driverId: DRIVER_ID, vehicleId, shiftNo: 1 },
  })
  expect(created.statusCode).toBe(201)
  const id = created.json().id as string

  await uploadStart(id, driverToken)

  const start = await h.app.inject({
    method: 'PUT',
    url: `/shifts/${id}/start-package`,
    headers: { cookie: h.cookie(driverToken) },
    payload: {
      odometerKm: 15_320,
      batteryPercent: 95,
    },
  })
  expect(start.statusCode).toBe(200)
  expect(start.json().state).toBe('awaiting_open_approval')

  const approved = await h.app.inject({
    method: 'POST',
    url: `/shifts/${id}/approve-open`,
    headers: { cookie: h.cookie(managerToken) },
    payload: { floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)] },
  })
  expect(approved.statusCode).toBe(200)
  expect(approved.json().state).toBe('open')
  return id
}

async function addTwentyOrders(shiftId: string, _driverToken: string) {
  let n = 0
  const orders: Array<{
    clientKey: string; providerOrderNo: string; payMode: 'cash' | 'electronic' | 'free'; fee: string; occurredDate: string; occurredMinute: string
  }> = []
  const add = async (payMode: string, count: number) => {
    for (let i = 0; i < count; i++) {
      n += 1
      orders.push({
        clientKey: `lifecycle-yal-${n}`, providerOrderNo: `YAL-${n}`,
        payMode: payMode as 'cash' | 'electronic' | 'free', fee: sypStr(5_000),
        occurredDate: today, occurredMinute: '08:00',
      })
    }
  }
  await add('cash', 12)
  await add('electronic', 6)
  await add('free', 2)
  h.stageCloseDraftFinancialFixture(shiftId, {
    managerToken: await h.loginAs('manager'),
    orders,
  })
}

describe('the SRS §2.3 shift, end to end over HTTP', () => {
  it('opens, records 20 orders, closes at difference zero, and posts the ledger', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')

    const shiftId = await openShift(driver, manager)
    await addTwentyOrders(shiftId, driver)

    // ── The driver submits the end package ────────────────────────────────────────────────
    await uploadEnd(shiftId, driver)
    const submitted = await h.submitEndPackage(driver, shiftId, {
      odometerKm: 15_412,
      batteryPercent: 22,
      cashDeclared: sypStr(160_000),
      walletDeclared: sypStr(70_000),
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    const br1 = submitted.json().br1
    expect(submitted.json().state).toBe('pending_review')

    // The client's own numbers, over the wire, as decimal strings.
    expect(br1.expectedCash).toBe('160000.00')
    expect(br1.expectedWallet).toBe('70000.00')
    expect(br1.expectedTotal).toBe('230000.00')
    expect(br1.difference).toBe('0.00')
    expect(br1.balanced).toBe(true)
    expect(br1.splitBalanced).toBe(true)
    expect(br1.causes).toHaveLength(1)
    expect(br1.causes[0].code).toBe('balanced')

    // ── The manager reviews (C-7) ─────────────────────────────────────────────────────────
    const review = await h.app.inject({
      method: 'GET',
      url: `/shifts/${shiftId}/review`,
      headers: { cookie: h.cookie(manager) },
    })
    expect(review.statusCode).toBe(200)
    expect(review.json().orders).toHaveLength(20)
    expect(review.json().startPackage.floatTotal).toBe('100000.00')
    const seededDriver = await h.deps.directory.driver(DRIVER_ID)
    const seededVehicle = await h.deps.directory.vehicle(VEHICLE_ID)
    expect(review.json().driverNameAr).toBe(seededDriver?.fullNameAr)
    expect(review.json().driverNameEn).toBe(seededDriver?.fullNameEn ?? null)
    expect(review.json().vehicleCode).toBe(seededVehicle?.code)
    const hash = review.json().br1.ordersHash as string

    // ── The manager approves ──────────────────────────────────────────────────────────────
    const closed = await approveFixedClose(h, manager, shiftId, hash)
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().state).toBe('approved')

    // ── The ledger (AC #3, #4, #5, #7) ────────────────────────────────────────────────────
    const balance = (code: string) => h.deps.ledger.fundBalance('branch-damascus', code)

    // Yallago's 20% actually left the wallet.
    expect(await balance('yalago_share')).toBe(2_000_000n) // 20,000 new SYP
    // Fixed split is 40% driver / 40% company, and the driver's share is settled immediately.
    expect((await h.deps.settlements.findByShift(shiftId))?.fixedDriverShare).toBe(4_000_000n)
    expect(await balance(fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }))).toBe(0n)
    expect(await balance('company_revenue')).toBe(-4_000_000n)
    expect(await balance('yalago_income')).toBe(-2_000_000n)
    // Revenue fully allocated; the driver holds nothing after the daily returns.
    expect(await balance('fee_earned')).toBe(0n)
    expect(await balance(fundCodeOf({ kind: 'driver_cash', driverId: DRIVER_ID }))).toBe(0n)
    expect(await balance(fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID }))).toBe(0n)

    // Every posted entry balances (AC #5).
    for (const entry of h.deps.ledger.entries) {
      let d = 0n
      let c = 0n
      for (const l of entry.lines) (l.side === 'D' ? (d += l.amount) : (c += l.amount))
      expect(d, `entry ${entry.eventType}/${entry.occurrenceKey}`).toBe(c)
    }
  })

  it('is idempotent: approving twice does not double-post', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)
    await addTwentyOrders(shiftId, driver)
    await uploadEnd(shiftId, driver)

    await h.submitEndPackage(driver, shiftId, {
      odometerKm: 15_412, batteryPercent: 22,
      cashDeclared: sypStr(160_000), walletDeclared: sypStr(70_000),
    })
    const review = await h.app.inject({
      method: 'GET', url: `/shifts/${shiftId}/review`, headers: { cookie: h.cookie(manager) },
    })
    const hash = review.json().br1.ordersHash

    const approvalPayload = await fixedApprovalPayload(h, manager, shiftId, hash)
    const first = await h.app.inject({
      method: 'POST', url: `/shifts/${shiftId}/approve-close`,
      headers: { cookie: h.cookie(manager) }, payload: approvalPayload,
    })
    expect(first.statusCode).toBe(200)
    const entriesAfterFirst = h.deps.ledger.entries.length
    const companyAfterFirst = await h.deps.ledger.fundBalance('branch-damascus', 'company_revenue')

    // A retry, a double-click, or two managers racing.
    const second = await h.app.inject({
      method: 'POST', url: `/shifts/${shiftId}/approve-close`,
      headers: { cookie: h.cookie(manager) }, payload: approvalPayload,
    })
    // An exact confirmed replay succeeds without writing a second snapshot or journal batch.
    expect(second.statusCode).toBe(200)
    expect(h.deps.ledger.entries.length).toBe(entriesAfterFirst)
    expect(await h.deps.ledger.fundBalance('branch-damascus', 'company_revenue')).toBe(companyAfterFirst)
  })
})

describe('published tier history cannot change the active fixed policy', () => {
  it('pays fixed 40% even when an old published table says 50%', async () => {
    // A flat driver-50% table, effective before today — seeded like the go-live bootstrap installs
    // the F-1 default (the admin publish route refuses a PAST effective date, F-3, so a rule that
    // already governs today comes from the seed, not a fresh publish).
    await h.deps.tiers.publish({
      basis: 'orders',
      mode: 'whole',
      vehicleTypeId: null,
      bands: [{ from: 0, to: null, driverBps: 5000 }],
      effectiveFrom: '2026-01-01',
      createdBy: 'u-sa',
    })

    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)
    await addTwentyOrders(shiftId, driver)
    await uploadEnd(shiftId, driver)
    await h.submitEndPackage(driver, shiftId, {
      odometerKm: 15_412, batteryPercent: 22, cashDeclared: sypStr(160_000), walletDeclared: sypStr(70_000),
    })
    const review = await h.app.inject({ method: 'GET', url: `/shifts/${shiftId}/review`, headers: { cookie: h.cookie(manager) } })
    const hash = review.json().br1.ordersHash
    const closed = await approveFixedClose(h, manager, shiftId, hash)
    expect(closed.statusCode, closed.body).toBe(200)

    const balance = (code: string) => h.deps.ledger.fundBalance('branch-damascus', code)
    expect((await h.deps.settlements.findByShift(shiftId))?.fixedDriverShare).toBe(4_000_000n)
    expect(await balance(fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }))).toBe(0n)
    expect(await balance('company_revenue')).toBe(-4_000_000n)
    expect(await balance('yalago_income')).toBe(-2_000_000n)
  })
})

describe('the gates refuse what BR5 says they must (AC #1, #2)', () => {
  it('will not open without the odometer photo', async () => {
    const driver = await h.loginAs('driver1')
    const created = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    const res = await h.app.inject({
      method: 'PUT', url: `/shifts/${created.json().id}/start-package`,
      headers: { cookie: h.cookie(driver) },
      payload: {
        odometerKm: 100, batteryPercent: 90,
        floatTranches: [sypStr(1_000)], topupTranches: [sypStr(1_000)],
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('start_package_incomplete')
    expect(res.json().detail).toContainEqual({ kind: 'missing_photo', slot: 'odometer' })
  })

  it('will not open before the branch manager approves', async () => {
    const driver = await h.loginAs('driver1')
    const created = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    const id = created.json().id
    await h.app.inject({
      method: 'PUT', url: `/shifts/${id}/start-package`, headers: { cookie: h.cookie(driver) },
      payload: {
        odometerKm: 100, batteryPercent: 90,
        floatTranches: [sypStr(1_000)], topupTranches: [sypStr(1_000)],
      },
    })
    // Still awaiting approval — the driver cannot record an order yet.
    const res = await h.app.inject({
      method: 'POST', url: `/shifts/${id}/orders`, headers: { cookie: h.cookie(driver) },
      payload: { providerOrderNo: 'X-1', payMode: 'cash', fee: sypStr(5_000), zone: null },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('shift_not_open')
  })

  it('submits and settles when the equation is not zero, while still explaining the difference', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)
    await addTwentyOrders(shiftId, driver)

    // The driver hands over 5,000 too little in cash.
    await uploadEnd(shiftId, driver)
    await h.submitEndPackage(driver, shiftId, {
      odometerKm: 15_412, batteryPercent: 22,
      cashDeclared: sypStr(155_000), walletDeclared: sypStr(70_000),
    })

    const review = await h.app.inject({
      method: 'GET', url: `/shifts/${shiftId}/review`, headers: { cookie: h.cookie(manager) },
    })
    const br1 = review.json().br1
    expect(br1.difference).toBe('-5000.00')
    expect(br1.balanced).toBe(false)
    // The manager is told where to look, not merely that something is wrong.
    expect(br1.causes[0].code).toBe('cash_handover_mismatch')

    expect(review.json().state).toBe('pending_review')
    const res = await approveFixedClose(h, manager, shiftId, br1.ordersHash, {
      varianceReason: 'cash counted with the driver',
    })
    expect(res.statusCode, res.body).toBe(200)
    expect((await h.deps.settlements.findByShift(shiftId))?.variance).toBe(-500_000n)
  })

  it('refuses approval when the driver edited an order after the manager loaded the screen', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)
    await addTwentyOrders(shiftId, driver)
    await uploadEnd(shiftId, driver)
    await h.submitEndPackage(driver, shiftId, {
      odometerKm: 15_412, batteryPercent: 22,
      cashDeclared: sypStr(160_000), walletDeclared: sypStr(70_000),
    })
    const review = await h.app.inject({
      method: 'GET', url: `/shifts/${shiftId}/review`, headers: { cookie: h.cookie(manager) },
    })
    const staleHash = review.json().br1.ordersHash

    const res = await approveFixedClose(h, manager, shiftId, `${staleHash}-stale`)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('orders_changed_since_review')
  })

  it('rejects a duplicate Yallago order number as it is typed', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    const payload = { providerOrderNo: 'YAL-DUP', payMode: 'cash', fee: sypStr(5_000), zone: null }
    expect((await h.app.inject({
      method: 'POST', url: `/shifts/${shiftId}/orders`, headers: { cookie: h.cookie(driver) }, payload,
    })).statusCode).toBe(201)

    const dup = await h.app.inject({
      method: 'POST', url: `/shifts/${shiftId}/orders`, headers: { cookie: h.cookie(driver) }, payload,
    })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error).toBe('duplicate_order_no')
  })
})

describe('the pay-mode blind spot, over HTTP', () => {
  it('a miscoded order leaves the difference at zero but the components apart', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const shiftId = await openShift(driver, manager)

    // 11 cash + 7 electronic + 2 free: one cash order recorded as electronic.
    let n = 0
    const orders: Array<{
      clientKey: string; providerOrderNo: string; payMode: 'cash' | 'electronic' | 'free'; fee: string; occurredDate: string; occurredMinute: string
    }> = []
    const add = async (payMode: string, count: number) => {
      for (let i = 0; i < count; i++) {
        n += 1
        orders.push({
          clientKey: `lifecycle-m-${n}`, providerOrderNo: `M-${n}`,
          payMode: payMode as 'cash' | 'electronic' | 'free', fee: sypStr(5_000),
          occurredDate: today, occurredMinute: '08:00',
        })
      }
    }
    await add('cash', 11)
    await add('electronic', 7)
    await add('free', 2)
    h.stageCloseDraftFinancialFixture(shiftId, { managerToken: manager, orders })

    // The driver hands over what he ACTUALLY holds.
    await uploadEnd(shiftId, driver)
    const res = await h.submitEndPackage(driver, shiftId, {
      odometerKm: 15_412, batteryPercent: 22,
      cashDeclared: sypStr(160_000), walletDeclared: sypStr(70_000),
    })
    const br1 = res.json().br1

    expect(br1.difference).toBe('0.00') // ← the trap
    expect(br1.balanced).toBe(true)
    expect(br1.cashDifference).toBe('5000.00') // ← what catches it
    expect(br1.walletDifference).toBe('-5000.00')
    expect(br1.splitBalanced).toBe(false)
    expect(br1.causes[0].code).toBe('pay_mode_misclassified')
    expect(br1.causes[0].candidateOrderNos.length).toBeGreaterThan(0)
  })

  it('a confirmed cash/wallet settlement supersedes the legacy strict split gate', async () => {
    const strict = await makeHarness({ splitGate: 'strict' })
    try {
      const driver = await strict.loginAs('driver1')
      const manager = await strict.loginAs('manager')

      const created = await strict.app.inject({
        method: 'POST', url: '/shifts', headers: { cookie: strict.cookie(driver) },
        payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
      })
      const id = created.json().id
      await strict.uploadPhoto(driver, id, 'start', 'odometer')
      await strict.app.inject({
        method: 'PUT', url: `/shifts/${id}/start-package`, headers: { cookie: strict.cookie(driver) },
        payload: { odometerKm: 1, batteryPercent: 90 },
      })
      await strict.app.inject({
        method: 'POST', url: `/shifts/${id}/approve-open`, headers: { cookie: strict.cookie(manager) },
        payload: { floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)] },
      })
      strict.stageCloseDraftFinancialFixture(id, {
        managerToken: manager,
        orders: Array.from({ length: 20 }, (_, offset) => ({
          clientKey: `strict-s-${offset + 1}`,
          providerOrderNo: `S-${offset + 1}`,
          payMode: (offset < 11 ? 'cash' : 'electronic') as 'cash' | 'electronic',
          fee: sypStr(5_000),
          occurredDate: today,
          occurredMinute: '08:00',
        })),
      })
      for (const slot of END_MEDIA) await strict.uploadPhoto(driver, id, 'end', slot)
      await strict.submitEndPackage(driver, id, {
        odometerKm: 2, batteryPercent: 20,
        cashDeclared: sypStr(160_000), walletDeclared: sypStr(70_000),
      })
      const review = await strict.app.inject({
        method: 'GET', url: `/shifts/${id}/review`, headers: { cookie: strict.cookie(manager) },
      })
      const approvalPayload = await fixedApprovalPayload(strict, manager, id, review.json().br1.ordersHash)
      const res = await strict.app.inject({
        method: 'POST', url: `/shifts/${id}/approve-close`, headers: { cookie: strict.cookie(manager) },
        payload: approvalPayload,
      })
      expect(res.statusCode, res.body).toBe(200)
      expect((await strict.deps.settlements.findByShift(id))?.variance).toBe(0n)
    } finally {
      await strict.app.close()
    }
  })
})
