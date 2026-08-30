import type { LightMyRequestResponse } from 'fastify'
import { addDays, weekStartFor } from '@ash/domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
 * Two deliberately disjoint debts:
 *
 * - `ordinary` stays outstanding until an explicit collection command.
 * - `shift_funding` is cash/wallet already advanced for the next shift and is consumed
 *   automatically, in full, when that shift opens.
 *
 * Both remain office capital while outstanding, and every direct command is immutable/idempotent.
 */
let h: Harness
let commandSeq = 0
let orderSeq = 0

beforeEach(async () => {
  h = await makeHarness()
  commandSeq = 0
  orderSeq = 0
})

afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })
const post = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const put = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  url.endsWith('/end-package')
    ? await h.submitEndPackage(token, url.split('/')[2]!, payload)
    : await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })

const nextKey = (): string => {
  commandSeq += 1
  return `00000000-0000-4000-8000-${String(commandSeq).padStart(12, '0')}`
}

async function seedOffice(manager: string, cash = 500_000, wallet = 500_000): Promise<void> {
  const response = await post(manager, '/journal/manual', {
    reason: 'receivable test office capital',
    lines: [
      { fundCode: 'office_cash', side: 'D', amount: sypStr(cash) },
      { fundCode: 'office_wallet', side: 'D', amount: sypStr(wallet) },
      { fundCode: 'opening_balance', side: 'C', amount: sypStr(cash + wallet) },
    ],
  })
  expect(response.statusCode, response.body).toBe(201)
}

function receivableBody(over: Partial<Payload> = {}): Payload {
  return {
    driverId: DRIVER_ID,
    receivableKind: 'ordinary',
    channel: 'cash',
    direction: 'create',
    amount: sypStr(10_000),
    reason: 'direct driver receivable',
    idempotencyKey: nextKey(),
    ...over,
  }
}

async function createReceivable(manager: string, over: Partial<Payload> = {}): Promise<LightMyRequestResponse> {
  const response = await post(manager, '/receivables/events', receivableBody(over))
  expect(response.statusCode, response.body).toBe(201)
  return response
}

async function deactivateDriver(): Promise<void> {
  const driver = await h.deps.directory.driver(DRIVER_ID)
  if (!driver) throw new Error('missing driver fixture')
  await h.deps.directory.updateDriver({ ...driver, active: false })
}

function latch(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const fundingTranches = (amount: string): string[] => amount === sypStr(0) ? [] : [amount]

async function awaitingEmptyShift(driver: string): Promise<string> {
  const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  const started = await put(driver, `/shifts/${id}/start-package`, {
    odometerKm: 1_000,
    batteryPercent: 90,
  })
  expect(started.statusCode, started.body).toBe(200)
  return id
}

async function openEmptyShift(driver: string, manager: string): Promise<string> {
  const id = await awaitingEmptyShift(driver)
  const review = await get(manager, `/shifts/${id}/review`)
  expect(review.statusCode, review.body).toBe(200)
  const opened = await post(manager, `/shifts/${id}/approve-open`, {
    floatTranches: [],
    topupTranches: [],
    carriedTranches: fundingTranches(review.json().shiftFunding.cash as string),
    carriedWalletTranches: fundingTranches(review.json().shiftFunding.wallet as string),
  })
  expect(opened.statusCode, opened.body).toBe(200)
  return id
}

async function submitBalancedShift(
  driver: string,
  manager: string,
  id: string,
  cashDeclared: number,
  walletDeclared: number,
): Promise<string> {
  orderSeq += 1
  h.stageCloseDraftFinancialFixture(id, {
    managerToken: manager,
    orders: [{
      clientKey: `receivable-order-${orderSeq}`,
      providerOrderNo: `R-${orderSeq}`,
      payMode: 'cash',
      fee: sypStr(5_000),
      occurredDate: today,
      occurredMinute: '08:00',
    }],
  })
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  const ended = await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 1_040,
    batteryPercent: null,
    cashDeclared: sypStr(cashDeclared),
    walletDeclared: sypStr(walletDeclared),
  })
  expect(ended.statusCode, ended.body).toBe(200)
  expect(ended.json().br1.difference).toBe(sypStr(0))
  const review = await get(manager, `/shifts/${id}/review`)
  expect(review.statusCode, review.body).toBe(200)
  return review.json().br1.ordersHash as string
}

