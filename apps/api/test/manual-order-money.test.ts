import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * A shift that mixes YALLAGO deliveries with the branch's OWN jobs, closed at zero.
 *
 * This is the money-critical case of the two-kind order model. A manual job carries no Yallago cut
 * and its two shares are typed rather than derived from the day's band, so three things could go
 * wrong and each would be silent:
 *
 *   • BR1 could charge a 20% cut on a delivery Yallago never saw, putting the equation out by that
 *     amount and blocking a close that is actually correct;
 *   • the tier band could count the manual jobs, lifting the driver's percentage on Yallago work he
 *     did not do;
 *   • the approval posting could fail to exhaust `fee_earned`, which throws at the close.
 *
 * The numbers below are chosen so each of those would show up as a different, visible failure.
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

/** Every posted entry must balance (AC #5). */
function assertLedgerBalances(): void {
  for (const entry of h.deps.ledger.entries) {
    let d = 0n
    let c = 0n
    for (const l of entry.lines) (l.side === 'D' ? (d += l.amount) : (c += l.amount))
    expect(d, `entry ${entry.eventType}/${entry.occurrenceKey}`).toBe(c)
  }
}

describe('a shift mixing Yallago deliveries and the branch’s own jobs', () => {
  it('closes at zero: no Yallago cut on a manual job, and its typed shares are what post', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')

    const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
    await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)] })

    // 10 Yallago cash deliveries at 5,000 → cash +50,000, wallet −10,000 (their 20%).
    for (let i = 1; i <= 10; i++) {
      expect(
        (await post(driver, `/shifts/${id}/orders`, { providerOrderNo: `YAL-${i}`, payMode: 'cash', fee: sypStr(5_000), zone: null })).statusCode,
      ).toBe(201)
    }

    // One of our own jobs, in cash, at 10,000 — split 4,000 / 6,000 by agreement. Yallago gets
    // NOTHING from it, so the wallet must not move at all for this order.
    expect(
      (
        await post(manager, `/shifts/${id}/orders/manual`, {
          providerOrderNo: 'MAN-1',
          payMode: 'cash',
          fee: sypStr(10_000),
          zone: null,
          kind: 'manual',
          driverShare: sypStr(4_000),
          companyShare: sypStr(6_000),
          notes: 'توصيلة خاصة',
          points: [
            { role: 'start', label: 'مطعم الشام', lat: 33.5138, lng: 36.2765 },
            { role: 'end', label: 'جسر النحاس', lat: null, lng: null },
          ],
        })
      ).statusCode,
    ).toBe(201)

    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)

    // Cash:   100,000 float + 50,000 (Yallago) + 10,000 (ours)          = 160,000
    // Wallet:  50,000 topup − 10,000 (Yallago's 20% on the cash orders)  =  40,000
    // If a cut were charged on the manual job too, the wallet would be 2,000 short here.
    const closed = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(160_000),
      walletDeclared: sypStr(40_000),
    })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().br1.difference).toBe('0.00')

    const review = await get(manager, `/shifts/${id}/review`)
    const approved = await post(manager, `/shifts/${id}/approve-close`, { reviewedOrdersHash: review.json().br1.ordersHash })
    expect(approved.statusCode, approved.body).toBe(200)

    // ── The money, after approval ────────────────────────────────────────────────────────
    // Debit raises a fund and credit lowers it, so the three share accounts — all credited — carry
    // negative balances. Yallago took 20% of their 50,000 and NOTHING of our 10,000.
    expect(await bal('yalago_share')).toBe(1_000_000n)
    expect(await bal('yalago_income')).toBe(-1_000_000n)
    // 10 Yallago orders → the 0–14 band → 35% of 50,000 = 17,500, plus the 4,000 we agreed = 21,500.
    expect(await bal(fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }))).toBe(-2_150_000n)
    // The company takes the residual of Yallago's block (50,000 − 10,000 − 17,500 = 22,500) plus
    // our 6,000 = 28,500. And 21,500 + 28,500 + 10,000 = 60,000, the whole of both kinds' fees.
    expect(await bal('company_revenue')).toBe(-2_850_000n)
    // Everything the driver held went back: both funds are exactly zero.
    expect(await bal(fundCodeOf({ kind: 'driver_cash', driverId: DRIVER_ID }))).toBe(0n)
    expect(await bal(fundCodeOf({ kind: 'driver_wallet', driverId: DRIVER_ID }))).toBe(0n)
    assertLedgerBalances()
  })

  it('the daily band counts Yallago orders only — our own jobs do not lift the driver’s rate', async () => {
    // 12 Yallago + 5 manual = 17 orders in total. Counting all of them would cross into the 15–24
    // band (40%); counting Yallago's alone stays in 0–14 (35%). The difference is real money.
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')

    const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 })).json().id as string
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    await put(driver, `/shifts/${id}/start-package`, { odometerKm: 100, batteryPercent: 90 })
    await post(manager, `/shifts/${id}/approve-open`, { floatTranches: [sypStr(10_000)], topupTranches: [sypStr(100_000)] })

    // 12 Yallago, electronic — 5,000 each, so the wallet gains the 80% block on each.
    for (let i = 1; i <= 12; i++) {
      await post(driver, `/shifts/${id}/orders`, { providerOrderNo: `YAL-${i}`, payMode: 'electronic', fee: sypStr(5_000), zone: null })
    }
    // 5 of our own, electronic, 1,000 each, split 600/400. No Yallago cut ⇒ the FULL fee lands.
    for (let i = 1; i <= 5; i++) {
      await post(manager, `/shifts/${id}/orders/manual`, {
        providerOrderNo: `MAN-${i}`,
        payMode: 'electronic',
        fee: sypStr(1_000),
        zone: null,
        kind: 'manual',
        driverShare: sypStr(600),
        companyShare: sypStr(400),
        points: [
          { role: 'start', label: 'أ', lat: null, lng: null },
          { role: 'end', label: 'ب', lat: null, lng: null },
        ],
      })
    }

    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
    // Wallet: 100,000 topup + 12 × 4,000 (Yallago block) + 5 × 1,000 (ours, in full) = 153,000
    const closed = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 200,
      batteryPercent: null,
      cashDeclared: sypStr(10_000), // the float, untouched — every order here was electronic
      walletDeclared: sypStr(153_000),
    })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().br1.difference).toBe('0.00')

    const review = await get(manager, `/shifts/${id}/review`)
    expect((await post(manager, `/shifts/${id}/approve-close`, { reviewedOrdersHash: review.json().br1.ordersHash })).statusCode).toBe(200)

    // 12 Yallago orders → the 0–14 band → 35% of 60,000 = 21,000; plus 5 × 600 of ours = 24,000.
    // Had the manual jobs been counted the band would have been 40%, and this would read 27,000.
    expect(await bal(fundCodeOf({ kind: 'driver_share_payable', driverId: DRIVER_ID }))).toBe(-2_400_000n)
    assertLedgerBalances()
  })
})
