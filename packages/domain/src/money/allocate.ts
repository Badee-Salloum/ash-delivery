import { type Bps, type Minor, minor, sub, sum } from './minor.ts'

export type Rounding = 'floor' | 'ceil' | 'half-up'

/** BR2 / BR4: Yallago's share is 20% of the delivery fee, fixed, always, forever. */
export const YALAGO_BPS: Bps = 2000

/** The maximum share a tier band may grant the driver: everything that is not Yallago's. */
export const MAX_DRIVER_BPS: Bps = 10_000 - YALAGO_BPS

/**
 * The owner's closing rule from 2026-08-14: every Yallago delivery pays the driver 40% of its
 * gross fee. This is deliberately separate from the legacy tier table; a close must not silently
 * move between 35/40/43/46% merely because another order was added later in the day.
 */
export const FIXED_DRIVER_BPS: Bps = 4_000

/**
 * Allocate `bps` of `total`, in whole minor units.
 *
 * `total` must be non-negative. Every allocation in this system is over a non-negative
 * amount (a fee, a day's fee total, a block); signed deltas are always produced by
 * SUBTRACTING two allocations, never by allocating a negative. Enforcing that here keeps
 * the rounding direction unambiguous — "floor" of a negative is a trap we simply refuse.
 */
export function allocate(total: Minor, bps: Bps, rounding: Rounding = 'floor'): Minor {
  if (total < 0n) throw new RangeError(`allocate() requires a non-negative total, got ${total}`)
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new RangeError(`bps must be an integer in [0, 10000], got ${bps}`)
  }
  const numerator = total * BigInt(bps)
  switch (rounding) {
    case 'floor':
      return minor(numerator / 10_000n)
    case 'ceil':
      return minor((numerator + 9_999n) / 10_000n)
    case 'half-up':
      return minor((numerator + 5_000n) / 10_000n)
  }
}

/**
 * Yallago's instant 20% cut on a SINGLE order (BR2 — deducted from the driver's wallet the
 * moment the order completes, never accrued and settled weekly).
 *
 * ASSUMPTION A-09: Yallago floors its own cut. We do not control this arithmetic — it happens
 * inside their app — so the rounding mode is a parameter, to be calibrated against the first
 * real dashboard + wallet screenshot pair (SRS open point م-4). If their rounding differs, a
 * shift with fees not divisible by 5 will show a non-zero BR1 of a few minor units.
 */
export function yalagoCut(fee: Minor, rounding: Rounding = 'floor'): Minor {
  return allocate(fee, YALAGO_BPS, rounding)
}

/**
 * The "80% block" for a single order: the driver+company money that stays merged in the
 * driver's hands until the ledger splits it at approval time (BR4).
 *
 * Defined as a RESIDUAL — `fee - yalagoCut(fee)` — never as `allocate(fee, 8000)`.
 */
export function orderBlock(fee: Minor, rounding: Rounding = 'floor'): Minor {
  return sub(fee, yalagoCut(fee, rounding))
}

export interface FeeTotals {
  /** Σ of the shift's / day's delivery fees. */
  readonly feeTotal: Minor
  /** Σ of the PER-ORDER Yallago cuts. Not a percentage of `feeTotal`. */
  readonly yalagoTotal: Minor
  /** `feeTotal - yalagoTotal`. The residual. This is the "0.80 ×" term of BR1. */
  readonly blockTotal: Minor
}

/**
 * Total the fees of a set of orders into the three BR1 terms.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────────────┐
 * │ THE SINGLE MOST IMPORTANT LINE IN THIS CODEBASE                                     │
 * │                                                                                     │
 * │ `blockTotal` is a RESIDUAL: Σfees − Σ(per-order 20% cuts).                           │
 * │ It is NEVER `0.80 × Σfees`.                                                          │
 * │                                                                                     │
 * │ BR1's tolerance is exactly zero. Multiplying a sum by 0.80 and rounding makes the    │
 * │ equation mathematically unsatisfiable the moment a fee is not divisible by 5 — the   │
 * │ rounding error lands on the wrong side of an equals sign that admits no slack.       │
 * │ The canonical SRS §2.3 example uses fees of 5,000 throughout, which hides this       │
 * │ perfectly. See test/money/allocate.test.ts, which generates fees that are NOT        │
 * │ divisible by 5 precisely to keep this honest.                                        │
 * └─────────────────────────────────────────────────────────────────────────────────────┘
 */
export function totalFees(fees: readonly Minor[], rounding: Rounding = 'floor'): FeeTotals {
  const feeTotal = sum(fees)
  const yalagoTotal = sum(fees.map((f) => yalagoCut(f, rounding)))
  return { feeTotal, yalagoTotal, blockTotal: sub(feeTotal, yalagoTotal) }
}

export interface BlockSplit {
  readonly driverShare: Minor
  readonly companyShare: Minor
  readonly yalagoShare: Minor
}

/**
 * Split the day's block between driver and company at the day's tier rate (BR4).
 *
 * The driver's share is allocated from `feeTotal` (the tier percentages in SRS F-1 are
 * percentages OF THE DELIVERY FEE — 40/40/20 — not of the block). The company then takes
 * the RESIDUAL of the block, which means:
 *
 *   • driverShare + companyShare + yalagoShare === feeTotal, exactly, always;
 *   • the company absorbs every rounding remainder — which is exactly BR4's rule that
 *     "Yallago's 20% is always fixed; tier changes come only out of the company's side".
 */
export function splitBlock(totals: FeeTotals, driverBps: Bps, rounding: Rounding = 'floor'): BlockSplit {
  if (driverBps > MAX_DRIVER_BPS) {
    throw new RangeError(`driver share ${driverBps}bps exceeds the ${MAX_DRIVER_BPS}bps left after Yallago`)
  }
  const driverShare = allocate(totals.feeTotal, driverBps, rounding)
  const companyShare = sub(totals.blockTotal, driverShare)
  if (companyShare < 0n) {
    throw new RangeError(`company share went negative (${companyShare}) — band table is invalid`)
  }
  return { driverShare, companyShare, yalagoShare: totals.yalagoTotal }
}

/**
 * Split one shift's Yallago fees at the fixed 40/40/20 policy.
 *
 * `fees` contains Yallago deliveries only. Manual jobs already carry their manager-agreed driver
 * and company shares and are added by the application after this split. Yallago is still rounded
 * per order, while the driver's 40% is floored once over the shift's gross Yallago fees; the
 * company receives the residual so the three parties exhaust every minor unit exactly.
 */
export function splitFixedDriverShare(
  fees: readonly Minor[],
  rounding: Rounding = 'floor',
): BlockSplit {
  return splitBlock(totalFees(fees, rounding), FIXED_DRIVER_BPS, rounding)
}
