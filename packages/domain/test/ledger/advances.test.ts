import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Minor, ZERO, minor } from '../../src/money/minor.ts'
import {
  type Posting,
  advance,
  advanceConversion,
  advanceRepayment,
  creditsOf,
  debitsOf,
  fundCode,
  fundRefFromCode,
} from '../../src/ledger/recipes.ts'
import { type FundPosition, planRestoration, restoredPosition } from '../../src/treasury/restoration.ts'

/**
 * «السلفة» — an expense that must come back (owner decision 17).
 *
 * «هوي صرفية دفعت لكنها يجب ان ترد كاملة». The whole instrument rests on one property: paying an
 * advance moves working capital by exactly zero, so الترميم does not read the emptier box as a
 * shortfall and pull real money out of صندوق الشركة every night. Capital falls at the conversion,
 * and only there.
 */
const syp = (whole: number): Minor => minor(BigInt(whole) * 100n)
const ADV = '5f0f3f3e-0000-4000-8000-000000000001'

const codesOn = (posting: Posting, side: 'D' | 'C'): string[] =>
  posting.lines.filter((l) => l.side === side).map((l) => fundCode(l.fund))
const rolesOf = (posting: Posting): string[] => posting.lines.map((l) => l.role ?? '')

/** Signed effect on office capital = office boxes + الذمم + السلف. */
const capitalDeltaOf = (posting: Posting): bigint =>
  posting.lines.reduce((acc, l) => {
    const counted =
      l.fund.kind === 'office_cash' ||
      l.fund.kind === 'office_wallet' ||
      l.fund.kind.startsWith('advance_receivable_')
    if (!counted) return acc
    return l.side === 'D' ? acc + l.amount : acc - l.amount
  }, 0n)

describe('paying an advance', () => {
  it('moves value out of the box and into a named advance asset', () => {
    const posting = advance('office_cash', ADV, syp(100_000))
    expect(posting.eventType).toBe('advance')
    expect(debitsOf(posting)).toBe(creditsOf(posting))
    expect(codesOn(posting, 'D')).toEqual([`advance_receivable_cash:${ADV}`])
    expect(codesOn(posting, 'C')).toEqual(['office_cash'])
  })

  it('changes working capital by exactly zero', () => {
    /*
     * THE HEADLINE PROPERTY, and the reason this is not simply an expense.
     *
     * Office capital is `office_* + ذمم + سلف`. An advance debits one member of that set and
     * credits another, so the sum is untouched — which is what «يجب أن ترد كاملة» means once it is
     * written in double entry rather than in a policy document.
     */
    fc.assert(
      fc.property(
        fc.constantFrom('office_cash' as const, 'office_wallet' as const),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (channel, raw) => {
          expect(capitalDeltaOf(advance(channel, ADV, minor(raw)))).toBe(0n)
        },
      ),
    )
  })

  it('pays from the WALLET as readily as from cash', () => {
    // Yallago's cut leaves the wallet, so the wallet is a real source of an advance — and a
    // cash-only recipe would force the manager to misfile it against the box that did not pay.
    const posting = advance('office_wallet', ADV, syp(250))
    expect(codesOn(posting, 'D')).toEqual([`advance_receivable_wallet:${ADV}`])
    expect(codesOn(posting, 'C')).toEqual(['office_wallet'])
  })

  it('is suffixed by the ADVANCE, so two advances to one party never pool', () => {
    // The party is free text and has no id. Pooling by name would let «أبو محمد» and «ابو محمد» be
    // two funds — or worse, let over-repaying one advance hide behind another still outstanding.
    const other = '5f0f3f3e-0000-4000-8000-000000000002'
    expect(codesOn(advance('office_cash', ADV, syp(10)), 'D')).not.toEqual(
      codesOn(advance('office_cash', other, syp(10)), 'D'),
    )
  })
})

describe('repaying an advance', () => {
  it('is the exact reverse of its payment', () => {
    const paid = advance('office_cash', ADV, syp(100_000))
    const back = advanceRepayment('office_cash', ADV, syp(100_000))
    expect(back.eventType).toBe('advance_repayment')
    expect(codesOn(back, 'D')).toEqual(codesOn(paid, 'C'))
    expect(codesOn(back, 'C')).toEqual(codesOn(paid, 'D'))
    expect(capitalDeltaOf(back)).toBe(0n)
  })

  it('returns to the box the money left from', () => {
    /*
     * الترميم plans each box against its own target. An advance repaid into the other box would
     * push one leg up and the other down at different moments, letting a single advance's own
     * balance go negative in between — and every reader in the system treats a negative counted
     * asset as corruption. The physical case (notes handed over for a wallet advance) is served by
     * recording it to the wallet and moving it with the office transfer, which moves no capital.
     */
    expect(codesOn(advanceRepayment('office_wallet', ADV, syp(1)), 'D')).toEqual(['office_wallet'])
    expect(codesOn(advanceRepayment('office_wallet', ADV, syp(1)), 'C')).toEqual([
      `advance_receivable_wallet:${ADV}`,
    ])
  })
})

describe('converting an advance into an ordinary expense', () => {
  it('debits the cost centre and touches no box — the cash left weeks ago', () => {
    const posting = advanceConversion('office_cash', ADV, 'branch:b1', syp(100_000))
    expect(posting.eventType).toBe('advance_conversion')
    expect(codesOn(posting, 'D')).toEqual(['cost_center:branch:b1'])
    expect(codesOn(posting, 'C')).toEqual([`advance_receivable_cash:${ADV}`])
    const kinds = posting.lines.map((l) => l.fund.kind)
    expect(kinds).not.toContain('office_cash')
    expect(kinds).not.toContain('office_wallet')
  })

  it('is the ONLY one of the three that reduces office capital', () => {
    expect(capitalDeltaOf(advance('office_cash', ADV, syp(500)))).toBe(0n)
    expect(capitalDeltaOf(advanceRepayment('office_cash', ADV, syp(500)))).toBe(0n)
    expect(capitalDeltaOf(advanceConversion('office_cash', ADV, 'branch:b1', syp(500)))).toBe(-50_000n)
  })
})

