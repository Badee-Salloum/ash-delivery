import { describe, expect, it } from 'vitest'
import {
  type FundPosition,
  planRestoration,
  postingsForCashCountReconciliation,
  postingsForRestoration,
} from '../../src/treasury/restoration.ts'
import { type Minor, ZERO, minor, sub } from '../../src/money/minor.ts'
import { creditsOf, debitsOf, fundCode } from '../../src/ledger/recipes.ts'

/**
 * «الترميم» — measured against the owner's own spreadsheet.
 *
 * His book is the specification, so the first two tests are his two rows, verbatim. If those ever
 * stop passing, the system has stopped agreeing with the way he actually runs the business.
 */

const syp = (whole: number): Minor => minor(BigInt(whole) * 100n)

const box = (over: Partial<FundPosition> = {}): FundPosition => ({
  fundCode: 'office_cash',
  officeBalance: syp(3_600_000),
  receivables: syp(400_000),
  capitalTarget: syp(4_000_000),
  ...over,
})

describe('the owner`s own book, encoded', () => {
  /** كاش المكتب 3,600,000 + ذمم 400,000 = 4,000,000 — his `=SUM(I38:J48)-4000000` is zero. */
  it('a day already restored: cash lands exactly on capital', () => {
    const plan = planRestoration([box()])
    expect(plan.legs[0]!.officeBalance).toBe(syp(3_600_000))
    expect(plan.legs[0]!.receivables).toBe(syp(400_000))
    expect(plan.legs[0]!.position).toBe(syp(4_000_000))
    expect(plan.legs[0]!.delta).toBe(ZERO)
    expect(plan.legs[0]!.direction).toBeNull()
    expect(plan.netToCompany).toBe(ZERO)
    // Nothing on target should post. A zero-amount entry is not a no-op, it is a lie in the ledger.
    expect(postingsForRestoration(plan, '2026-08-12')).toHaveLength(0)
  })

  /** محفظة المكتب 970,000 + ذمم 30,000 = 1,000,000 — his `=SUM(G38:H49)-1000000` is zero. */
  it('and so does the wallet', () => {
    const plan = planRestoration([
      box({ fundCode: 'office_wallet', officeBalance: syp(970_000), receivables: syp(30_000), capitalTarget: syp(1_000_000) }),
    ])
    expect(plan.legs[0]!.delta).toBe(ZERO)
    expect(plan.feasible).toBe(true)
  })

  /** Both boxes together — «المبلغ الكامل 5,000,000». */
  it('nets to nothing across both boxes on a restored day', () => {
    const plan = planRestoration([
      box(),
      box({ fundCode: 'office_wallet', officeBalance: syp(970_000), receivables: syp(30_000), capitalTarget: syp(1_000_000) }),
    ])
    expect(plan.netToCompany).toBe(ZERO)
    expect(plan.feasible).toBe(true)
  })
})

describe('«كييش» — the day made a profit', () => {
  it('sweeps the surplus to صندوق الشركة', () => {
    const plan = planRestoration([box({ officeBalance: syp(4_300_000) })]) // +400,000 ذمم = 4,700,000
    const leg = plan.legs[0]!
    expect(leg.direction).toBe('to_company')
    expect(leg.amount).toBe(syp(700_000))
    expect(plan.netToCompany).toBe(syp(700_000))

    const [posting] = postingsForRestoration(plan, '2026-08-12')
    expect(posting!.eventType).toBe('restoration')
    expect(fundCode(posting!.lines.find((l) => l.side === 'D')!.fund)).toBe('company_box')
    expect(fundCode(posting!.lines.find((l) => l.side === 'C')!.fund)).toBe('office_cash')
  })

  /**
   * THE ذمم SUBTLETY, and it is deliberate. A surplus counting ذمم leaves the box BELOW its target
   * after the sweep — the missing money is in a driver's pocket and comes back tomorrow when he
   * opens on it. That is exactly why the owner's formula adds الذمم in the first place.
   */
  it('leaves the box below target when the surplus is partly out on ذمم', () => {
    const plan = planRestoration([box({ officeBalance: syp(4_600_000), receivables: syp(400_000) })])
    const leg = plan.legs[0]!
    expect(leg.position).toBe(syp(5_000_000)) // 4,600,000 in office + 400,000 owed
    expect(leg.amount).toBe(syp(1_000_000))
    // 4,600,000 office balance − 1,000,000 swept leaves 3,600,000 against a 4,000,000
    // target. Correct: the missing 400,000 is in a driver's pocket and returns tomorrow.
    expect(sub(syp(4_600_000), leg.amount)).toBe(syp(3_600_000))
  })

  /** You cannot hand over cash you are not holding. */
  it('refuses a sweep larger than the live office balance', () => {
    // The whole surplus is ذمم: 100,000 in the office fund, 4,500,000 owed, target 4,000,000.
    const plan = planRestoration([box({ officeBalance: syp(100_000), receivables: syp(4_500_000) })])
    expect(plan.legs[0]!.refusals).toContain('sweep_exceeds_counted')
    expect(plan.feasible).toBe(false)
    expect(postingsForRestoration(plan, '2026-08-12')).toHaveLength(0)
  })
})

