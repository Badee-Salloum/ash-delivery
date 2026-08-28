import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, type Harness, makeHarness, sypStr } from './harness.ts'

/**
 * The system-settings surface (SRS A-4): the daily FX rate and the general operating constants —
 * both had endpoints/enforcement but, until now, no screen and (for FX) no read route or audit.
 *
 * These pin the three things that matter: only the system admin may read or write them; the FX
 * write is audited (it gates every day's USD figures and the Sunday close); and a ceiling set
 * through /settings is actually ENFORCED on the expense path, which is the whole point of the
 * "approval-ceiling editor".
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

type Payload = Record<string, unknown>
const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })
const put = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload })
const post = async (token: string, url: string, payload: Payload = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })

describe('the daily FX rate (BR6)', () => {
  it('a system admin enters today’s rate and reads it back as entered', async () => {
    const admin = await h.loginAs('sysadmin')
    const today = (await get(admin, '/fx')).json().businessDate

    // 130.00 SYP/USD = 13000 minor units per USD.
    const set = await put(admin, '/fx', { businessDate: today, sypMinorPerUsd: 13_000 })
    expect(set.statusCode, set.body).toBe(200)

    const read = await get(admin, '/fx')
    expect(read.json().sypMinorPerUsd).toBe(13_000)
    expect(read.json().provisional).toBe(false)
  })

  it('audits the rate change — it gates every day’s USD figures and the Sunday close', async () => {
    const admin = await h.loginAs('sysadmin')
    const today = (await get(admin, '/fx')).json().businessDate
    await put(admin, '/fx', { businessDate: today, sypMinorPerUsd: 13_500 })

    const rows = await h.deps.audit.list({ tableName: 'fx_days' })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.actorId === 'u-sa')).toBe(true)
  })

  it('is refused to a general manager and a branch manager', async () => {
    const today = '2026-07-21'
    expect((await put(await h.loginAs('gm'), '/fx', { businessDate: today, sypMinorPerUsd: 13_000 })).statusCode).toBe(403)
    expect((await put(await h.loginAs('manager'), '/fx', { businessDate: today, sypMinorPerUsd: 13_000 })).statusCode).toBe(403)
    expect((await get(await h.loginAs('gm'), '/fx')).statusCode).toBe(403)
  })
})

describe('general settings', () => {
  it('a system admin sets the receipt ceiling and the kWh price, and reads them back', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await put(admin, '/settings', { receiptCeilingMinor: sypStr(10_000), kwhPriceMinor: sypStr(250) })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().updated).toEqual(
      expect.arrayContaining(['expense.receipt_required_above_minor', 'vehicle.kwh_price_minor']),
    )

    const read = await get(admin, '/settings')
    expect(read.json().receiptCeilingMinor).toBe(sypStr(10_000))
    expect(read.json().kwhPriceMinor).toBe(sypStr(250))
  })

  it('changing one setting leaves the other alone', async () => {
    const admin = await h.loginAs('sysadmin')
    await put(admin, '/settings', { receiptCeilingMinor: sypStr(10_000), kwhPriceMinor: sypStr(250) })
    await put(admin, '/settings', { kwhPriceMinor: sypStr(300) })

    const read = await get(admin, '/settings')
    expect(read.json().receiptCeilingMinor).toBe(sypStr(10_000)) // untouched
    expect(read.json().kwhPriceMinor).toBe(sypStr(300))
  })

  it('is refused to a general manager and a branch manager', async () => {
    expect((await get(await h.loginAs('gm'), '/settings')).statusCode).toBe(403)
    expect((await put(await h.loginAs('manager'), '/settings', { kwhPriceMinor: sypStr(1) })).statusCode).toBe(403)
  })

  it('the write is audited', async () => {
    const admin = await h.loginAs('sysadmin')
    await put(admin, '/settings', { receiptCeilingMinor: sypStr(10_000) })
    const rows = await h.deps.audit.list({ tableName: 'settings' })
    expect(rows.some((r) => r.actorId === 'u-sa')).toBe(true)
  })
})

describe('the ceiling set through /settings is actually enforced', () => {
  const category = async (admin: string): Promise<string> =>
    (await post(admin, '/expense-categories', { code: 'FUEL', nameAr: 'وقود' })).json().id

  it('an over-ceiling expense needs a receipt; under-ceiling does not', async () => {
    // This is the point of the editor: the value it writes is the one the expense path reads.
    const admin = await h.loginAs('sysadmin')
    const categoryId = await category(admin)
    await put(admin, '/settings', { receiptCeilingMinor: sypStr(10_000) })

    const manager = await h.loginAs('manager')
    const base = { categoryId, costCenterKind: 'general', vehicleId: null, description: 'وقود' }

    const over = await post(manager, '/expenses', { ...base, idempotencyKey: crypto.randomUUID(), amount: sypStr(25_000) })
    expect(over.statusCode).toBe(422)
    expect(over.json().error).toBe('receipt_required')

    const withReceipt = await post(manager, '/expenses', {
      ...base,
      idempotencyKey: crypto.randomUUID(),
      amount: sypStr(25_000),
      receiptMediaId: '00000000-0000-4000-8000-000000000abc',
    })
    expect(withReceipt.statusCode, withReceipt.body).toBe(201)

    const under = await post(manager, '/expenses', { ...base, idempotencyKey: crypto.randomUUID(), amount: sypStr(5_000) })
    expect(under.statusCode, under.body).toBe(201)
  })
})

/**
 * «تاريخ بدء التطبيق» — the go-live date (owner request, 2026-08-28).
 *
 * The owner ran the platform for five days as a trial before real operations began, and wanted the
 * figures to start on a date he names rather than carry that trial forever.
 *
 * THE POINT OF THE CEREMONY GATE. Declaring the date only clamps FLOW reports. Balances stay
 * cumulative on purpose — `fundBalance` is a CONTROL read (it feeds the insufficient-funds guards,
 * the cash-count baseline, `cash_count_stale`, and the restoration plan), so date-filtering it
 * would make the drawer look empty. What actually makes flows and balances agree from the epoch
 * forward is a sealed count plus a restoration, which puts each box on its capital target. So the
 * date cannot be set until that has happened — otherwise "ignore everything before" is a half
 * truth: the headline figures restart while the boxes silently carry the trial period.
 */