describe('what the three recipes must never do', () => {
  it('never borrows «كييش» or «شحن», which mean money left for صندوق الشركة', () => {
    // The treasury dashboard classifies a flow by these line roles. An advance wearing one would be
    // read as company money moving when nothing left the branch at all.
    for (const posting of [
      advance('office_cash', ADV, syp(10)),
      advanceRepayment('office_cash', ADV, syp(10)),
      advanceConversion('office_cash', ADV, 'branch:b1', syp(10)),
    ]) {
      expect(rolesOf(posting)).not.toContain('kaish')
      expect(rolesOf(posting)).not.toContain('shahn')
      expect(posting.lines.map((l) => l.fund.kind)).not.toContain('company_box')
    }
  })

  it('refuses a zero or negative amount rather than posting a backwards entry', () => {
    for (const bad of [minor(0n), minor(-1n)]) {
      expect(() => advance('office_cash', ADV, bad)).toThrow(RangeError)
      expect(() => advanceRepayment('office_cash', ADV, bad)).toThrow(RangeError)
      expect(() => advanceConversion('office_cash', ADV, 'branch:b1', bad)).toThrow(RangeError)
    }
  })
})

describe('the advance fund survives the round-trip through its code', () => {
  it('reads back as the advance fund, NOT as a cost centre', () => {
    /*
     * The single most valuable assertion in this suite. `fundRefFromCode`'s default clause turns any
     * unrecognised head into `cost_center:<code>` — a look-alike account الترميم does not count
     * toward office capital. Without the case in that switch, every night would read a phantom
     * shortfall and «شحن» real money out of صندوق الشركة, and nothing would raise.
     */
    for (const kind of ['advance_receivable_cash', 'advance_receivable_wallet'] as const) {
      const ref = fundRefFromCode(`${kind}:${ADV}`)
      expect(ref).toEqual({ kind, advanceId: ADV })
      expect(ref.kind).not.toBe('cost_center')
    }
  })

  it('round-trips any advance id', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('advance_receivable_cash' as const, 'advance_receivable_wallet' as const),
        fc.uuid(),
        (kind, advanceId) => {
          expect(fundRefFromCode(fundCode({ kind, advanceId }))).toEqual({ kind, advanceId })
        },
      ),
    )
  })

  it('refuses a bare code with no advance id', () => {
    // Mirrors the driver rule: a fund that identifies nobody is a bug, not a default.
    expect(() => fundRefFromCode('advance_receivable_cash')).toThrow(RangeError)
    expect(() => fundRefFromCode('advance_receivable_wallet:')).toThrow(RangeError)
  })
})

describe('الترميم counts an outstanding advance as capital', () => {
  const box = (over: Partial<FundPosition> = {}): FundPosition => ({
    fundCode: 'office_cash',
    officeBalance: syp(3_600_000),
    receivables: syp(400_000),
    advances: ZERO,
    capitalTarget: syp(4_000_000),
    ...over,
  })

  it('a 100,000 advance moves nothing: the box is emptier and the capital is identical', () => {
    // The owner's own spreadsheet row with one more term. This is the test that stops الترميم from
    // financing every advance out of صندوق الشركة and sweeping it back when it is repaid.
    const plan = planRestoration([box({ officeBalance: syp(3_500_000), advances: syp(100_000) })])
    expect(plan.legs[0]?.position).toBe(syp(4_000_000))
    expect(plan.legs[0]?.delta).toBe(ZERO)
    expect(plan.legs[0]?.direction).toBeNull()
    expect(plan.netToCompany).toBe(ZERO)
  })

  it('converting it — and only converting it — creates the shortfall', () => {
    const plan = planRestoration([box({ officeBalance: syp(3_500_000), advances: ZERO })])
    expect(plan.legs[0]?.direction).toBe('from_company')
    expect(plan.legs[0]?.amount).toBe(syp(100_000))
  })

  it('refuses a surplus that exists only because of an outstanding advance', () => {
    // Real on paper, unavailable in the drawer. `sweep_exceeds_counted` already said this about
    // الذمم; advances make it reachable by a deliberate act, so it must keep saying it.
    const plan = planRestoration([
      box({ officeBalance: syp(100_000), receivables: ZERO, advances: syp(4_500_000) }),
    ])
    expect(plan.legs[0]?.delta).toBe(syp(600_000))
    expect(plan.legs[0]?.direction).toBe('to_company')
    expect(plan.feasible).toBe(false)
    expect(plan.refusals).toContain('sweep_exceeds_counted')
  })

  it('the postcondition holds with advances in the sum', () => {
    // `restoredPosition` returns the office balance that must remain once the leg has posted. The
    // invariant it exists to state is that this balance, plus everything owed to the box, is
    // exactly رأس مال المكتب — the owner's `=SUM(I38:J48)-4000000` evaluating to zero, now with a
    // سلف term. Asserting the sum rather than the return value is what makes the test say that.
    const plan = planRestoration([box({ officeBalance: syp(3_450_000), advances: syp(100_000) })])
    const leg = plan.legs[0]!
    const officeAfter = restoredPosition(leg, syp(400_000), syp(100_000))
    expect(officeAfter).toBe(syp(3_500_000))
    expect(officeAfter + syp(400_000) + syp(100_000)).toBe(leg.capitalTarget)
  })
})