describe('«شحن من الصندوق» — the day came up short', () => {
  it('restores the capital from صندوق الشركة', () => {
    const plan = planRestoration([box({ officeBalance: syp(3_000_000), receivables: ZERO })])
    const leg = plan.legs[0]!
    expect(leg.direction).toBe('from_company')
    expect(leg.amount).toBe(syp(1_000_000))
    expect(plan.netToCompany).toBe(minor(-syp(1_000_000)))

    const [posting] = postingsForRestoration(plan, '2026-08-12')
    expect(fundCode(posting!.lines.find((l) => l.side === 'D')!.fund)).toBe('office_cash')
    expect(fundCode(posting!.lines.find((l) => l.side === 'C')!.fund)).toBe('company_box')
  })

  /** A shortfall is never refused for lack of cash — the company fund is the one paying. */
  it('does not check the drawer when money is coming IN', () => {
    const plan = planRestoration([box({ officeBalance: ZERO, receivables: ZERO })])
    expect(plan.legs[0]!.feasible).toBe(true)
    expect(plan.legs[0]!.amount).toBe(syp(4_000_000))
  })
})

describe('the guards', () => {
  /**
   * Without a target every box looks like pure surplus. On the very first run that would sweep the
   * entire treasury into the company fund — the most expensive possible reading of "not configured".
   */
  it('refuses a box with no رأس مال configured rather than sweeping everything', () => {
    const plan = planRestoration([box({ capitalTarget: null })])
    expect(plan.legs[0]!.officeBalance).toBe(syp(3_600_000))
    expect(plan.legs[0]!.receivables).toBe(syp(400_000))
    expect(plan.legs[0]!.refusals).toContain('no_capital_target')
    expect(plan.feasible).toBe(false)
    expect(postingsForRestoration(plan, '2026-08-12')).toHaveLength(0)
  })

  it('keys each leg by date AND box, so one day cannot restore the same box twice', () => {
    const plan = planRestoration([
      box({ officeBalance: syp(4_300_000) }),
      box({ fundCode: 'office_wallet', officeBalance: syp(1_200_000), receivables: ZERO, capitalTarget: syp(1_000_000) }),
    ])
    const keys = postingsForRestoration(plan, '2026-08-12').map((p) => p.occurrenceKey)
    expect(keys).toEqual(['2026-08-12:office_cash', '2026-08-12:office_wallet'])
  })

  it('every posting balances', () => {
    const plan = planRestoration([
      box({ officeBalance: syp(4_300_000) }),
      box({ fundCode: 'office_wallet', officeBalance: syp(500_000), receivables: ZERO, capitalTarget: syp(1_000_000) }),
    ])
    for (const p of postingsForRestoration(plan, '2026-08-12')) expect(debitsOf(p)).toBe(creditsOf(p))
  })

  /** One infeasible leg must not silently take the other with it, nor be counted in the net. */
  it('keeps a good leg usable when the other is refused', () => {
    const plan = planRestoration([
      box({ capitalTarget: null }),
      box({ fundCode: 'office_wallet', officeBalance: syp(1_200_000), receivables: ZERO, capitalTarget: syp(1_000_000) }),
    ])
    expect(plan.feasible).toBe(false)
    expect(plan.netToCompany).toBe(syp(200_000)) // only the wallet leg counts
    expect(postingsForRestoration(plan, '2026-08-12')).toHaveLength(1)
  })
})

describe('sealed cash-count variance reconciliation', () => {
  const input = {
    branchId: '11111111-1111-1111-1111-111111111111',
    cashCountId: '42',
    proofSha256: 'a'.repeat(64),
  }

  it('records a shortage against a dedicated variance cost centre, never company_box', () => {
    const [posting] = postingsForCashCountReconciliation({
      ...input,
      lines: [{ fundCode: 'office_cash', variance: minor(-syp(100_000)), resolution: 'signed shortage' }],
    })

    expect(posting).toMatchObject({
      eventType: 'correction',
      occurrenceKey: `cash-count:42:${'a'.repeat(64)}:office_cash`,
    })
    expect(posting!.lines).toEqual([
      {
        fund: { kind: 'office_cash' },
        side: 'C',
        amount: syp(100_000),
        role: 'cash_count_reconciled_fund',
      },
      {
        fund: {
          kind: 'cost_center',
          costCenterId: 'cash_count_variance:11111111-1111-1111-1111-111111111111:office_cash',
        },
        side: 'D',
        amount: syp(100_000),
        role: 'cash_count_variance_counterpart',
      },
    ])
    expect(posting!.lines.map((line) => fundCode(line.fund))).not.toContain('company_box')
    expect(debitsOf(posting!)).toBe(creditsOf(posting!))
  })

  it('records an overage in the opposite direction and emits nothing for exact boxes', () => {
    const postings = postingsForCashCountReconciliation({
      ...input,
      lines: [
        { fundCode: 'office_cash', variance: syp(50_000), resolution: 'signed overage' },
        { fundCode: 'office_wallet', variance: ZERO, resolution: null },
      ],
    })
    expect(postings).toHaveLength(1)
    expect(postings[0]!.lines[0]).toMatchObject({ fund: { kind: 'office_cash' }, side: 'D' })
    expect(postings[0]!.lines[1]).toMatchObject({ fund: { kind: 'cost_center' }, side: 'C' })
  })

  it('requires the sealed proof and the manager`s line-specific explanation', () => {
    expect(() => postingsForCashCountReconciliation({
      ...input,
      proofSha256: 'not-a-proof',
      lines: [{ fundCode: 'office_cash', variance: syp(1), resolution: 'counted twice' }],
    })).toThrow('SHA-256 proof')
    expect(() => postingsForCashCountReconciliation({
      ...input,
      lines: [{ fundCode: 'office_cash', variance: syp(1), resolution: null }],
    })).toThrow('requires a resolution')
  })
})
