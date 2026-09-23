import { type GeoPoint, distanceMetres } from '../geo/haversine.ts'
import type { CalendarDate } from '../time/civil.ts'

/**
 * «التفقّد» — a branch manager proving he was at the branch, at the times he is expected there.
 *
 * The owner's rule: several times a day (say 01:00, 05:00 and 10:00), each within a tolerance, and
 * each from inside the branch's own patch of ground. Drivers are out on the road all day and are
 * tracked by their shift; this is only for the people who are supposed to BE somewhere.
 *
 * PURE: no clock, no I/O, no locale. The caller supplies the instant and the branch-local offset,
 * exactly as `businessDateFor` does — so a check-in evaluated today and re-evaluated in a year
 * gives the same verdict, and a tz-database update can never silently re-judge someone's day.
 */

/** Minutes past branch-local midnight. 60 = 01:00, 630 = 10:30. */
export type MinuteOfDay = number

export interface CheckInWindow {
  /** Opaque to the domain — the caller's identity for this window. */
  readonly windowRef: string
  /** When the manager is expected, in minutes past branch-local midnight. */
  readonly atMinute: MinuteOfDay
  /**
   * How early or late still counts, in minutes. A window of 01:00 ± 30 accepts 00:30 to 01:30.
   * Deliberately symmetric: "be there at one" means around one, not "any time after one".
   */
  readonly toleranceMinutes: number
}

export interface GeoFence extends GeoPoint {
  /** How far from the point still counts as "here". */
  readonly radiusMetres: number
}

export type CheckInVerdict =
  /** Inside the fence and inside a window. */
  | 'on_time'
  /** Inside the fence, but no window was open. */
  | 'outside_window'
  /** Inside a window, but too far from the branch. */
  | 'outside_area'
  /** Neither. */
  | 'outside_both'

export interface CheckInAssessment {
  readonly verdict: CheckInVerdict
  /** The window this check-in answers, or null when none was open. */
  readonly windowRef: string | null
  /** Metres from the fence centre, rounded to whole metres. */
  readonly distanceMetres: number
  readonly insideArea: boolean
  /** Signed minutes from the window's target: negative is early, positive is late. */
  readonly minutesFromTarget: number | null
}

/** Minutes past branch-local midnight for an instant, given the branch's UTC offset. */
export function localMinuteOfDay(epochMs: number, offsetMinutes: number): MinuteOfDay {
  const localMs = epochMs + offsetMinutes * 60_000
  const minutes = Math.floor(localMs / 60_000) % 1440
  // JavaScript's % keeps the sign of the dividend, and a pre-1970 or deeply negative offset would
  // otherwise produce a negative minute that silently matches no window.
  return ((minutes % 1440) + 1440) % 1440
}

/**
 * The window a check-in answers: the one whose target it is CLOSEST to, among those still open.
 *
 * Closest rather than first, because tolerances may overlap — 01:00 ± 45 and 02:00 ± 45 both
 * accept 01:30 — and a manager who checks in at 01:55 means the two o'clock round, not the one
 * o'clock round he is nearly an hour late for. Ties break on the earlier target, then on the
 * opaque ref, so the same inputs always give the same answer.
 */
export function windowFor(
  minute: MinuteOfDay,
  windows: readonly CheckInWindow[],
): { window: CheckInWindow; minutesFromTarget: number } | null {
  let best: { window: CheckInWindow; minutesFromTarget: number } | null = null
  for (const window of windows) {
    const delta = minute - window.atMinute
    if (Math.abs(delta) > window.toleranceMinutes) continue
    if (
      best === null ||
      Math.abs(delta) < Math.abs(best.minutesFromTarget) ||
      (Math.abs(delta) === Math.abs(best.minutesFromTarget) &&
        (window.atMinute < best.window.atMinute ||
          (window.atMinute === best.window.atMinute && window.windowRef < best.window.windowRef)))
    ) {
      best = { window, minutesFromTarget: delta }
    }
  }
  return best
}

/**
 * Judge one check-in. Records what happened; decides nothing about anyone's pay.
 *
 * Nothing here blocks: a manager whose GPS is refused, or who is genuinely away, still gets a
 * recorded row saying so. The report is for a human to read — the same stance the operation-window
 * hint takes on the driver's screen.
 */