describe('ordinary and shift-funding receivable commands', () => {
  it('reports both kinds by cash/wallet while preserving aggregate compatibility fields', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager, { receivableKind: 'ordinary', channel: 'cash', amount: sypStr(40_000) })
    await createReceivable(manager, { receivableKind: 'ordinary', channel: 'wallet', amount: sypStr(3_000) })
    await createReceivable(manager, { receivableKind: 'shift_funding', channel: 'cash', amount: sypStr(10_000) })
    await createReceivable(manager, { receivableKind: 'shift_funding', channel: 'wallet', amount: sypStr(2_000) })

    const response = await get(manager, `/receivables?branchId=${BRANCH}`)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      total: sypStr(50_000),
      cashTotal: sypStr(50_000),
      walletTotal: sypStr(5_000),
      grandTotal: sypStr(55_000),
      ordinaryCashTotal: sypStr(40_000),
      ordinaryWalletTotal: sypStr(3_000),
      shiftFundingCashTotal: sypStr(10_000),
      shiftFundingWalletTotal: sypStr(2_000),
      drivers: [{
        driverId: DRIVER_ID,
        ordinaryCash: sypStr(40_000),
        ordinaryWallet: sypStr(3_000),
        shiftFundingCash: sypStr(10_000),
        shiftFundingWallet: sypStr(2_000),
        cash: sypStr(50_000),
        wallet: sypStr(5_000),
        total: sypStr(55_000),
      }],
    })

    const history = await get(manager, `/receivables/events?driverId=${DRIVER_ID}`)
    expect(history.statusCode, history.body).toBe(200)
    expect(history.json().events).toHaveLength(4)
    expect(history.json().events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        driverId: DRIVER_ID,
        receivableKind: 'shift_funding',
        channel: 'wallet',
        direction: 'create',
        amount: sypStr(2_000),
      }),
    ]))
  })

  it('auto-consumes only shift funding at open, including wallet funding, and closes cleanly', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager, { receivableKind: 'ordinary', channel: 'cash', amount: sypStr(40_000) })
    await createReceivable(manager, { receivableKind: 'shift_funding', channel: 'cash', amount: sypStr(10_000) })
    await createReceivable(manager, { receivableKind: 'shift_funding', channel: 'wallet', amount: sypStr(3_000) })

    const id = await openEmptyShift(driver, manager)
    const shift = await h.deps.shifts.findById(id)
    expect(shift?.carriedTranches).toEqual([1_000_000n])
    expect(shift?.carriedWalletTranches).toEqual([300_000n])
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_cash:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_wallet:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(4_000_000n)

    // One cash order adds 5,000 cash and takes the 1,000 provider cut from the wallet.
    const ordersHash = await submitBalancedShift(driver, manager, id, 15_000, 2_000)
    const approved = await approveFixedClose(h, manager, id, ordersHash)
    expect(approved.statusCode, approved.body).toBe(200)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(4_000_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_cash:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_wallet:${DRIVER_ID}`)).toBe(0n)
  })

  /**
   * THE regression test for the deferred-collection defect, and the one whose absence let it ship.
   *
   * A deferral leaves money physically with the driver — banknotes in his pocket, balance in his
   * Yallago app. Booked to the ORDINARY receivable it was invisible to the next open, so BR1 at the
   * next close counted money he already owed as a SURPLUS and decision 13 paid it to him. Here that
   * is worth exactly 4,000: expected 5,000 against 8,000 actually held.
   *
   * Everything below is arithmetic, not a golden file. Shift 1 defers 3,000 cash + 1,000 wallet.
   * Shift 2 opens on that money alone and takes one 5,000 cash delivery, so it expects
   * 3,000 + 5,000 = 8,000 cash and 1,000 − 1,000 = 0 wallet. `submitBalancedShift` asserts BR1's
   * difference is zero, which is the whole point: the carried money must be EXPECTED, not a windfall.
   */
  it('carries a deferred collection into the next shift instead of paying it back as a surplus', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await seedOffice(manager)

    const first = await awaitingEmptyShift(driver)
    expect((await post(manager, `/shifts/${first}/approve-open`, {
      floatTranches: [sypStr(10_000)],
      topupTranches: [sypStr(5_000)],
    })).statusCode).toBe(200)
    const firstHash = await submitBalancedShift(driver, manager, first, 15_000, 4_000)

    // Claims are cash 13,000 (15,000 held less the 2,000 fixed share) and wallet 4,000.
    const deferredPreview = await get(
      manager,
      `/shifts/${first}/settlement?cashReceivableDeferred=${sypStr(3_000)}`
        + `&walletReceivableDeferred=${sypStr(1_000)}`,
    )
    expect(deferredPreview.statusCode, deferredPreview.body).toBe(200)
    const deferred = deferredPreview.json() as {
      settlementHash: string
      cashReceivableDeferred: string
      walletReceivableDeferred: string
    }
    const closed = await post(manager, `/shifts/${first}/approve-close`, {
      reviewedOrdersHash: firstHash,
      reviewedSettlementHash: deferred.settlementHash,
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      cashReceivableDeferred: deferred.cashReceivableDeferred,
      walletReceivableDeferred: deferred.walletReceivableDeferred,
    })
    expect(closed.statusCode, closed.body).toBe(200)

    // The deferral is SHIFT FUNDING, so the next open can see it. The ordinary debt funds — which
    // are cleared only by an explicit collection command — must stay untouched by a close.
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_cash:${DRIVER_ID}`)).toBe(300_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_wallet:${DRIVER_ID}`)).toBe(100_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_wallet:${DRIVER_ID}`)).toBe(0n)

    const second = await openEmptyShift(driver, manager)
    const carried = await h.deps.shifts.findById(second)
    expect(carried?.carriedTranches).toEqual([300_000n])
    expect(carried?.carriedWalletTranches).toEqual([100_000n])
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_cash:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_wallet:${DRIVER_ID}`)).toBe(0n)

    // Zero difference is the assertion. On the old routing this read as a 4,000 surplus.
    const secondHash = await submitBalancedShift(driver, manager, second, 8_000, 0)
    const settled = await approveFixedClose(h, manager, second, secondHash)
    expect(settled.statusCode, settled.body).toBe(200)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_cash:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_wallet:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_share_payable:${DRIVER_ID}`)).toBe(0n)
  })

  it('rejects a stale funding preview after a concurrent direct event without opening or posting', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager, { receivableKind: 'ordinary', channel: 'cash', amount: sypStr(40_000) })
    const id = await awaitingEmptyShift(driver)

    const reviewed = await get(manager, `/shifts/${id}/review`)
    expect(reviewed.statusCode, reviewed.body).toBe(200)
    // This is the dangerous case: the old service treated reviewed zero as a wildcard.
    expect(reviewed.json().shiftFunding).toEqual({ cash: sypStr(0), wallet: sypStr(0) })
    const staleFunding = reviewed.json().shiftFunding as { cash: string; wallet: string }
    const beforeShift = await h.deps.shifts.findById(id)
    const beforeShiftJournal = await h.deps.ledger.listByShift(id)
    const beforeDecisions = await h.deps.decisions.listByShift(id)
    const beforeFx = await h.deps.fx.list()

    // Hold a direct funding command after its rows are staged but before its financial UOW commits.
    // Approve-open queues on the same gate (the same branch advisory key in PostgreSQL), then must
    // observe the committed balance rather than the stale review amount.
    const fundingEventEntered = latch()
    const releaseFundingEvent = latch()
    const originalCreate = h.deps.receivableEvents.create
    h.deps.receivableEvents.create = async (event) => {
      const created = await originalCreate.call(h.deps.receivableEvents, event)
      fundingEventEntered.release()
      await releaseFundingEvent.promise
      return created
    }

    let fundingChanged: LightMyRequestResponse
    let refused: LightMyRequestResponse
    try {
      const fundingPromise = createReceivable(manager, {
        receivableKind: 'shift_funding',
        channel: 'cash',
        amount: sypStr(2_000),
        reason: 'funding added while manager review was open',
      })
      await fundingEventEntered.promise
      const approvalPromise = post(manager, `/shifts/${id}/approve-open`, {
        floatTranches: [],
        topupTranches: [],
        carriedTranches: fundingTranches(staleFunding.cash),
        carriedWalletTranches: fundingTranches(staleFunding.wallet),
      })
      releaseFundingEvent.release()
      ;[fundingChanged, refused] = await Promise.all([fundingPromise, approvalPromise])
    } finally {
      releaseFundingEvent.release()
      h.deps.receivableEvents.create = originalCreate
    }

    expect(fundingChanged.statusCode, fundingChanged.body).toBe(201)
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json()).toMatchObject({
      error: 'shift_funding_changed',
      detail: { cash: sypStr(2_000), wallet: sypStr(0) },
    })
    expect(await h.deps.shifts.findById(id)).toEqual(beforeShift)
    expect(await h.deps.ledger.listByShift(id)).toEqual(beforeShiftJournal)
    expect(await h.deps.decisions.listByShift(id)).toEqual(beforeDecisions)
    expect(await h.deps.fx.list()).toEqual(beforeFx)

    const refreshed = await get(manager, `/shifts/${id}/review`)
    expect(refreshed.statusCode, refreshed.body).toBe(200)
    expect(refreshed.json().shiftFunding).toEqual({ cash: sypStr(2_000), wallet: sypStr(0) })
    const freshFunding = refreshed.json().shiftFunding as { cash: string; wallet: string }
    const opened = await post(manager, `/shifts/${id}/approve-open`, {
      floatTranches: [],
      topupTranches: [],
      carriedTranches: fundingTranches(freshFunding.cash),
      carriedWalletTranches: fundingTranches(freshFunding.wallet),
    })
    expect(opened.statusCode, opened.body).toBe(200)
    expect((await h.deps.shifts.findById(id))?.carriedTranches).toEqual([200_000n])
    expect((await h.deps.shifts.findById(id))?.carriedWalletTranches).toEqual([])
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_cash:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_wallet:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(4_000_000n)
  })

  it('restores both shift-funding balances when the consuming shift is voided', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager, { receivableKind: 'shift_funding', channel: 'cash', amount: sypStr(10_000) })
    await createReceivable(manager, { receivableKind: 'shift_funding', channel: 'wallet', amount: sypStr(3_000) })
    const officeCashAfterAdvance = await h.deps.ledger.fundBalance(BRANCH, 'office_cash')
    const officeWalletAfterAdvance = await h.deps.ledger.fundBalance(BRANCH, 'office_wallet')

    const id = await openEmptyShift(driver, manager)
    const voided = await post(manager, `/shifts/${id}/void`, { reason: 'cancelled before work' })
    expect(voided.statusCode, voided.body).toBe(200)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_cash:${DRIVER_ID}`)).toBe(1_000_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_wallet:${DRIVER_ID}`)).toBe(300_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(officeCashAfterAdvance)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_wallet')).toBe(officeWalletAfterAdvance)
  })

  it('supports immutable partial and full collection of an ordinary receivable', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager, { amount: sypStr(40_000) })
    const collectedPart = await createReceivable(manager, {
      direction: 'collect',
      amount: sypStr(15_000),
      reason: 'partial collection',
    })
    expect(collectedPart.json().direction).toBe('collect')
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(2_500_000n)

    await createReceivable(manager, {
      direction: 'collect',
      amount: sypStr(25_000),
      reason: 'final collection',
    })
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(0n)
    expect((await get(manager, '/receivables')).json().drivers).toEqual([])
    expect((await get(manager, `/receivables/events?driverId=${DRIVER_ID}`)).json().events).toHaveLength(3)
  })

  it('collects both kinds from an inactive branch debtor but blocks every new advance', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager, {
      receivableKind: 'ordinary',
      channel: 'cash',
      amount: sypStr(40_000),
    })
    await createReceivable(manager, {
      receivableKind: 'shift_funding',
      channel: 'wallet',
      amount: sypStr(20_000),
    })
    await deactivateDriver()

    await createReceivable(manager, {
      receivableKind: 'ordinary',
      channel: 'cash',
      direction: 'collect',
      amount: sypStr(15_000),
      reason: 'inactive driver partial collection',
    })
    await createReceivable(manager, {
      receivableKind: 'shift_funding',
      channel: 'wallet',
      direction: 'collect',
      amount: sypStr(20_000),
      reason: 'inactive driver funding returned',
    })
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(2_500_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_wallet:${DRIVER_ID}`)).toBe(0n)

    for (const receivableKind of ['ordinary', 'shift_funding'] as const) {
      const refused = await post(manager, '/receivables/events', receivableBody({
        receivableKind,
        direction: 'create',
        amount: sypStr(1_000),
      }))
      expect(refused.statusCode, refused.body).toBe(404)
      expect(refused.json().error).toBe('driver_not_found')
    }
  })

  it('replays a committed receipt before inactive-driver, closed-week, and FX rules', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    const idempotencyKey = nextKey()
    const body = receivableBody({ idempotencyKey, amount: sypStr(10_000) })
    const created = await post(manager, '/receivables/events', body)
    expect(created.statusCode, created.body).toBe(201)
    await deactivateDriver()

    const weekStartDate = weekStartFor(today)
    const lock = await h.deps.weekLocks.create({
      branchId: BRANCH,
      weekStartDate,
      weekEndDate: addDays(weekStartDate, 6),
      closedAtMs: null,
      closedBy: null,
    })
    await h.deps.weekLocks.seal(lock.id, 'u-sa', Date.now())
    const weekRule = vi.spyOn(h.deps.weekLocks, 'listClosedStarts')
    const fxRule = vi.spyOn(h.deps.fx, 'idFor')

    const replay = await post(manager, '/receivables/events', body)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({
      id: created.json().id,
      journalEntryId: created.json().journalEntryId,
      replayed: true,
    })

    const conflict = await post(manager, '/receivables/events', { ...body, amount: sypStr(11_000) })
    expect(conflict.statusCode, conflict.body).toBe(409)
    expect(conflict.json().error).toBe('idempotency_key_conflict')
    expect(weekRule).not.toHaveBeenCalled()
    expect(fxRule).not.toHaveBeenCalled()
    expect((await h.deps.receivableEvents.listByBranchAndDriver(BRANCH, DRIVER_ID))).toHaveLength(1)
  })

  it('serializes concurrent exact retries and rejects a changed payload with the same key', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    const idempotencyKey = nextKey()
    const body = receivableBody({ idempotencyKey, amount: sypStr(10_000) })
    const [first, retry] = await Promise.all([
      post(manager, '/receivables/events', body),
      post(manager, '/receivables/events', body),
    ])
    expect([first.statusCode, retry.statusCode].sort()).toEqual([200, 201])
    expect([first.json().replayed, retry.json().replayed].sort()).toEqual([false, true])
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(1_000_000n)
    expect((await h.deps.receivableEvents.listByBranchAndDriver(BRANCH, DRIVER_ID))).toHaveLength(1)

    const conflict = await post(manager, '/receivables/events', { ...body, amount: sypStr(11_000) })
    expect(conflict.statusCode, conflict.body).toBe(409)
    expect(conflict.json().error).toBe('idempotency_key_conflict')
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(1_000_000n)
  })

  it('rejects zero/negative commands and collection above the selected kind/channel balance', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    for (const amount of ['0', '0.00', '-1.00']) {
      const invalid = await post(manager, '/receivables/events', receivableBody({ amount }))
      expect(invalid.statusCode, invalid.body).toBe(400)
    }

    await createReceivable(manager, { amount: sypStr(10_000) })
    const tooMuch = await post(manager, '/receivables/events', receivableBody({
      direction: 'collect',
      amount: sypStr(10_001),
    }))
    expect(tooMuch.statusCode, tooMuch.body).toBe(422)
    expect(tooMuch.json().error).toBe('receivable_overcollection')
  })
})

/**
 * «تعديل الذمم المسجلة» (owner request, 2026-08-29) — restating a receivable balance that was
 * recorded wrongly.
 *
 * THE FINDING THAT DECIDED THE SHAPE. A driver's receivable balance is a LEDGER FUND BALANCE fed
 * from seven places, and only ONE of them writes a `receivable_events` row. So a correction that
 * points at an event cannot touch the commonest wrong number of all — a `shift_funding` carry,
 * which has no event to point at. The correction therefore names the BALANCE, and the last test
 * here is the proof: it corrects a carry created entirely by a shift close, with no command row in
 * existence.
 */
describe('correcting a recorded receivable', () => {
  const correction = (over: Partial<Payload> = {}): Payload => ({
    driverId: DRIVER_ID,
    receivableKind: 'ordinary',
    channel: 'cash',
    expectedCurrentBalance: sypStr(10_000),
    targetBalance: sypStr(4_000),
    reason: 'أُدخلت ١٠٬٠٠٠ والصحيح ٤٬٠٠٠',
    idempotencyKey: nextKey(),
    ...over,
  })

  const balance = async (manager: string): Promise<string> => {
    const res = await get(manager, '/treasury/receivables')
    expect(res.statusCode, res.body).toBe(200)
    const row = res.json().drivers.find((d: { driverId: string }) => d.driverId === DRIVER_ID)
    return row.cash as string
  }

  it('lowers a balance that was entered too high, and moves the value back to the office', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager)
    expect(await balance(manager)).toBe(sypStr(10_000))

    const res = await post(manager, '/receivables/adjustments', correction())
    expect(res.statusCode, res.body).toBe(201)
    // The posting is a `collect` of the difference — the ledger has one way to move a receivable,
    // and this reuses it rather than inventing a second.
    expect(res.json()).toMatchObject({
      direction: 'collect',
      amount: sypStr(6_000),
      intent: 'correction',
      priorBalance: sypStr(10_000),
      targetBalance: sypStr(4_000),
    })
    expect(await balance(manager)).toBe(sypStr(4_000))
  })

  it('raises a balance that was entered too low', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager)

    const res = await post(
      manager,
      '/receivables/adjustments',
      correction({ targetBalance: sypStr(17_500) }),
    )
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ direction: 'create', amount: sypStr(7_500), intent: 'correction' })
    expect(await balance(manager)).toBe(sypStr(17_500))
  })

  it('records it as a correction, so the history never claims money came back', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager)
    await post(manager, '/receivables/adjustments', correction())

    const events = (await get(manager, '/treasury/receivables/events')).json().events
    const restatement = events.find((e: { intent: string }) => e.intent === 'correction')
    // Same posting shape as a collection — and that is exactly why the label has to exist. Without
    // it the driver's history reads «تحصيل ٦٬٠٠٠», money returned, for an event where none did.
    expect(restatement).toMatchObject({
      direction: 'collect',
      intent: 'correction',
      priorBalance: sypStr(10_000),
      targetBalance: sypStr(4_000),
    })
    expect(events.filter((e: { intent: string }) => e.intent === 'command')).toHaveLength(1)
  })

  it('refuses when the balance moved under the operator between reading and pressing', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager)
    // Something else happens — a collection lands.
    await post(manager, '/receivables/events', receivableBody({ direction: 'collect', amount: sypStr(3_000) }))

    // He is still looking at 10,000. Applying "set it to 4,000" now would silently erase the
    // collection, and a correction that erases a real event is worse than the number it fixes.
    const res = await post(manager, '/receivables/adjustments', correction())
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('receivable_balance_changed')
    expect(res.json().detail).toMatchObject({ expected: sypStr(10_000), actual: sypStr(7_000) })
    expect(await balance(manager)).toBe(sypStr(7_000))
  })

  it('refuses a correction that changes nothing', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager)
    const res = await post(manager, '/receivables/adjustments', correction({ targetBalance: sypStr(10_000) }))
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('receivable_already_at_target')
  })

  it('replays a lost response instead of restating the balance twice', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager)
    const body = correction()

    const first = await post(manager, '/receivables/adjustments', body)
    expect(first.statusCode, first.body).toBe(201)
    const again = await post(manager, '/receivables/adjustments', body)
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ id: first.json().id, replayed: true })
    // The whole risk of a retried correction: 10,000 → 4,000 applied twice would land on -2,000.
    expect(await balance(manager)).toBe(sypStr(4_000))
  })

  it('refuses a reused key that means something else', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager)
    const key = nextKey()
    expect((await post(manager, '/receivables/adjustments', correction({ idempotencyKey: key }))).statusCode).toBe(201)
    const changed = await post(
      manager,
      '/receivables/adjustments',
      correction({ idempotencyKey: key, expectedCurrentBalance: sypStr(4_000), targetBalance: sypStr(1_000) }),
    )
    expect(changed.statusCode).toBe(409)
    expect(changed.json().error).toBe('idempotency_key_conflict')
  })

  it('will not raise a receivable the office box cannot fund', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager, 12_000, 12_000)
    await createReceivable(manager)
    const res = await post(manager, '/receivables/adjustments', correction({ targetBalance: sypStr(500_000) }))
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('insufficient_funds')
  })

  it('names the inactive driver rather than failing on a database guard', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager)
    await deactivateDriver()

    // Lowering is fine — an inactive driver's debt stays collectible.
    expect((await post(manager, '/receivables/adjustments', correction())).statusCode).toBe(201)

    // Raising is refused, matching 0037's `create` guard, with a name the operator can act on.
    const raise = await post(
      manager,
      '/receivables/adjustments',
      correction({ expectedCurrentBalance: sypStr(4_000), targetBalance: sypStr(9_000) }),
    )
    expect(raise.statusCode).toBe(422)
    expect(raise.json().error).toBe('receivable_correction_needs_active_driver')
  })

  /**
   * THE TEST THAT DECIDED THE DESIGN.
   *
   * This `shift_funding` carry is created entirely by a shift close. There is no `receivable_events`
   * row for it and there never will be — the close posts the fund line directly. An "edit this
   * event" correction would have nothing to edit, which is why the correction names the BALANCE.
   *
   * The number is the same one the deferral test above produces: 3,000 cash carried, held in the
   * driver's own pocket. Say the manager meant 2,000.
   */
  it('corrects a shift-funding carry, which has no event row to point at', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    await seedOffice(manager)

    const first = await awaitingEmptyShift(driver)
    expect((await post(manager, `/shifts/${first}/approve-open`, {
      floatTranches: [sypStr(10_000)],
      topupTranches: [sypStr(5_000)],
    })).statusCode).toBe(200)
    const firstHash = await submitBalancedShift(driver, manager, first, 15_000, 4_000)
    const preview = await get(
      manager,
      `/shifts/${first}/settlement?cashReceivableDeferred=${sypStr(3_000)}&walletReceivableDeferred=${sypStr(0)}`,
    )
    expect(preview.statusCode, preview.body).toBe(200)
    const deferred = preview.json() as {
      settlementHash: string
      cashReceivableDeferred: string
      walletReceivableDeferred: string
    }
    expect((await post(manager, `/shifts/${first}/approve-close`, {
      reviewedOrdersHash: firstHash,
      reviewedSettlementHash: deferred.settlementHash,
      walletTransferConfirmed: true,
      cashSettlementConfirmed: true,
      cashReceivableDeferred: deferred.cashReceivableDeferred,
      walletReceivableDeferred: deferred.walletReceivableDeferred,
    })).statusCode).toBe(200)

    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_cash:${DRIVER_ID}`)).toBe(300_000n)
    // Not one command row exists for that 3,000 — the premise of the whole design.
    const before = (await get(manager, '/treasury/receivables/events')).json().events
    expect(before).toHaveLength(0)

    const res = await post(manager, '/receivables/adjustments', {
      driverId: DRIVER_ID,
      receivableKind: 'shift_funding',
      channel: 'cash',
      expectedCurrentBalance: sypStr(3_000),
      targetBalance: sypStr(2_000),
      reason: 'رُحّل ٣٬٠٠٠ والصحيح ٢٬٠٠٠',
      idempotencyKey: nextKey(),
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({
      receivableKind: 'shift_funding',
      direction: 'collect',
      amount: sypStr(1_000),
      intent: 'correction',
    })
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_shift_funding_cash:${DRIVER_ID}`)).toBe(200_000n)

    // And the corrected carry is what the next shift actually opens on — the correction reaches the
    // number that matters, not a parallel record of it.
    const second = await openEmptyShift(driver, manager)
    expect((await h.deps.shifts.findById(second))?.carriedTranches).toEqual([200_000n])
  })

  it('is journal.manual.write, like every other hand-entered movement of money', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager)
    const driver = await h.loginAs('driver1')
    expect((await post(driver, '/receivables/adjustments', correction())).statusCode).toBe(403)
  })
})

describe('writing off an ordinary receivable without collection', () => {
  const writeoff = (over: Partial<Payload> = {}): Payload => ({
    driverId: DRIVER_ID,
    channel: 'cash',
    amount: sypStr(4_000),
    reason: 'uncollectible balance approved for write-off',
    idempotencyKey: nextKey(),
    ...over,
  })

  it.each(['cash', 'wallet'] as const)(
    'reduces ordinary %s debt into the loss account without moving either office box',
    async (channel) => {
      const manager = await h.loginAs('manager')
      await seedOffice(manager)
      await createReceivable(manager, { channel, amount: sypStr(10_000) })
      await createReceivable(manager, {
        receivableKind: 'shift_funding',
        channel,
        amount: sypStr(2_000),
      })

      const ordinaryCode = `driver_receivable_${channel}:${DRIVER_ID}`
      const fundingCode = `driver_shift_funding_${channel}:${DRIVER_ID}`
      const officeCashBefore = await h.deps.ledger.fundBalance(BRANCH, 'office_cash')
      const officeWalletBefore = await h.deps.ledger.fundBalance(BRANCH, 'office_wallet')

      const response = await post(
        manager,
        '/treasury/receivables/writeoffs',
        writeoff({ channel }),
      )
      expect(response.statusCode, response.body).toBe(201)
      expect(response.json()).toMatchObject({
        driverId: DRIVER_ID,
        receivableKind: 'ordinary',
        channel,
        direction: 'collect',
        amount: sypStr(4_000),
        reason: 'uncollectible balance approved for write-off',
        intent: 'writeoff',
        priorBalance: sypStr(10_000),
        targetBalance: sypStr(6_000),
        replayed: false,
      })

      expect(await h.deps.ledger.fundBalance(BRANCH, ordinaryCode)).toBe(600_000n)
      expect(await h.deps.ledger.fundBalance(BRANCH, fundingCode)).toBe(200_000n)
      expect(await h.deps.ledger.fundBalance(BRANCH, 'cost_center:receivable_writeoff_loss')).toBe(400_000n)
      expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(officeCashBefore)
      expect(await h.deps.ledger.fundBalance(BRANCH, 'office_wallet')).toBe(officeWalletBefore)

      const history = await get(manager, `/receivables/events?driverId=${DRIVER_ID}`)
      expect(history.statusCode, history.body).toBe(200)
      expect(history.json().events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          intent: 'writeoff',
          receivableKind: 'ordinary',
          channel,
          direction: 'collect',
          reason: 'uncollectible balance approved for write-off',
          priorBalance: sypStr(10_000),
          targetBalance: sypStr(6_000),
        }),
      ]))
    },
  )

  it('can fully write off an inactive driver balance', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager, { amount: sypStr(10_000) })
    await deactivateDriver()

    const response = await post(manager, '/receivables/writeoffs', writeoff({ amount: sypStr(10_000) }))
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json()).toMatchObject({ targetBalance: sypStr(0), intent: 'writeoff' })
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(0n)
  })

  it('refuses to write off more than the selected ordinary channel balance atomically', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager, { amount: sypStr(10_000) })
    const officeBefore = await h.deps.ledger.fundBalance(BRANCH, 'office_cash')

    const response = await post(manager, '/receivables/writeoffs', writeoff({ amount: sypStr(10_001) }))
    expect(response.statusCode, response.body).toBe(422)
    expect(response.json()).toMatchObject({
      error: 'receivable_writeoff_exceeds_balance',
      detail: { available: sypStr(10_000) },
    })
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(1_000_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'cost_center:receivable_writeoff_loss')).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(officeBefore)
  })

  it('replays an identical key once and rejects every changed or cross-intent reuse', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager, { amount: sypStr(10_000) })
    const body = writeoff()

    const first = await post(manager, '/receivables/writeoffs', body)
    expect(first.statusCode, first.body).toBe(201)
    const replay = await post(manager, '/treasury/receivables/writeoffs', body)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ id: first.json().id, replayed: true })
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(600_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'cost_center:receivable_writeoff_loss')).toBe(400_000n)

    const changed = await post(manager, '/receivables/writeoffs', {
      ...body,
      amount: sypStr(3_000),
    })
    expect(changed.statusCode).toBe(409)
    expect(changed.json().error).toBe('idempotency_key_conflict')

    const disguisedCollection = await post(manager, '/receivables/events', receivableBody({
      direction: 'collect',
      amount: sypStr(4_000),
      reason: body.reason,
      idempotencyKey: body.idempotencyKey,
    }))
    expect(disguisedCollection.statusCode).toBe(409)
    expect(disguisedCollection.json().error).toBe('idempotency_key_conflict')
  })

  it('requires positive money, an audited reason, and journal.manual.write permission', async () => {
    const manager = await h.loginAs('manager')
    await seedOffice(manager)
    await createReceivable(manager, { amount: sypStr(10_000) })

    for (const amount of ['0', '0.00', '-1.00']) {
      const response = await post(manager, '/receivables/writeoffs', writeoff({ amount }))
      expect(response.statusCode, response.body).toBe(400)
    }
    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      const response = await post(manager, '/receivables/writeoffs', writeoff({ reason }))
      expect(response.statusCode, response.body).toBe(400)
    }

    const driver = await h.loginAs('driver1')
    const forbidden = await post(driver, '/receivables/writeoffs', writeoff())
    expect(forbidden.statusCode).toBe(403)
  })
})
