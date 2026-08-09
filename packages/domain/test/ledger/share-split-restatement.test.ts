import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Minor, minor, sum } from '../../src/money/minor.ts'
import { totalFees } from '../../src/money/allocate.ts'
import { type ShiftOrder } from '../../src/br1/equation.ts'
import { DEFAULT_BANDS, type TierRule } from '../../src/tier/rules.ts'
import { splitDay, trueUp } from '../../src/tier/split.ts'
import {
  UnbalancedPostingError,
  balanceOf,
  creditsOf,
  debitsOf,
  isFund,
  postingsForApproval,
  shareSplit,
} from '../../src/ledger/recipes.ts'

/**
 * The day-tier true-up hands `shareSplit` SIGNED deltas, and in whole-amount mode — the configured
 * default — the company's delta is negative on every band crossing. `shareSplit` used to push a
 * share line only `if (share > 0n)`, so the negative one vanished and the posting no longer
 * balanced: `UnbalancedPostingError` out of `postingsForApproval`, i.e. a 500 at the moment a branch
 * manager approves the second shift of the day. The shift could not be approved at all.
 *
 * Revert the `share()` helper in `shareSplit` to the three `if (… > 0n)` pushes and every test here
 * fails.
 */

const syp = (n: number): Minor => minor(BigInt(n) * 100n)

const whole: TierRule = {
  basis: 'orders',
  mode: 'whole',
  vehicleTypeId: null,
  bands: DEFAULT_BANDS,
  effectiveFrom: '2026-01-01',
}

/** The deltas a second shift posts, given how many orders came before it and how many it adds. */
function deltasFor(rule: TierRule, priorCount: number, newCount: number, fee: Minor) {
  const priorFees = Array.from({ length: priorCount }, () => fee)
  const newFees = Array.from({ length: newCount }, () => fee)
  const posted = splitDay(priorFees, rule)
  const t = trueUp([...priorFees, ...newFees], rule, {
    driver: posted.driverShare,
    company: posted.companyShare,
    yalago: posted.yalagoShare,
  })
  return {
    posted,
    day: t.day,
    split: { driverShare: t.driverDelta, companyShare: t.companyDelta, yalagoShare: t.yalagoDelta },
    newFees,
  }
}

describe('the tier true-up posts a NEGATIVE share, and the ledger must take it', () => {
  it('the 14→15 crossing: the company gives back 1,500 and the posting still balances', () => {
    const { posted, day, split, newFees } = deltasFor(whole, 14, 1, syp(5_000))

    // The numbers this is really about, stated plainly so a reader can check them by hand.
    expect(posted.driverShare).toBe(syp(24_500)) // 35% of 70,000
    expect(posted.companyShare).toBe(syp(31_500))
    expect(day.driverShare).toBe(syp(30_000)) // 40% of 75,000 — the band moved
    expect(day.companyShare).toBe(syp(30_000))

    expect(split.driverShare).toBe(syp(5_500))
    expect(split.companyShare).toBe(syp(-1_500)) // ← BR4: the tier rise comes out of the company
    expect(split.yalagoShare).toBe(syp(1_000))

    const posting = shareSplit('drv-1', totalFees(newFees), split)
    expect(debitsOf(posting)).toBe(creditsOf(posting))

    // The negative share is a DEBIT of company_revenue, not a missing line.
    const companyLine = posting.lines.find((l) => l.role === 'company_share')
    expect(companyLine).toBeDefined()
    expect(companyLine!.side).toBe('D')
    expect(companyLine!.amount).toBe(syp(1_500))

    // And the two postings TOGETHER land the day on its correct totals — which is the whole point
    // of a restatement. This ledger's convention is "debit increases, credit decreases", so revenue
    // accumulates as a negative balance and the give-back moves it back up by exactly 1,500.
    const priorPosting = shareSplit('drv-1', totalFees(Array.from({ length: 14 }, () => syp(5_000))), {
      driverShare: posted.driverShare,
      companyShare: posted.companyShare,
      yalagoShare: posted.yalagoShare,
    })
    const both = [priorPosting, posting]
    expect(balanceOf(both, isFund('company_revenue'))).toBe(minor(-day.companyShare))
    expect(balanceOf(both, isFund('driver_share_payable'))).toBe(minor(-day.driverShare))
    expect(balanceOf(both, isFund('yalago_income'))).toBe(minor(-day.yalagoShare))
  })

  it('the 34→35 crossing does the same, larger', () => {
    const { split, newFees } = deltasFor(whole, 34, 1, syp(5_000))
    expect(split.companyShare).toBe(syp(-3_400))
    const posting = shareSplit('drv-1', totalFees(newFees), split)
    expect(debitsOf(posting)).toBe(creditsOf(posting))
  })

  it('marginal mode produces no negative delta — which is why the mode switch hid this', () => {
    const { split } = deltasFor({ ...whole, mode: 'marginal' }, 14, 1, syp(5_000))
    expect(split.driverShare > 0n).toBe(true)
    expect(split.companyShare > 0n).toBe(true)
    expect(split.yalagoShare > 0n).toBe(true)
  })

  it('the whole approval path survives the crossing — this is the 500 the manager saw', () => {
    const { split, newFees } = deltasFor(whole, 14, 1, syp(5_000))
    const orders: ShiftOrder[] = newFees.map((fee, i) => ({
      orderNo: `o-${i}`,
      payMode: 'cash',
      fee,
      kind: 'yallago',
    }))
    const postings = postingsForApproval(
      {
        driverId: 'drv-1',
        branchId: 'br-1',
        floatTranches: [syp(100_000)],
        topupTranches: [syp(50_000)],
        orders,
      },
      split,
    )
    for (const p of postings) expect(debitsOf(p)).toBe(creditsOf(p))
  })

  it('a share of exactly zero posts no line — a line amount must carry a direction', () => {
    // A restatement with no new fees and nothing to move is not a posting at all. `assertBalanced`
    // refuses an empty line set, which is the correct answer: the alternative is a zero-amount line,
    // and `journal_lines` CHECKs `amount_minor > 0` precisely so that cannot exist.
    expect(() =>
      shareSplit('drv-1', totalFees([]), {
        driverShare: minor(0n),
        companyShare: minor(0n),
        yalagoShare: minor(0n),
      }),
    ).toThrow(UnbalancedPostingError)
  })

  it('property: any prior/new split of a day balances, in both tier modes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 9_999 }),
        fc.constantFrom<'whole' | 'marginal'>('whole', 'marginal'),
        (priorCount, newCount, feeUnits, mode) => {
          const fee = minor(BigInt(feeUnits))
          const { split, newFees } = deltasFor({ ...whole, mode }, priorCount, newCount, fee)
          const posting = shareSplit('drv-1', totalFees(newFees), split)
          expect(debitsOf(posting)).toBe(creditsOf(posting))
          // Whatever the signs, the three shares still exhaust exactly this shift's fees.
          expect(split.driverShare + split.companyShare + split.yalagoShare).toBe(sum(newFees))
        },
      ),
      { numRuns: 400 },
    )
  })
})
