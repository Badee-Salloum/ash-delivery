import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, COMPANY_BRANCH, type Harness, makeHarness, sypStr } from './harness.ts'

/**
 * «صندوق الشركة» — who may see it, who may move it, and how it moves.
 *
 * Until 2026-09-17 the fund was READ under `profit.view_total` (GM + sysadmin) but WRITTEN under
 * `journal.manual.write`, which the branch manager holds: he could deposit into and withdraw from a
 * fund he could not see, name `company_box` in a free-form manual entry, and sweep the branch box
 * into it through `/treasury/withdraw`. Owner decision: «إدارة صندوق الشركة: المدير العام ومدير
 * النظام فقط». One permission, `company_fund.manage`, now gates the read and both writes, the hand
 * «كييش» and the reversal of any entry that moved the fund; the manual entry no longer accepts the
 * fund at all; and every money move here carries a client idempotency key and checks the balance
 * inside the branch-money lock.
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

const key = (): string => crypto.randomUUID()
const companyBox = async (): Promise<bigint> => await h.deps.ledger.fundBalance(BRANCH, 'company_box')
const companyCash = async (): Promise<bigint> => await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')
/** Every ledger line that touches صندوق الشركة — the thing a refusal must leave untouched. */
const companyLines = () =>
  h.deps.ledger.entries.flatMap((e) => e.lines.filter((l) => l.fundCode === 'company_box'))
const companyCashLines = () =>
  h.deps.ledger.entries.flatMap((e) => e.lines.filter((l) => l.fundCode === 'company_cash:SYP_NEW'))

const move = (amount: number, reason: string, idempotencyKey = key()): Payload => ({
  idempotencyKey,
  amount: sypStr(amount),
  reason,
  branchId: BRANCH,
})

/** Put money in the branch box so there is something to withdraw. */
async function fundBox(token: string, target: 'cash' | 'wallet', amount: string): Promise<void> {
  const res = await post(token, '/treasury/deposit', { idempotencyKey: key(), target, amount, branchId: BRANCH })
  expect(res.statusCode, res.body).toBe(201)
}

