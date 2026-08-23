import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fundCodeOf } from '@ash/adapters/memory'
import { DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * Upper-level override for a stuck shift a driver can't finish (SRS ops escape hatch). VOID reverses
 * the float/top-up and discards the orders (→ cancelled); FORCE-CLOSE uses the exact same fixed
 * settlement preview, full wallet sweep and one cash transaction as ordinary approval.
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

async function forceClosePayload(
  manager: string,
  id: string,
  reason: string,
  cash: number,
  wallet: number,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const settlement = await get(
    manager,
    `/shifts/${id}/settlement?actualCash=${encodeURIComponent(sypStr(cash))}&actualWallet=${encodeURIComponent(sypStr(wallet))}`,
  )
  expect(settlement.statusCode, settlement.body).toBe(200)
  return {
    reason,
    cashDeclared: sypStr(cash),
    walletDeclared: sypStr(wallet),
    reviewedSettlementHash: settlement.json().settlementHash,
    walletTransferConfirmed: true,
    cashSettlementConfirmed: true,
    ...extra,
  }
}

async function forceCloseThroughBoundary(
  manager: string,
  id: string,
  reason: string,
  cash: number,
  wallet: number,
  extra: Record<string, unknown> = {},
): Promise<{ response: LightMyRequestResponse; replayPayload: Record<string, unknown> }> {
  const beforeLedger = await h.deps.ledger.listByShift(id)
  const boundary = await post(manager, `/shifts/${id}/force-close`, {
    prepareOnly: true,
    reason,
    cashDeclared: sypStr(cash),
    walletDeclared: sypStr(wallet),
    ...extra,
  })
  expect(boundary.statusCode, boundary.body).toBe(200)
  expect(boundary.json()).toMatchObject({ state: 'pending_review', postings: 0, prepared: true })
  expect(await h.deps.shifts.findById(id)).toMatchObject({
    state: 'pending_review',
    submittedAt: expect.any(String),
    endCashDeclared: BigInt(Math.round(cash * 100)),
    endWalletDeclared: BigInt(Math.round(wallet * 100)),
  })
  expect(await h.deps.decisions.listByShift(id)).toEqual(
    expect.arrayContaining([expect.objectContaining({ decision: 'force_close_prepared', notes: reason })]),
  )
  expect(await h.deps.ledger.listByShift(id)).toEqual(beforeLedger)
  expect(await h.deps.settlements.findByShift(id)).toBeNull()

  const replayPayload = await forceClosePayload(manager, id, reason, cash, wallet, extra)
  expect(replayPayload.reviewedSettlementHash).toMatch(/^[0-9a-f]{64}$/)
  const response = await post(manager, `/shifts/${id}/force-close`, replayPayload)
  return { response, replayPayload }
}

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

    const reason = 'الدراجة تعطلت والسائق غادر'
    const res = await post(manager, `/shifts/${id}/void`, { reason })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().state).toBe('cancelled')

    // Money nets to zero: driver funds emptied, office funds restored, and the orders are gone.
    expect(await bal(driverCash)).toBe(0n)
    expect(await bal(driverWallet)).toBe(0n)
    expect(await bal(fundCodeOf({ kind: 'office_cash' }))).toBe(0n)
    expect(await bal(fundCodeOf({ kind: 'office_wallet' }))).toBe(0n)
    expect(await h.deps.orders.listByShift(id)).toHaveLength(0)
    expect(await h.deps.decisions.listByShift(id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ gate: 'close', decision: 'force_cancelled', notes: reason }),
    ]))
    assertLedgerBalances()

    const entriesAfterFirst = (await h.deps.ledger.listByShift(id)).length
    const exactRetry = await post(manager, `/shifts/${id}/void`, { reason })
    expect(exactRetry.statusCode, exactRetry.body).toBe(200)
    expect(exactRetry.json()).toMatchObject({ state: 'cancelled', replayed: true })
    expect(await h.deps.ledger.listByShift(id)).toHaveLength(entriesAfterFirst)
    expect((await h.deps.decisions.listByShift(id)).filter(
      (decision) => decision.decision === 'force_cancelled',
    )).toHaveLength(1)

    const changedRetry = await post(manager, `/shifts/${id}/void`, { reason: 'different reason' })
    expect(changedRetry.statusCode, changedRetry.body).toBe(409)
    expect(changedRetry.json().error).toBe('void_already_completed')
  })

  it('recovers from a lost post-commit audit response using the transactional void decision', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    const reason = 'manager verified the abandoned shift'
    const originalAppend = h.deps.audit.append.bind(h.deps.audit)
    let failOnce = true
    h.deps.audit.append = async (record) => {
      if (failOnce) {
        failOnce = false
        throw new Error('simulated lost response after commit')
      }
      await originalAppend(record)
    }

    const lostResponse = await post(manager, `/shifts/${id}/void`, { reason })
    expect(lostResponse.statusCode, lostResponse.body).toBe(500)
    expect((await h.deps.shifts.findById(id))?.state).toBe('cancelled')
    expect(await h.deps.decisions.listByShift(id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'force_cancelled', notes: reason }),
    ]))

    const retry = await post(manager, `/shifts/${id}/void`, { reason })
    expect(retry.statusCode, retry.body).toBe(200)
    expect(retry.json()).toMatchObject({ state: 'cancelled', replayed: true })
  })

  it.each(['   \t', '\u200B\u2060'])(
    'rejects a blank-looking void reason at the request boundary: %j',
    async (reason) => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    const response = await post(manager, `/shifts/${id}/void`, { reason })
    expect(response.statusCode, response.body).toBe(400)
    expect((await h.deps.shifts.findById(id))?.state).toBe('open')
    },
  )

  it('FORCE-CLOSE with the correct figures settles like a normal close — no variance', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    await addOrders(driver, id, 'cash', 12)
    await addOrders(driver, id, 'electronic', 6)
    await addOrders(driver, id, 'free', 2)

    // The §2.3 expected close: 160,000 cash / 70,000 wallet.
    const { response: res, replayPayload } = await forceCloseThroughBoundary(
      manager,
      id,
      'lost his phone',
      160_000,
      70_000,
    )
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().state).toBe('approved')

    expect(await bal(driverCash)).toBe(0n)
    expect(await bal(driverWallet)).toBe(0n)
    expect(await bal(sharePayable)).toBe(0n)
    expect(await bal(variance)).toBe(0n) // declared == expected
    expect(await bal('yalago_share')).toBe(2_000_000n) // 20% of 100,000 fees
    assertLedgerBalances()

    const exactRetry = await post(manager, `/shifts/${id}/force-close`, replayPayload)
    expect(exactRetry.statusCode, exactRetry.body).toBe(200)
    expect(exactRetry.json()).toMatchObject({ state: 'approved', postings: 0 })
  })

  it('prepares the force-close boundary without confirmations, then requires the exact confirmed settlement', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    const reason = 'manager counted the stuck shift in person'
    const preparedFigures = {
      odometerKm: 110,
      cashDeclared: sypStr(100_000),
      walletDeclared: sypStr(50_000),
    }

    // Phase one freezes the boundary and actual figures only. Confirming physical handovers against
    // a pre-boundary preview would be unsafe, so this request deliberately carries no hash/ticks.
    const prepared = await post(manager, `/shifts/${id}/force-close`, {
      prepareOnly: true,
      reason,
      ...preparedFigures,
    })
    expect(prepared.statusCode, prepared.body).toBe(200)
    expect(prepared.json()).toMatchObject({ state: 'pending_review', postings: 0, prepared: true })
    expect(await h.deps.shifts.findById(id)).toMatchObject({
      state: 'pending_review',
      submittedAt: expect.any(String),
      endCashDeclared: 10_000_000n,
      endWalletDeclared: 5_000_000n,
      odoEnd: 110,
    })
    expect(await h.deps.decisions.listByShift(id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ decision: 'force_close_prepared', notes: reason })]),
    )
    expect(await h.deps.settlements.findByShift(id)).toBeNull()

    const revisedAfterPreparation = await post(manager, `/shifts/${id}/close-figures`, {
      cashDeclared: sypStr(100_001),
    })
    expect(revisedAfterPreparation.statusCode, revisedAfterPreparation.body).toBe(409)
    expect(revisedAfterPreparation.json().error).toBe('force_close_figures_locked')
    expect(await h.deps.shifts.findById(id)).toMatchObject({
      endCashDeclared: 10_000_000n,
      endWalletDeclared: 5_000_000n,
      odoEnd: 110,
    })

    const settlement = await get(manager, `/shifts/${id}/settlement`)
    expect(settlement.statusCode, settlement.body).toBe(200)
    const review = await get(manager, `/shifts/${id}/review`)
    expect(review.statusCode, review.body).toBe(200)
    const ordinaryClose = await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: review.json().br1.ordersHash,
      reviewedSettlementHash: settlement.json().settlementHash,
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      varianceReason: reason,
    })
    expect(ordinaryClose.statusCode, ordinaryClose.body).toBe(409)
    expect(ordinaryClose.json().error).toBe('force_close_commit_required')

    const final = {
      prepareOnly: false,
      reason,
      ...preparedFigures,
      reviewedSettlementHash: settlement.json().settlementHash,
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
    }
    for (const changed of [
      { ...final, cashDeclared: sypStr(100_001) },
      { ...final, odometerKm: 111 },
    ]) {
      const refused = await post(manager, `/shifts/${id}/force-close`, changed)
      expect(refused.statusCode, refused.body).toBe(409)
      expect(refused.json()).toMatchObject({
        error: 'settlement_changed_since_review',
        detail: { preparedFiguresChanged: true },
      })
    }
    for (const missing of [
      'reason',
      'reviewedSettlementHash',
      'walletTransferConfirmed',
      'cashSettlementConfirmed',
    ] as const) {
      const invalid = { ...final } as Record<string, unknown>
      delete invalid[missing]
      const refused = await post(manager, `/shifts/${id}/force-close`, invalid)
      expect(refused.statusCode, `${missing}: ${refused.body}`).toBe(400)
      expect((await h.deps.shifts.findById(id))?.state).toBe('pending_review')
      expect(await h.deps.settlements.findByShift(id)).toBeNull()
    }

    const approved = await post(manager, `/shifts/${id}/force-close`, final)
    expect(approved.statusCode, approved.body).toBe(200)
    expect(approved.json()).toMatchObject({ state: 'approved', prepared: false })

    const exactRetry = await post(manager, `/shifts/${id}/force-close`, final)
    expect(exactRetry.statusCode, exactRetry.body).toBe(200)
    expect(exactRetry.json()).toMatchObject({ state: 'approved', postings: 0, prepared: false })

    for (const changed of [
      { ...final, cashDeclared: sypStr(100_001) },
      { ...final, odometerKm: 111 },
    ]) {
      const refused = await post(manager, `/shifts/${id}/force-close`, changed)
      expect(refused.statusCode, refused.body).toBe(409)
      expect(refused.json()).toMatchObject({
        error: 'settlement_changed_since_review',
        detail: { replayFiguresChanged: true },
      })
    }
  })

  it('returns a client validation error for negative actual cash on every close entry point', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    const preview = await get(manager, `/shifts/${id}/settlement?actualCash=-1.00&actualWallet=0.00`)
    expect(preview.statusCode, preview.body).toBe(400)

    const force = await post(manager, `/shifts/${id}/force-close`, {
      prepareOnly: true,
      reason: 'invalid negative count',
      cashDeclared: '-1.00',
      walletDeclared: '0.00',
    })
    expect(force.statusCode, force.body).toBe(400)

    const endPackage = await put(driver, `/shifts/${id}/end-package`, {
      odometerKm: 110,
      batteryPercent: null,
      cashDeclared: '-1.00',
      walletDeclared: '0.00',
    })
    expect(endPackage.statusCode, endPackage.body).toBe(400)
    expect((await h.deps.shifts.findById(id))?.state).toBe('open')
  })

  /**
   * «اي نقص يرمم من حصة السائق» — owner decision (k), 2026-08-12.
   *
   * This used to book the whole gap to `shift_variance:<branch>`, an account that records THAT
   * money was missing and nothing about WHOSE shift it was. The owner settles it against the man:
   * his fixed share absorbs it first. Ordinary and exceptional close now use the same function.
   */
  it('FORCE-CLOSE with a cash shortfall takes it from the driver`s share, not a nameless account', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    await addOrders(driver, id, 'cash', 12)
    await addOrders(driver, id, 'electronic', 6)
    await addOrders(driver, id, 'free', 2)

    // The driver handed over 150,000, not the expected 160,000 — a 10,000 shortfall.
    const { response: res } = await forceCloseThroughBoundary(
      manager,
      id,
      'cash short, driver owes it',
      150_000,
      70_000,
    )
    expect(res.statusCode, res.body).toBe(200)

    expect(await bal(driverCash)).toBe(0n)
    expect(await bal(sharePayable)).toBe(0n)
    expect(await bal(variance)).toBe(0n)
    expect(await h.deps.settlements.findByShift(id)).toMatchObject({
      variance: -1_000_000n,
      finalEmployeeCash: 3_000_000n,
      cashToOffice: 12_000_000n,
    })
    assertLedgerBalances()
  })

  it('collects a shortage beyond his whole share immediately and creates no receivable', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    await addOrders(driver, id, 'cash', 12)
    await addOrders(driver, id, 'electronic', 6)
    await addOrders(driver, id, 'free', 2)

    // 100,000 handed over against 160,000 expected — a 60,000 gap, well past his 40,000 share.
    const { response: res } = await forceCloseThroughBoundary(
      manager,
      id,
      'large shortfall',
      100_000,
      70_000,
    )
    expect(res.statusCode, res.body).toBe(200)

    expect(await bal(sharePayable)).toBe(0n)
    expect(await bal(receivable)).toBe(0n)
    expect(await bal(variance)).toBe(0n)
    expect(await h.deps.settlements.findByShift(id)).toMatchObject({
      variance: -6_000_000n,
      finalEmployeeCash: -2_000_000n,
      cashToOffice: 12_000_000n,
    })
    assertLedgerBalances()
  })

  it('requires and persists an explicit manager confirmation for a lower force-close odometer', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)

    const refused = await post(
      manager,
      `/shifts/${id}/force-close`,
      await forceClosePayload(manager, id, 'replacement odometer', 100_000, 50_000, { odometerKm: 90 }),
    )
    expect(refused.statusCode, refused.body).toBe(422)
    expect(refused.json().error).toBe('odometer_anomaly_confirmation_required')
    expect((await h.deps.shifts.findById(id))?.state).toBe('open')

    const { response: accepted } = await forceCloseThroughBoundary(
      manager,
      id,
      'replacement odometer verified in person',
      100_000,
      50_000,
      {
        odometerKm: 90,
        odometerAnomalyConfirmed: true,
      },
    )
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(await h.deps.shifts.findById(id)).toMatchObject({
      state: 'approved',
      odoEnd: 90,
      odoEndAnomalyConfirmedBy: 'u-bm',
    })
    expect((await h.deps.shifts.findById(id))?.odoEndAnomalyConfirmedAt).toBeTruthy()
  })

  it('a driver may not void or force-close (shift.approve only)', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await openShift(driver, manager)
    expect((await post(driver, `/shifts/${id}/void`, { reason: 'x' })).statusCode).toBe(403)
    expect((await post(driver, `/shifts/${id}/force-close`, { reason: 'x' })).statusCode).toBe(403)
  })
})
