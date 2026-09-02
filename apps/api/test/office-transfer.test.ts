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

  it('records one entry when the same transfer is submitted twice', async () => {
    /*
     * 2026-09-02, 02:42:37 · :37 · :38 · :39 — this route recorded «تسكير نوبة عمران», the same
     * 461.15 from the wallet to the cash box, FOUR times. One button, four presses, two seconds.
     * Three phantom entries moved 1,383.45 between the boxes and put the ledger that far from the
     * counted drawer, and nothing in the system objected: the occurrence key was a fresh UUID on
     * every call, so the ledger's idempotency guard could not see a repeat as a repeat. Every other
     * posting in this codebase is protected by that guard; this one opted out of it.
     */
    const manager = await h.loginAs('manager')
    await seed(manager, 100_000, 100_000)

    const body = transfer({ direction: 'wallet_to_cash', amount: sypStr(461), reason: 'تسكير نوبة عمران' })
    const first = await post(manager, '/treasury/transfer', body)
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().applied).toBe(true)

    // The double-click. Accepted, because a retry must not be an error — and applied nothing.
    const second = await post(manager, '/treasury/transfer', body)
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json().applied, 'the second press must not move money again').toBe(false)

    // One journal for THIS transfer, and the boxes moved once. Counted by reason, because the
    // opening-balance seed is itself a `manual` entry.
    expect(h.deps.ledger.entries.filter((entry) => entry.reason === 'تسكير نوبة عمران')).toHaveLength(1)
    expect(second.json().cash).toBe(sypStr(100_461))
    expect(second.json().wallet).toBe(sypStr(99_539))
  })

  it('still allows a second, genuinely different transfer on the same day', async () => {
    // The key is derived from what the transfer IS, so the way to say «this one is different» is to
    // say why — which the reason field exists for and which good bookkeeping wants regardless.
    const manager = await h.loginAs('manager')
    await seed(manager, 100_000, 100_000)

    const a = await post(manager, '/treasury/transfer', transfer({ amount: sypStr(1_000), reason: 'تعبئة الصباح' }))
    const b = await post(manager, '/treasury/transfer', transfer({ amount: sypStr(1_000), reason: 'تعبئة المساء' }))
    expect([a.statusCode, b.statusCode]).toEqual([201, 201])
    expect(b.json().applied).toBe(true)
    expect(h.deps.ledger.entries.filter((entry) => entry.reason?.startsWith('تعبئة '))).toHaveLength(2)

    // A different AMOUNT is likewise its own transfer.
    const c = await post(manager, '/treasury/transfer', transfer({ amount: sypStr(1_500), reason: 'تعبئة الصباح' }))
    expect(c.statusCode, c.body).toBe(201)
    expect(c.json().applied).toBe(true)
  })

  it('shows the movements back, which is how a repeat would have been noticed', async () => {
    // The Treasury screen could post a transfer and never show one. Asked «أين أرى عمليات عمران»,
    // the answer was nowhere: `/audit` needs a table name and a record id and returns everything
    // ever, oldest first. Four duplicates sat in the ledger, correct and invisible.
    const manager = await h.loginAs('manager')
    await seed(manager, 100_000, 100_000)
    await post(manager, '/treasury/transfer', transfer({ amount: sypStr(700), reason: 'تعبئة المحفظة' }))

    const res = await h.app.inject({
      method: 'GET',
      url: '/treasury/movements?limit=10',
      headers: { cookie: h.cookie(manager) },
    })
    expect(res.statusCode, res.body).toBe(200)
    const rows = res.json().rows
    const moved = rows.find((row: any) => row.reason === 'تعبئة المحفظة')
    expect(moved, 'the transfer just posted must be visible').toBeDefined()
    // Signed from each box's own point of view, so the direction reads off the row.
    expect(moved.cash).toBe(sypStr(-700))
    expect(moved.wallet).toBe(sypStr(700))
    expect(moved.actorName, 'who did it is the whole point').toBeTruthy()
  })

  it('records one manual entry when the same one is submitted twice', async () => {
    /*
     * `/journal/manual` had the same fault the transfer route did: `occurrenceKey: deps.ids.uuid()`
     * on every call, so the ledger's idempotency guard could not see a double submit. It is the
     * most dangerous place for it — a manual entry's lines are arbitrary, so a repeat can move any
     * amount between any two funds. Found while preparing a ground-count adjustment: posting that
     * correction twice would have left the books 1,114.74 above a drawer that does not hold it, and
     * الترميم would then have swept the difference to the company box as «كييش».
     */
    const manager = await h.loginAs('manager')
    await seed(manager, 100_000, 100_000)

    const entry = {
      branchId: BRANCH,
      reason: 'مطابقة أرضية',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(300) },
        { fundCode: 'cost_center:office_ground_reconciliation:' + BRANCH, side: 'C', amount: sypStr(300) },
      ],
    }
    expect((await post(manager, '/journal/manual', entry)).statusCode).toBe(201)
    const second = await post(manager, '/journal/manual', entry)
    expect([200, 201], second.body).toContain(second.statusCode)

    // One entry with that reason, whatever the second call answered.
    expect(h.deps.ledger.entries.filter((e) => e.reason === 'مطابقة أرضية')).toHaveLength(1)
  })

  it('still allows a manual entry that genuinely differs', async () => {
    const manager = await h.loginAs('manager')
    await seed(manager, 100_000, 100_000)
    const line = (amount: string) => ({
      branchId: BRANCH,
      reason: 'مطابقة أرضية ' + amount,
      lines: [
        { fundCode: 'office_cash', side: 'D', amount },
        { fundCode: 'cost_center:office_ground_reconciliation:' + BRANCH, side: 'C', amount },
      ],
    })
    expect((await post(manager, '/journal/manual', line(sypStr(100)))).statusCode).toBe(201)
    expect((await post(manager, '/journal/manual', line(sypStr(200)))).statusCode).toBe(201)
    expect(h.deps.ledger.entries.filter((e) => (e.reason ?? '').startsWith('مطابقة أرضية '))).toHaveLength(2)
  })

})