describe('صندوق الشركة — company_fund.manage', () => {
  it('starts empty and is visible to the general manager', async () => {
    const gm = await h.loginAs('gm')
    const res = await get(gm, '/company-fund')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().total).toBe(sypStr(0))
  })

  /** Was `profit.view_total`; the holders are the same two roles, now under the fund's own key. */
  it('is visible to the GM and the system admin only, under company_fund.manage (was profit.view_total)', async () => {
    expect((await get(await h.loginAs('gm'), '/company-fund')).statusCode).toBe(200)
    expect((await get(await h.loginAs('sysadmin'), '/company-fund')).statusCode).toBe(200)
    for (const who of ['manager', 'driver1']) {
      const res = await get(await h.loginAs(who), '/company-fund')
      expect(res.statusCode, who).toBe(403)
      expect(res.json()).toMatchObject({ error: 'forbidden', permission: 'company_fund.manage' })
    }
  })

  /**
   * THE GAP. The branch manager holds `journal.manual.write`, which is all these two routes used to
   * ask for. Refused now — and nothing reaches the ledger.
   */
  it('refuses the branch manager both writes, although he still holds journal.manual.write', async () => {
    const manager = await h.loginAs('manager')
    for (const url of ['/company-fund/deposit', '/company-fund/withdraw']) {
      const res = await post(manager, url, move(1_000, 'محاولة من مدير الفرع'))
      expect(res.statusCode, url).toBe(403)
      expect(res.json()).toMatchObject({ error: 'forbidden', permission: 'company_fund.manage' })
    }
    expect(companyLines()).toEqual([])
    // His manual-entry grant itself is untouched: an ordinary manual entry still posts.
    const manual = await post(manager, '/journal/manual', {
      reason: 'قيد عادي',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(10) },
        { fundCode: 'office_wallet', side: 'C', amount: sypStr(10) },
      ],
    })
    expect(manual.statusCode, manual.body).toBe(201)
  })

  it('takes a GM deposit and gives it back on withdrawal', async () => {
    const gm = await h.loginAs('gm')
    const put = await post(gm, '/company-fund/deposit', move(500_000, 'رأس مال'))
    expect(put.statusCode, put.body).toBe(201)
    expect(put.json()).toMatchObject({ balance: sypStr(500_000), replayed: false })

    const take = await post(gm, '/company-fund/withdraw', move(200_000, 'مسحوبات المالك'))
    expect(take.statusCode, take.body).toBe(201)
    expect(take.json()).toMatchObject({ balance: sypStr(300_000), replayed: false })
    expect((await get(gm, '/company-fund')).json().total).toBe(sypStr(300_000))

    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_equity:SYP_NEW:owner_funding')).toBe(-50_000_000n)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_equity:SYP_NEW:owner_drawings')).toBe(20_000_000n)
  })

  it('lets the system admin deposit and withdraw too', async () => {
    const sysadmin = await h.loginAs('sysadmin')
    expect((await post(sysadmin, '/company-fund/deposit', move(1_000, 'x'))).statusCode).toBe(201)
    expect((await post(sysadmin, '/company-fund/withdraw', move(400, 'y'))).statusCode).toBe(201)
    expect(await companyCash()).toBe(60_000n)
  })

  it('always targets HQ and no longer needs a named operating branch', async () => {
    const gm = await h.loginAs('gm')
    const { branchId: _omitted, ...unnamed } = move(1_000, 'x')
    const res = await post(gm, '/company-fund/deposit', unnamed)
    expect(res.statusCode, res.body).toBe(201)
    expect(await companyCash()).toBe(100_000n)
    expect(await companyBox()).toBe(0n)
  })

  it('refuses to withdraw more than it holds', async () => {
    const gm = await h.loginAs('gm')
    await post(gm, '/company-fund/deposit', move(1_000, 'x'))
    const res = await post(gm, '/company-fund/withdraw', move(5_000, 'too much'))
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: 'insufficient_funds', detail: { held: sypStr(1_000) } })
    expect(await companyCash()).toBe(100_000n)
  })

  /**
   * The balance check used to run BEFORE the posting, outside any lock: two withdrawals of the whole
   * balance could both read it and both post, leaving the fund negative. It now runs inside the
   * branch-money lock, so exactly one of them wins.
   */
  it('lets only one of two concurrent withdrawals of the whole balance through', async () => {
    const gm = await h.loginAs('gm')
    await post(gm, '/company-fund/deposit', move(1_000, 'seed'))
    const results = await Promise.all([
      post(gm, '/company-fund/withdraw', move(1_000, 'first')),
      post(gm, '/company-fund/withdraw', move(1_000, 'second')),
    ])
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422])
    expect(results.find((r) => r.statusCode === 422)!.json().error).toBe('insufficient_funds')
    expect(await companyCash()).toBe(0n)
  })

  it('requires a reason — money moved by decision must be answerable later', async () => {
    const gm = await h.loginAs('gm')
    const { reason: _omitted, ...noReason } = move(1_000, 'x')
    expect((await post(gm, '/company-fund/deposit', noReason)).statusCode).toBe(400)
    expect(companyLines()).toEqual([])
  })
})

