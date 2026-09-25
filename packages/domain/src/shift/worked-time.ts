/**
 * How long a shift ran, which SLOT it started in, and which of the fleet's patterns it was.
 *
 * Pure, like the rest of the domain: no `Date`, no `Intl`, no clock. The branch's UTC offset and
 * the business-day start are injected as values for the same reason `civil.ts` injects them —
 * Syria abolished DST in October 2022, the day start is configuration, and rows written under
 * either must stay reproducible.
 *
 *
 * THE SCHEDULE IS THE OWNER'S, DECIDED 2026-09-17. It replaced boundaries that had been inferred
 * from 155 production shifts (a 15:00 start split plus a 22:00 «came back» limit), which read an
 * ordinary 09:00 → 21:00 double as a long `day` shift and judged every double against sixteen
 * hours. The owner's words are the rule now:
 *
 *     morning («صباحية»)   09:00 → 17:00   target  8 h
 *     evening («مسائية»)   18:00 → 02:00   target  8 h
 *     double  («دبل»)      12 hours        target 12 h
 *
 * Classification is AUTOMATIC from the two instants, and asks two questions in this order:
 *
 *   1. How long did it run? A CLOSED shift of `DOUBLE_SHIFT_MIN_MINUTES` (10 h) or more is `full`
 *      — a double — whatever time it started. Ten hours is two hours past either slot and two
 *      short of a double's target, so a double worked a little short is still a double (judged,
 *      and shown short) rather than a slot worked two hours long.
 *   2. Otherwise, when did it start? Its SLOT is its pattern. A start from 04:00 up to 14:59 local
 *      is `day`; a start from 15:00 through midnight up to 03:59 is `evening`. 15:00 sits in the
 *      empty two hours between the morning slot's end and the evening slot's start, and the
 *      business day (not the calendar day) is what makes a 02:00 start the tail of an evening
 *      rather than the beginning of a morning.
 *
 * The slot is reported separately from the pattern because a RUNNING shift has a slot but no
 * pattern yet: a 09:00 start is a morning or a double, and only its length can say which. The
 * screens show it as «جارية — صباحية» rather than guessing and relabelling it after ten hours.
 *
 *
 * WHAT THE DURATION IS, AND WHAT IT IS NOT. There is no `opened_at` and no `closed_at` on a shift;
 * `approved_at` exists but has never been written. The only honest pair is the operation window the
 * system already reasons about elsewhere: the driver's own confirmation through his close
 * submission. So this measures FROM THE DRIVER SAYING HE HAS STARTED TO HIM SENDING THE CLOSE
 * PACKAGE — not time spent driving, and not time on the road.
 *
 * Two consequences the caller must surface rather than hide:
 *
 *   - Suspension is not subtracted. `suspended_at` is a column that no code path writes, so a shift
 *     suspended and resumed carries dead time this function cannot see.
 *   - A shift nobody closed on time is not a long shift. Six of 113 measured ran over sixteen
 *     hours, including one of 22 and one of 24.6 — those are forgotten close packages. `abandoned`
 *     names them; they keep their SLOT as their pattern (they are not promoted to a double on the
 *     strength of paperwork) and they are never judged against a target.
 */

import { DAMASCUS_OFFSET_MINUTES, DAY_START_MINUTES } from '../time/civil.ts'

/** The fleet's three patterns, plus `unknown` for a shift that has not ended (or never started). */
export type ShiftPattern = 'day' | 'evening' | 'full' | 'unknown'

/** Which half of the working day a shift STARTED in. Known the moment it starts. */
export type ShiftSlot = 'day' | 'evening'

/**
 * Local minute-of-day at or after which a start belongs to the evening slot: 15:00.
 *
 * Starts after midnight but before the business day rolls over (00:00–03:59 with the default
 * 04:00 day start) are evening too — see `slotOfStart`.
 */
export const SLOT_SPLIT_MINUTES = 15 * 60

/** The earlier name of `SLOT_SPLIT_MINUTES`, kept so existing importers keep compiling. */
export const EVENING_START_MINUTES = SLOT_SPLIT_MINUTES

/** A closed shift at least this long is a double (`full`), whatever time it started. */
export const DOUBLE_SHIFT_MIN_MINUTES = 10 * 60

/**
 * Longer than this and the close package was forgotten, not worked.
 *
 * Sixteen hours sits above every genuine double measured (the longest was 14.46) and below the
 * abandoned ones (22.01 and 24.64). Nothing in between has ever been observed.
 */
export const ABANDONED_AFTER_MINUTES = 16 * 60

/**
 * How long each pattern is expected to run — the owner's rule, one table for every screen.
 *
 * `unknown` is null: a shift with no pattern cannot be short of anything.
 */
export const SHIFT_TARGET_MINUTES: Readonly<Record<ShiftPattern, number | null>> = Object.freeze({
  day: 8 * 60,
  evening: 8 * 60,
  full: 12 * 60,
  unknown: null,
})

/**
 * The owner's published slot hours, in local minutes past midnight. DISPLAY ONLY.
 *
 * Nothing classifies against these: a driver who starts the morning slot at 10:30 is still on the
 * morning slot. `evening.end` (02:00) is past midnight, so it is smaller than `evening.start`.
 */
