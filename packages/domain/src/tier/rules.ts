import type { Bps } from '../money/minor.ts'
import { MAX_DRIVER_BPS } from '../money/allocate.ts'

export type TierBasis = 'orders' | 'revenue'
export type TierMode = 'whole' | 'marginal'

export interface TierBand {
  /** Inclusive lower bound of the band, in orders (basis = 'orders'). */
  readonly from: number
  /** Inclusive upper bound, or `null` for the open-ended top band. */
  readonly to: number | null
  readonly driverBps: Bps
}

export interface TierRule {
  readonly basis: TierBasis
  readonly mode: TierMode
  /** `null` = applies to every vehicle type (SRS F-4 allows a table per type). */
  readonly vehicleTypeId: string | null
  readonly bands: readonly TierBand[]
  /** ISO calendar date, inclusive. Versions are dated and never mutate the past (F-3). */
  readonly effectiveFrom: string
}

/**
 * SRS F-1, the client's default table: whole-amount, daily, basis = approved orders.
 * Yallago's 20% is fixed; every point the driver gains comes out of the company's 80% side.
 */
export const DEFAULT_BANDS: readonly TierBand[] = [
  { from: 0, to: 14, driverBps: 3500 },
  { from: 15, to: 24, driverBps: 4000 },
  { from: 25, to: 34, driverBps: 4300 },
  { from: 35, to: null, driverBps: 4600 },
]

export class TierRuleError extends Error {}

/**
 * A band table is only valid if it is a total function over 0..∞ — contiguous, gapless,
 * non-overlapping, starting at 0, ending open. An invalid table is caught here, at publish
 * time, and never at 23:00 on a Saturday when a shift will not close.
 */
export function validateBands(bands: readonly TierBand[]): void {
  if (bands.length === 0) throw new TierRuleError('band table is empty')

  const sorted = [...bands].sort((a, b) => a.from - b.from)
  if (sorted[0]?.from !== 0) throw new TierRuleError('band table must start at 0 orders')

  for (let i = 0; i < sorted.length; i++) {
    const band = sorted[i]
    if (!band) continue
    if (!Number.isInteger(band.from) || band.from < 0) {
      throw new TierRuleError(`band ${i}: 'from' must be a non-negative integer`)
    }
    if (!Number.isInteger(band.driverBps) || band.driverBps < 0 || band.driverBps > MAX_DRIVER_BPS) {
      throw new TierRuleError(
        `band ${i}: driverBps must be an integer in [0, ${MAX_DRIVER_BPS}] — Yallago's 20% is not negotiable`,
      )
    }
    const isLast = i === sorted.length - 1
    if (isLast) {
      if (band.to !== null) throw new TierRuleError('the last band must be open-ended (to: null)')
      continue
    }
    if (band.to === null) throw new TierRuleError(`band ${i}: only the last band may be open-ended`)
    if (band.to < band.from) throw new TierRuleError(`band ${i}: 'to' is before 'from'`)
    const next = sorted[i + 1]
    if (next && next.from !== band.to + 1) {
      throw new TierRuleError(
        `bands ${i} and ${i + 1} are not contiguous: ${band.to} then ${next.from} (gap or overlap)`,
      )
    }
  }
}

/** The driver rate for the Nth order (1-based) — used by marginal mode. */
export function bpsForOrdinal(bands: readonly TierBand[], ordinal: number): Bps {
  return bpsForCount(bands, ordinal)
}

/** The driver rate for a day of `count` orders — used by whole-amount mode. */
export function bpsForCount(bands: readonly TierBand[], count: number): Bps {
  for (const band of bands) {
    if (count >= band.from && (band.to === null || count <= band.to)) return band.driverBps
  }
  throw new TierRuleError(`no band covers a count of ${count} — validateBands() should have caught this`)
}

/**
 * Select the rule in force on `businessDate` for a vehicle type.
 *
 * Candidates are filtered by status IN ('active','superseded') — NOT 'active' alone.
 * Publishing a successor marks the incumbent 'superseded', and filtering it out would
 * silently lose the rate that actually applied to every past day, quietly restating history
 * the first time anyone edited the table.
 */
export function resolveRule<T extends TierRule & { status: 'active' | 'superseded' | 'withdrawn' }>(
  rules: readonly T[],
  businessDate: string,
  vehicleTypeId: string | null,
): T {
  const applicable = rules
    .filter((r) => r.status !== 'withdrawn')
    .filter((r) => r.effectiveFrom <= businessDate)
    .filter((r) => r.vehicleTypeId === vehicleTypeId || r.vehicleTypeId === null)
    // A type-specific table beats the catch-all; then the latest effective date wins.
    .sort((a, b) => {
      if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1
      const aSpecific = a.vehicleTypeId === null ? 0 : 1
      const bSpecific = b.vehicleTypeId === null ? 0 : 1
      return bSpecific - aSpecific
    })

  const chosen = applicable[0]
  if (!chosen) throw new TierRuleError(`no tier rule in force on ${businessDate} for vehicle type ${vehicleTypeId}`)
  return chosen
}