describe('صندوق الشركة — a client idempotency key on every move', () => {
  it('requires the key, and requires it to be a UUID', async () => {
    const gm = await h.loginAs('gm')
    for (const url of ['/company-fund/deposit', '/company-fund/withdraw']) {
      const { idempotencyKey: _omitted, ...keyless } = move(1_000, 'x')
      expect((await post(gm, url, keyless)).statusCode, url).toBe(400)
      expect((await post(gm, url, { ...keyless, idempotencyKey: 'click-1' })).statusCode, url).toBe(400)
    }
    expect(companyLines()).toEqual([])
  })

  /** One button pressed twice, or pressed again after a lost response: one deposit. */
  it('answers a replayed deposit (same key, same body) with 200 and posts it once', async () => {
    const gm = await h.loginAs('gm')
    const body = move(500_000, 'رأس مال')
    const first = await post(gm, '/company-fund/deposit', body)
    expect(first.statusCode, first.body).toBe(201)

    const replay = await post(gm, '/company-fund/deposit', body)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ balance: sypStr(500_000), replayed: true })
    expect(await companyCash()).toBe(50_000_000n)
    expect(companyCashLines()).toHaveLength(1)
  })

  it('answers a concurrent double click with one deposit', async () => {
    const gm = await h.loginAs('gm')
    const body = move(700, 'نقرتان')
    const results = await Promise.all([post(gm, '/company-fund/deposit', body), post(gm, '/company-fund/deposit', body)])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 201])
    expect(await companyCash()).toBe(70_000n)
    expect(companyCashLines()).toHaveLength(1)
  })

  /**
   * The receipt is read before the balance guard: the first withdrawal emptied the fund, and its
   * retry must still get its own answer rather than a false «insufficient funds».
   */
  it('answers a replayed withdrawal with 200 even after it emptied the fund, and withdraws once', async () => {
    const gm = await h.loginAs('gm')
    await post(gm, '/company-fund/deposit', move(1_000, 'seed'))
    const body = move(1_000, 'كل الرصيد')
    expect((await post(gm, '/company-fund/withdraw', body)).statusCode).toBe(201)

    const replay = await post(gm, '/company-fund/withdraw', body)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ balance: sypStr(0), replayed: true })
    expect(await companyCash()).toBe(0n)
    expect(companyCashLines()).toHaveLength(2)
  })

  it('refuses the same key with a different amount or reason as 409 and posts nothing', async () => {
    const gm = await h.loginAs('gm')
    const body = move(500, 'أصل')
    expect((await post(gm, '/company-fund/deposit', body)).statusCode).toBe(201)
    for (const changed of [
      { ...body, amount: sypStr(501) },
      { ...body, reason: 'سبب آخر' },
    ]) {
      const res = await post(gm, '/company-fund/deposit', changed)
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json().error).toBe('idempotency_key_conflict')
    }
    expect(await companyCash()).toBe(50_000n)
    expect(companyCashLines()).toHaveLength(1)
  })

  /** One key, one decision: a deposit's key cannot later become a withdrawal. */
  it('refuses a deposit key reused for a withdrawal, and the reverse', async () => {
    const gm = await h.loginAs('gm')
    const deposit = move(500, 'إيداع')
    expect((await post(gm, '/company-fund/deposit', deposit)).statusCode).toBe(201)
    const asWithdrawal = await post(gm, '/company-fund/withdraw', deposit)
    expect(asWithdrawal.statusCode, asWithdrawal.body).toBe(409)
    expect(asWithdrawal.json().error).toBe('idempotency_key_conflict')

    const withdrawal = move(100, 'سحب')
    expect((await post(gm, '/company-fund/withdraw', withdrawal)).statusCode).toBe(201)
    expect((await post(gm, '/company-fund/deposit', withdrawal)).statusCode).toBe(409)
    // HQ commands and branch treasury commands are separate immutable ledgers.
    const asBranchDeposit = await post(gm, '/treasury/deposit', {
      idempotencyKey: deposit.idempotencyKey,
      target: 'cash',
      amount: sypStr(500),
      branchId: BRANCH,
    })
    expect(asBranchDeposit.statusCode, asBranchDeposit.body).toBe(201)
    expect(await companyCash()).toBe(40_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(50_000n)
  })

  it('treats the same key from another person as a conflict, not as his receipt', async () => {
    const body = move(500, 'رأس مال')
    expect((await post(await h.loginAs('gm'), '/company-fund/deposit', body)).statusCode).toBe(201)
    const other = await post(await h.loginAs('sysadmin'), '/company-fund/deposit', body)
    expect(other.statusCode, other.body).toBe(409)
    expect(companyCashLines()).toHaveLength(1)
  })
})

