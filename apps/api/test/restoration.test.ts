import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, DRIVER_ID, type Harness, makeHarness, sypStr } from './harness.ts'

/**
 * «الترميم» — the daily restoration, at the HTTP level (owner decision 10).
 *
 * The domain suite proves the arithmetic. What is only provable here is the part the owner's own
 * process depends on: that the plan is built from the SEALED COUNT and not from the request body,
 * that it refuses before it is counted, that it runs once a day, and that the money it moves
 * actually lands in صندوق الشركة.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (token: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

/** Put money into a fund the honest way — a balanced manual entry against opening_balance. */
async function seedFund(token: string, fundCode: string, amount: string): Promise<void> {
  const res = await post(token, '/journal/manual', {
    reason: 'رصيد افتتاحي',
    lines: [
      { fundCode, side: 'D', amount },
      { fundCode: 'opening_balance', side: 'C', amount },
    ],
  })
  expect(res.statusCode, res.body).toBe(201)
}

/** Seal today's count. Only the funds named are counted; anything omitted counts as zero. */
async function countBoxes(token: string, cash: string, wallet: string): Promise<void> {
  const res = await post(token, '/cash-counts', {
    lines: [
      { fundCode: 'office_cash', counted: cash, resolution: 'جرد اليوم' },
      { fundCode: 'office_wallet', counted: wallet, resolution: 'جرد اليوم' },
    ],
  })
  expect(res.statusCode, res.body).toBe(201)
}

interface LegView {
  fundCode: string
  position: string
  capitalTarget: string
  delta: string
  direction: 'to_company' | 'from_company' | null
  amount: string
  feasible: boolean
  refusals: string[]
}
const legOf = (body: { legs: LegView[] }, code: string): LegView => body.legs.find((l) => l.fundCode === code)!

/**
 * صندوق الشركة for the harness branch — read as the GM, because `profit.view_total` is his and the
 * sysadmin's (BR8 as amended by decision 9). The branch manager performs الترميم and is told what
 * he is handing over; he is not shown the company's accumulated profit.
 */
async function companyFund(): Promise<string> {
  const res = await get(await h.loginAs('gm'), '/company-fund')
  expect(res.statusCode, res.body).toBe(200)
  return (res.json().branches as Array<{ branchId: string; balance: string }>).find((b) => b.branchId === BRANCH)!
    .balance
}

