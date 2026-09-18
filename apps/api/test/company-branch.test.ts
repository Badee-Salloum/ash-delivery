import { randomUUID } from 'node:crypto'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JournalEntryRecord } from '@ash/contracts'
import { minor, weekStartFor } from '@ash/domain'
import { COMPANY_BRANCH } from '../src/seed.ts'
import { BRANCH, GOV_DAMASCUS, type Harness, makeHarness, sypStr } from './harness.ts'

/**
 * «صندوق الشركة» lives in its own ledger, under a company (HQ) row that is NOT a branch (C1).
 *
 * The row exists so the ledger's machinery — fund identity, week locks, sealing — works for the
 * company unchanged. What must never happen is a branch screen or a branch permission treating it
 * as one more branch: reading its "treasury", posting a manual entry into it, counting its drawer.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
  // What migration 0066 and seedReferenceData leave in every database.
  h.deps.directory.branches.set(COMPANY_BRANCH, {
    id: COMPANY_BRANCH,
    code: 'HQ',
    nameAr: 'صندوق الشركة',
    nameEn: 'Company',
    governorateId: GOV_DAMASCUS,
    branchNo: 0,
    timezone: 'Asia/Damascus',
    lat: null,
    lng: null,
    checkinRadiusM: 150,
    kind: 'company',
  })
})
afterEach(async () => {
  await h.app.close()
})

const request = async (
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  await h.app.inject({
    method,
    url,
    headers: { cookie: h.cookie(token) },
    ...(payload === undefined ? {} : { payload }),
  })

const expectNotAddressable = (res: LightMyRequestResponse, label: string): void => {
  expect(res.statusCode, `${label}: ${res.body}`).toBe(403)
  expect(res.json().error, label).toBe('company_branch_not_addressable')
}

describe('the company row is not addressable by a branch permission', () => {
  it('refuses the branch manager by name, not as «another branch»', async () => {
    const manager = await h.loginAs('manager')
    const res = await request(manager, 'GET', `/receivables?branchId=${COMPANY_BRANCH}`)
    expectNotAddressable(res, 'manager receivables')
    // His own branch still answers.
    expect((await request(manager, 'GET', `/receivables?branchId=${BRANCH}`)).statusCode).toBe(200)
  })

  it('refuses the general manager and the system admin too, whose scope is `all`', async () => {
    for (const who of ['gm', 'sysadmin']) {
      const token = await h.loginAs(who)
      expectNotAddressable(await request(token, 'GET', `/receivables?branchId=${COMPANY_BRANCH}`), `${who} receivables`)
      expectNotAddressable(await request(token, 'GET', `/treasury/balances?branchId=${COMPANY_BRANCH}`), `${who} balances`)
      expectNotAddressable(
        await request(token, 'GET', `/treasury/restoration/preview?branchId=${COMPANY_BRANCH}`),
        `${who} restoration preview`,
      )
      // Organisation-wide reads that declare no subject still name a branch in the query.
      expectNotAddressable(await request(token, 'GET', `/dashboard/treasury?branchId=${COMPANY_BRANCH}`), `${who} dashboard`)
      expectNotAddressable(await request(token, 'GET', `/dashboard/profit?branchId=${COMPANY_BRANCH}`), `${who} profit`)
      // A branch read of a real branch still works for them.
      expect((await request(token, 'GET', `/dashboard/treasury?branchId=${BRANCH}`)).statusCode, who).toBe(200)
    }
  })

  it('refuses every branch-money write aimed at it', async () => {
    const admin = await h.loginAs('sysadmin')
    expectNotAddressable(
      await request(admin, 'POST', '/journal/manual', {
        branchId: COMPANY_BRANCH,
        reason: 'قيد على صندوق الشركة',
        lines: [
          { fundCode: 'office_cash', side: 'D', amount: sypStr(1) },
          { fundCode: 'owner_funding', side: 'C', amount: sypStr(1) },
        ],
      }),
      'manual entry',
    )
    expectNotAddressable(
      await request(admin, 'POST', '/cash-counts', {
        branchId: COMPANY_BRANCH,
        businessDate: '2026-07-21',
        lines: [{ fundCode: 'office_cash', counted: sypStr(0) }],
      }),
      'cash count',
    )
    expectNotAddressable(
      await request(admin, 'POST', '/treasury/restoration', { branchId: COMPANY_BRANCH, reason: 'ترميم' }),
      'restoration',
    )
    expect(h.deps.ledger.entries).toHaveLength(0)
  })

  it('routes legacy company-fund moves to HQ even when a stale client sends the HQ branch id', async () => {
    const gm = await h.loginAs('gm')
    for (const url of ['/company-fund/deposit', '/company-fund/withdraw']) {
      const res = await request(gm, 'POST', url, {
        branchId: COMPANY_BRANCH,
        idempotencyKey: randomUUID(),
        amount: sypStr(10),
        reason: 'حركة عبر المسار القديم',
      })
      expect(res.statusCode, `${url}: ${res.body}`).toBe(201)
      expect(res.json().command.branchId).toBe(COMPANY_BRANCH)
    }
    expect(h.deps.ledger.entries).toHaveLength(2)
  })

  it('still lets the company permissions reach it: audit', async () => {
    const gm = await h.loginAs('gm')
    const res = await request(gm, 'GET', `/operation-removals?branchId=${COMPANY_BRANCH}`)
    expect(res.statusCode, res.body).toBe(200)
  })
})

describe('the company row is not a branch on any branch screen', () => {
  it('is not listed', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await request(admin, 'GET', '/branches')
    expect(res.statusCode).toBe(200)
    const ids = (res.json().branches as Array<{ id: string; kind: string }>).map((b) => b.id)
    expect(ids).toContain(BRANCH)
    expect(ids).not.toContain(COMPANY_BRANCH)
    expect((res.json().branches as Array<{ kind: string }>).every((b) => b.kind === 'branch')).toBe(true)
  })

  it('is not summed into the legacy company fund view as a branch', async () => {
    const gm = await h.loginAs('gm')
    const res = await request(gm, 'GET', '/company-fund')
    expect(res.statusCode).toBe(200)
    expect((res.json().branches as Array<{ branchId: string }>).map((b) => b.branchId)).not.toContain(COMPANY_BRANCH)
  })

  it('cannot be edited through the branch route', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await request(admin, 'PATCH', `/branches/${COMPANY_BRANCH}`, { nameAr: 'فرع' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('branch_not_found')
    expect((await h.deps.directory.branch(COMPANY_BRANCH))?.nameAr).toBe('صندوق الشركة')
  })

  it('is never created by the branch route, whatever the body says', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await request(admin, 'POST', '/branches', {
      code: 'HMS',
      nameAr: 'حمص',
      nameEn: 'Homs',
      governorateId: GOV_DAMASCUS,
      branchNo: 7,
      kind: 'company',
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().kind).toBe('branch')
    expect((await h.deps.directory.branch(res.json().id))?.kind).toBe('branch')
    expect((await h.deps.directory.companyBranch())?.id).toBe(COMPANY_BRANCH)
  })
})

describe('the company week closes on its own terms', () => {
  const CLOSE_DATE = '2026-07-26'
  const WEEK = ['2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25']

  async function confirmRates(admin: string): Promise<void> {
    for (const businessDate of WEEK) {
      await request(admin, 'PUT', '/fx', { businessDate, sypMinorPerUsd: 13000 })
    }
  }

  const companyEntry = (id: number, lines: JournalEntryRecord['lines'], rate: bigint | null): JournalEntryRecord => ({
    id,
    branchId: COMPANY_BRANCH,
    eventType: 'company_correction',
    shiftId: null,
    occurrenceKey: `c1-week-${id}`,
    businessDate: '2026-07-21',
    postingDate: '2026-07-21',
    weekStartDate: weekStartFor('2026-07-21'),
    fxDayId: 1,
    sypMinorPerUsd: rate,
    weekLockId: null,
    reason: 'company week fixture',
    createdBy: 'u-gm',
    lines,
  })

  it('owes no daily cash count — nobody opens a drawer there', async () => {
    const admin = await h.loginAs('sysadmin')
    await confirmRates(admin)
    // The branch, uncounted, is still refused for exactly that…
    const branch = await request(admin, 'POST', '/weeks/close', { closeDate: CLOSE_DATE, branchId: BRANCH })
    expect(branch.statusCode).toBe(422)
    expect((branch.json().blockers as Array<{ kind: string }>).map((b) => b.kind)).toContain('missing_cash_counts')
    // …while the company week, equally uncounted, seals.
    const company = await request(admin, 'POST', '/weeks/close', { closeDate: CLOSE_DATE, branchId: COMPANY_BRANCH })
    expect(company.statusCode, company.body).toBe(200)
    expect(company.json()).toMatchObject({ weekStart: '2026-07-19', weekEnd: '2026-07-25' })
    expect(await h.deps.weekLocks.listClosedStarts(COMPANY_BRANCH)).toEqual(['2026-07-19'])
    expect(await h.deps.weekLocks.listClosedStarts(BRANCH)).toEqual([])
  })

  it('judges the trial balance per currency: $1.00 up and 100 lira-minor down is two broken books', async () => {
    const admin = await h.loginAs('sysadmin')
    await confirmRates(admin)
    // Posted straight into the fake: no route may produce this, which is the point of refusing it.
    h.deps.ledger.entries.push(
      companyEntry(
        90_001,
        [
          { fundCode: 'company_cash:USD', side: 'D', amount: minor(100n), currency: 'USD' },
          { fundCode: 'company_cash:SYP_NEW', side: 'C', amount: minor(100n), currency: 'SYP_NEW' },
        ],
        13_000n,
      ),
    )
    const res = await request(admin, 'POST', '/weeks/close', { closeDate: CLOSE_DATE, branchId: COMPANY_BRANCH })
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error).toBe('week_not_closable')
    expect(res.json().blockers).toEqual([
      { kind: 'trial_balance_not_zero', diff: '-1.00', currency: 'SYP_NEW' },
      { kind: 'trial_balance_not_zero', diff: '1.00', currency: 'USD' },
    ])
    expect(await h.deps.weekLocks.listClosedStarts(COMPANY_BRANCH)).toEqual([])
  })

  it('seals a week whose every currency foots, dollars included', async () => {
    const admin = await h.loginAs('sysadmin')
    await confirmRates(admin)
    h.deps.ledger.entries.push(
      companyEntry(
        90_002,
        [
          { fundCode: 'company_fx_position:USD', side: 'D', amount: minor(5_000n), currency: 'USD' },
          { fundCode: 'company_cash:USD', side: 'C', amount: minor(5_000n), currency: 'USD' },
          { fundCode: 'company_cash:SYP_NEW', side: 'D', amount: minor(650_000n), currency: 'SYP_NEW' },
          { fundCode: 'company_fx_position:SYP_NEW', side: 'C', amount: minor(650_000n), currency: 'SYP_NEW' },
        ],
        13_000n,
      ),
    )
    const res = await request(admin, 'POST', '/weeks/close', { closeDate: CLOSE_DATE, branchId: COMPANY_BRANCH })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().entriesSealed).toBe(1)
  })
})
