import { describe, expect, it } from 'vitest'
import { cashSettledReturnPostings, minor, parseMinor, planFixedShareSettlement } from '../../src/index.ts'

/**
 * «الحسم» — the charge that actually charges.
 *
 * Its predecessor did not. A manager-created CASH DEDUCTION shipped on 2026-09-08, and because a
 * cash deduction is subtracted from the expected total AND from the share, the variance rose by
 * exactly the charge and decision 13 handed the money back to the employee as a surplus. See
 * `deduction-cancels.test.ts`, which pins that cancellation so it cannot return.
 *
 * The owner's instruction was «يُنقص من حصّته فوراً»: the employee's figure falls by the charge and
 * the office collects it in the same close. So this term touches ONE side — earnings — and leaves
 * the expected total alone, which is precisely what its predecessor got wrong.
 *
 * Every assertion below is the one that was missing: not "did the number on the screen change", but
 * "did the employee receive less and did the office receive more".
 */

/** Keeps the branded `Minor` type rather than widening to bigint, so the plan input typechecks. */
const syp = (decimal: string) => parseMinor(decimal)

/** The measured production shape: 100 float + 20 top-up, one 100.00 fee, all of it in cash. */
function shift(managerChargeTotal?: ReturnType<typeof parseMinor>) {
  return planFixedShareSettlement({
    deliveryFeeTotal: syp('100.00'),
    fixedDriverShare: syp('40.00'),
    manualDriverShare: minor(0n),
    cashDeductionTotal: minor(0n),
    expectedCash: syp('200.00'),
    expectedWallet: minor(0n),
    actualCash: syp('200.00'),
    actualWallet: minor(0n),
    ...(managerChargeTotal === undefined ? {} : { managerChargeTotal }),
  })
}

describe('«الحسم» moves the money, which is the whole test', () => {
  it('takes the charge off the employee and gives it to the office', () => {
    const before = shift()
    expect(before.finalEmployeeCash).toBe(syp('40.00'))
    expect(before.cashClaimToOffice).toBe(syp('160.00'))
    expect(before.variance).toBe(minor(0n))

    const after = shift(syp('30.00'))
    expect(after.finalEmployeeCash).toBe(syp('10.00')) // he takes 30 less…
    expect(after.cashClaimToOffice).toBe(syp('190.00')) // …and the office collects 30 more
    // And the variance is UNTOUCHED, which is the difference from the withdrawn instrument: the
    // count did not disagree about anything, so the close must not claim a surplus.
    expect(after.variance).toBe(minor(0n))
    expect(after.baseDriverShare).toBe(syp('40.00')) // he still EARNED his share
  })

  it('conserves the shift: what the employee loses, the office gains, to the minor unit', () => {
    for (const amount of ['0.01', '7.00', '39.99', '40.00', '250.75', '9999.99']) {
      const before = shift()
      const after = shift(syp(amount))
      expect(before.finalEmployeeCash - after.finalEmployeeCash, amount).toBe(syp(amount))
      expect(after.cashClaimToOffice - before.cashClaimToOffice, amount).toBe(syp(amount))
      // Nothing else in the close is allowed to move.
      expect(after.variance, amount).toBe(before.variance)
      expect(after.expectedTotal, amount).toBe(before.expectedTotal)
      expect(after.baseDriverShare, amount).toBe(before.baseDriverShare)
      expect(after.walletClaimToOffice, amount).toBe(before.walletClaimToOffice)
    }
  })

  it('can drive the employee negative — he then pays in, and that is the point', () => {
    // A 60 charge against a 40 share: he owes the company 20 on top of handing back the custody.
    const over = shift(syp('60.00'))
    expect(over.finalEmployeeCash).toBe(syp('-20.00'))
    expect(over.cashClaimToOffice).toBe(syp('220.00'))
    // …and the close offers that shortfall as a receivable rather than forcing it to be paid now.
    expect(over.maximumCashShortageReceivable).toBe(syp('20.00'))
  })

  it('refuses a negative charge — the direction is the instrument, not the sign', () => {
    expect(() => shift(syp('-1.00'))).toThrow()
  })

  it('is absent by default, so every shift without one is unchanged to the minor unit', () => {
    expect(shift(minor(0n))).toEqual(shift())
  })
})

describe('the books say what happened', () => {
  it('records the charge as income, not as a quietly fuller cash box', () => {
    const settlement = shift(syp('30.00'))
    const postings = cashSettledReturnPostings({ driverId: 'd-1', settlement })
    const lines = postings.flatMap((posting) => posting.lines)

    /** Net movement on one fund: debits positive, credits negative. */
    const at = (kind: string) =>
      lines.filter((l) => l.fund.kind === kind).reduce<bigint>((t, l) => t + (l.side === 'D' ? l.amount : -l.amount), 0n)

    // The payable clears all 40 — he EARNED his share, and the charge is not hidden by shrinking it.
    expect(at('driver_share_payable')).toBe(syp('40.00'))
    // The office physically receives 190.
    expect(at('office_cash')).toBe(syp('190.00'))
    // And the 30 is named. `other_income`, never `company_revenue`: that account is the company's
    // residual share of DELIVERY fees, and damage recovered from a driver is not delivery work.
    expect(at('other_income')).toBe(syp('-30.00'))

    // Every posting balances, which is what the income line is also there to guarantee.
    for (const posting of postings) {
      const sum = posting.lines.reduce<bigint>((t, l) => t + (l.side === 'D' ? l.amount : -l.amount), 0n)
      expect(sum, posting.eventType).toBe(0n)
    }
  })

  it('posts no income line at all when there is no charge', () => {
    const postings = cashSettledReturnPostings({ driverId: 'd-1', settlement: shift() })
    const income = postings.flatMap((p) => p.lines).filter((l) => l.fund.kind === 'other_income')
    expect(income).toHaveLength(0)
  })
})