describe('the go-live date (تاريخ بدء التطبيق)', () => {
  const seedFund = async (token: string, fundCode: string, amount: string): Promise<void> => {
    const res = await post(token, '/journal/manual', {
      reason: 'رصيد افتتاحي',
      lines: [
        { fundCode, side: 'D', amount },
        { fundCode: 'opening_balance', side: 'C', amount },
      ],
    })
    expect(res.statusCode, res.body).toBe(201)
  }

  /** The opening ceremony, made of existing audited routes: count the boxes, then restore them. */
  const performOpeningCeremony = async (): Promise<string> => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_000_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    const counted = await post(manager, '/cash-counts', {
      lines: [
        { fundCode: 'office_cash', counted: sypStr(4_000_000) },
        { fundCode: 'office_wallet', counted: sypStr(1_000_000) },
      ],
    })
    expect(counted.statusCode, counted.body).toBe(201)
    const restored = await post(manager, '/treasury/restoration', { reason: 'ترميم الافتتاح' })
    expect(restored.statusCode, restored.body).toBe(201)
    return counted.json().businessDate as string
  }

  it('is unset until it is declared', async () => {
    const admin = await h.loginAs('sysadmin')
    expect((await get(admin, '/settings')).json().goLiveBusinessDate).toBeNull()
  })

  it('refuses a date whose boxes were never counted and restored', async () => {
    const admin = await h.loginAs('sysadmin')
    const res = await put(admin, '/settings', { goLiveBusinessDate: '2026-07-21', branchId: BRANCH })
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error).toBe('go_live_requires_opening_ceremony')
    // Names what is missing, so the screen can say it rather than just refusing.
    expect(res.json().detail.missing).toEqual(['sealed_cash_count', 'restoration'])
    expect((await get(admin, '/settings')).json().goLiveBusinessDate).toBeNull()
  })

  it('accepts the date once the boxes have been counted and restored, and reads it back', async () => {
    const date = await performOpeningCeremony()
    const admin = await h.loginAs('sysadmin')
    const res = await put(admin, '/settings', { goLiveBusinessDate: date, branchId: BRANCH })
    expect(res.statusCode, res.body).toBe(200)
    expect((await get(admin, '/settings')).json().goLiveBusinessDate).toBe(date)
  })

  it('can be cleared, which returns every report to the whole history', async () => {
    const date = await performOpeningCeremony()
    const admin = await h.loginAs('sysadmin')
    await put(admin, '/settings', { goLiveBusinessDate: date, branchId: BRANCH })
    expect((await put(admin, '/settings', { goLiveBusinessDate: null })).statusCode).toBe(200)
    expect((await get(admin, '/settings')).json().goLiveBusinessDate).toBeNull()
  })

  it('is system-admin only, like every other operating constant', async () => {
    const manager = await h.loginAs('manager')
    expect((await put(manager, '/settings', { goLiveBusinessDate: '2026-07-21' })).statusCode).toBe(403)
  })

  it('does not demand a cash count for days before it — a mid-week go-live must still seal', async () => {
    // The worst failure this feature could introduce. The week close demands a sealed count for
    // EVERY day of the week; a day before go-live was never operated and can never acquire one,
    // so without the skip the first week would be permanently unsealable and BR7 blocked forever.
    const date = await performOpeningCeremony()
    const admin = await h.loginAs('sysadmin')
    expect((await put(admin, '/settings', { goLiveBusinessDate: date, branchId: BRANCH })).statusCode).toBe(200)

    const res = await post(admin, '/weeks/close', { closeDate: '2026-07-26', branchId: BRANCH })
    const blockers: string[] = res.json().blockers ?? []
    expect(blockers, res.body).not.toContain('cash_count_missing')
  })
})

