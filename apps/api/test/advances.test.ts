import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, DRIVER_ID, type Harness, makeHarness, sypStr } from './harness.ts'

/**
 * «السلفة» (owner decision 17) — an expense that was paid but must come back in full.
 *
 * «اضف شي خليط بين الصرفية و الذمة — هوي صرفية دفعت لكنها يجب ان ترد كاملة».
 *
 * One property carries the whole instrument: paying an advance moves office capital by exactly
 * zero. Get that wrong and الترميم reads the emptier box as a shortfall and «شحن» real money out of
 * صندوق الشركة every night, then sweeps it back the day it is repaid — financing every advance out
 * of the company fund, invisibly.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })
const post = async (token: string, url: string, payload: unknown = {}): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload: payload as object })

const category = async (): Promise<string> => {
  const admin = await h.loginAs('sysadmin')
  const res = await post(admin, '/expense-categories', { code: 'MISC', nameAr: 'نثريات' })
  expect(res.statusCode, res.body).toBe(201)
  return res.json().id as string
}

/** Put real money in both boxes, so an advance has something to come out of. */
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

const body = (categoryId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  idempotencyKey: crypto.randomUUID(),
  partyName: 'ورشة النور',
  categoryId,
  costCenterKind: 'general',
  vehicleId: null,
  channel: 'office_cash',
  amount: sypStr(100_000),
  description: 'سلفة تصليح',
  ...over,
})

/** Office capital as every reader computes it: the boxes, الذمم, and السلف. */
const capitalOf = (): bigint => {
  let total = 0n
  for (const entry of h.deps.ledger.entries) {
    for (const line of entry.lines) {
      const counted =
        line.fundCode === 'office_cash' ||
        line.fundCode === 'office_wallet' ||
        line.fundCode.startsWith('driver_receivable_') ||
        line.fundCode.startsWith('driver_shift_funding_') ||
        line.fundCode.startsWith('advance_receivable_')
      if (!counted) continue
      total += line.side === 'D' ? line.amount : -line.amount
    }
  }
  return total
}

describe('paying an advance', () => {
  it('posts the row and its journal together, and moves office capital by exactly zero', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 500_000, 100_000)
    const before = capitalOf()

    const res = await post(manager, '/advances', body(categoryId))
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().amount).toBe(sypStr(100_000))
    expect(res.json().journalEntryId).toBeGreaterThan(0)

    // THE HEADLINE PROPERTY. The cash box is 100,000 lighter and the company is no poorer.
    expect(capitalOf()).toBe(before)
    // …and the box really is lighter: 500,000 seeded, 100,000 handed over.
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(40_000_000n)
  })

  it('names the advance in its own fund, never the party', async () => {
    // The party is free text and has no id. Pooling by name would let two spellings be two funds —
    // or let over-repaying one advance hide behind another still outstanding.
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 500_000, 100_000)
    const res = await post(manager, '/advances', body(categoryId))
    const id = res.json().id as string
    const entry = h.deps.ledger.entries.find((e) => e.id === res.json().journalEntryId)
    expect(entry?.eventType).toBe('advance')
    expect(entry!.lines.map((l) => l.fundCode).sort()).toEqual([`advance_receivable_cash:${id}`, 'office_cash'])
  })

  it('pays from the wallet as readily as from cash', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 500_000, 100_000)
    const res = await post(manager, '/advances', body(categoryId, { channel: 'office_wallet', amount: sypStr(20_000) }))
    expect(res.statusCode, res.body).toBe(201)
    const entry = h.deps.ledger.entries.find((e) => e.id === res.json().journalEntryId)
    expect(entry!.lines.map((l) => l.fundCode)).toContain(`advance_receivable_wallet:${res.json().id}`)
  })

  it('refuses to hand over money the box is not holding', async () => {
    // The ledger would carry a negative office balance without complaint — arithmetic has no
    // opinion — and this is the cheapest place to catch the extra zero this form invites.
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 50_000, 10_000)
    const res = await post(manager, '/advances', body(categoryId, { amount: sypStr(100_000) }))
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('insufficient_funds')
  })

  it('never borrows «كييش» or «شحن», which mean money left for صندوق الشركة', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 500_000, 100_000)
    const before = h.deps.ledger.entries.length
    await post(manager, '/advances', body(categoryId))
    const roles = h.deps.ledger.entries.slice(before).flatMap((e) => e.lines.map((l) => l.role))
    expect(roles).not.toContain('kaish')
    expect(roles).not.toContain('shahn')
    expect(roles).toEqual(expect.arrayContaining(['advance_created', 'office_value_advanced']))
  })

  it('is audited, like every other posted money movement', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 500_000, 100_000)
    const res = await post(manager, '/advances', body(categoryId))
    expect(h.deps.audit.rows.some((r) => r.tableName === 'advances' && r.recordId === res.json().id)).toBe(true)
  })
})

