import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, type Harness, makeHarness, sypStr } from './harness.ts'

/**
 * The Sunday close (BR7 / E-6, acceptance criterion #9).
 *
 * The week runs Sunday 00:00 → Saturday 23:59 Asia/Damascus and is closed by the SYSTEM ADMIN on
 * the following Sunday. A shift worked on the closing Sunday belongs to the NEW week.
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

/** The seeded clock sits on Tuesday 2026-07-21, inside the week of Sunday the 19th. */
const CLOSE_DATE = '2026-07-26' // the following Sunday
const WEEK = ['2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25']

async function countEveryDay(): Promise<void> {
  const manager = await h.loginAs('manager')
  for (const businessDate of WEEK) {
    await post(manager, '/cash-counts', {
      businessDate,
      lines: [{ fundCode: 'office_cash', counted: sypStr(0) }],
    })
  }
}

/**
 * Confirm the day's rate. The app seeds a PROVISIONAL rate at boot so posting is never blocked
 * on a missing one — but the close then refuses to seal a week still carrying it, which is the
 * whole point of the flag. Confirming it is part of a clean week.
 */
async function confirmRates(): Promise<void> {
  const admin = await h.loginAs('sysadmin')
  for (const businessDate of WEEK) {
    await h.app.inject({
      method: 'PUT',
      url: '/fx',
      headers: { cookie: h.cookie(admin) },
      payload: { businessDate, sypMinorPerUsd: 13000 },
    })
  }
}

describe('who may close the week', () => {
  it('is the system admin, and nobody else (§3 matrix)', async () => {
    for (const [user, allowed] of [
      ['sysadmin', true],
      ['gm', false],
      ['manager', false],
      ['driver1', false],
    ] as const) {
      const token = await h.loginAs(user)
      const res = await post(token, '/weeks/close', { closeDate: CLOSE_DATE, branchId: BRANCH })
      expect(res.statusCode === 403, user).toBe(!allowed)
    }
  })
})

/**
 * The regression that made every other test in this file a lie.
 *
 * `week.close` is granted to the system admin ALONE, and a system admin is organisation-wide:
 * `bootstrap.ts` and `POST /users` both force `branchId = null` for that role, so a branched
 * sysadmin is a shape production cannot produce. The route nonetheless read the branch off the
 * session and 422'd — meaning BR7's Sunday close, the moment a week's entries become immutable,
 * was unperformable by any real account. The suite stayed green only because these tests seeded
 * an impossible actor with a branch attached.
 */
describe('the system admin can close the week he actually is (SRS BR7)', () => {
  it('has no branch on his session — the production shape, not a test fixture', async () => {
    const admin = await h.loginAs('sysadmin')
    const me = await h.app.inject({ method: 'GET', url: '/me', headers: { cookie: h.cookie(admin) } })
    expect(me.json().branchId).toBeNull()
  })

  it('names the branch he is sealing and the close proceeds to its real checks', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/weeks/close', { closeDate: CLOSE_DATE, branchId: BRANCH })
    // 422 `week_not_closable` — a pre-flight blocker, i.e. the close RAN. The bug returned
    // `branch_required_for_close` before ever reaching a business rule.
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('week_not_closable')
  })

  it('naming no branch is refused with a reason, not silence', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/weeks/close', { closeDate: CLOSE_DATE })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('branch_required')
  })

  it('and a clean week really does seal, driven by that same branch-less admin', async () => {
    await countEveryDay()
    await confirmRates()
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/weeks/close', { closeDate: CLOSE_DATE, branchId: BRANCH })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().weekStart).toBe('2026-07-19')
  })
})

describe('the pre-flight refuses an unready week', () => {
  it('blocks when a day was never physically counted (E-5)', async () => {
    // This is the check that was a placeholder until cash counts existed. Without it a week
    // could be sealed with drawers nobody ever opened.
    const admin = await h.loginAs('sysadmin')

    const res = await post(admin, '/weeks/close', { closeDate: CLOSE_DATE, branchId: BRANCH })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('week_not_closable')

    const kinds = (res.json().blockers as Array<{ kind: string; dates?: string[] }>).map((b) => b.kind)
    expect(kinds).toContain('missing_cash_counts')
    const missing = (res.json().blockers as Array<{ kind: string; dates?: string[] }>).find(
      (b) => b.kind === 'missing_cash_counts',
    )
    expect(missing?.dates).toEqual(WEEK)
  })

  it('refuses to close on any day that is not a Sunday', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/weeks/close', { closeDate: '2026-07-25', branchId: BRANCH }) // a Saturday
    expect(res.statusCode).toBe(422)
    expect((res.json().blockers as Array<{ kind: string }>)[0]?.kind).toBe('not_a_sunday')
  })
})

describe('a clean week closes and seals its entries', () => {

  it('seals the week of the 19th–25th when closing on the 26th', async () => {
    await countEveryDay()
    await confirmRates()
    const admin = await h.loginAs('sysadmin')

    const res = await post(admin, '/weeks/close', { closeDate: CLOSE_DATE, branchId: BRANCH })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().weekStart).toBe('2026-07-19')
    expect(res.json().weekEnd).toBe('2026-07-25')
  })

  it('stamps the week lock onto that week’s entries', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/journal/manual', {
      reason: 'قيد ضمن الأسبوع',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(1_000) },
        { fundCode: 'adjustments', side: 'C', amount: sypStr(1_000) },
      ],
    })
    await countEveryDay()
    await confirmRates()

    const admin = await h.loginAs('sysadmin')
    const res = await post(admin, '/weeks/close', { closeDate: CLOSE_DATE, branchId: BRANCH })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().entriesSealed).toBeGreaterThan(0)

    // Every entry of that week now carries a lock id — the DB guard keys off exactly this.
    const sealed = h.deps.ledger.entries.filter((e) => e.weekStartDate === '2026-07-19')
    expect(sealed.length).toBeGreaterThan(0)
    expect(sealed.every((e) => e.weekLockId !== null)).toBe(true)
  })

  it('refuses to close the same week twice', async () => {
    await countEveryDay()
    await confirmRates()
    const admin = await h.loginAs('sysadmin')
    expect((await post(admin, '/weeks/close', { closeDate: CLOSE_DATE, branchId: BRANCH })).statusCode).toBe(200)

    const second = await post(admin, '/weeks/close', { closeDate: CLOSE_DATE, branchId: BRANCH })
    expect(second.statusCode).toBe(422)
    expect((second.json().blockers as Array<{ kind: string }>).map((b) => b.kind)).toContain('already_closed')
  })
})
