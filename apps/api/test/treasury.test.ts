import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH, type Harness, makeHarness, sypStr } from './harness.ts'

/**
 * Treasury: the daily cash count (E-5 / س51) and disciplined manual entries (E-3 / س50).
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

/** Put some money in the office funds so a count has something to reconcile against. */
async function seedOfficeCash(amount: string): Promise<void> {
  const manager = await h.loginAs('manager')
  await post(manager, '/journal/manual', {
    reason: 'رصيد افتتاحي',
    lines: [
      { fundCode: 'office_cash', side: 'D', amount },
      { fundCode: 'opening_balance', side: 'C', amount },
    ],
  })
}

describe('branch treasury: cash box + wallet deposits (E-1, D-5 as superseded by decision 9)', () => {
  it('shows the branch cash box + wallet balances (empty at first)', async () => {
    const manager = await h.loginAs('manager')
    const res = await get(manager, '/treasury/balances')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ cash: sypStr(0), wallet: sypStr(0) })
  })

  it('a deposit raises the cash box balance', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/treasury/deposit', { target: 'cash', amount: sypStr(200_000) })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().balance).toBe(sypStr(200_000))
    expect((await get(manager, '/treasury/balances')).json().cash).toBe(sypStr(200_000))
  })

  it('a wallet top-up raises the wallet balance', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/treasury/deposit', { target: 'wallet', amount: sypStr(50_000) })
    expect((await get(manager, '/treasury/balances')).json().wallet).toBe(sypStr(50_000))
  })

  /**
   * REVERSED BY DECISION 9. The owner granted the system admin every permission, so the question is
   * no longer whether he may touch the money but whether he said WHOSE money — he is org-wide and
   * belongs to no branch, exactly like the GM. That guard is untouched and is what this now pins.
   */
  it('the system admin may deposit, once he names a branch (decision 9, was D-5)', async () => {
    const sysadmin = await h.loginAs('sysadmin')
    const unnamed = await post(sysadmin, '/treasury/deposit', { target: 'cash', amount: sypStr(1_000) })
    expect(unnamed.statusCode).toBe(422)
    expect(unnamed.json().error).toBe('branch_required')

    const named = await post(sysadmin, '/treasury/deposit', {
      target: 'cash',
      amount: sypStr(1_000),
      branchId: BRANCH,
    })
    expect(named.statusCode, named.body).toBe(201)
  })

  it('rejects a non-positive amount', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/treasury/deposit', { target: 'wallet', amount: sypStr(0) })
    expect(res.statusCode).toBe(422)
  })
})

