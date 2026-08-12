import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, type Harness, makeHarness, sypStr } from './harness.ts'

/**
 * «صندوق الشركة» and taking money back OUT of خزينة الفرع.
 *
 * Until now money could only go INTO the branch treasury, while the owner's own cash book has it
 * moving both ways every single day: «كييش» withdraws the day's profit to the company fund, and
 * «شحن من الصندوق» puts capital back. These are the manual controls he asked for directly —
 * «امكانية السحب و الايداع بشكل مباشر من صندوق خزينة الفرع» — and the same recipes الترميم will
 * use automatically, so a hand-made sweep and an automatic one are indistinguishable in the ledger.
 */

let h: Harness
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

/** Put money in the branch box so there is something to withdraw. */
async function fundBox(token: string, target: 'cash' | 'wallet', amount: string): Promise<void> {
  const res = await post(token, '/treasury/deposit', { target, amount, branchId: BRANCH })
  expect(res.statusCode, res.body).toBe(201)
}

describe('صندوق الشركة', () => {
  it('starts empty and is visible to the roles that may see total profit', async () => {
    const gm = await h.loginAs('gm')
    const res = await get(gm, '/company-fund')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().total).toBe(sypStr(0))
  })

  /** Decision 9 gave the system admin `profit.view_total`; BR8 previously made it GM-only. */
  it('is visible to the system admin too, and not to the branch manager', async () => {
    expect((await get(await h.loginAs('sysadmin'), '/company-fund')).statusCode).toBe(200)
    expect((await get(await h.loginAs('manager'), '/company-fund')).statusCode).toBe(403)
    expect((await get(await h.loginAs('driver1'), '/company-fund')).statusCode).toBe(403)
  })

  it('takes a deposit and gives it back on withdrawal', async () => {
    const gm = await h.loginAs('gm')
    const put = await post(gm, '/company-fund/deposit', {
      amount: sypStr(500_000),
      reason: 'رأس مال',
      branchId: BRANCH,
    })
    expect(put.statusCode, put.body).toBe(201)
    expect(put.json().balance).toBe(sypStr(500_000))

    const take = await post(gm, '/company-fund/withdraw', {
      amount: sypStr(200_000),
      reason: 'مسحوبات المالك',
      branchId: BRANCH,
    })
    expect(take.statusCode, take.body).toBe(201)
    expect(take.json().balance).toBe(sypStr(300_000))
    expect((await get(gm, '/company-fund')).json().total).toBe(sypStr(300_000))
  })

  /**
   * A fund that owes itself money is a data-entry mistake every time. The ledger would carry a
   * negative balance without complaint — arithmetic has no opinion — so the refusal has to be here,
   * at the moment the mistake is made, where it can still be corrected by the person making it.
   */
  it('refuses to withdraw more than it holds', async () => {
    const gm = await h.loginAs('gm')
    await post(gm, '/company-fund/deposit', { amount: sypStr(1_000), reason: 'x', branchId: BRANCH })
    const res = await post(gm, '/company-fund/withdraw', {
      amount: sypStr(5_000),
      reason: 'too much',
      branchId: BRANCH,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('insufficient_funds')
  })

  it('requires a reason — money moved by decision must be answerable later', async () => {
    const gm = await h.loginAs('gm')
    const res = await post(gm, '/company-fund/deposit', { amount: sypStr(1_000), branchId: BRANCH })
    expect(res.statusCode).toBe(400)
  })
})

describe('«كييش» — withdrawing from خزينة الفرع', () => {
  it('moves cash out of the branch box into the company fund', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(1_000_000))

    const res = await post(gm, '/treasury/withdraw', {
      target: 'cash',
      amount: sypStr(300_000),
      to: 'company_box',
      reason: 'كييش — سحب أرباح اليوم',
      branchId: BRANCH,
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().balance).toBe(sypStr(700_000))
    expect((await get(gm, '/company-fund')).json().total).toBe(sypStr(300_000))
  })

  /** Both boxes settle directly against صندوق الشركة — owner decision (l). */
  it('does the same for the wallet box', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'wallet', sypStr(100_000))
    const res = await post(gm, '/treasury/withdraw', {
      target: 'wallet',
      amount: sypStr(40_000),
      to: 'company_box',
      reason: 'كييش من المحفظة',
      branchId: BRANCH,
    })
    expect(res.statusCode, res.body).toBe(201)
    expect((await get(gm, '/treasury/balances?branchId=' + BRANCH)).json().wallet).toBe(sypStr(60_000))
    expect((await get(gm, '/company-fund')).json().total).toBe(sypStr(40_000))
  })

  it('refuses to withdraw cash the box does not hold', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(1_000))
    const res = await post(gm, '/treasury/withdraw', {
      target: 'cash',
      amount: sypStr(9_999),
      reason: 'too much',
      branchId: BRANCH,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('insufficient_funds')
  })

  /**
   * THE ROUND TRIP. A sweep followed by a replenishment of the same amount must leave both funds
   * exactly where they started — that is what makes الترميم safe to run every day for a year.
   */
  it('nets to nothing when the money is swept out and put back', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(500_000))
    await post(gm, '/company-fund/deposit', { amount: sypStr(200_000), reason: 'seed', branchId: BRANCH })

    await post(gm, '/treasury/withdraw', {
      target: 'cash',
      amount: sypStr(120_000),
      to: 'company_box',
      reason: 'كييش',
      branchId: BRANCH,
    })
    // «شحن من الصندوق» is the manual inverse: the company fund puts the capital back.
    await post(gm, '/company-fund/withdraw', { amount: sypStr(120_000), reason: 'شحن', branchId: BRANCH })
    await post(gm, '/treasury/deposit', { target: 'cash', amount: sypStr(120_000), branchId: BRANCH })

    expect((await get(gm, '/treasury/balances?branchId=' + BRANCH)).json().cash).toBe(sypStr(500_000))
    expect((await get(gm, '/company-fund')).json().total).toBe(sypStr(200_000))
  })

  it('is refused to a driver', async () => {
    const driver = await h.loginAs('driver1')
    const res = await post(driver, '/treasury/withdraw', {
      target: 'cash',
      amount: sypStr(1),
      reason: 'x',
      branchId: BRANCH,
    })
    expect(res.statusCode).toBe(403)
  })
})