describe('/journal/manual never names صندوق الشركة', () => {
  const entryNaming = (fundCode: string): Payload => ({
    reason: 'قيد يدوي على صندوق الشركة',
    branchId: BRANCH,
    lines: [
      { fundCode, side: 'D', amount: sypStr(100) },
      { fundCode: 'opening_balance', side: 'C', amount: sypStr(100) },
    ],
  })

  /** For EVERY role that may post a manual entry — the GM's route is `/company-fund/*`. */
  it('refuses company_box with 422 company_fund_not_manual for the branch manager, the GM and the system admin', async () => {
    for (const who of ['manager', 'gm', 'sysadmin']) {
      const res = await post(await h.loginAs(who), '/journal/manual', entryNaming('company_box'))
      expect(res.statusCode, `${who}: ${res.body}`).toBe(422)
      expect(res.json()).toMatchObject({
        error: 'company_fund_not_manual',
        detail: { line: 0, fundCode: 'company_box' },
      })
    }
    expect(companyLines()).toEqual([])
    expect(h.deps.ledger.entries).toHaveLength(0)
  })

  it('refuses it on a credit line, and under a suffixed spelling the parser still reads as the fund', async () => {
    const manager = await h.loginAs('manager')
    const credit = await post(manager, '/journal/manual', {
      reason: 'سحب من صندوق الشركة',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(100) },
        { fundCode: 'company_box', side: 'C', amount: sypStr(100) },
      ],
    })
    expect(credit.statusCode).toBe(422)
    expect(credit.json().detail).toMatchObject({ line: 1 })

    // `fundRefFromCode('company_box:x')` IS the company fund, so a string comparison would miss it.
    const suffixed = await post(manager, '/journal/manual', entryNaming('company_box:alias'))
    expect(suffixed.statusCode).toBe(422)
    expect(suffixed.json().error).toBe('company_fund_not_manual')
    expect(h.deps.ledger.entries).toHaveLength(0)
  })

  it('still accepts the owner funding and drawings contra accounts', async () => {
    const manager = await h.loginAs('manager')
    for (const fundCode of ['owner_funding', 'owner_drawings']) {
      const res = await post(manager, '/journal/manual', {
        reason: `قيد ${fundCode}`,
        lines: [
          { fundCode: 'office_cash', side: 'D', amount: sypStr(100) },
          { fundCode, side: 'C', amount: sypStr(100) },
        ],
      })
      expect(res.statusCode, `${fundCode}: ${res.body}`).toBe(201)
    }
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(20_000n)
  })
})