describe('the replay comparator, field by field', () => {
  /*
   * One `it` per field on purpose. A comparator that silently forgets a field returns 200 to a
   * changed request and leaves the ORIGINAL row standing — the money is wrong and the caller is
   * told everything is fine. Enumerating them is how the comparator stays complete as it grows.
   */
  const conflicts: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['party name', { partyName: 'شخص آخر' }],
    ['cost centre kind', { costCenterKind: 'branch' }],
    ['channel', { channel: 'office_wallet' }],
    ['amount', { amount: sypStr(99_000) }],
    ['description', { description: 'شيء آخر تماماً' }],
    ['explicit business date', { businessDate: '2026-08-20' }],
  ]

  it.each(conflicts)('refuses a replay that changed the %s', async (_name, changed) => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 500_000, 100_000)
    const first = body(categoryId, { businessDate: '2026-08-21' })
    expect((await post(manager, '/advances', first)).statusCode).toBe(201)

    const res = await post(manager, '/advances', { ...first, ...changed })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('idempotency_key_conflict')
  })

  it('accepts an identical replay and posts nothing twice', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 500_000, 100_000)
    const payload = body(categoryId)
    expect((await post(manager, '/advances', payload)).statusCode).toBe(201)
    const entries = h.deps.ledger.entries.length

    const again = await post(manager, '/advances', payload)
    expect(again.statusCode).toBe(200)
    expect(h.deps.ledger.entries.length).toBe(entries)
  })

  it('replays the immutable receipt even after the category is disabled', async () => {
    // A lost-response retry must not start failing because a mutable rule changed underneath it.
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 500_000, 100_000)
    const payload = body(categoryId)
    expect((await post(manager, '/advances', payload)).statusCode).toBe(201)

    const cat = h.deps.expenses.categories.get(categoryId)!
    h.deps.expenses.categories.set(categoryId, { ...cat, active: false })
    expect((await post(manager, '/advances', payload)).statusCode).toBe(200)
  })
})

