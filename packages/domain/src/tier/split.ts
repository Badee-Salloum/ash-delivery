import { type Minor, minor, sub, sum } from '../money/minor.ts'
import { type BlockSplit, type Rounding, allocate, splitBlock, totalFees } from '../money/allocate.ts'
import { type TierRule, bpsForOrdinal, bpsForCount, validateBands } from './rules.ts'

export interface DaySplit extends BlockSplit {
  readonly orderCount: number
  readonly feeTotal: Minor
  readonly blockTotal: Minor
  /** The whole-day rate actually applied. For marginal mode this is the effective blended rate. */
  readonly effectiveDriverBps: number
}

/**
 * Split ONE DRIVER'S WHOLE DAY between driver, company and Yallago.
 *
 * The basis is the day, not the shift (SRS F-1: «بأساس عدد الطلبات المعتمدة» daily). A driver
 * who runs 12 orders in shift 1 and 10 in shift 2 has a 22-order day and earns the 15–24 band
 * on ALL of it — see `trueUp()` for how the already-posted first shift is restated.
 *
 * `fees` must be the day's fees in the order the orders were performed; marginal mode assigns
 * the Nth order the rate of the band containing N, so sequence matters there.
 */
export function splitDay(fees: readonly Minor[], rule: TierRule, rounding: Rounding = 'floor'): DaySplit {
  validateBands(rule.bands)
  const totals = totalFees(fees, rounding)
  const orderCount = fees.length

  if (rule.mode === 'whole') {
    const driverBps = bpsForCount(rule.bands, orderCount)
    const split = splitBlock(totals, driverBps, rounding)
    return {
      ...split,
      orderCount,
      feeTotal: totals.feeTotal,
      blockTotal: totals.blockTotal,
      effectiveDriverBps: driverBps,
    }
  }

  // Marginal: the Nth order earns the rate of the band containing N.
  // ASSUMPTION A-36: with a per-ORDER-COUNT band table and varying fees, "marginal" can only
  // mean "each order is paid at the rate of its own ordinal position". Documented in
  // ASSUMPTIONS.md; the client's default is 'whole', and F-2 keeps marginal as a config switch.
  const driverShare = sum(fees.map((fee, i) => allocate(fee, bpsForOrdinal(rule.bands, i + 1), rounding)))
  const companyShare = sub(totals.blockTotal, driverShare)
  if (companyShare < 0n) {
    throw new RangeError(`marginal split drove the company share negative (${companyShare})`)
  }
  const effectiveDriverBps =
    totals.feeTotal === 0n ? 0 : Number((driverShare * 10_000n) / totals.feeTotal)

  return {
    driverShare,
    companyShare,
    yalagoShare: totals.yalagoTotal,
    orderCount,
    feeTotal: totals.feeTotal,
    blockTotal: totals.blockTotal,
    effectiveDriverBps,
  }
}

export interface TrueUp {
  /** The day's totals after including the newly approved shift. */
  readonly day: DaySplit
  /** Signed deltas to post now: `day - alreadyPosted`. May be negative. */
  readonly driverDelta: Minor
  readonly companyDelta: Minor
  readonly yalagoDelta: Minor
  /** True when an earlier shift's rate is being restated because the day crossed a band. */
  readonly restatesEarlierShifts: boolean
}

/**
 * Compute what to post when approving a shift, given what the day has already been paid.
 *
 * This is the «تسوية شريحة اليوم» true-up. Approving shift 2 of a 12+10 day recomputes the
 * whole day at the 22-order band and posts the DIFFERENCE, which restates shift 1 upward.
 * The alternative — banding each shift alone — under-pays every driver whose day crosses a
 * boundary, and blunts the exact incentive the tier table exists to create.
 *
 * Deltas are produced by SUBTRACTING two allocations, never by allocating a negative, which
 * is why `allocate()` is free to reject negative inputs outright.
 */
export function trueUp(
  dayFees: readonly Minor[],
  rule: TierRule,
  alreadyPosted: { driver: Minor; company: Minor; yalago: Minor },
  rounding: Rounding = 'floor',
): TrueUp {
  const day = splitDay(dayFees, rule, rounding)
  const driverDelta = sub(day.driverShare, alreadyPosted.driver)
  return {
    day,
    driverDelta,
    companyDelta: sub(day.companyShare, alreadyPosted.company),
    yalagoDelta: sub(day.yalagoShare, alreadyPosted.yalago),
    restatesEarlierShifts: alreadyPosted.driver !== minor(0n) && driverDelta !== minor(0n),
  }
}
