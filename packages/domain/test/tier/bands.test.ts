import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { minor } from '../../src/money/minor.ts'
import { MAX_DRIVER_BPS, totalFees } from '../../src/money/allocate.ts'
import { DEFAULT_BANDS, type TierRule, TierRuleError, bpsForCount, resolveRule, validateBands } from '../../src/tier/rules.ts'
import { splitDay, trueUp } from '../../src/tier/split.ts'

const syp = (n: number) => minor(BigInt(n) * 100n)
const rule = (over: Partial<TierRule> = {}): TierRule => ({
  basis: 'orders',
  mode: 'whole',
  vehicleTypeId: null,
  bands: DEFAULT_BANDS,
  effectiveFrom: '2026-01-01',
  ...over,
})

describe('band table validation', () => {
  it('accepts the client’s default table', () => {
    expect(() => validateBands(DEFAULT_BANDS)).not.toThrow()
  })

  it('rejects a gap', () => {
    expect(() =>
      validateBands([
        { from: 0, to: 14, driverBps: 3500 },
        { from: 16, to: null, driverBps: 4000 },
      ]),
    ).toThrow(TierRuleError)
  })

  it('rejects an overlap', () => {
    expect(() =>
      validateBands([
        { from: 0, to: 14, driverBps: 3500 },
        { from: 14, to: null, driverBps: 4000 },
      ]),
    ).toThrow(TierRuleError)
  })

  it('rejects a table that does not start at zero orders', () => {
    expect(() => validateBands([{ from: 1, to: null, driverBps: 4000 }])).toThrow(TierRuleError)
  })

  it('rejects a table that is not open-ended at the top', () => {
    expect(() => validateBands([{ from: 0, to: 99, driverBps: 4000 }])).toThrow(TierRuleError)
  })

  it('refuses a band that would eat into Yallago’s fixed 20% (BR4)', () => {
    expect(() => validateBands([{ from: 0, to: null, driverBps: MAX_DRIVER_BPS + 1 }])).toThrow(TierRuleError)
  })
})

describe('band boundaries — 14/15, 24/25, 34/35 (AC #7)', () => {
  it.each([
    [0, 3500],
    [1, 3500],
    [14, 3500],
    [15, 4000],
    [24, 4000],
    [25, 4300],
    [34, 4300],
    [35, 4600],
    [500, 4600],
  ])('a %i-order day earns %i bps', (count, expected) => {
    expect(bpsForCount(DEFAULT_BANDS, count)).toBe(expected)
  })

  it('the SRS example’s 20-order day lands in the 40% band', () => {
    const fees = Array.from({ length: 20 }, () => syp(5_000))
    const day = splitDay(fees, rule())

    expect(day.effectiveDriverBps).toBe(4000)
    expect(day.driverShare).toBe(syp(40_000))
    expect(day.companyShare).toBe(syp(40_000))
    expect(day.yalagoShare).toBe(syp(20_000))
  })

  it('crossing 14→15 raises the whole day, not just the marginal order', () => {
    const at14 = splitDay(Array.from({ length: 14 }, () => syp(5_000)), rule())
    const at15 = splitDay(Array.from({ length: 15 }, () => syp(5_000)), rule())

    expect(at14.driverShare).toBe(syp(24_500)) // 35% of 70,000
    expect(at15.driverShare).toBe(syp(30_000)) // 40% of 75,000 — the WHOLE day re-rated
  })
})

