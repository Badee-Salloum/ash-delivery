import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type SettlementInput, planSettlement } from '../../src/settlement/statement.ts'
import { type Minor, ZERO, minor } from '../../src/money/minor.ts'

/**
 * «كشف التسوية» — where the cash in the driver's hands goes.
 *
 * The property that matters more than any single case: the three destinations must sum back to the
 * declared cash exactly. Anything else is inventing or destroying money between his pocket and the
 * box, and it would balance against itself so nobody would ever find it.
 */

const syp = (whole: number): Minor => minor(BigInt(whole) * 100n)

const base = (over: Partial<SettlementInput> = {}): SettlementInput => ({
  endCashDeclared: syp(230_000),
  expectedCash: syp(230_000),
  driverShare: syp(40_000),
  openingReceivable: ZERO,
  keepAsReceivable: ZERO,
  payShareNow: true,
  managerAdjustment: ZERO,
  ...over,
})

describe('the ordinary night — BR1 zero, share paid, nothing kept', () => {
  it('sends everything but his share to the box', () => {
    const p = planSettlement(base())
    expect(p.paidToDriver).toBe(syp(40_000))
    expect(p.toOfficeCash).toBe(syp(190_000))
    expect(p.keptAsReceivable).toBe(ZERO)
    expect(p.withheldFromShare).toBe(ZERO)
    expect(p.feasible).toBe(true)
  })

  /** Owner decision (f) is per-shift payment; deferring is the configurable alternative. */
  it('sends the whole lot to the box when the share is not paid tonight', () => {
    const p = planSettlement(base({ payShareNow: false }))
    expect(p.paidToDriver).toBe(ZERO)
    expect(p.toOfficeCash).toBe(syp(230_000))
    expect(p.shareRemainingPayable).toBe(syp(40_000))
  })
})

describe('الذمة — cash that stays with him overnight', () => {
  it('comes out of the box, not out of his share', () => {
    const p = planSettlement(base({ keepAsReceivable: syp(100_000) }))
    expect(p.paidToDriver).toBe(syp(40_000))
    expect(p.keptAsReceivable).toBe(syp(100_000))
    expect(p.toOfficeCash).toBe(syp(90_000))
  })

  it('refuses to keep more than he is holding', () => {
    const p = planSettlement(base({ keepAsReceivable: syp(500_000) }))
    expect(p.feasible).toBe(false)
    expect(p.refusals).toContain('keep_exceeds_end_cash')
  })

  it('refuses a distribution that would take the box below nothing', () => {
    // Keeping 200,000 AND paying a 40,000 share out of 230,000 leaves the box short.
    const p = planSettlement(base({ keepAsReceivable: syp(200_000) }))
    expect(p.feasible).toBe(false)
    expect(p.refusals).toContain('office_share_negative')
  })
})

/**
 * Only force-close admits a gap — `canApproveClose` refuses unless BR1 is exactly zero. Decision
 * (k): the shortfall comes off his share first, and the refusal stays the default.
 */
describe('a shortfall, which only force-close allows', () => {
  it('takes it from his share before anything else', () => {
    const p = planSettlement(base({ endCashDeclared: syp(212_000) })) // 18,000 short
    expect(p.withheldFromShare).toBe(syp(18_000))
    expect(p.residualReceivable).toBe(ZERO)
    expect(p.paidToDriver).toBe(syp(22_000))
    expect(p.toOfficeCash).toBe(syp(190_000)) // the box still gets what it was always owed
  })

  it('turns the part beyond his whole share into a receivable rather than losing it', () => {
    const p = planSettlement(base({ endCashDeclared: syp(180_000) })) // 50,000 short, share 40,000
    expect(p.withheldFromShare).toBe(syp(40_000))
    expect(p.residualReceivable).toBe(syp(10_000))
    expect(p.paidToDriver).toBe(ZERO)
  })

  it('gives a surplus back to him', () => {
    const p = planSettlement(base({ endCashDeclared: syp(235_000) })) // 5,000 over
    expect(p.paidToDriver).toBe(syp(45_000)) // his share plus the surplus
    expect(p.toOfficeCash).toBe(syp(190_000))
  })
})