describe('/treasury/withdraw — «كييش» by hand is company_fund.manage', () => {
  const kaish = (amount: number, over: Payload = {}): Payload => ({
    idempotencyKey: key(),
    target: 'cash',
    amount: sypStr(amount),
    to: 'company_box',
    reason: 'كييش — سحب أرباح اليوم',
    branchId: BRANCH,
    ...over,
  })

  it('moves branch cash into the company fund for the GM and the system admin', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(1_000_000))

    const byGm = await post(gm, '/treasury/withdraw', kaish(300_000))
    expect(byGm.statusCode, byGm.body).toBe(201)
    expect(byGm.json()).toMatchObject({ target: 'cash', balance: sypStr(700_000), replayed: false })

    const bySysadmin = await post(await h.loginAs('sysadmin'), '/treasury/withdraw', kaish(100_000))
    expect(bySysadmin.statusCode, bySysadmin.body).toBe(201)
    expect(bySysadmin.json().balance).toBe(sypStr(600_000))
    expect(await companyBox()).toBe(40_000_000n)
    expect((await get(gm, '/company-fund')).json().total).toBe(sypStr(0))
  })

  /** The gap this closes: the branch manager's hand «كييش» used to answer 201. */
  it('refuses the branch manager with 403 company_fund_forbidden and moves nothing (was 201)', async () => {
    const manager = await h.loginAs('manager')
    await fundBox(manager, 'cash', sypStr(1_000_000))
    await fundBox(manager, 'wallet', sypStr(1_000_000))
    const before = h.deps.ledger.entries.length
    for (const over of [{ target: 'cash' }, { target: 'wallet' }, { amount: sypStr(99_999_999) }]) {
      const res = await post(manager, '/treasury/withdraw', kaish(1_000, over))
      expect(res.statusCode, res.body).toBe(403)
      expect(res.json()).toMatchObject({
        error: 'company_fund_forbidden',
        detail: { permission: 'company_fund.manage', reason: 'no_grant_for_role' },
      })
    }
    expect(h.deps.ledger.entries).toHaveLength(before)
    expect(companyLines()).toEqual([])
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(100_000_000n)
  })

  it('posts a hand sweep as `manual` with the `kaish` role, never as `restoration`', async () => {
    /*
     * PRODUCTION, 2026-08-29: this route answered 500 every time it was pressed. `sweepToCompany`
     * stamps `event_type = 'restoration'`, and `restoration_journal_fact_from_entry` refuses any
     * restoration entry without an immutable `restorations` row in the same transaction. A hand
     * sweep has none of that, and the memory ledger has no triggers to show it — so the type is
     * asserted directly, because the type is the exact thing the database keys on.
     */
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(1_000_000))
    const res = await post(gm, '/treasury/withdraw', kaish(300_000))
    expect(res.statusCode, res.body).toBe(201)

    const swept = h.deps.ledger.entries.filter((e) => e.reason === 'كييش — سحب أرباح اليوم')
    expect(swept).toHaveLength(1)
    expect(swept[0]!.eventType).toBe('manual')
    // The MEANING travels on the line role the dashboard classifies by.
    expect(swept[0]!.lines.find((l) => l.side === 'D')).toMatchObject({ fundCode: 'company_box', role: 'kaish' })
  })

  /** Both boxes settle directly against صندوق الشركة — owner decision (l). */
  it('does the same for the wallet box', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'wallet', sypStr(100_000))
    const res = await post(gm, '/treasury/withdraw', kaish(40_000, { target: 'wallet', reason: 'كييش من المحفظة' }))
    expect(res.statusCode, res.body).toBe(201)
    expect((await get(gm, '/treasury/balances?branchId=' + BRANCH)).json().wallet).toBe(sypStr(60_000))
    expect(await companyBox()).toBe(4_000_000n)
    expect((await get(gm, '/company-fund')).json().total).toBe(sypStr(0))
  })

  it('requires the client key, and requires it to be a UUID', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(1_000))
    const before = h.deps.ledger.entries.length
    const { idempotencyKey: _omitted, ...keyless } = kaish(10)
    expect((await post(gm, '/treasury/withdraw', keyless)).statusCode).toBe(400)
    expect((await post(gm, '/treasury/withdraw', { ...keyless, idempotencyKey: 'click-1' })).statusCode).toBe(400)
    expect(h.deps.ledger.entries).toHaveLength(before)
  })

  /** It used to post under a fresh server UUID: one button pressed twice swept twice. */
  it('answers a replayed sweep (same key, same body) with 200 and sweeps once — even after it emptied the box', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(1_000))
    const body = kaish(1_000)
    expect((await post(gm, '/treasury/withdraw', body)).statusCode).toBe(201)

    const replay = await post(gm, '/treasury/withdraw', body)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toMatchObject({ balance: sypStr(0), replayed: true })
    expect(await companyBox()).toBe(100_000n)
    expect(companyLines()).toHaveLength(1)
  })

  it('answers a concurrent double click with one sweep', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(5_000))
    const body = kaish(700)
    const results = await Promise.all([post(gm, '/treasury/withdraw', body), post(gm, '/treasury/withdraw', body)])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 201])
    expect(await companyBox()).toBe(70_000n)
    expect(companyLines()).toHaveLength(1)
  })

  it('refuses the same key with a different amount, box, destination or reason as 409 and moves nothing more', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(10_000))
    await fundBox(gm, 'wallet', sypStr(10_000))
    const body = kaish(1_000)
    expect((await post(gm, '/treasury/withdraw', body)).statusCode).toBe(201)
    for (const changed of [
      { ...body, amount: sypStr(1_001) },
      { ...body, target: 'wallet' },
      { ...body, to: 'owner_drawings' },
      { ...body, reason: 'سبب آخر' },
    ]) {
      const res = await post(gm, '/treasury/withdraw', changed)
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json().error).toBe('idempotency_key_conflict')
    }
    // An HQ command key may also identify a branch command: their partitions are independent.
    const deposit = move(50, 'إيداع')
    expect((await post(gm, '/company-fund/deposit', deposit)).statusCode).toBe(201)
    const reused = await post(gm, '/treasury/withdraw', kaish(50, { idempotencyKey: deposit.idempotencyKey }))
    expect(reused.statusCode, reused.body).toBe(201)

    expect(await companyBox()).toBe(105_000n)
    expect(await companyCash()).toBe(5_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(895_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_wallet')).toBe(1_000_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'cost_center:owner_drawings')).toBe(0n)
  })

  /** The balance check runs inside the branch-money lock: two sweeps of the whole box, one wins. */
  it('lets only one of two concurrent sweeps of the whole box through', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(1_000))
    const results = await Promise.all([
      post(gm, '/treasury/withdraw', kaish(1_000, { reason: 'first' })),
      post(gm, '/treasury/withdraw', kaish(1_000, { reason: 'second' })),
    ])
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422])
    expect(results.find((r) => r.statusCode === 422)!.json().error).toBe('insufficient_funds')
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(0n)
    expect(await companyBox()).toBe(100_000n)
  })

  it('refuses to withdraw cash the box does not hold, to either destination', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(1_000))
    for (const to of ['company_box', 'owner_drawings']) {
      const res = await post(gm, '/treasury/withdraw', kaish(9_999, { to, reason: 'too much' }))
      expect(res.statusCode, to).toBe(422)
      expect(res.json()).toMatchObject({ error: 'insufficient_funds', detail: { held: sypStr(1_000) } })
    }
    expect(companyLines()).toEqual([])
  })

  it('has no default destination and accepts no free-text one', async () => {
    const manager = await h.loginAs('manager')
    await fundBox(manager, 'cash', sypStr(1_000))
    const base = { target: 'cash', amount: sypStr(10), reason: 'x' }
    expect((await post(manager, '/treasury/withdraw', { ...base, idempotencyKey: key() })).statusCode).toBe(400)
    for (const to of ['somewhere', 'cost_center:company_box', 'office_wallet', 'company_box:alias']) {
      const res = await post(manager, '/treasury/withdraw', { ...base, idempotencyKey: key(), to })
      expect(res.statusCode, to).toBe(400)
    }
    expect(companyLines()).toEqual([])
  })

  it('lets the branch manager take cash out to the owner drawings — that is not the company fund', async () => {
    const manager = await h.loginAs('manager')
    await fundBox(manager, 'cash', sypStr(1_000))
    const res = await post(manager, '/treasury/withdraw', {
      idempotencyKey: key(),
      target: 'cash',
      amount: sypStr(400),
      to: 'owner_drawings',
      reason: 'سحب المالك من الصندوق',
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().balance).toBe(sypStr(600))
    expect(await h.deps.ledger.fundBalance(BRANCH, 'cost_center:owner_drawings')).toBe(40_000n)
    expect(companyLines()).toEqual([])
  })

  /**
   * THE ROUND TRIP. A sweep followed by a replenishment of the same amount must leave both funds
   * exactly where they started — that is what makes الترميم safe to run every day for a year.
   */
  it('keeps pre-cutover HQ cash separate from the branch company box', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(500_000))
    expect((await post(gm, '/company-fund/deposit', move(200_000, 'seed'))).statusCode).toBe(201)

    expect((await post(gm, '/treasury/withdraw', kaish(120_000, { reason: 'كييش' }))).statusCode).toBe(201)
    // «شحن من الصندوق» is the manual inverse: the company fund puts the capital back.
    expect((await post(gm, '/company-fund/withdraw', move(120_000, 'شحن'))).statusCode).toBe(201)
    await fundBox(gm, 'cash', sypStr(120_000))

    expect((await get(gm, '/treasury/balances?branchId=' + BRANCH)).json().cash).toBe(sypStr(500_000))
    expect((await get(gm, '/company-fund')).json().total).toBe(sypStr(80_000))
    expect(await companyBox()).toBe(12_000_000n)
  })
})