export function assessCheckIn(input: {
  readonly at: GeoPoint
  readonly fence: GeoFence
  readonly epochMs: number
  readonly offsetMinutes: number
  readonly windows: readonly CheckInWindow[]
}): CheckInAssessment {
  const distance = Math.round(distanceMetres(input.at, input.fence))
  const insideArea = distance <= input.fence.radiusMetres
  const minute = localMinuteOfDay(input.epochMs, input.offsetMinutes)
  const matched = windowFor(minute, input.windows)

  const verdict: CheckInVerdict =
    insideArea && matched !== null
      ? 'on_time'
      : insideArea
        ? 'outside_window'
        : matched !== null
          ? 'outside_area'
          : 'outside_both'

  return {
    verdict,
    windowRef: matched?.window.windowRef ?? null,
    distanceMetres: distance,
    insideArea,
    minutesFromTarget: matched?.minutesFromTarget ?? null,
  }
}

/** One expected round, and what became of it. `missed` is the absence of a check-in, not a failure. */
export interface WindowOutcome {
  readonly windowRef: string
  readonly atMinute: MinuteOfDay
  readonly status: 'on_time' | 'outside_area' | 'missed'
  readonly distanceMetres: number | null
  readonly minutesFromTarget: number | null
}

/**
 * The day's roll-call: every expected window, answered or not.
 *
 * Built from the windows rather than from the check-ins, because the interesting row is the one
 * with NO check-in against it — and a report driven by what happened can never show what didn't.
 */
export function rollCall(
  windows: readonly CheckInWindow[],
  checkIns: readonly { windowRef: string | null; insideArea: boolean; distanceMetres: number; minutesFromTarget: number | null }[],
): WindowOutcome[] {
  return [...windows]
    .sort((a, b) => a.atMinute - b.atMinute || (a.windowRef < b.windowRef ? -1 : 1))
    .map((window) => {
      const answers = checkIns.filter((c) => c.windowRef === window.windowRef)
      // The best answer stands: a manager who checked in from the road and again from the office
      // was, in the end, at the office for that round.
      const best = answers.find((c) => c.insideArea) ?? answers[0]
      if (!best) {
        return { windowRef: window.windowRef, atMinute: window.atMinute, status: 'missed' as const, distanceMetres: null, minutesFromTarget: null }
      }
      return {
        windowRef: window.windowRef,
        atMinute: window.atMinute,
        status: best.insideArea ? ('on_time' as const) : ('outside_area' as const),
        distanceMetres: best.distanceMetres,
        minutesFromTarget: best.minutesFromTarget,
      }
    })
}

/** A day's check-ins belong to a business date; the caller supplies it from `businessDateFor`. */
export interface CheckInDay {
  readonly businessDate: CalendarDate
  readonly outcomes: readonly WindowOutcome[]
}

/**
 * The ground this business operates on.
 *
 * Syria's bounding box, padded a little. This exists for ONE failure that range validation cannot
 * catch: a swapped latitude and longitude. `lat` is checked against ±90 and `lng` against ±180, and
 * at almost every inhabited place on earth the two numbers are each valid in the other's field.
 * Damascus is the worst possible case — 33.5 and 36.3 are both legal as either — so a swap passes
 * every schema, stores cleanly, and moves the branch several hundred kilometres without a word.
 *
 * The cost of that silence is total: every round reads «خارج الفرع», and the only evidence is a
 * distance nobody thinks to read as "this fence is in the wrong country".
 */
export const OPERATING_REGION = {
  minLat: 32.0,
  maxLat: 37.5,
  minLng: 35.5,
  maxLng: 42.5,
} as const

export function isWithinOperatingRegion(point: GeoPoint): boolean {
  return (
    point.lat >= OPERATING_REGION.minLat &&
    point.lat <= OPERATING_REGION.maxLat &&
    point.lng >= OPERATING_REGION.minLng &&
    point.lng <= OPERATING_REGION.maxLng
  )
}

/**
 * Would swapping these two numbers put the point back on the map?
 *
 * Returning this alongside the refusal is what turns "that is wrong" into a one-press correction.
 * It answers only when the swap is UNAMBIGUOUSLY better — the pair as given is outside and the pair
 * reversed is inside — so it never talks someone out of a point that was right to begin with.
 */
export function swapWouldBeInRegion(point: GeoPoint): boolean {
  return !isWithinOperatingRegion(point) && isWithinOperatingRegion({ lat: point.lng, lng: point.lat })
}
