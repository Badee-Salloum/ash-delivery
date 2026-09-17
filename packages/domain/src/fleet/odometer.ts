/**
 * «كم قطعت الآلية» — kilometres from the two odometer readings a shift carries (P3).
 *
 * A shift records the odometer at its start package and again at its end package. The distance it
 * covered is the difference, and only when that difference can be trusted:
 *
 *   - BOTH readings must exist. A shift with no end reading (a close that never happened, a
 *     package from before the end odometer was required) has not told us how far it went — and
 *     «0 km» would be a claim, not an absence.
 *   - The end must not be BELOW the start. A reading that runs backwards is a typo, a swapped
 *     odometer or a reset cluster, never negative distance. Counting it would subtract a real
 *     shift's kilometres from the bike's total.
 *
 * Neither case is silently dropped. Each is counted as an UNRECORDED shift, so a screen can say
 * «5,120 كم · 2 نوبات بلا قراءة» instead of presenting a partial sum as the whole truth.
 *
 * Pure and deterministic, like everything in this package. Kilometres are whole numbers from an
 * integer-only input (`odometerKm`), and a `number` is exact for them far beyond any bike's life —
 * this is distance, not money.
 *
 * P6 («سجل الآلية») extends this module with the gaps BETWEEN shifts (kilometres nobody logged)
 * and with rollbacks along a bike's timeline; the per-shift rule below is the one it builds on.
 */

/** The two readings of one shift, as stored. `null` means «not recorded». */
export interface OdometerReading {
  readonly start: number | null | undefined
  readonly end: number | null | undefined
}

/** Why a shift's distance cannot be stated. */
export type UnrecordedDistanceReason =
  /** One reading or both are absent (or not a whole, non-negative number). */
  | 'missing'
  /** The end reading is below the start reading. */
  | 'rollback'

export type ShiftDistance =
  | { readonly recorded: true; readonly km: number }
  | { readonly recorded: false; readonly reason: UnrecordedDistanceReason }

/** A usable odometer figure: a whole number of kilometres, zero or more, exactly representable. */
function isReading(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** The distance one shift covered, or why it cannot be said. */
export function shiftDistance(reading: OdometerReading): ShiftDistance {
  const { start, end } = reading
  if (!isReading(start) || !isReading(end)) return { recorded: false, reason: 'missing' }
  if (end < start) return { recorded: false, reason: 'rollback' }
  return { recorded: true, km: end - start }
}

/** Kilometres over many shifts, with the shifts that could not contribute counted beside them. */
export interface DistanceTotal {
  /** Σ km over the recorded shifts. Never negative. */
  readonly km: number
  /** Shifts whose distance was added to `km`. */
  readonly recordedShifts: number
  /** Shifts whose distance is unknown: `missing + rollbacks`. */
  readonly unrecordedShifts: number
  readonly missing: number
  readonly rollbacks: number
}

export const EMPTY_DISTANCE_TOTAL: DistanceTotal = Object.freeze({
  km: 0,
  recordedShifts: 0,
  unrecordedShifts: 0,
  missing: 0,
  rollbacks: 0,
})

/** Add one shift's distance to a running total, returning a new total. */
export function addShiftDistance(total: DistanceTotal, distance: ShiftDistance): DistanceTotal {
  if (distance.recorded) {
    return { ...total, km: total.km + distance.km, recordedShifts: total.recordedShifts + 1 }
  }
  return {
    ...total,
    unrecordedShifts: total.unrecordedShifts + 1,
    missing: total.missing + (distance.reason === 'missing' ? 1 : 0),
    rollbacks: total.rollbacks + (distance.reason === 'rollback' ? 1 : 0),
  }
}

/** The total over a set of shifts. Order does not matter. */
export function totalDistance(readings: Iterable<OdometerReading>): DistanceTotal {
  let total = EMPTY_DISTANCE_TOTAL
  for (const reading of readings) total = addShiftDistance(total, shiftDistance(reading))
  return total
}