describe('/journal/:entryId/reverse — undoing a company-fund movement is company_fund.manage', () => {
  const reverseAs = async (token: string, entryId: number): Promise<LightMyRequestResponse> =>
    await post(token, `/journal/${entryId}/reverse`, { reason: 'تصحيح ظاهر مؤرَّخ', branchId: BRANCH })
  const corrections = () => h.deps.ledger.entries.filter((e) => e.eventType === 'correction')
  const lastCompanyEntry = () =>
    [...h.deps.ledger.entries].reverse().find((e) => e.lines.some((l) =>
      l.fundCode === 'company_box' || l.fundCode === 'company_cash:SYP_NEW'))!

  it('does not expose HQ company commands through the branch journal reversal endpoint', async () => {
    const gm = await h.loginAs('gm')
    const manager = await h.loginAs('manager')
    expect((await post(gm, '/company-fund/deposit', move(5_000, 'رأس مال'))).statusCode).toBe(201)
    const deposit = lastCompanyEntry()

    const refused = await reverseAs(manager, deposit.id)
    expect(refused.statusCode, refused.body).toBe(404)
    expect(refused.json()).toMatchObject({ error: 'entry_not_found' })
    expect(corrections()).toEqual([])
    expect(await companyCash()).toBe(500_000n)

    const byGm = await reverseAs(gm, deposit.id)
    expect(byGm.statusCode, byGm.body).toBe(404)
    expect(await companyCash()).toBe(500_000n)

    expect((await post(gm, '/company-fund/deposit', move(700, 'ثان'))).statusCode).toBe(201)
    const bySysadmin = await reverseAs(await h.loginAs('sysadmin'), lastCompanyEntry().id)
    expect(bySysadmin.statusCode, bySysadmin.body).toBe(404)
    expect(await companyCash()).toBe(570_000n)
  })

  it('refuses the branch manager a hand «كييش» reversal; the GM may', async () => {
    const gm = await h.loginAs('gm')
    await fundBox(gm, 'cash', sypStr(1_000))
    const swept = await post(gm, '/treasury/withdraw', {
      idempotencyKey: key(),
      target: 'cash',
      amount: sypStr(1_000),
      to: 'company_box',
      reason: 'كييش',
      branchId: BRANCH,
    })
    expect(swept.statusCode, swept.body).toBe(201)
    const sweep = lastCompanyEntry()

    const refused = await reverseAs(await h.loginAs('manager'), sweep.id)
    expect(refused.statusCode, refused.body).toBe(403)
    expect(refused.json().error).toBe('company_fund_forbidden')
    expect(corrections()).toEqual([])

    expect((await reverseAs(gm, sweep.id)).statusCode).toBe(201)
    expect(await companyBox()).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(100_000n)
  })

  /** الترميم runs under the branch manager's own grant; undoing it moves the company fund. */
  it('refuses the branch manager a restoration reversal (it touches company_box); the GM may', async () => {
    const manager = await h.loginAs('manager')
    // 500,000 above the seeded 4,000,000 cash target; the wallet exactly on its 1,000,000 target.
    const seeded = await post(manager, '/journal/manual', {
      reason: 'رصيد افتتاحي',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(4_500_000) },
        { fundCode: 'office_wallet', side: 'D', amount: sypStr(1_000_000) },
        { fundCode: 'opening_balance', side: 'C', amount: sypStr(5_500_000) },
      ],
    })
    expect(seeded.statusCode, seeded.body).toBe(201)
    const restored = await post(manager, '/treasury/restoration', { reason: 'ترميم اليوم' })
    expect(restored.statusCode, restored.body).toBe(201)
    const restoration = h.deps.ledger.entries.find((e) => e.eventType === 'restoration')!
    expect(restoration.lines.some((l) => l.fundCode === 'company_box')).toBe(true)
    expect(await companyBox()).toBe(50_000_000n)

    const refused = await reverseAs(manager, restoration.id)
    expect(refused.statusCode, refused.body).toBe(403)
    expect(refused.json().error).toBe('company_fund_forbidden')
    expect(corrections()).toEqual([])

    const byGm = await reverseAs(await h.loginAs('gm'), restoration.id)
    expect(byGm.statusCode, byGm.body).toBe(201)
    expect(await companyBox()).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(450_000_000n)
  })

  it('keeps the existing rule for an entry that never touched the company fund', async () => {
    const manager = await h.loginAs('manager')
    const created = await post(manager, '/journal/manual', {
      reason: 'قيد خاطئ',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(7_000) },
        { fundCode: 'adjustments', side: 'C', amount: sypStr(7_000) },
      ],
    })
    expect(created.statusCode, created.body).toBe(201)
    const res = await reverseAs(manager, created.json().entryId as number)
    expect(res.statusCode, res.body).toBe(201)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(0n)
    expect(corrections()).toHaveLength(1)
  })
})