describe('the daily cash count (E-5)', () => {
  it('offers a sheet of what the system believes each fund holds', async () => {
    const manager = await h.loginAs('manager')
    const res = await get(manager, '/cash-counts/sheet')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().businessDate).toBe('2026-07-21')
    expect(res.json().alreadyCounted).toBe(false)
    expect((res.json().funds as Array<{ fundCode: string }>).map((f) => f.fundCode)).toEqual([
      'office_cash',
      'office_wallet',
    ])
  })

  it('records a matching count with zero variance and a proof hash', async () => {
    await seedOfficeCash(sypStr(500_000))
    const manager = await h.loginAs('manager')

    const res = await post(manager, '/cash-counts', {
      lines: [
        { fundCode: 'office_cash', counted: sypStr(500_000) },
        { fundCode: 'office_wallet', counted: sypStr(0) },
      ],
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().balanced).toBe(true)
    expect(res.json().lines[0].variance).toBe('0.00')
    // «إثبات الجرد» — the count cannot be quietly restated later.
    expect(res.json().proofSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reports a variance when the drawer disagrees with the ledger', async () => {
    await seedOfficeCash(sypStr(500_000))
    const manager = await h.loginAs('manager')

    const res = await post(manager, '/cash-counts', {
      lines: [
        { fundCode: 'office_cash', counted: sypStr(495_000), resolution: 'نقص غير مفسر' },
        { fundCode: 'office_wallet', counted: sypStr(0) },
      ],
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().balanced).toBe(false)
    expect(res.json().lines[0].variance).toBe('-5000.00')
    expect(res.json().lines[0].resolution).toBe('نقص غير مفسر')
  })

  it('FREEZES the computed side — a later posting cannot rewrite a signed-off variance', async () => {
    await seedOfficeCash(sypStr(500_000))
    const manager = await h.loginAs('manager')
    await post(manager, '/cash-counts', {
      lines: [{ fundCode: 'office_cash', counted: sypStr(500_000) }],
    })

    // Money moves after the count. The recorded count must not change.
    await seedOfficeCash(sypStr(100_000))
    const stored = await get(manager, '/cash-counts/2026-07-21')
    expect(stored.json().lines[0].computed).toBe('500000.00')
    expect(stored.json().lines[0].variance).toBe('0.00')
  })

  it.each([null, '   '])('refuses a non-zero line without its own explanation (%s)', async (resolution) => {
    await seedOfficeCash(sypStr(500_000))
    const manager = await h.loginAs('manager')

    const res = await post(manager, '/cash-counts', {
      lines: [{ fundCode: 'office_cash', counted: sypStr(495_000), resolution }],
    })

    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({
      error: 'cash_count_resolution_required',
      detail: { fundCode: 'office_cash', variance: '-5000.00' },
    })
    expect(await h.deps.cashCounts.find(BRANCH, '2026-07-21')).toBeNull()
  })

  it('seals the per-line explanation into the cash-count proof', async () => {
    await seedOfficeCash(sypStr(500_000))
    const manager = await h.loginAs('manager')
    const first = await post(manager, '/cash-counts', {
      lines: [{ fundCode: 'office_cash', counted: sypStr(495_000), resolution: 'first explanation' }],
    })
    expect(first.statusCode, first.body).toBe(201)

    const other = await makeHarness()
    try {
      const otherManager = await other.loginAs('manager')
      const otherPost = async (url: string, payload: Record<string, unknown>) =>
        await other.app.inject({ method: 'POST', url, headers: { cookie: other.cookie(otherManager) }, payload })
      await otherPost('/journal/manual', {
        reason: 'opening balance',
        lines: [
          { fundCode: 'office_cash', side: 'D', amount: sypStr(500_000) },
          { fundCode: 'opening_balance', side: 'C', amount: sypStr(500_000) },
        ],
      })
      const second = await otherPost('/cash-counts', {
        lines: [{ fundCode: 'office_cash', counted: sypStr(495_000), resolution: 'second explanation' }],
      })
      expect(second.statusCode, second.body).toBe(201)
      expect(second.json().proofSha256).not.toBe(first.json().proofSha256)
    } finally {
      await other.app.close()
    }
  })

  it('uses a deterministic prefix-safe proof when explanations contain old delimiters', async () => {
    const proofFor = async (lines: Array<Record<string, unknown>>): Promise<string> => {
      const isolated = await makeHarness()
      try {
        const manager = await isolated.loginAs('manager')
        const res = await isolated.app.inject({
          method: 'POST',
          url: '/cash-counts',
          headers: { cookie: isolated.cookie(manager) },
          payload: { lines },
        })
        expect(res.statusCode, res.body).toBe(201)
        return String(res.json().proofSha256)
      } finally {
        await isolated.app.close()
      }
    }

    // Under the old `line.join('|') + lines.join(';')` canonicalization these two different
    // records produced exactly the same text: the first explanation impersonated a wallet line.
    const embeddedLine = [
      {
        fundCode: 'office_cash',
        counted: sypStr(1),
        resolution: 'a;office_wallet|100|0|100|b',
      },
    ]
    const realTwoLines = [
      { fundCode: 'office_cash', counted: sypStr(1), resolution: 'a' },
      { fundCode: 'office_wallet', counted: sypStr(1), resolution: 'b' },
    ]

    const embeddedProof = await proofFor(embeddedLine)
    const twoLineProof = await proofFor(realTwoLines)
    const reorderedProof = await proofFor([...realTwoLines].reverse())
    expect(embeddedProof).not.toBe(twoLineProof)
    expect(reorderedProof).toBe(twoLineProof)
  })

  it('refuses a second count for the same day', async () => {
    const manager = await h.loginAs('manager')
    const body = { lines: [{ fundCode: 'office_cash', counted: sypStr(0) }] }
    expect((await post(manager, '/cash-counts', body)).statusCode).toBe(201)

    // Two counts would make "what did we agree the drawer held" ambiguous.
    const second = await post(manager, '/cash-counts', body)
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toBe('already_counted_today')
  })

  it('refuses a fund that is not physically countable', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/cash-counts', {
      lines: [{ fundCode: 'yalago_share', counted: sypStr(1) }],
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('fund_not_countable')
  })

  it('refuses negative physical cash while preserving a signed wallet count', async () => {
    const manager = await h.loginAs('manager')
    const negativeCash = await post(manager, '/cash-counts', {
      lines: [
        { fundCode: 'office_cash', counted: '-1.00', resolution: 'invalid physical cash' },
        { fundCode: 'office_wallet', counted: sypStr(0) },
      ],
    })
    expect(negativeCash.statusCode).toBe(422)
    expect(negativeCash.json()).toEqual({
      error: 'cash_count_negative',
      detail: { fundCode: 'office_cash' },
    })
    expect(await h.deps.cashCounts.find(BRANCH, '2026-07-21')).toBeNull()

    const signedWallet = await post(manager, '/cash-counts', {
      lines: [
        { fundCode: 'office_cash', counted: sypStr(0) },
        { fundCode: 'office_wallet', counted: '-1.00', resolution: 'provider wallet liability' },
      ],
    })
    expect(signedWallet.statusCode, signedWallet.body).toBe(201)
    expect(signedWallet.json().lines).toContainEqual(
      expect.objectContaining({ fundCode: 'office_wallet', counted: '-1.00' }),
    )
  })

  /** Decision 9 gave him `cash_count.perform`; being org-wide he must still say whose drawer. */
  it('the system admin may count a drawer he names (decision 9, was D-5)', async () => {
    const admin = await h.loginAs('sysadmin')
    const unnamed = await post(admin, '/cash-counts', { lines: [{ fundCode: 'office_cash', counted: sypStr(0) }] })
    expect(unnamed.statusCode).toBe(422)
    expect(unnamed.json().error).toBe('branch_required')

    const named = await post(admin, '/cash-counts', {
      branchId: BRANCH,
      lines: [{ fundCode: 'office_cash', counted: sypStr(0) }],
    })
    expect(named.statusCode, named.body).toBe(201)
  })

  it('a driver may not count anything', async () => {
    const driver = await h.loginAs('driver1')
    expect((await get(driver, '/cash-counts/sheet')).statusCode).toBe(403)
  })
})

describe('manual entries (E-3 / س50)', () => {
  it('posts a balanced entry with a mandatory reason', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/journal/manual', {
      reason: 'تصحيح رصيد',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(1_000) },
        { fundCode: 'adjustments', side: 'C', amount: sypStr(1_000) },
      ],
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().entryId).not.toBeNull()
    expect(res.json().reason).toBe('تصحيح رصيد')
  })

  it('refuses an unbalanced entry', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/journal/manual', {
      reason: 'خطأ',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(1_000) },
        { fundCode: 'adjustments', side: 'C', amount: sypStr(900) },
      ],
    })
    expect(res.statusCode).toBe(500) // the domain throws; the ledger would refuse it too
  })

  it('refuses an entry with no reason', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/journal/manual', {
      reason: '',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(1) },
        { fundCode: 'adjustments', side: 'C', amount: sypStr(1) },
      ],
    })
    expect(res.statusCode).toBe(400) // schema rejects it before the handler
  })

  it('demands evidence above the configured ceiling', async () => {
    const manager = await h.loginAs('manager')
    await h.deps.settings.set('expense.receipt_required_above_minor', '100000', 'u-sa') // 1,000 SYP

    const res = await post(manager, '/journal/manual', {
      reason: 'مبلغ كبير',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(50_000) },
        { fundCode: 'adjustments', side: 'C', amount: sypStr(50_000) },
      ],
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('evidence_required')
  })

  /** Decision 9: he may post them. The reason and the branch are still mandatory. */
  it('the system admin may post manual entries for a branch he names (decision 9, was D-5)', async () => {
    const admin = await h.loginAs('sysadmin')
    const lines = [
      { fundCode: 'office_cash', side: 'D', amount: sypStr(1) },
      { fundCode: 'adjustments', side: 'C', amount: sypStr(1) },
    ]
    const unnamed = await post(admin, '/journal/manual', { reason: 'x', lines })
    expect(unnamed.statusCode).toBe(422)
    expect(unnamed.json().error).toBe('branch_required')

    const named = await post(admin, '/journal/manual', { reason: 'قيد من مدير النظام', branchId: BRANCH, lines })
    expect(named.statusCode, named.body).toBe(201)
  })
})

