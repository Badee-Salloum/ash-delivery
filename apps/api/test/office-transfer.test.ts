import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, type Harness, makeHarness, sypStr } from './harness.ts'

/**
 * «نقل الأموال من الصندوق للمحفظة و بالعكس» (owner request, 2026-08-31).
 *
 * Yallago's cut comes out of the wallet while the drivers hand back notes, so the wallet empties as
 * the cash box fills and the office tops one from the other. It was already possible through the
 * generic withdraw route's free-form `to` — which is exactly the problem: `fundRefFromCode` turns
 * any string it does not recognise into `cost_center:<code>`, a look-alike account no reader sums
 * and no error is raised about. Naming both ends closes that door.
 */
let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (token: string, url: string, payload: unknown = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload: payload as object })

const seed = async (token: string, cash: number, wallet: number): Promise<void> => {
  const res = await post(token, '/journal/manual', {
    reason: 'رصيد افتتاحي',
    lines: [
      { fundCode: 'office_cash', side: 'D', amount: sypStr(cash) },
      { fundCode: 'office_wallet', side: 'D', amount: sypStr(wallet) },
      { fundCode: 'opening_balance', side: 'C', amount: sypStr(cash + wallet) },
    ],
  })
  expect(res.statusCode, res.body).toBe(201)
}

const transfer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  branchId: BRANCH,
  direction: 'cash_to_wallet',
  amount: sypStr(5_000),
  reason: 'تعبئة المحفظة من الصندوق',
  ...over,
})

describe('moving money between the office boxes', () => {
  it('moves cash into the wallet and leaves working capital untouched', async () => {
    const manager = await h.loginAs('manager')
    await seed(manager, 50_000, 10_000)
    const res = await post(manager, '/treasury/transfer', transfer())
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ cash: sypStr(45_000), wallet: sypStr(15_000) })

    // The whole character of this posting: the branch holds exactly what it held a second ago.
    // Only the shape moved, so the capital card, the restoration and the go-live gate see no change.
    const cash = await h.deps.ledger.fundBalance(BRANCH, 'office_cash')
    const wallet = await h.deps.ledger.fundBalance(BRANCH, 'office_wallet')
    expect(cash + wallet).toBe(6_000_000n)
  })

  it('moves the wallet back into cash', async () => {
    const manager = await h.loginAs('manager')
    await seed(manager, 50_000, 10_000)
    const res = await post(manager, '/treasury/transfer', transfer({ direction: 'wallet_to_cash', amount: sypStr(2_500) }))
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ cash: sypStr(52_500), wallet: sypStr(7_500) })
  })

  it('refuses to move money the box is not holding', async () => {
    // The ledger would carry a negative balance without complaint — arithmetic has no opinion — and
    // a box that owes itself money is a data-entry mistake every time.
    const manager = await h.loginAs('manager')
    await seed(manager, 1_000, 10_000)
    const res = await post(manager, '/treasury/transfer', transfer({ amount: sypStr(5_000) }))
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('insufficient_funds')
    expect(res.json().detail).toMatchObject({ held: sypStr(1_000), from: 'office_cash' })
  })

  it('never lands in a look-alike account, whatever the caller names', async () => {
    /*
     * The reason this route exists at all. `/treasury/withdraw` takes a free-form `to`, and
     * `fundRefFromCode`'s default clause turns an unrecognised string into `cost_center:<code>`
     * — money moved into an account no profit or treasury reader sums, with no error raised.
     * Here the direction is an enum, so a typo is a 400 rather than silent misfiling.
     */
    const manager = await h.loginAs('manager')
    await seed(manager, 50_000, 10_000)
    // Everything the seed wrote — `opening_balance` legitimately IS a cost centre — is behind us.
    const before = h.deps.ledger.entries.length
    const res = await post(manager, '/treasury/transfer', transfer({ direction: 'cash_to_walet' }))
    expect(res.statusCode).toBe(400)

    const funds = h.deps.ledger.entries.slice(before).flatMap((e) => e.lines.map((l) => l.fundCode))
    expect(funds).toEqual([])
  })

  it('demands a reason that says something', async () => {
    // A transfer with no explanation is indistinguishable next month from a mistake. `trim()` alone
    // is not enough: RTL bidi marks survive it, which is why the schema tests visible characters.
    const manager = await h.loginAs('manager')
    await seed(manager, 50_000, 10_000)
    expect((await post(manager, '/treasury/transfer', transfer({ reason: '   ' }))).statusCode).toBe(400)
    expect((await post(manager, '/treasury/transfer', transfer({ reason: '\u200e\u200f' }))).statusCode).toBe(400)
  })

  it('is journal.manual.write, so a driver cannot reshape the branch treasury', async () => {
    const driver = await h.loginAs('driver1')
    expect((await post(driver, '/treasury/transfer', transfer())).statusCode).toBe(403)
  })

  it('stays out of «كييش»/«شحن», which mean money leaving for صندوق الشركة', async () => {
    // The treasury reader classifies by the `kaish`/`shahn` line roles. A transfer wearing one
    // would be counted as company money that never moved.
    const manager = await h.loginAs('manager')
    await seed(manager, 50_000, 10_000)
    const before = h.deps.ledger.entries.length
    expect((await post(manager, '/treasury/transfer', transfer())).statusCode).toBe(201)
    const roles = h.deps.ledger.entries.slice(before).flatMap((e) => e.lines.map((l) => l.role))
    expect(roles).not.toContain('kaish')
    expect(roles).not.toContain('shahn')
    expect(roles).toEqual(expect.arrayContaining(['office_transfer_in', 'office_transfer_out']))
  })
})
