import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, type Harness, makeHarness, sypStr, today } from './harness.ts'

/**
 * BR7: once the sysadmin seals a week, that week takes no NEW postings either.
 *
 * 0006 enforced immutability twice — REVOKE plus a trigger — but both key off
 * `journal_entries.week_lock_id`, which only `fin_seal_week()` ever writes, by UPDATE, at seal time.
 * A row inserted afterwards carries NULL, so `IF v_week_lock_id IS NULL THEN RETURN` waved it
 * through, and `fin_seal_week` can never stamp it because `week_locks_no_reopen` refuses to re-close
 * the lock. The entry sits inside a sealed week for ever: counted by `listByWeek`, exempt from the
 * immutability trigger, moving totals the owner already has a printed report for.
 *
 * Three routes reach it with a client-supplied date. Migration 0018 is the real guard; these tests
 * pin the application half, which turns the 25006 into a 409 a manager can read.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const post = async (t: string, url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(t) }, payload })

/**
 * The seeded clock sits on Tuesday 2026-07-21, inside the OPEN week of Sunday the 19th. The week we
 * seal is the one before it — which is the real shape: the sysadmin closes the week that ended, and
 * the fleet keeps working in the current one.
 */
const SEALED_START = '2026-07-12'
const SEALED_MIDWEEK = '2026-07-15' // a Wednesday inside the sealed week
const SEALED_END = '2026-07-18'

/**
 * A confirmed rate for the earlier week (BR6).
 *
 * The harness seeds one rate, for today. `resolveFxDay` carries the nearest EARLIER rate forward and
 * throws `FxError` when there is none, so any entry dated before the first rate 500s — a separate,
 * pre-existing rough edge, and not what these tests are about.
 */
async function rateFor(businessDate: string): Promise<void> {
  const admin = await h.loginAs('sysadmin')
  const res = await h.app.inject({
    method: 'PUT',
    url: '/fx',
    headers: { cookie: h.cookie(admin) },
    payload: { businessDate, sypMinorPerUsd: 13000 },
  })
  expect(res.statusCode, res.body).toBe(200)
}

/**
 * Seal the previous week directly through the repo.
 *
 * `POST /weeks/close` would need a legal close of that week — its seven days counted and its rates
 * confirmed — which is a lot of setup for a guarantee that begins where the close ends.
 * `create` + `seal` is exactly what the route performs.
 */
async function sealTheWeek(): Promise<void> {
  const lock = await h.deps.weekLocks.create({
    branchId: BRANCH,
    weekStartDate: SEALED_START,
    weekEndDate: SEALED_END,
    closedAtMs: null,
    closedBy: null,
  })
  await h.deps.weekLocks.seal(lock.id, 'u-sa', Date.now())
  expect(await h.deps.weekLocks.listClosedStarts(BRANCH)).toContain(SEALED_START)
}

describe('a sealed week refuses new postings', () => {
  it('the expense a manager back-dates into last week — the likeliest path of all', async () => {
    await sealTheWeek()
    const manager = await h.loginAs('manager')

    // Categories are `settings.write` — the sysadmin's, not the manager's.
    const admin = await h.loginAs('sysadmin')
    const cat = await post(admin, '/expense-categories', {
      code: 'charging',
      nameAr: 'شحن',
      nameEn: 'Charging',
      costCenterKind: 'branch',
    })
    expect(cat.statusCode, cat.body).toBe(201)

    const res = await post(manager, '/expenses', {
      categoryId: cat.json().id,
      costCenterKind: 'branch',
      vehicleId: null,
      amount: sypStr(250),
      businessDate: SEALED_MIDWEEK,
      description: 'فاتورة شحن الخميس',
    })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error).toBe('week_locked')

    // And nothing reached the ledger.
    expect(h.deps.ledger.entries.filter((e) => e.businessDate === SEALED_MIDWEEK)).toHaveLength(0)
  })

  it('a manual journal entry back-dated into the sealed week', async () => {
    await sealTheWeek()
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/journal/manual', {
      businessDate: SEALED_MIDWEEK,
      reason: 'تصحيح يدوي',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(1_000) },
        { fundCode: 'company_revenue', side: 'C', amount: sypStr(1_000) },
      ],
      evidenceMediaId: null,
    })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error).toBe('week_locked')
  })

  it('a cash count back-dated into the sealed week', async () => {
    await sealTheWeek()
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/cash-counts', {
      businessDate: SEALED_MIDWEEK,
      lines: [{ fundCode: 'office_cash', counted: sypStr(0) }],
    })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error).toBe('week_locked')
  })

  it('the SAME writes are fine in the open week — the guard is not a blanket refusal', async () => {
    await sealTheWeek()
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/journal/manual', {
      businessDate: today,
      reason: 'قيد في أسبوع مفتوح',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(1_000) },
        { fundCode: 'company_revenue', side: 'C', amount: sypStr(1_000) },
      ],
      evidenceMediaId: null,
    })
    expect(res.statusCode, res.body).toBe(201)
  })
})

