import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, DRIVER_ID, type Harness, VEHICLE_ID, makeHarness, sypStr } from './harness.ts'

/**
 * «الذمم» end to end — cash kept overnight, carried into the next shift, and cleared.
 *
 * The domain proves the arithmetic; this proves the WIRING. Between the two sits every place a
 * receivable could be stranded: an approval that forgets to post it, an open that double-spends it,
 * a void that returns it to the wrong fund.
 */

let h: Harness
let orderSeq = 0
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>
const get = async (t: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(t) } })
const post = async (t: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(t) }, payload })
const put = async (t: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(t) }, payload })

const receivable = async (): Promise<bigint> =>
  await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)

/** Drive one shift from nothing to `pending_review`, closing at BR1 exactly zero. */
async function runShift(
  driver: string,
  manager: string,
  open: { floatTranches?: string[]; carriedTranches?: string[] },
): Promise<string> {
  // Resolve the default ONCE. Reading `open.floatTranches` again below would see the caller's
  // original object, not this default — which declared 5,000 instead of 105,000 and made every
  // close fail on br1_not_zero.
  const floatTranches = open.floatTranches ?? [sypStr(100_000)]
  const carriedTranches = open.carriedTranches ?? []

  const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await put(driver, `/shifts/${id}/start-package`, { odometerKm: 1_000, batteryPercent: 90 })
  const opened = await post(manager, `/shifts/${id}/approve-open`, {
    floatTranches,
    topupTranches: [sypStr(50_000)],
    carriedTranches,
  })
  expect(opened.statusCode, opened.body).toBe(200)

  // `shift_orders_provider_no_uq` is GLOBAL, and the memory adapter issues sequential uuids — so
  // two shifts in one test share the first eight characters and collide. A counter, not the id.
  orderSeq += 1
  const added = await post(driver, `/shifts/${id}/orders`, {
    providerOrderNo: `R-${orderSeq}`,
    payMode: 'cash',
    fee: sypStr(5_000),
  })
  expect(added.statusCode, added.body).toBe(201)
  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)

  // He holds the float he was given (new or carried) plus every lira of the fee.
  const sumOf = (xs: string[]): number => xs.reduce((a, b) => a + Number(b), 0)
  const cash = sumOf(floatTranches) + sumOf(carriedTranches) + 5_000
  const ended = await put(driver, `/shifts/${id}/end-package`, {
    odometerKm: 1_040,
    batteryPercent: 50,
    cashDeclared: cash.toFixed(2),
    walletDeclared: sypStr(49_000),
  })
  expect(ended.statusCode, ended.body).toBe(200)
  return id
}

/** The hash the manager reviewed — approval refuses without the one it was shown. */
const hashOf = async (manager: string, id: string): Promise<string> =>
  (await get(manager, `/shifts/${id}/review`)).json().br1.ordersHash

describe('a ذمة is created at close and cleared at the next open', () => {
  it('records what the manager left with him, and shows it on the receivables list', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await runShift(driver, manager, {})

    const res = await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: await hashOf(manager, id),
      keepAsReceivable: sypStr(40_000),
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(await receivable()).toBe(4_000_000n) // 40,000.00 in minor units

    const list = (await get(manager, `/receivables?branchId=${BRANCH}`)).json()
    expect(list.total).toBe(sypStr(40_000))
    expect(list.drivers).toHaveLength(1)
    expect(list.drivers[0].cash).toBe(sypStr(40_000))
  })

  /**
   * THE ROUND TRIP. Close keeping 40,000, open the next shift on that money alone, close flat —
   * the receivable must return to zero and the branch box must be no worse off than if the cash
   * had simply been handed over and handed back.
   */
  it('clears to zero when he opens his next shift on it', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')

    const first = await runShift(driver, manager, {})
    await post(manager, `/shifts/${first}/approve-close`, {
      reviewedOrdersHash: await hashOf(manager, first),
      keepAsReceivable: sypStr(40_000),
    })
    expect(await receivable()).toBe(4_000_000n)

    // The office hands over NOTHING new — the 40,000 he is already holding is the float.
    const second = await runShift(driver, manager, { floatTranches: [], carriedTranches: [sypStr(40_000)] })
    expect(await receivable()).toBe(0n)

    const closed = await post(manager, `/shifts/${second}/approve-close`, {
      reviewedOrdersHash: await hashOf(manager, second),
    })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(await receivable()).toBe(0n)
    // Both driver funds close at exactly zero, which is the invariant everything rests on.
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_cash:${DRIVER_ID}`)).toBe(0n)
  })

  /** BR1 stays in its ABSOLUTE form: the carried cash is float, so the equation still hits zero. */
  it('keeps BR1 at exactly zero on the shift that consumes it', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const first = await runShift(driver, manager, {})
    await post(manager, `/shifts/${first}/approve-close`, {
      reviewedOrdersHash: await hashOf(manager, first),
      keepAsReceivable: sypStr(40_000),
    })
    const second = await runShift(driver, manager, { floatTranches: [], carriedTranches: [sypStr(40_000)] })
    expect((await get(manager, `/shifts/${second}/review`)).json().br1.difference).toBe(sypStr(0))
  })
})

describe('the guards around it', () => {
  it('refuses to carry more than the driver actually owes', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = (await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })).json().id as string
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    await put(driver, `/shifts/${id}/start-package`, { odometerKm: 1_000, batteryPercent: 90 })

    const res = await post(manager, `/shifts/${id}/approve-open`, {
      floatTranches: [],
      topupTranches: [],
      carriedTranches: [sypStr(40_000)], // he owes nothing
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('carry_exceeds_receivable')
  })

  it('refuses to keep more cash than he is holding', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await runShift(driver, manager, {})
    const res = await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: await hashOf(manager, id),
      keepAsReceivable: sypStr(999_999),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('settlement_infeasible')
  })

  /**
   * A VOIDED shift must put the ذمة BACK, not sweep it into the branch box. Returning it through
   * `floatReturn` would credit office_cash with money the box never paid out for that shift: the
   * office would show a gain, the receivable would stay cleared, and the driver would still be
   * holding the cash with nothing on the books saying so.
   */
  it('restores the ذمة when the shift that consumed it is voided', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const first = await runShift(driver, manager, {})
    await post(manager, `/shifts/${first}/approve-close`, {
      reviewedOrdersHash: await hashOf(manager, first),
      keepAsReceivable: sypStr(40_000),
    })
    const boxBefore = await h.deps.ledger.fundBalance(BRANCH, 'office_cash')

    const second = await runShift(driver, manager, { floatTranches: [], carriedTranches: [sypStr(40_000)] })
    expect(await receivable()).toBe(0n)

    const voided = await post(manager, `/shifts/${second}/void`, { reason: 'أُلغيت النوبة' })
    expect(voided.statusCode, voided.body).toBe(200)
    expect(await receivable()).toBe(4_000_000n) // back to being a ذمة
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(boxBefore) // the box gained nothing
  })
})

describe('حصة السائق paid out of the cash in his hands', () => {
  it('settles the payable to zero when the share is paid tonight', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await runShift(driver, manager, {})
    await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: await hashOf(manager, id),
      payShareNow: true,
    })
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_share_payable:${DRIVER_ID}`)).toBe(0n)
  })

  /** The default is unchanged behaviour: the share stays a payable, as every close did before. */
  it('leaves it standing when it is not', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const id = await runShift(driver, manager, {})
    await post(manager, `/shifts/${id}/approve-close`, {
      reviewedOrdersHash: await hashOf(manager, id),
    })
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_share_payable:${DRIVER_ID}`)).not.toBe(0n)
  })
})