describe('corrections are visible reversals, never edits (BR7)', () => {
  it('reverses an entry and leaves both visible', async () => {
    const manager = await h.loginAs('manager')
    const original = await post(manager, '/journal/manual', {
      reason: 'قيد خاطئ',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(7_000) },
        { fundCode: 'adjustments', side: 'C', amount: sypStr(7_000) },
      ],
    })
    const entryId = original.json().entryId as number
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(700_000n)

    const res = await post(manager, `/journal/${entryId}/reverse`, { reason: 'تصحيح ظاهر مؤرَّخ' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().reversalOf).toBe(entryId)

    // Net zero, and BOTH entries remain in the ledger — nothing was edited away.
    expect(await h.deps.ledger.fundBalance(BRANCH, 'office_cash')).toBe(0n)
    expect(h.deps.ledger.entries.filter((e) => e.eventType === 'manual')).toHaveLength(1)
    expect(h.deps.ledger.entries.filter((e) => e.eventType === 'correction')).toHaveLength(1)
  })

  it('preserves a treasury line role when reversing a restoration entry', async () => {
    await seedOfficeCash(sypStr(10_000))
    const manager = await h.loginAs('manager')
    const moved = await post(manager, '/treasury/withdraw', {
      target: 'cash',
      amount: sypStr(10_000),
      to: 'company_box',
      reason: 'sweep',
    })
    expect(moved.statusCode, moved.body).toBe(201)

    // Selected by the role it carries, not by its event type: a hand sweep is a `manual` entry —
    // `restoration` is reserved for the atomic ceremony the database enforces a fact row for.
    const original = h.deps.ledger.entries.find((entry) =>
      entry.lines.some((line) => line.fundCode === 'company_box' && line.role === 'kaish'),
    )!
    expect(original.lines.find((line) => line.fundCode === 'company_box')?.role).toBe('kaish')

    const res = await post(manager, `/journal/${original.id}/reverse`, { reason: 'reverse sweep' })
    expect(res.statusCode, res.body).toBe(201)
    const correction = h.deps.ledger.entries.find((entry) => entry.id === res.json().reversalEntryId)!
    expect(correction.lines.find((line) => line.fundCode === 'company_box')).toMatchObject({
      side: 'C',
      role: 'kaish',
    })
  })

  it('404s on an entry that does not exist', async () => {
    const manager = await h.loginAs('manager')
    const res = await post(manager, '/journal/99999/reverse', { reason: 'x' })
    expect(res.statusCode).toBe(404)
  })
})