describe('الترميم — the daily restoration', () => {
  it('refuses before the boxes are counted (decision j)', async () => {
    const manager = await h.loginAs('manager')

    const preview = await get(manager, '/treasury/restoration/preview')
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().counted).toBe(false)

    const res = await post(manager, '/treasury/restoration', { reason: 'ترميم اليوم' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('cash_count_required')
  })

  /**
   * The owner's own book, row for row: كاش المكتب 3,600,000 counted with 400,000 out on ذمم is
   * exactly 4,000,000 — a day already restored. His `=SUM(I38:J48)-4000000` evaluating to zero,
   * as a system invariant rather than a spreadsheet formula.
   */
  it('counts الذمم toward the capital: 3,600,000 + 400,000 == 4,000,000, and moves nothing', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(3_600_000))
    await seedFund(manager, `driver_receivable_cash:${DRIVER_ID}`, sypStr(400_000))
    await seedFund(manager, 'office_wallet', sypStr(970_000))
    await seedFund(manager, `driver_receivable_wallet:${DRIVER_ID}`, sypStr(30_000))
    await countBoxes(manager, sypStr(3_600_000), sypStr(970_000))

    const res = await post(manager, '/treasury/restoration', { reason: 'ترميم اليوم' })
    expect(res.statusCode, res.body).toBe(201)

    const cash = legOf(res.json(), 'office_cash')
    expect(cash.position).toBe(sypStr(4_000_000))
    expect(cash.capitalTarget).toBe(sypStr(4_000_000))
    expect(cash.delta).toBe(sypStr(0))
    expect(cash.direction).toBeNull()

    const wallet = legOf(res.json(), 'office_wallet')
    expect(wallet.position).toBe(sypStr(1_000_000))
    expect(wallet.delta).toBe(sypStr(0))

    // Nothing moved, and that is a fact worth recording — «we restored and it was already level»
    // is a different thing from «nobody looked».
    expect(res.json().postings).toBe(0)
    expect(await companyFund()).toBe(sypStr(0))
  })

  it('«كييش»: a surplus is swept to صندوق الشركة and leaves the box on target', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_500_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await countBoxes(manager, sypStr(4_500_000), sypStr(1_000_000))

    const res = await post(manager, '/treasury/restoration', { reason: 'ترميم اليوم' })
    expect(res.statusCode, res.body).toBe(201)
    const cash = legOf(res.json(), 'office_cash')
    expect(cash.direction).toBe('to_company')
    expect(cash.amount).toBe(sypStr(500_000))
    expect(res.json().netToCompany).toBe(sypStr(500_000))

    expect(await companyFund()).toBe(sypStr(500_000))
    expect((await get(manager, '/treasury/balances')).json().cash).toBe(sypStr(4_000_000))
  })

  it('«شحن من الصندوق»: a shortfall is replenished from the company fund', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(3_000_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await countBoxes(manager, sypStr(3_000_000), sypStr(1_000_000))

    const res = await post(manager, '/treasury/restoration', { reason: 'ترميم اليوم' })
    expect(res.statusCode, res.body).toBe(201)
    const cash = legOf(res.json(), 'office_cash')
    expect(cash.direction).toBe('from_company')
    expect(cash.amount).toBe(sypStr(1_000_000))
    expect(res.json().netToCompany).toBe(sypStr(-1_000_000))

    // The company fund goes NEGATIVE, and that is correct: it owes the branch a million it has not
    // got. Refusing here would leave the branch under-capitalised and the books silent about it.
    expect(await companyFund()).toBe(sypStr(-1_000_000))
    expect((await get(manager, '/treasury/balances')).json().cash).toBe(sypStr(4_000_000))
  })

  /**
   * The wallet settles against صندوق الشركة directly (decision l) — it is NOT routed through the
   * branch cash box. A wallet سحب means money really leaving Yallago.
   */
  it('the wallet leg settles against the company fund, not through the cash box', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_000_000))
    await seedFund(manager, 'office_wallet', sypStr(1_200_000))
    await countBoxes(manager, sypStr(4_000_000), sypStr(1_200_000))

    await post(manager, '/treasury/restoration', { reason: 'ترميم اليوم' })
    const balances = (await get(manager, '/treasury/balances')).json()
    expect(balances.wallet).toBe(sypStr(1_000_000))
    expect(balances.cash).toBe(sypStr(4_000_000))
    expect(await companyFund()).toBe(sypStr(200_000))
  })

  it('refuses to sweep money the box does not physically hold', async () => {
    const manager = await h.loginAs('manager')
    // The ledger believes there is plenty; the drawer holds 100,000 and the ذمم carry the rest.
    await seedFund(manager, 'office_cash', sypStr(4_000_000))
    await seedFund(manager, `driver_receivable_cash:${DRIVER_ID}`, sypStr(5_000_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await countBoxes(manager, sypStr(100_000), sypStr(1_000_000))

    const preview = await get(manager, '/treasury/restoration/preview')
    expect(preview.json().feasible).toBe(false)
    expect(legOf(preview.json(), 'office_cash').refusals).toContain('sweep_exceeds_counted')

    const res = await post(manager, '/treasury/restoration', { reason: 'ترميم اليوم' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('restoration_infeasible')
  })

  it('runs once per working day', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_500_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await countBoxes(manager, sypStr(4_500_000), sypStr(1_000_000))

    expect((await post(manager, '/treasury/restoration', { reason: 'ترميم اليوم' })).statusCode).toBe(201)
    const second = await post(manager, '/treasury/restoration', { reason: 'مرة ثانية' })
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toBe('already_restored_today')
    // And the sweep did not happen twice.
    expect(await companyFund()).toBe(sypStr(500_000))
  })

  it('returns the live post-action position after reload while keeping the restoration record immutable', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_500_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await countBoxes(manager, sypStr(4_500_000), sypStr(1_000_000))

    const before = await get(manager, '/treasury/restoration/preview')
    expect(before.statusCode, before.body).toBe(200)
    expect(before.json().alreadyRestored).toBe(false)

    const performed = await post(manager, '/treasury/restoration', { reason: 'daily restoration' })
    expect(performed.statusCode, performed.body).toBe(201)
    const storedBeforeReload = structuredClone(await h.deps.restorations.find(BRANCH, '2026-07-21'))

    const reloaded = await get(manager, '/treasury/restoration/preview')
    expect(reloaded.statusCode, reloaded.body).toBe(200)
    expect(reloaded.json().alreadyRestored).toBe(true)
    expect(reloaded.json().netToCompany).toBe(sypStr(0))
    for (const leg of reloaded.json().legs as LegView[]) {
      expect(leg.position).toBe(leg.capitalTarget)
      expect(leg.delta).toBe(sypStr(0))
      expect(leg.direction).toBeNull()
      expect(leg.amount).toBe(sypStr(0))
    }
    expect(reloaded.json().legs).not.toEqual(performed.json().legs)
    expect(await h.deps.restorations.find(BRANCH, '2026-07-21')).toEqual(storedBeforeReload)
  })

  it('is refused to a driver, and the system admin must name a branch', async () => {
    const driver = await h.loginAs('driver1')
    expect((await get(driver, '/treasury/restoration/preview')).statusCode).toBe(403)

    const sysadmin = await h.loginAs('sysadmin')
    const unnamed = await post(sysadmin, '/treasury/restoration', { reason: 'ترميم' })
    expect(unnamed.statusCode).toBe(422)
    expect(unnamed.json().error).toBe('branch_required')

    const named = await post(sysadmin, `/treasury/restoration?branchId=${BRANCH}`, { reason: 'ترميم' })
    // He may act — he is stopped by the count gate, not by his role (decision 9).
    expect(named.json().error).toBe('cash_count_required')
  })
})
