import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Minor, minor, sum } from '../../src/money/minor.ts'
import { MAX_DRIVER_BPS, orderBlock, splitBlock, totalFees, yalagoCut } from '../../src/money/allocate.ts'

/**
 * Fees deliberately NOT divisible by 5.
 *
 * The SRS's canonical example uses 5,000 throughout, which divides evenly by 20% and hides
 * every rounding question in the system. If the 80% block were ever computed as
 * `0.80 × Σfees` instead of as a residual, these generators would fail immediately — which
 * is exactly their job.
 */
const awkwardFee = fc.integer({ min: 1, max: 999_999 }).map((n) => minor(BigInt(n * 5 + (n % 4) + 1)))
const anyFee = fc.oneof(
  awkwardFee,
  fc.integer({ min: 0, max: 10_000_000 }).map((n) => minor(BigInt(n))),
)
const feeList = fc.array(anyFee, { minLength: 0, maxLength: 120 })

describe('allocate / yalagoCut', () => {
  it('rejects a negative total rather than guessing a rounding direction', () => {
    expect(() => yalagoCut(minor(-1n))).toThrow(RangeError)
  })

  it('the per-order block is exactly fee − cut, for any fee', () => {
    fc.assert(
      fc.property(anyFee, (fee) => {
        expect(orderBlock(fee) + yalagoCut(fee)).toBe(fee)
      }),
    )
  })

  it("Yallago's cut never exceeds 20% and never loses more than one minor unit to flooring", () => {
    fc.assert(
      fc.property(anyFee, (fee) => {
        const cut = yalagoCut(fee)
        expect(cut * 10_000n).toBeLessThanOrEqual(fee * 2000n)
        expect((cut + 1n) * 10_000n).toBeGreaterThan(fee * 2000n)
      }),
    )
  })
})

describe('totalFees — the residual rule', () => {
  it('blockTotal + yalagoTotal === feeTotal, exactly, for any basket of fees', () => {
    fc.assert(
      fc.property(feeList, (fees) => {
        const t = totalFees(fees)
        expect(t.blockTotal + t.yalagoTotal).toBe(t.feeTotal)
      }),
    )
  })

  it('yalagoTotal is the SUM OF PER-ORDER CUTS, not 20% of the sum', () => {
    fc.assert(
      fc.property(feeList, (fees) => {
        const t = totalFees(fees)
        expect(t.yalagoTotal).toBe(sum(fees.map((f) => yalagoCut(f))))
      }),
    )
  })

  it('REGRESSION: the naive 0.80 × Σfees formula really does diverge — this is not theoretical', () => {
    // Three orders at 1,001 minor units. Per-order: cut = 200 (floored from 200.2), block = 801.
    // Residual blockTotal = 3,003 − 600 = 2,403.
    // Naive 0.80 × 3,003 = 2,402 (floored). One minor unit adrift, against a zero tolerance.
    const fees: Minor[] = [minor(1001n), minor(1001n), minor(1001n)]
    const t = totalFees(fees)

    expect(t.feeTotal).toBe(3003n)
    expect(t.yalagoTotal).toBe(600n)
    expect(t.blockTotal).toBe(2403n)

    const naive = (t.feeTotal * 8000n) / 10_000n
    expect(naive).toBe(2402n)
    expect(naive).not.toBe(t.blockTotal)
  })
})

describe('splitBlock — exhaustiveness (AC #5)', () => {
  const driverBps = fc.integer({ min: 0, max: MAX_DRIVER_BPS })

  it('driver + company + yalago === feeTotal, exactly, for any fees and any band rate', () => {
    fc.assert(
      fc.property(feeList, driverBps, (fees, bps) => {
        const t = totalFees(fees)
        const s = splitBlock(t, bps)
        expect(s.driverShare + s.companyShare + s.yalagoShare).toBe(t.feeTotal)
      }),
    )
  })

  it('no share is ever negative', () => {
    fc.assert(
      fc.property(feeList, driverBps, (fees, bps) => {
        const s = splitBlock(totalFees(fees), bps)
        expect(s.driverShare >= 0n && s.companyShare >= 0n && s.yalagoShare >= 0n).toBe(true)
      }),
    )
  })

  it('the company absorbs the rounding remainder, never the driver and never Yallago (BR4)', () => {
    fc.assert(
      fc.property(feeList, driverBps, (fees, bps) => {
        const t = totalFees(fees)
        const s = splitBlock(t, bps)
        // The driver gets the floor of his entitlement...
        expect(s.driverShare * 10_000n).toBeLessThanOrEqual(t.feeTotal * BigInt(bps))
        // ...Yallago's is untouched by the band...
        expect(s.yalagoShare).toBe(t.yalagoTotal)
        // ...so whatever is left over is the company's.
        expect(s.companyShare).toBe(t.blockTotal - s.driverShare)
      }),
    )
  })

  it('refuses a band that would eat into Yallago’s fixed 20%', () => {
    expect(() => splitBlock(totalFees([minor(1000n)]), MAX_DRIVER_BPS + 1)).toThrow(RangeError)
  })
})