/**
 * THE CASE THAT BITES. Decision D-6 computes the tier over the whole day, so a later shift restates
 * the earlier ones and one shift's delta can legitimately be NEGATIVE — the measured 14→15 crossing
 * in `recipes.ts:280-308`. A negative share is a ledger restatement, not cash owed by the driver,
 * and it must never be taken out of tonight's money.
 */
describe('a negative driver share', () => {
  it('never turns into a demand on tonight`s cash', () => {
    const p = planSettlement(base({ driverShare: minor(-1_500_00n) }))
    expect(p.paidToDriver).toBe(ZERO)
    expect(p.withheldFromShare).toBe(ZERO)
    expect(p.toOfficeCash).toBe(syp(230_000))
    expect(p.feasible).toBe(true)
  })

  it('does not let a shortfall be "recovered" from a share that is already negative', () => {
    const p = planSettlement({ ...base({ driverShare: minor(-1_500_00n) }), endCashDeclared: syp(220_000) })
    expect(p.withheldFromShare).toBe(ZERO)
    expect(p.residualReceivable).toBe(syp(10_000)) // the whole gap, since there is no share to take
  })
})

describe('the manager`s adjustment', () => {
  it('moves the box figure and nothing else', () => {
    const up = planSettlement(base({ managerAdjustment: syp(5_000) }))
    const down = planSettlement(base({ managerAdjustment: minor(-5_000_00n) }))
    expect(up.toOfficeCash).toBe(syp(195_000))
    expect(down.toOfficeCash).toBe(syp(185_000))
    expect(up.paidToDriver).toBe(down.paidToDriver)
  })
})

describe('the conservation property — the whole safety argument', () => {
  it('always distributes exactly the declared cash, for any inputs', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_00n }),
        fc.bigInt({ min: 0n, max: 10_000_000_00n }),
        fc.bigInt({ min: -500_000_00n, max: 500_000_00n }),
        fc.bigInt({ min: 0n, max: 1_000_000_00n }),
        fc.bigInt({ min: -50_000_00n, max: 50_000_00n }),
        fc.boolean(),
        (declared, expected, share, keep, adjust, payNow) => {
          const p = planSettlement({
            endCashDeclared: minor(declared),
            expectedCash: minor(expected),
            driverShare: minor(share),
            openingReceivable: ZERO,
            keepAsReceivable: minor(keep),
            payShareNow: payNow,
            managerAdjustment: minor(adjust),
          })
          // يدخل الصندوق + يبقى ذمة + يُعاد للسائق − تعديل المدير === النقد المصرَّح به
          expect(p.toOfficeCash + p.keptAsReceivable + p.paidToDriver - minor(adjust)).toBe(declared)
        },
      ),
    )
  })

  /** A shortfall is fully accounted for: what his share absorbs plus what becomes a ذمة. */
  it('never loses part of a shortfall', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000_00n }),
        fc.bigInt({ min: 0n, max: 1_000_000_00n }),
        fc.bigInt({ min: -100_000_00n, max: 100_000_00n }),
        (declared, expected, share) => {
          const p = planSettlement({
            ...base(),
            endCashDeclared: minor(declared),
            expectedCash: minor(expected),
            driverShare: minor(share),
          })
          const shortfall = expected > declared ? expected - declared : 0n
          expect(p.withheldFromShare + p.residualReceivable).toBe(shortfall)
        },
      ),
    )
  })

  it('lists no zero-valued line — a statement of nothings is harder to read, not more complete', () => {
    for (const line of planSettlement(base()).lines) expect(line.amount).not.toBe(ZERO)
  })
})
