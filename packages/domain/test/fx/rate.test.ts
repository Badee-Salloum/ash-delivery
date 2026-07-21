import { describe, expect, it } from 'vitest'
import { minor } from '../../src/money/minor.ts'
import { type FxDay, FxError, SEED_SYP_MINOR_PER_USD, resolveFxDay, toUsdMinor } from '../../src/fx/rate.ts'

const syp = (n: number) => minor(BigInt(n) * 100n)
const day = (businessDate: string, rate = SEED_SYP_MINOR_PER_USD, provisional = false): FxDay => ({
  businessDate,
  sypMinorPerUsd: rate,
  provisional,
})

describe('USD equivalence (BR6, AC #6)', () => {
  it('converts at the seed rate of ~130 new SYP to the dollar', () => {
    // 130,000 new SYP at 130/USD = 1,000 USD = 100,000 cents.
    expect(toUsdMinor(syp(130_000), day('2026-07-21'))).toBe(100_000n)
  })

  it('converts the canonical shift’s 230,000 new SYP', () => {
    // 230,000 / 130 ≈ 1,769.23 USD
    expect(toUsdMinor(syp(230_000), day('2026-07-21'))).toBe(176_923n)
  })

  it('rounds half-up, because this is a display figure and never a posting basis', () => {
    // 1 new SYP = 100 minor. 100 × 100 / 13000 = 0.769… → 1 cent.
    expect(toUsdMinor(syp(1), day('2026-07-21'))).toBe(1n)
    expect(toUsdMinor(minor(0n), day('2026-07-21'))).toBe(0n)
  })

  it('is symmetric around zero — a negative balance converts to a negative equivalent', () => {
    expect(toUsdMinor(minor(-syp(130_000)), day('2026-07-21'))).toBe(-100_000n)
  })

  it('refuses a non-positive rate rather than dividing by zero', () => {
    expect(() => toUsdMinor(syp(1), day('2026-07-21', 0n))).toThrow(FxError)
    expect(() => toUsdMinor(syp(1), day('2026-07-21', -1n))).toThrow(FxError)
  })

  it('one rate covers the whole day — the same amount converts identically all day', () => {
    const rate = day('2026-07-21', 13_500n)
    expect(toUsdMinor(syp(10_000), rate)).toBe(toUsdMinor(syp(10_000), rate))
  })
})

describe('resolving the day’s rate', () => {
  const days = [day('2026-07-19', 12_900n), day('2026-07-20', 13_000n)]

  it('uses the exact rate when the admin entered one', () => {
    const r = resolveFxDay(days, '2026-07-20')
    expect(r.sypMinorPerUsd).toBe(13_000n)
    expect(r.provisional).toBe(false)
  })

  it('carries the last rate forward, flagged provisional, when today’s is missing', () => {
    // A missing rate must never block posting: a failed 00:05 cron cannot be allowed to freeze
    // the business.
    const r = resolveFxDay(days, '2026-07-21')
    expect(r.sypMinorPerUsd).toBe(13_000n)
    expect(r.provisional).toBe(true)
    expect(r.businessDate).toBe('2026-07-21')
  })

  it('carries forward across a gap of several days', () => {
    expect(resolveFxDay(days, '2026-07-28').sypMinorPerUsd).toBe(13_000n)
  })

  it('never reaches forward in time for a rate', () => {
    expect(() => resolveFxDay(days, '2026-07-18')).toThrow(FxError)
  })

  it('throws before the very first rate exists, rather than inventing one', () => {
    expect(() => resolveFxDay([], '2026-07-21')).toThrow(FxError)
  })
})