export const OWNER_SHIFT_HOURS: Readonly<Record<ShiftSlot, Readonly<{ start: number; end: number }>>> =
  Object.freeze({
    day: Object.freeze({ start: 9 * 60, end: 17 * 60 }),
    evening: Object.freeze({ start: 18 * 60, end: 2 * 60 }),
  })

export interface WorkedTime {
  /** Net minutes from confirmation to close, after recorded breaks. `null` while live. */
  readonly minutes: number | null
  /** `full` when closed and at least ten hours long; otherwise the slot; `unknown` while live. */
  readonly pattern: ShiftPattern
  /** The slot the shift started in. `null` only when there is no start instant at all. */
  readonly slot: ShiftSlot | null
  /**
   * The shift ran past every plausible length, so its close was late rather than its work long.
   * Such a shift has a duration but that duration means nothing, and it must not be judged.
   */
  readonly abandoned: boolean
}

/** The part of a `WorkedTime` a judgement needs. A row from an older API carries no `slot`. */
export type JudgedWorkedTime = Pick<WorkedTime, 'minutes' | 'pattern' | 'abandoned'>

const MINUTES_PER_DAY = 1440

/** `n mod m` that is never negative, so instants before 1970 and negative offsets stay correct. */
function floorMod(n: number, m: number): number {
  return ((n % m) + m) % m
}

/** Minute of the branch-local day, 0–1439. */
function localMinuteOfDay(epochMs: number, offsetMinutes: number): number {
  return floorMod(Math.floor((epochMs + offsetMinutes * 60_000) / 60_000), MINUTES_PER_DAY)
}

/**
 * The slot a shift started in.
 *
 * Measured from the BUSINESS-day start rather than from midnight, which is what makes a start at
 * 02:00 the tail of the evening slot instead of the head of a morning one: with the default 04:00
 * day start, local 04:00–14:59 is `day` and 15:00–03:59 is `evening`.
 *
 * Both boundaries are reduced modulo a day, so any configured day start (0–1439) yields exactly
 * two contiguous ranges; with `dayStartMinutes = 0` this is the plain «before or after 15:00» rule.
 */
export function slotOfStart(
  startedAtMs: number,
  offsetMinutes: number = DAMASCUS_OFFSET_MINUTES,
  dayStartMinutes: number = DAY_START_MINUTES,
): ShiftSlot {
  const businessMinute = floorMod(localMinuteOfDay(startedAtMs, offsetMinutes) - dayStartMinutes, MINUTES_PER_DAY)
  const eveningFrom = floorMod(SLOT_SPLIT_MINUTES - dayStartMinutes, MINUTES_PER_DAY)
  return businessMinute >= eveningFrom ? 'evening' : 'day'
}

/**
 * Classify one shift and measure it.
 *
 * `endedAtMs` is null for a shift still running, or for one whose close was rejected — the reject
 * path clears `submitted_at` and the next submission re-stamps it, so this always measures the
 * LATEST submission. Both cases yield `unknown` with the slot filled in: the slot is certain, the
 * pattern is not, because any running shift can still reach ten hours.
 */
export function workedTime(
  startedAtMs: number | null,
  endedAtMs: number | null,
  offsetMinutes: number = DAMASCUS_OFFSET_MINUTES,
  dayStartMinutes: number = DAY_START_MINUTES,
  breakDurationMs = 0,
): WorkedTime {
  if (startedAtMs === null) return { minutes: null, pattern: 'unknown', slot: null, abandoned: false }

  const slot = slotOfStart(startedAtMs, offsetMinutes, dayStartMinutes)
  if (endedAtMs === null) return { minutes: null, pattern: 'unknown', slot, abandoned: false }

  // The same rounded figure the screens print, so the badge and the duration beside it can never
  // disagree about which side of ten hours a shift fell.
  const minutes = Math.max(0, Math.round((endedAtMs - startedAtMs - Math.max(0, breakDurationMs)) / 60_000))
  const abandoned = minutes > ABANDONED_AFTER_MINUTES
  // A forgotten close is not a double: it keeps the slot it started in, and is never judged.
  if (abandoned) return { minutes, pattern: slot, slot, abandoned }

  const pattern: ShiftPattern = minutes >= DOUBLE_SHIFT_MIN_MINUTES ? 'full' : slot
  return { minutes, pattern, slot, abandoned }
}

/** The owner's target for a pattern, in minutes. `null` for `unknown`. */
export function shiftTargetMinutes(pattern: ShiftPattern): number | null {
  return SHIFT_TARGET_MINUTES[pattern]
}

/**
 * How far short of its target a shift fell, in minutes. `0` when it met or beat the target.
 *
 * The target defaults to the pattern's own, which is the point: a double is judged against twelve
 * hours, so a 10.5-hour double reads ninety minutes short rather than two and a half hours over.
 *
 * Returns null when there is nothing to judge: a live shift, an unclassified one, one whose close
 * was forgotten — punishing a driver for a manager's late paperwork would be the wrong reading of
 * the only number on the screen — or a null target.
 */
export function shortfallMinutes(
  worked: JudgedWorkedTime,
  targetMinutes: number | null = shiftTargetMinutes(worked.pattern),
): number | null {
  if (worked.minutes === null || worked.pattern === 'unknown' || worked.abandoned) return null
  if (targetMinutes === null) return null
  return Math.max(0, targetMinutes - worked.minutes)
}
