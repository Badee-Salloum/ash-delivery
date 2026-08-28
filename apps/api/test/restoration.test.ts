import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, DRIVER_ID, type Harness, makeHarness, sypStr } from './harness.ts'

const MAX_MINOR = '92233720368547758.07'
const ONE_MINOR = '0.01'

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
const put = async (token: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })
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
  counted: string
  receivables: string
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
  it('publishes editable cash/wallet targets atomically and the next restoration uses them', async () => {
    const manager = await h.loginAs('manager')
    const changed = await put(manager, '/treasury/capital-targets', {
      cashTarget: sypStr(50_000),
      walletTarget: sypStr(10_000),
      reason: 'قرار رأس المال الجديد',
    })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(changed.json()).toMatchObject({
      businessDate: '2026-07-21',
      cashTarget: sypStr(50_000),
      walletTarget: sypStr(10_000),
    })

    const preview = await get(manager, '/treasury/restoration/preview')
    expect(legOf(preview.json(), 'office_cash').capitalTarget).toBe(sypStr(50_000))
    expect(legOf(preview.json(), 'office_wallet').capitalTarget).toBe(sypStr(10_000))

    await seedFund(manager, 'office_cash', sypStr(60_000))
    await seedFund(manager, 'office_wallet', sypStr(10_000))
    await countBoxes(manager, sypStr(60_000), sypStr(10_000))
    const restored = await post(manager, '/treasury/restoration', { reason: 'ترميم على الهدف الجديد' })
    expect(restored.statusCode, restored.body).toBe(201)
    expect(legOf(restored.json(), 'office_cash')).toMatchObject({
      capitalTarget: sypStr(50_000),
      direction: 'to_company',
      amount: sypStr(10_000),
    })

    const frozen = await put(manager, '/treasury/capital-targets', {
      cashTarget: sypStr(55_000),
      walletTarget: sypStr(10_000),
      reason: 'must not restate today',
    })
    expect(frozen.statusCode).toBe(409)
    expect(frozen.json().error).toBe('capital_target_date_already_restored')
  })

  it('rolls both target rows back when the second write fails', async () => {
    const manager = await h.loginAs('manager')
    const before = await h.deps.capitalTargets.resolve(BRANCH, '2026-07-21')
    const originalUpsert = h.deps.capitalTargets.upsert.bind(h.deps.capitalTargets)
    h.deps.capitalTargets.upsert = async (row) => {
      if (row.fundCode === 'office_wallet') throw new Error('late wallet target failure')
      await originalUpsert(row)
    }
    try {
      const failed = await put(manager, '/treasury/capital-targets', {
        cashTarget: sypStr(50_000),
        walletTarget: sypStr(10_000),
        reason: 'must commit together',
      })
      expect(failed.statusCode).toBe(500)
    } finally {
      h.deps.capitalTargets.upsert = originalUpsert
    }
    expect(await h.deps.capitalTargets.resolve(BRANCH, '2026-07-21')).toEqual(before)
  })

  it('validates target range and refuses target editing to a driver', async () => {
    const manager = await h.loginAs('manager')
    const negative = await put(manager, '/treasury/capital-targets', {
      cashTarget: '-1.00',
      walletTarget: sypStr(10_000),
      reason: 'invalid',
    })
    expect(negative.statusCode).toBe(422)
    expect(negative.json().error).toBe('capital_target_negative')

    const overflow = await put(manager, '/treasury/capital-targets', {
      cashTarget: '92233720368547758.08',
      walletTarget: sypStr(10_000),
      reason: 'invalid',
    })
    expect(overflow.statusCode).toBe(422)
    expect(overflow.json().error).toBe('money_total_out_of_range')

    const driver = await h.loginAs('driver1')
    expect((await put(driver, '/treasury/capital-targets', {
      cashTarget: sypStr(50_000),
      walletTarget: sypStr(10_000),
      reason: 'forbidden',
    })).statusCode).toBe(403)
  })

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
    await seedFund(manager, `driver_receivable_cash:${DRIVER_ID}`, sypStr(250_000))
    await seedFund(manager, `driver_shift_funding_cash:${DRIVER_ID}`, sypStr(150_000))
    await seedFund(manager, 'office_wallet', sypStr(970_000))
    await seedFund(manager, `driver_receivable_wallet:${DRIVER_ID}`, sypStr(20_000))
    await seedFund(manager, `driver_shift_funding_wallet:${DRIVER_ID}`, sypStr(10_000))
    await countBoxes(manager, sypStr(3_600_000), sypStr(970_000))

    const res = await post(manager, '/treasury/restoration', { reason: 'ترميم اليوم' })
    expect(res.statusCode, res.body).toBe(201)

    const cash = legOf(res.json(), 'office_cash')
    expect(cash.counted).toBe(sypStr(3_600_000))
    expect(cash.receivables).toBe(sypStr(400_000))
    expect(cash.position).toBe(sypStr(4_000_000))
    expect(cash.capitalTarget).toBe(sypStr(4_000_000))
    expect(cash.delta).toBe(sypStr(0))
    expect(cash.direction).toBeNull()

    const wallet = legOf(res.json(), 'office_wallet')
    expect(wallet.counted).toBe(sypStr(970_000))
    expect(wallet.receivables).toBe(sypStr(30_000))
    expect(wallet.position).toBe(sypStr(1_000_000))
    expect(wallet.delta).toBe(sypStr(0))

    // Nothing moved, and that is a fact worth recording — «we restored and it was already level»
    // is a different thing from «nobody looked».
    expect(res.json().postings).toBe(0)
    expect(await companyFund()).toBe(sypStr(0))
  })

  it.each([
    ['cash', 'driver_receivable_cash', 'driver_shift_funding_cash'],
    ['wallet', 'driver_receivable_wallet', 'driver_shift_funding_wallet'],
  ] as const)(
    'returns a named 422 when ordinary + shift-funding %s receivables exceed bigint',
    async (channel, ordinaryFund, shiftFundingFund) => {
      const manager = await h.loginAs('manager')
      await seedFund(manager, `${ordinaryFund}:${DRIVER_ID}`, MAX_MINOR)
      await seedFund(manager, `${shiftFundingFund}:${DRIVER_ID}`, ONE_MINOR)
      await countBoxes(manager, sypStr(0), sypStr(0))

      const preview = await get(manager, '/treasury/restoration/preview')
      expect(preview.statusCode, preview.body).toBe(422)
      expect(preview.json()).toMatchObject({
        error: 'money_total_out_of_range',
        detail: { field: `restoration.receivables.${channel}` },
      })

      const performed = await post(manager, '/treasury/restoration', { reason: 'range guard' })
      expect(performed.statusCode, performed.body).toBe(422)
      expect(performed.json()).toMatchObject({
        error: 'money_total_out_of_range',
        detail: { field: `restoration.receivables.${channel}` },
      })
      expect(await h.deps.restorations.find(BRANCH, '2026-07-21')).toBeNull()
      expect(h.deps.ledger.entries.filter((entry) => entry.eventType === 'restoration')).toEqual([])
    },
  )

  it('rejects an overflowing counted-plus-receivable position before snapshot or journal writes', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', MAX_MINOR)
    await seedFund(manager, `driver_receivable_cash:${DRIVER_ID}`, ONE_MINOR)
    await countBoxes(manager, MAX_MINOR, sypStr(0))

    const response = await post(manager, '/treasury/restoration', { reason: 'range guard' })
    expect(response.statusCode, response.body).toBe(422)
    expect(response.json()).toMatchObject({
      error: 'money_total_out_of_range',
      detail: { field: 'restoration.legs.office_cash.position' },
    })
    expect(await h.deps.restorations.find(BRANCH, '2026-07-21')).toBeNull()
    expect(h.deps.ledger.entries.filter((entry) => entry.eventType === 'restoration')).toEqual([])
  })

  it('rejects an overflowing cash-plus-wallet restoration net before journal lines are posted', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', MAX_MINOR)
    await seedFund(manager, 'office_wallet', MAX_MINOR)
    await countBoxes(manager, MAX_MINOR, MAX_MINOR)

    const response = await post(manager, '/treasury/restoration', { reason: 'range guard' })
    expect(response.statusCode, response.body).toBe(422)
    expect(response.json()).toMatchObject({
      error: 'money_total_out_of_range',
      detail: { field: 'restoration.netToCompany' },
    })
    expect(await h.deps.restorations.find(BRANCH, '2026-07-21')).toBeNull()
    expect(h.deps.ledger.entries.filter((entry) => entry.eventType === 'restoration')).toEqual([])
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

  it('reconciles a signed nonzero count variance explicitly before restoration without touching company_box', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_100_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await countBoxes(manager, sypStr(4_000_000), sypStr(1_000_000))

    const count = await h.deps.cashCounts.find(BRANCH, '2026-07-21')
    expect(count?.lines.find((line) => line.fundCode === 'office_cash')?.variance).toBe(-10_000_000n)
    const res = await post(manager, '/treasury/restoration', { reason: 'manager approved signed shortage' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().postings).toBe(0)
    expect(res.json().reconciliationPostings).toBe(1)

    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(400_000_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'company_box')).toBe(0n)
    expect(
      await h.deps.ledger.fundBalance(
        BRANCH,
        `cost_center:cash_count_variance:${BRANCH}:office_cash`,
      ),
    ).toBe(10_000_000n)

    const correction = h.deps.ledger.entries.find(
      (entry) => entry.eventType === 'correction' && entry.occurrenceKey.startsWith(`cash-count:${count!.id}:`),
    )
    expect(correction).toMatchObject({
      reason: 'manager approved signed shortage',
      lines: [
        { fundCode: 'office_cash', side: 'C', role: 'cash_count_reconciled_fund' },
        {
          fundCode: `cost_center:cash_count_variance:${BRANCH}:office_cash`,
          side: 'D',
          role: 'cash_count_variance_counterpart',
        },
      ],
    })
    expect(correction!.occurrenceKey).toContain(count!.proofSha256)

    const restoration = await h.deps.restorations.find(BRANCH, '2026-07-21')
    expect(restoration?.cashCountId).toBe(count!.id)
    expect(restoration?.plan).toMatchObject({
      schemaVersion: 2,
      cashCountProofSha256: count!.proofSha256,
      countReconciliation: [
        { fundCode: 'office_cash', variance: sypStr(-100_000), resolution: 'جرد اليوم' },
        { fundCode: 'office_wallet', variance: sypStr(0), resolution: 'جرد اليوم' },
      ],
      reconciliationJournalEntryIds: [correction!.id],
      restorationJournalEntryIds: [],
    })
  })

  it('rolls the restoration journal back when the immutable record fails after posting', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_500_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await countBoxes(manager, sypStr(4_500_000), sypStr(1_000_000))
    const originalCreate = h.deps.restorations.create.bind(h.deps.restorations)
    h.deps.restorations.create = async () => {
      throw new Error('late restoration record failure')
    }

    try {
      const res = await post(manager, '/treasury/restoration', { reason: 'must roll back together' })
      expect(res.statusCode).toBe(500)
    } finally {
      h.deps.restorations.create = originalCreate
    }

    expect(await h.deps.restorations.find(BRANCH, '2026-07-21')).toBeNull()
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(450_000_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'company_box')).toBe(0n)
    expect(h.deps.ledger.entries.filter((entry) => entry.eventType === 'restoration')).toHaveLength(0)
  })

  it('serializes concurrent restoration attempts and commits exactly one immutable result', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_500_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await countBoxes(manager, sypStr(4_500_000), sypStr(1_000_000))

    const [left, right] = await Promise.all([
      post(manager, '/treasury/restoration', { reason: 'concurrent restoration' }),
      post(manager, '/treasury/restoration', { reason: 'concurrent restoration' }),
    ])
    expect([left.statusCode, right.statusCode].sort()).toEqual([201, 409])
    expect(await companyFund()).toBe(sypStr(500_000))
    expect(h.deps.ledger.entries.filter((entry) => entry.eventType === 'restoration')).toHaveLength(1)
    expect(await h.deps.restorations.find(BRANCH, '2026-07-21')).not.toBeNull()
  })

  it('refuses a stale sealed count after a later branch-money posting', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_000_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await countBoxes(manager, sypStr(4_000_000), sypStr(1_000_000))
    await seedFund(manager, 'office_cash', sypStr(100_000))

    const res = await post(manager, '/treasury/restoration', { reason: 'stale count must not repair silently' })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error).toBe('cash_count_stale')
    expect(await h.deps.restorations.find(BRANCH, '2026-07-21')).toBeNull()
    expect(h.deps.ledger.entries.filter((entry) => entry.eventType === 'restoration')).toHaveLength(0)
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