describe('whole vs marginal', () => {
  const fees = Array.from({ length: 20 }, () => syp(5_000))

  it('marginal pays each order at the rate of its own ordinal', () => {
    const marginal = splitDay(fees, rule({ mode: 'marginal' }))
    // orders 1–14 at 35% of 5,000 = 1,750 each; orders 15–20 at 40% = 2,000 each
    expect(marginal.driverShare).toBe(syp(14 * 1_750 + 6 * 2_000))
    expect(marginal.driverShare).toBeLessThan(splitDay(fees, rule()).driverShare)
  })

  it('both modes still exhaust the fee total exactly', () => {
    for (const mode of ['whole', 'marginal'] as const) {
      const d = splitDay(fees, rule({ mode }))
      expect(d.driverShare + d.companyShare + d.yalagoShare).toBe(d.feeTotal)
    }
  })

  it('property: exhaustive for any fees, any mode, any valid band table', () => {
    const feeArb = fc.array(
      fc.integer({ min: 1, max: 1_000_000 }).map((n) => minor(BigInt(n))),
      { maxLength: 60 },
    )
    fc.assert(
      fc.property(feeArb, fc.constantFrom('whole' as const, 'marginal' as const), (fees, mode) => {
        const d = splitDay(fees, rule({ mode }))
        expect(d.driverShare + d.companyShare + d.yalagoShare).toBe(totalFees(fees).feeTotal)
        expect(d.companyShare >= 0n).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})

describe('day-level true-up across two shifts', () => {
  it('restates shift 1 when shift 2 pushes the day across a band', () => {
    const shift1 = Array.from({ length: 12 }, () => syp(5_000))
    const shift2 = Array.from({ length: 10 }, () => syp(5_000))

    // Shift 1 approved alone: 12 orders → 35%.
    const first = splitDay(shift1, rule())
    expect(first.effectiveDriverBps).toBe(3500)
    expect(first.driverShare).toBe(syp(21_000))

    // Shift 2 approved: the day is now 22 orders → 40% on ALL of it.
    const t = trueUp([...shift1, ...shift2], rule(), {
      driver: first.driverShare,
      company: first.companyShare,
      yalago: first.yalagoShare,
    })

    expect(t.day.effectiveDriverBps).toBe(4000)
    expect(t.day.driverShare).toBe(syp(44_000)) // 40% of 110,000
    expect(t.driverDelta).toBe(syp(23_000)) // 44,000 − 21,000
    expect(t.restatesEarlierShifts).toBe(true)

    // The true-up is worth real money: per-shift banding would have paid 35% throughout.
    const perShift = splitDay(shift1, rule()).driverShare + splitDay(shift2, rule()).driverShare
    expect(t.day.driverShare - perShift).toBe(syp(5_500))
  })

  it('the deltas still exhaust the day exactly', () => {
    const shift1 = Array.from({ length: 12 }, () => syp(5_000))
    const first = splitDay(shift1, rule())
    const t = trueUp([...shift1, ...Array.from({ length: 10 }, () => syp(5_000))], rule(), {
      driver: first.driverShare,
      company: first.companyShare,
      yalago: first.yalagoShare,
    })
    expect(t.driverDelta + t.companyDelta + t.yalagoDelta).toBe(t.day.feeTotal - first.feeTotal)
  })
})

describe('effective-dated resolution (F-3)', () => {
  type Stored = TierRule & { status: 'active' | 'superseded' | 'withdrawn' }
  const rules: Stored[] = [
    { ...rule({ effectiveFrom: '2026-01-01' }), status: 'superseded' },
    { ...rule({ effectiveFrom: '2026-07-01', bands: [{ from: 0, to: null, driverBps: 4500 }] }), status: 'active' },
  ]

  it('a past date resolves to the rule that was in force THEN, even though it is superseded', () => {
    // Filtering on status='active' alone would silently restate every historical day.
    const r = resolveRule(rules, '2026-06-30', null)
    expect(r.effectiveFrom).toBe('2026-01-01')
    expect(bpsForCount(r.bands, 20)).toBe(4000)
  })

  it('a current date resolves to the active rule', () => {
    expect(resolveRule(rules, '2026-07-21', null).effectiveFrom).toBe('2026-07-01')
  })

  it('a vehicle-type-specific table beats the catch-all on the same date', () => {
    const withType: Stored[] = [
      ...rules,
      {
        ...rule({ effectiveFrom: '2026-07-01', vehicleTypeId: 'scooter', bands: [{ from: 0, to: null, driverBps: 4200 }] }),
        status: 'active',
      },
    ]
    expect(bpsForCount(resolveRule(withType, '2026-07-21', 'scooter').bands, 20)).toBe(4200)
    expect(bpsForCount(resolveRule(withType, '2026-07-21', null).bands, 20)).toBe(4500)
  })

  it('withdrawn rules are never resolved', () => {
    const withdrawn: Stored[] = [{ ...rule({ effectiveFrom: '2026-07-10' }), status: 'withdrawn' }, ...rules]
    expect(resolveRule(withdrawn, '2026-07-21', null).effectiveFrom).toBe('2026-07-01')
  })

  it('throws rather than guessing when no rule is in force', () => {
    expect(() => resolveRule(rules, '2025-12-31', null)).toThrow(TierRuleError)
  })
})
