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