/**
 * The three answers a variance deserves (owner request, 2026-08-29):
 * proceed, recount, or withdraw the count until the error is fixed.
 *
 * «في حال الفرق يجب اقتراح اما الاكمال مع اضافة عملية تصلح الفرق او اعادة الجرد او الغائه لحين اصلاح الخطا»
 */
describe('a cash count that shows a variance', () => {
  const countBody = (cash: number, wallet: number, extra: Record<string, unknown> = {}) => ({
    lines: [
      { fundCode: 'office_cash', counted: sypStr(cash), resolution: 'عُدّ يدوياً' },
      { fundCode: 'office_wallet', counted: sypStr(wallet), resolution: 'من شاشة المزوّد' },
    ],
    ...extra,
  })

  it('THE DEADLOCK THIS BREAKS: a posting after the count no longer strands the day', async () => {
    // Before recounting existed: the restoration refused with `cash_count_stale` telling the
    // manager to recount, while the count route refused that with `already_counted_today`. The day
    // could never be restored, and nothing said why.
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(60_000))
    await seedFund(manager, 'office_wallet', sypStr(10_000))
    expect((await post(manager, '/cash-counts', countBody(60_000, 10_000))).statusCode).toBe(201)

    // A late movement lands after the seal.
    await seedFund(manager, 'office_cash', sypStr(500))

    const stale = await post(manager, '/treasury/restoration', { reason: 'ترميم' })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error).toBe('cash_count_stale')

    // The way out: recount, naming why.
    const again = await post(manager, '/cash-counts', countBody(60_500, 10_000, {
      recountReason: 'حركة متأخرة بعد الجرد الأول',
    }))
    expect(again.statusCode, again.body).toBe(201)

    const restored = await post(manager, '/treasury/restoration', { reason: 'ترميم بعد إعادة الجرد' })
    expect(restored.statusCode, restored.body).toBe(201)
  })

  it('refuses a second count that does not say why it is replacing the first', async () => {
    // Replacing a signed count must be deliberate. The refusal now names the way out.
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(60_000))
    await seedFund(manager, 'office_wallet', sypStr(10_000))
    expect((await post(manager, '/cash-counts', countBody(60_000, 10_000))).statusCode).toBe(201)

    const second = await post(manager, '/cash-counts', countBody(60_000, 10_000))
    expect(second.statusCode, second.body).toBe(409)
    expect(second.json().error).toBe('already_counted_today')
    expect(second.json().detail.hint).toContain('recountReason')
  })

  it('keeps the superseded count readable, with its own proof', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(60_000))
    await seedFund(manager, 'office_wallet', sypStr(10_000))
    const first = await post(manager, '/cash-counts', countBody(60_000, 10_000))
    const firstProof = first.json().proofSha256

    const second = await post(manager, '/cash-counts', countBody(59_000, 10_000, {
      recountReason: 'أُعيد العدّ',
    }))
    expect(second.statusCode, second.body).toBe(201)

    // `find` returns only the ACTIVE count — the restoration must never reconcile against a
    // superseded one.
    const active = await get(manager, `/cash-counts/${second.json().businessDate}`)
    expect(active.json().id).toBe(second.json().id)
    expect(active.json().status).toBe('active')
    // …and the first keeps the proof it always had, unaltered.
    expect(firstProof).not.toBe(second.json().proofSha256)
  })

  it('withdrawing the count leaves the day uncounted, so nothing settles against it', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(60_000))
    await seedFund(manager, 'office_wallet', sypStr(10_000))
    const created = await post(manager, '/cash-counts', countBody(60_000, 10_000))
    const date = created.json().businessDate as string

    const cancelled = await post(manager, `/cash-counts/${date}/cancel`, { reason: 'الفرق غير مفسَّر — نعيد بعد المراجعة' })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    expect(cancelled.json().status).toBe('cancelled')
    expect(cancelled.json().closedReason).toContain('نعيد بعد المراجعة')

    // The day is uncounted again: the restoration refuses rather than settling on withdrawn figures.
    const blocked = await post(manager, '/treasury/restoration', { reason: 'ترميم' })
    expect(blocked.statusCode, blocked.body).toBe(422)
    expect(blocked.json().error).toBe('cash_count_required')

    // And counting again is a plain first count, needing no recount reason.
    expect((await post(manager, '/cash-counts', countBody(60_000, 10_000))).statusCode).toBe(201)
  })

  it('a withdrawn count must NOT let a financial week seal', async () => {
    // The silent failure this guards. `listDatesInRange` feeds the week-close blocker; if it
    // counted withdrawn rows, a week would seal on evidence its own author retracted — and BR7
    // makes that seal immutable.
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(60_000))
    await seedFund(manager, 'office_wallet', sypStr(10_000))
    const created = await post(manager, '/cash-counts', countBody(60_000, 10_000))
    const date = created.json().businessDate as string
    await post(manager, `/cash-counts/${date}/cancel`, { reason: 'سُحب' })

    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/weeks/close', { closeDate: '2026-07-26', branchId: BRANCH })
    const missing = (res.json().blockers ?? []).find(
      (b: { kind: string }) => b.kind === 'missing_cash_counts',
    )
    // The withdrawn day is reported UNCOUNTED, which is the whole point: a week must not seal on
    // evidence its own author retracted.
    expect(missing, res.body).toBeDefined()
    expect(missing.dates).toContain(date)
  })

  it('refuses to withdraw a count the restoration already settled against', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(60_000))
    await seedFund(manager, 'office_wallet', sypStr(10_000))
    const created = await post(manager, '/cash-counts', countBody(60_000, 10_000))
    const date = created.json().businessDate as string
    expect((await post(manager, '/treasury/restoration', { reason: 'ترميم' })).statusCode).toBe(201)

    const res = await post(manager, `/cash-counts/${date}/cancel`, { reason: 'تراجع' })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error).toBe('already_restored_today')
  })
})