describe('a correction against a sealed week is re-homed, not refused', () => {
  it('keeps its date while the week is open, and moves to today once it is sealed', async () => {
    const manager = await h.loginAs('manager')

    // Post a manual entry in the OPEN week (today = Tuesday 2026-07-21).
    const created = await post(manager, '/journal/manual', {
      businessDate: today,
      reason: 'قيد أصلي',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(2_000) },
        { fundCode: 'company_revenue', side: 'C', amount: sypStr(2_000) },
      ],
      evidenceMediaId: null,
    })
    expect(created.statusCode, created.body).toBe(201)
    const entryId = created.json().entryId as number

    // Reversing while the week is open keeps the original business date — unchanged behaviour.
    const open = await post(manager, `/journal/${entryId}/reverse`, { reason: 'خطأ في المبلغ' })
    expect(open.statusCode, open.body).toBe(201)
    expect(open.json().rehomed).toBe(false)
    expect(open.json().businessDate).toBe(today)
  })

  it('a correction against a SEALED week books into the open week instead', async () => {
    const manager = await h.loginAs('manager')
    await rateFor(SEALED_MIDWEEK)
    // Written while nothing is sealed, dated into the week that is about to be closed — the
    // ordinary case: an entry made during the week, and a mistake noticed after the Sunday close.
    const created = await post(manager, '/journal/manual', {
      businessDate: SEALED_MIDWEEK,
      reason: 'قيد أصلي',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(2_000) },
        { fundCode: 'company_revenue', side: 'C', amount: sypStr(2_000) },
      ],
      evidenceMediaId: null,
    })
    expect(created.statusCode, created.body).toBe(201)
    const entryId = created.json().entryId as number

    await sealTheWeek()
    const res = await post(manager, `/journal/${entryId}/reverse`, { reason: 'تصحيح بعد الإغلاق' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().rehomed).toBe(true)

    // The correction did NOT land back inside the sealed week — which is the whole guarantee.
    const reversal = h.deps.ledger.entries.find((e) => e.id === res.json().reversalEntryId)
    expect(reversal).toBeDefined()
    expect(reversal!.weekStartDate).not.toBe(SEALED_START)
    expect(reversal!.businessDate > SEALED_END).toBe(true)
    expect(reversal!.businessDate).toBe(today)

    // And the sealed week's own totals are untouched: it still holds only the original entry.
    const inSealed = h.deps.ledger.entries.filter((e) => e.weekStartDate === SEALED_START)
    expect(inSealed).toHaveLength(1)
    expect(inSealed[0]!.id).toBe(entryId)
  })

  it('refuses outright when there is no open week left to book the correction into', async () => {
    const manager = await h.loginAs('manager')
    await rateFor(SEALED_MIDWEEK)
    const created = await post(manager, '/journal/manual', {
      businessDate: SEALED_MIDWEEK,
      reason: 'قيد أصلي',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(2_000) },
        { fundCode: 'company_revenue', side: 'C', amount: sypStr(2_000) },
      ],
      evidenceMediaId: null,
    })
    const entryId = created.json().entryId as number

    await sealTheWeek()
    // Seal the CURRENT week too. The close route would never do this — it only ever seals the week
    // before the closing Sunday — but `checkWeekClose` has no future-date blocker, so re-homing must
    // not assume an open week exists. A clear 409 beats a posting that lands in a sealed week.
    const current = await h.deps.weekLocks.create({
      branchId: BRANCH,
      weekStartDate: '2026-07-19',
      weekEndDate: '2026-07-25',
      closedAtMs: null,
      closedBy: null,
    })
    await h.deps.weekLocks.seal(current.id, 'u-sa', Date.now())

    const res = await post(manager, `/journal/${entryId}/reverse`, { reason: 'تصحيح' })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error).toBe('week_locked')
  })
})