describe('a driver is refused everywhere', () => {
  it('cannot read or move the company fund, post or reverse an entry, deposit or withdraw', async () => {
    const gm = await h.loginAs('gm')
    expect((await post(gm, '/company-fund/deposit', move(10, 'x'))).statusCode).toBe(201)
    const entryId = h.deps.ledger.entries[0]!.id
    const before = h.deps.ledger.entries.length

    const driver = await h.loginAs('driver1')
    const attempts: Array<[string, Payload | null]> = [
      ['/company-fund', null],
      ['/company-fund/deposit', move(1, 'x')],
      ['/company-fund/withdraw', move(1, 'x')],
      [
        '/journal/manual',
        {
          reason: 'x',
          lines: [
            { fundCode: 'company_box', side: 'D', amount: sypStr(1) },
            { fundCode: 'opening_balance', side: 'C', amount: sypStr(1) },
          ],
        },
      ],
      [`/journal/${entryId}/reverse`, { reason: 'x' }],
      ['/treasury/deposit', { idempotencyKey: key(), target: 'cash', amount: sypStr(1) }],
      ['/treasury/withdraw', { idempotencyKey: key(), target: 'cash', amount: sypStr(1), to: 'company_box', reason: 'x' }],
      ['/treasury/withdraw', { idempotencyKey: key(), target: 'cash', amount: sypStr(1), to: 'owner_drawings', reason: 'x' }],
    ]
    for (const [url, payload] of attempts) {
      const res = payload === null ? await get(driver, url) : await post(driver, url, payload)
      expect(res.statusCode, url).toBe(403)
    }
    expect(h.deps.ledger.entries).toHaveLength(before)
  })
})