/**
 * The second proof: the position is ALREADY on capital.
 *
 * Requiring the ceremony alone was a design error. The restoration settles the office boxes and
 * deliberately excludes active custody, so it can only run when no shift is live — at the END of a
 * day. That made declaring go-live ON the first day impossible, and a first day is exactly when an
 * owner declares one. Working capital equal to the target with an empty صندوق الشركة proves the
 * same fact the ceremony proves: nothing is carried in from before.
 */
describe('the go-live date accepts a position already on capital', () => {
  const seedFund = async (token: string, fundCode: string, amount: string): Promise<void> => {
    const res = await post(token, '/journal/manual', {
      reason: 'رصيد افتتاحي',
      lines: [
        { fundCode, side: 'D', amount },
        { fundCode: 'opening_balance', side: 'C', amount },
      ],
    })
    expect(res.statusCode, res.body).toBe(201)
  }

  /** Put the boxes exactly on the configured capital, with no company fund and no receivables. */
  const putOnCapital = async (): Promise<void> => {
    const admin = await h.loginAs('sysadmin')
    const targets = await put(admin, '/treasury/capital-targets', {
      cashTarget: sypStr(4_000_000),
      walletTarget: sypStr(1_000_000),
      reason: 'رأس المال عند بدء التطبيق',
      branchId: BRANCH,
    })
    expect(targets.statusCode, targets.body).toBe(200)
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_000_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
  }

  it('accepts the date with no count and no restoration when the position is exactly on capital', async () => {
    await putOnCapital()
    const admin = await h.loginAs('sysadmin')
    const today = (await get(admin, '/fx')).json().businessDate

    const res = await put(admin, '/settings', { goLiveBusinessDate: today, branchId: BRANCH })
    expect(res.statusCode, res.body).toBe(200)
    expect((await get(admin, '/settings')).json().goLiveBusinessDate).toBe(today)
  })

  it('still refuses when the position carries accumulation, and says how far off it is', async () => {
    await putOnCapital()
    // One lira more than capital is accumulation carried in from before. Refuse it.
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(1))

    const admin = await h.loginAs('sysadmin')
    const today = (await get(admin, '/fx')).json().businessDate
    const res = await put(admin, '/settings', { goLiveBusinessDate: today, branchId: BRANCH })
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error).toBe('go_live_requires_opening_ceremony')
    expect(res.json().detail.workingCapital).toBe(sypStr(5_000_001))
    expect(res.json().detail.capitalTarget).toBe(sypStr(5_000_000))
  })

  it('refuses while صندوق الشركة still holds anything', async () => {
    // A non-empty company fund is exactly the shape of carried-over profit this rule exists to
    // keep out of a fresh start.
    await putOnCapital()
    const manager = await h.loginAs('manager')
    await post(manager, '/journal/manual', {
      reason: 'ربح متراكم',
      lines: [
        { fundCode: 'company_box', side: 'D', amount: sypStr(100) },
        { fundCode: 'opening_balance', side: 'C', amount: sypStr(100) },
      ],
    })
    const admin = await h.loginAs('sysadmin')
    const today = (await get(admin, '/fx')).json().businessDate
    const res = await put(admin, '/settings', { goLiveBusinessDate: today, branchId: BRANCH })
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().detail.companyBox).toBe(sypStr(100))
  })
})