describe('money coming back', () => {
  const paid = async (over: Record<string, unknown> = {}): Promise<{ token: string; id: string }> => {
    const categoryId = await category()
    const token = await h.loginAs('manager')
    await seed(token, 500_000, 100_000)
    const res = await post(token, '/advances', body(categoryId, over))
    expect(res.statusCode, res.body).toBe(201)
    return { token, id: res.json().id as string }
  }

  it('returns the money to the box and clears the advance, still at zero capital change', async () => {
    const { token, id } = await paid()
    const before = capitalOf()
    const res = await post(token, `/advances/${id}/repayments`, {
      idempotencyKey: crypto.randomUUID(),
      amount: sypStr(100_000),
      reason: 'أعادها نقداً',
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(capitalOf()).toBe(before)
    expect(await h.deps.ledger.fundBalance(BRANCH, `advance_receivable_cash:${id}`)).toBe(0n)
  })

  it('accepts a partial repayment and leaves the remainder outstanding', async () => {
    const { token, id } = await paid()
    const res = await post(token, `/advances/${id}/repayments`, {
      idempotencyKey: crypto.randomUUID(),
      amount: sypStr(40_000),
      reason: 'دفعة أولى',
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(await h.deps.ledger.fundBalance(BRANCH, `advance_receivable_cash:${id}`)).toBe(6_000_000n)
  })

  it('refuses more than is outstanding', async () => {
    // Without this the advance's own fund goes negative, and every reader in the system treats a
    // negative counted asset as corruption.
    const { token, id } = await paid()
    const res = await post(token, `/advances/${id}/repayments`, {
      idempotencyKey: crypto.randomUUID(),
      amount: sypStr(100_001),
      reason: 'أكثر مما أخذ',
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('advance_overrepayment')
  })

  it('refuses a second full repayment of the same advance', async () => {
    const { token, id } = await paid()
    const once = { idempotencyKey: crypto.randomUUID(), amount: sypStr(100_000), reason: 'أعادها' }
    expect((await post(token, `/advances/${id}/repayments`, once)).statusCode).toBe(201)
    const twice = await post(token, `/advances/${id}/repayments`, { ...once, idempotencyKey: crypto.randomUUID() })
    expect(twice.statusCode).toBe(422)
    expect(twice.json().error).toBe('advance_overrepayment')
  })

  it('is idempotent on its own key', async () => {
    const { token, id } = await paid()
    const payload = { idempotencyKey: crypto.randomUUID(), amount: sypStr(40_000), reason: 'دفعة' }
    expect((await post(token, `/advances/${id}/repayments`, payload)).statusCode).toBe(201)
    const entries = h.deps.ledger.entries.length
    expect((await post(token, `/advances/${id}/repayments`, payload)).statusCode).toBe(200)
    expect(h.deps.ledger.entries.length).toBe(entries)
  })

  it('two advances to the same party repay independently', async () => {
    /*
     * The reason the fund is keyed by the ADVANCE. If «أبو محمد» were the key, repaying one of his
     * advances in full would look like a partial repayment of a single pooled debt, and over-paying
     * one would hide behind the other still being outstanding.
     */
    const categoryId = await category()
    const token = await h.loginAs('manager')
    await seed(token, 500_000, 100_000)
    const a = await post(token, '/advances', body(categoryId, { partyName: 'أبو محمد', amount: sypStr(30_000) }))
    const b = await post(token, '/advances', body(categoryId, { partyName: 'ابو  محمد', amount: sypStr(50_000) }))
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)

    const res = await post(token, `/advances/${a.json().id}/repayments`, {
      idempotencyKey: crypto.randomUUID(),
      amount: sypStr(30_000),
      reason: 'سدّد الأولى',
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(await h.deps.ledger.fundBalance(BRANCH, `advance_receivable_cash:${a.json().id}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `advance_receivable_cash:${b.json().id}`)).toBe(5_000_000n)

    // …and the two spellings still group as one party in the suggestion list.
    const listed = await get(token, '/advances')
    expect(listed.json().parties).toHaveLength(1)
  })
})

describe('giving up on it', () => {
  const paid = async (): Promise<{ token: string; id: string; categoryId: string }> => {
    const categoryId = await category()
    const token = await h.loginAs('manager')
    await seed(token, 500_000, 100_000)
    const res = await post(token, '/advances', body(categoryId, { costCenterKind: 'branch' }))
    expect(res.statusCode, res.body).toBe(201)
    return { token, id: res.json().id as string, categoryId }
  }

  it('writes a real expense row and reduces office capital — the only one of the three that does', async () => {
    const { token, id, categoryId } = await paid()
    const before = capitalOf()
    const res = await post(token, `/advances/${id}/conversion`, {
      idempotencyKey: crypto.randomUUID(),
      reason: 'أفلست الورشة ولن تُعاد',
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(capitalOf()).toBe(before - 10_000_000n)

    // SRS G — «كل ليرة تخرج: مصنَّفة وموثَّقة ومنسوبة لمركز كلفتها» — honoured at the moment the
    // lira is finally recognised as spent, so every existing expense report picks it up for free.
    const listed = await get(token, '/expenses')
    const row = listed.json().expenses.find((e: { advanceId: string | null }) => e.advanceId === id)
    expect(row).toBeTruthy()
    expect(row.categoryId).toBe(categoryId)
    expect(row.amount).toBe(sypStr(100_000))
  })

  it('converts only the remainder after a partial repayment', async () => {
    // Converting `advances.amount_minor` would credit an asset that no longer holds it and drive
    // the fund negative.
    const { token, id } = await paid()
    expect(
      (
        await post(token, `/advances/${id}/repayments`, {
          idempotencyKey: crypto.randomUUID(),
          amount: sypStr(60_000),
          reason: 'دفعة',
        })
      ).statusCode,
    ).toBe(201)

    const res = await post(token, `/advances/${id}/conversion`, {
      idempotencyKey: crypto.randomUUID(),
      reason: 'الباقي لن يعود',
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().amount).toBe(sypStr(40_000))
    expect(await h.deps.ledger.fundBalance(BRANCH, `advance_receivable_cash:${id}`)).toBe(0n)
  })

  it('refuses a second conversion', async () => {
    const { token, id } = await paid()
    expect(
      (await post(token, `/advances/${id}/conversion`, { idempotencyKey: crypto.randomUUID(), reason: 'ضاعت' }))
        .statusCode,
    ).toBe(201)
    const again = await post(token, `/advances/${id}/conversion`, {
      idempotencyKey: crypto.randomUUID(),
      reason: 'مرة ثانية',
    })
    expect(again.statusCode).toBe(422)
    expect(again.json().error).toBe('advance_already_settled')
  })

  it('lands on the cost centre an ordinary expense would, never on the category', async () => {
    // Debiting `cost_center:<categoryId>` would mint a look-alike account no profitability reader
    // sums — the exact trap `fundRefFromCode`'s own header describes.
    const { token, id } = await paid()
    const before = h.deps.ledger.entries.length
    await post(token, `/advances/${id}/conversion`, { idempotencyKey: crypto.randomUUID(), reason: 'ضاعت' })
    const codes = h.deps.ledger.entries.slice(before).flatMap((e) => e.lines.map((l) => l.fundCode))
    expect(codes).toContain(`cost_center:branch:${BRANCH}`)
  })
})

describe('reclassifying a «ذمة» as a «سلفة»', () => {
  /*
   * «حول ذمة انس رميح إلى سلفة» (owner, 2026-09-01).
   *
   * The same debt, filed differently. The temptation is to compose the two routes that already
   * exist — collect the receivable, then pay an advance — which reaches the same balances in one
   * line of code. It also writes a COLLECTION into the driver's history for money that never came
   * back, and shows cash entering and leaving the box on a day neither happened. So there is a
   * posting for it, and these tests pin what makes it honest.
   */
  const owing = async (amount: number): Promise<string> => {
    const manager = await h.loginAs('manager')
    await seed(manager, 500_000, 100_000)
    const res = await post(manager, '/receivables/events', {
      driverId: DRIVER_ID,
      receivableKind: 'ordinary',
      channel: 'cash',
      direction: 'create',
      amount: sypStr(amount),
      reason: 'ذمة قائمة',
      idempotencyKey: crypto.randomUUID(),
    })
    expect(res.statusCode, res.body).toBe(201)
    return manager
  }

  const convert = (categoryId: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
    body(categoryId, { sourceDriverId: DRIVER_ID, channel: 'office_cash', ...over })

  it('moves the debt without touching a box, and without moving capital', async () => {
    const categoryId = await category()
    const token = await owing(80_000)
    const capitalBefore = capitalOf()
    const cashBefore = await h.deps.ledger.fundBalance(BRANCH, 'office_cash')

    const res = await post(token, '/advances', convert(categoryId, { amount: sypStr(80_000) }))
    expect(res.statusCode, res.body).toBe(201)
    const id = res.json().id as string

    // The debt is now an advance…
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(0n)
    expect(await h.deps.ledger.fundBalance(BRANCH, `advance_receivable_cash:${id}`)).toBe(8_000_000n)
    // …and NOTHING physical happened. No box moved; capital is untouched.
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(cashBefore)
    expect(capitalOf()).toBe(capitalBefore)
  })

  it('never writes a collection that did not happen', async () => {
    /*
     * The whole reason this route exists rather than composing the two that already do. A driver's
     * history saying «تحصيل» for money that never came back is the exact lie the ledger exists to
     * prevent — `ReceivableEventRecord.intent` says so in its own doc comment.
     */
    const categoryId = await category()
    const token = await owing(80_000)
    const before = h.deps.ledger.entries.length
    expect((await post(token, '/advances', convert(categoryId, { amount: sypStr(80_000) }))).statusCode).toBe(201)

    const written = h.deps.ledger.entries.slice(before)
    expect(written).toHaveLength(1)
    const roles = written.flatMap((e) => e.lines.map((l) => l.role))
    expect(roles).not.toContain('receivable_collected')
    expect(roles).toEqual(expect.arrayContaining(['advance_created', 'receivable_converted_to_advance']))
    // And no office line at all: the box was never involved.
    expect(written[0]!.lines.map((l) => l.fundCode)).not.toContain('office_cash')
  })

  it('converts part of a debt and leaves the rest a «ذمة»', async () => {
    const categoryId = await category()
    const token = await owing(80_000)
    const res = await post(token, '/advances', convert(categoryId, { amount: sypStr(30_000) }))
    expect(res.statusCode, res.body).toBe(201)
    expect(await h.deps.ledger.fundBalance(BRANCH, `driver_receivable_cash:${DRIVER_ID}`)).toBe(5_000_000n)
  })

  it('refuses to convert more than the driver actually owes', async () => {
    // Otherwise it invents office capital out of nothing and leaves his «ذمة» negative — which
    // every reader in this system treats as corruption.
    const categoryId = await category()
    const token = await owing(80_000)
    const res = await post(token, '/advances', convert(categoryId, { amount: sypStr(80_001) }))
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('receivable_too_small')
  })

  it('is not bounded by what the box holds, because no box is being drawn on', async () => {
    // A cash payout of this size would be refused with `insufficient_funds`. A reclassification
    // takes nothing out of the drawer, so the drawer has no say.
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 1_000, 1_000)
    expect(
      (await post(manager, '/receivables/events', {
        driverId: DRIVER_ID,
        receivableKind: 'ordinary',
        channel: 'cash',
        direction: 'create',
        amount: sypStr(500),
        reason: 'ذمة',
        idempotencyKey: crypto.randomUUID(),
      })).statusCode,
    ).toBe(201)

    const res = await post(manager, '/advances', convert(categoryId, { amount: sypStr(500) }))
    expect(res.statusCode, res.body).toBe(201)
  })

  it('is repaid into the box the debt was always owed to', async () => {
    // The channel is inherited from the receivable, never chosen, so no leg of الترميم moves
    // sideways when he finally pays.
    const categoryId = await category()
    const token = await owing(80_000)
    const created = await post(token, '/advances', convert(categoryId, { amount: sypStr(80_000) }))
    const cashBefore = await h.deps.ledger.fundBalance(BRANCH, 'office_cash')

    const back = await post(token, `/advances/${created.json().id}/repayments`, {
      idempotencyKey: crypto.randomUUID(),
      amount: sypStr(80_000),
      reason: 'سدّد الذمة',
    })
    expect(back.statusCode, back.body).toBe(201)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(cashBefore + 8_000_000n)
  })

  it('refuses a replay that changed the origin', async () => {
    // The same key turning a reclassified debt into a cash payout would post against a completely
    // different account while telling the caller nothing changed.
    const categoryId = await category()
    const token = await owing(80_000)
    const first = convert(categoryId, { amount: sypStr(80_000) })
    expect((await post(token, '/advances', first)).statusCode).toBe(201)
    const res = await post(token, '/advances', { ...first, sourceDriverId: null })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('idempotency_key_conflict')
  })

  it('refuses a driver from another branch', async () => {
    const categoryId = await category()
    const token = await owing(80_000)
    const res = await post(token, '/advances', convert(categoryId, { sourceDriverId: crypto.randomUUID() }))
    expect(res.statusCode).toBe(404)
  })
})

describe('who may do what', () => {
  it('a driver may not pay an advance out of the branch treasury', async () => {
    const categoryId = await category()
    const driver = await h.loginAs('driver1')
    expect((await post(driver, '/advances', body(categoryId))).statusCode).toBe(403)
  })

  it('conversion takes journal.manual.write, because it permanently reduces capital', async () => {
    // Paying and collecting move money about; declaring it gone is the manual-journal decision a
    // receivable write-off also is.
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 500_000, 100_000)
    const created = await post(manager, '/advances', body(categoryId))
    const driver = await h.loginAs('driver1')
    const res = await post(driver, `/advances/${created.json().id}/conversion`, {
      idempotencyKey: crypto.randomUUID(),
      reason: 'محاولة',
    })
    expect(res.statusCode).toBe(403)
  })

  it('demands a reason that says something', async () => {
    // `trim()` alone is not enough: RTL bidi marks survive it, and an unreadable reason is no
    // reason at all a month later.
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 500_000, 100_000)
    const created = await post(manager, '/advances', body(categoryId))
    for (const reason of ['   ', '‎‏']) {
      const res = await post(manager, `/advances/${created.json().id}/repayments`, {
        idempotencyKey: crypto.randomUUID(),
        amount: sypStr(1_000),
        reason,
      })
      expect(res.statusCode).toBe(400)
    }
  })

  it('refuses a party name made only of invisible characters', async () => {
    const categoryId = await category()
    const manager = await h.loginAs('manager')
    await seed(manager, 500_000, 100_000)
    const res = await post(manager, '/advances', body(categoryId, { partyName: '​‏ ' }))
    expect(res.statusCode).toBe(400)
  })
})

describe('a full cycle through الترميم — pay, restore, repay, restore, convert, restore', () => {
  /*
   * THE TEST THIS WHOLE FEATURE EXISTS TO PASS.
   *
   * الترميم runs every night and settles each box against a fixed رأس مال. Money out on a سلفة has
   * left the drawer but has NOT left the company, so if the restoration cannot see it the branch
   * reads as short by exactly the advance, «شحن» pulls that much out of صندوق الشركة to refill the
   * box, and the day the advance comes back the surplus is swept straight out again. The company
   * fund would silently finance every advance, twice over, and nothing would ever say so.
   *
   * So: run three nights around one advance and assert that صندوق الشركة never moves — until the
   * advance is written off, at which point it must move exactly once.
   */
  /** The next night — including a fresh login, because a day-old session really has expired. */
  const nextDay = async (): Promise<string> => {
    h.deps.clock.advance(24 * 60 * 60 * 1000)
    return await h.loginAs('manager')
  }

  const restore = async (token: string, reason: string): Promise<LightMyRequestResponse> =>
    await post(token, '/treasury/restoration', { reason })

  const companyBox = async (): Promise<bigint> => await h.deps.ledger.fundBalance(BRANCH, 'company_box')

  /** Seed both boxes exactly onto the seeded capital targets, so night one is a no-op. */
  const onTarget = async (token: string): Promise<void> => {
    await seed(token, 4_000_000, 1_000_000)
  }

  it('moves not one lira of company capital while the advance is outstanding', async () => {
    const categoryId = await category()
    let token = await h.loginAs('manager')
    await onTarget(token)

    // Night one: both boxes already on رأس مال المكتب, so nothing should move.
    expect((await restore(token, 'ليلة أولى')).statusCode).toBe(201)
    expect(await companyBox()).toBe(0n)

    // Hand over a 100,000 advance. The cash box is now 100,000 light.
    token = await nextDay()
    const created = await post(token, '/advances', body(categoryId, { amount: sypStr(100_000) }))
    expect(created.statusCode, created.body).toBe(201)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(390_000_000n)

    // Night two: the box is short, the advance is outstanding, and the two cancel exactly.
    const second = await restore(token, 'ليلة ثانية')
    expect(second.statusCode, second.body).toBe(201)
    expect(second.json().netToCompany).toBe(sypStr(0))
    expect(second.json().postings).toBe(0)
    expect(await companyBox()).toBe(0n)

    // The money comes back.
    token = await nextDay()
    const repaid = await post(token, `/advances/${created.json().id}/repayments`, {
      idempotencyKey: crypto.randomUUID(),
      amount: sypStr(100_000),
      reason: 'أعادها كاملة',
    })
    expect(repaid.statusCode, repaid.body).toBe(201)

    // Night three: back on target, and still nothing moved.
    const third = await restore(token, 'ليلة ثالثة')
    expect(third.statusCode, third.body).toBe(201)
    expect(third.json().netToCompany).toBe(sypStr(0))
    expect(await companyBox()).toBe(0n)
  })

  it('drops capital exactly once, at the conversion, and never before', async () => {
    const categoryId = await category()
    let token = await h.loginAs('manager')
    await onTarget(token)
    expect((await restore(token, 'ليلة أولى')).statusCode).toBe(201)

    token = await nextDay()
    const created = await post(token, '/advances', body(categoryId, { amount: sypStr(100_000) }))
    expect(created.statusCode, created.body).toBe(201)
    expect((await restore(token, 'ليلة ثانية')).json().netToCompany).toBe(sypStr(0))
    expect(await companyBox()).toBe(0n)

    // It is never coming back. NOW the branch is genuinely 100,000 short of رأس مال المكتب.
    token = await nextDay()
    const converted = await post(token, `/advances/${created.json().id}/conversion`, {
      idempotencyKey: crypto.randomUUID(),
      reason: 'أفلست الورشة',
    })
    expect(converted.statusCode, converted.body).toBe(201)

    const third = await restore(token, 'ليلة ثالثة')
    expect(third.statusCode, third.body).toBe(201)
    expect(third.json().netToCompany).toBe(sypStr(-100_000))
    expect(third.json().postings).toBe(1)
    // «شحن»: صندوق الشركة refills the box, once, for the amount actually lost.
    expect(await companyBox()).toBe(-10_000_000n)
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(400_000_000n)
  })

  it('carries السلف into the stored plan as their own term, never merged into «الذمم»', async () => {
    const categoryId = await category()
    const token = await h.loginAs('manager')
    await onTarget(token)
    await post(token, '/advances', body(categoryId, { amount: sypStr(100_000) }))

    expect((await restore(token, 'ليلة')).statusCode).toBe(201)
    const stored = await h.deps.restorations.find(BRANCH, '2026-07-21')
    const plan = stored?.plan as { schemaVersion: number; legs: Array<Record<string, string>> }
    expect(plan.schemaVersion).toBe(4)
    const cash = plan.legs.find((l) => l.fundCode === 'office_cash')!
    expect(cash.advances).toBe(sypStr(100_000))
    // The Treasury screen renders `receivables` as «الذمم». A سلفة showing up there would read as
    // a driver's debt to anyone looking at the record months later.
    expect(cash.receivables).toBe(sypStr(0))
    expect(cash.position).toBe(sypStr(4_000_000))
    expect(cash.delta).toBe(sypStr(0))
  })

  it('refuses a sweep that exists only because of an outstanding advance', async () => {
    /*
     * A surplus funded by a سلفة is real on paper and unavailable in the drawer. `sweep_exceeds_counted`
     * already said this about الذمم; advances make it reachable by a deliberate act, so it has to
     * keep saying it — and it must refuse BEFORE posting anything.
     */
    const categoryId = await category()
    const token = await h.loginAs('manager')
    await seed(token, 4_300_000, 1_000_000)
    await post(token, '/advances', body(categoryId, { amount: sypStr(4_200_000) }))

    const before = h.deps.ledger.entries.length
    const res = await restore(token, 'محاولة')
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('restoration_infeasible')
    expect(h.deps.ledger.entries.length).toBe(before)
  })
})

describe('what the branch is owed', () => {
  it('reports each outstanding advance, split by the box it left', async () => {
    const categoryId = await category()
    const token = await h.loginAs('manager')
    await seed(token, 500_000, 100_000)
    await post(token, '/advances', body(categoryId, { amount: sypStr(30_000) }))
    await post(token, '/advances', body(categoryId, { channel: 'office_wallet', amount: sypStr(20_000) }))

    const res = await get(token, '/advances')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().outstanding).toHaveLength(2)
    expect(res.json().outstandingCash).toBe(sypStr(30_000))
    expect(res.json().outstandingWallet).toBe(sypStr(20_000))
  })

  it('drops an advance from the outstanding list once it is settled', async () => {
    const categoryId = await category()
    const token = await h.loginAs('manager')
    await seed(token, 500_000, 100_000)
    const created = await post(token, '/advances', body(categoryId, { amount: sypStr(30_000) }))
    await post(token, `/advances/${created.json().id}/repayments`, {
      idempotencyKey: crypto.randomUUID(),
      amount: sypStr(30_000),
      reason: 'سدّد',
    })
    const res = await get(token, '/advances')
    expect(res.json().outstanding).toHaveLength(0)
    expect(res.json().outstandingCash).toBe(sypStr(0))
  })

  it('shows the history of one advance', async () => {
    const categoryId = await category()
    const token = await h.loginAs('manager')
    await seed(token, 500_000, 100_000)
    const created = await post(token, '/advances', body(categoryId))
    await post(token, `/advances/${created.json().id}/repayments`, {
      idempotencyKey: crypto.randomUUID(),
      amount: sypStr(25_000),
      reason: 'دفعة أولى',
    })
    const res = await get(token, `/advances/${created.json().id}/events`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().events).toHaveLength(1)
    expect(res.json().outstanding).toBe(sypStr(75_000))
  })
})
