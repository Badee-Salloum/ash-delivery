/**
 * How long a shift ran, and which of the fleet's three working patterns it was.
 *
 * Pure, like the rest of the domain: no `Date`, no `Intl`, no clock. The branch's UTC offset is
 * injected as a value for the same reason `civil.ts` injects it — Syria abolished DST in October
 * 2022 and pre-2022 rows must stay reproducible.
 *
 *
 * WHY THIS EXISTS AT ALL. The system has had no notion of working time. A search of the code, the
 * SRS and CLAUDE.md for hours, duration or an eight-hour rule returns one comment justifying a
 * session-token lifetime. Meanwhile the fleet plainly runs three patterns, and the manager could
 * not see which one he was looking at: on 2026-09-06 thirteen shifts ran, and every row on the
 * completed-shifts screen showed the same business date and «#1».
 *
 *
 * THE BOUNDARIES ARE MEASURED, NOT CHOSEN. Over 155 shifts the start hour is bimodal with a nearly
 * empty gap between 15:00 and 17:00 — five shifts in three hours, against 86 in the morning cluster
 * and 63 in the evening one. That gap is why 15:00 splits day from evening and why the split is
 * safe. The end boundaries separate an evening return from a night one.
 *
 *     day       starts < 15:00, ends 15:00–22:00      39 shifts, 6.18–8.69 h
 *     evening   starts >= 15:00                        43 shifts
 *     full      starts < 15:00, ends after 22:00        29 shifts, 11.49–14.46 h
 *               or before 08:00
 *
 * The dominant `full` is 12:00 → 01:00, fifteen times over. It is one shift covering both slots,
 * which is why it cannot be judged against a single slot's hours.
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
 *   - A shift nobody closed on time is not a long shift. Six of 113 measured over sixteen hours,
 *     including one of 22 and one of 24.6 — those are forgotten close packages. `abandoned` names
 *     them so they are neither read as diligence nor averaged in with real work.
 */

import { DAMASCUS_OFFSET_MINUTES } from '../time/civil.ts'

/** The three patterns the fleet actually works, plus the two states that are not yet a pattern. */
export type ShiftPattern = 'day' | 'evening' | 'full' | 'unknown'

/** Local minute-of-day at or after which a start is an evening shift. Measured: the 15:00–17:00 gap. */
export const EVENING_START_MINUTES = 15 * 60

/** A day shift that has not ended by this local minute is a `full` shift, not a late day one. */
export const DAY_END_LIMIT_MINUTES = 22 * 60

/** An end before this local minute is the small hours — the far side of a `full` shift. */
export const NIGHT_END_LIMIT_MINUTES = 8 * 60

/**
 * Longer than this and the close package was forgotten, not worked.
 *
 * Sixteen hours sits above every genuine `full` shift measured (the longest was 14.46) and below
 * the abandoned ones (22.01 and 24.64). Nothing in between has ever been observed.
 */
export const ABANDONED_AFTER_MINUTES = 16 * 60

export interface WorkedTime {
  /** Minutes from the driver's confirmation to his close submission. `null` while the shift is live. */
  readonly minutes: number | null
  readonly pattern: ShiftPattern
  /**
   * The shift ran past every plausible length, so its close was late rather than its work long.
   * Such a shift has a duration but that duration means nothing, and it must not be averaged.
   */
  readonly abandoned: boolean
}

/** Minute of the branch-local day, 0–1439. */
function localMinuteOfDay(epochMs: number, offsetMinutes: number): number {
  const localMs = epochMs + offsetMinutes * 60_000
  const minutes = Math.floor(localMs / 60_000)
  return ((minutes % 1440) + 1440) % 1440
}

/**
 * Classify one shift and measure it.
 *
 * `endedAtMs` is null for a shift still running, or for one whose close was rejected — the reject
 * path clears `submitted_at` and the next submission re-stamps it, so this always measures the
 * LATEST submission. Both cases yield `unknown`: a pattern cannot be known from a start alone,
 * because a 12:00 start is a day shift or a full one and only the end says which.
 */
export function workedTime(
  startedAtMs: number | null,
  endedAtMs: number | null,
  offsetMinutes: number = DAMASCUS_OFFSET_MINUTES,
): WorkedTime {
  if (startedAtMs === null) return { minutes: null, pattern: 'unknown', abandoned: false }

  const startMinute = localMinuteOfDay(startedAtMs, offsetMinutes)

  if (endedAtMs === null) {
    // An evening start is already unambiguous — nothing it could still turn into is a day shift.
    // A morning start is genuinely undecided until it ends, so it stays `unknown` rather than
    // guessing `day` and relabelling itself at midnight.
    return {
      minutes: null,
      pattern: startMinute >= EVENING_START_MINUTES ? 'evening' : 'unknown',
      abandoned: false,
    }
  }

  const minutes = Math.max(0, Math.round((endedAtMs - startedAtMs) / 60_000))
  const abandoned = minutes > ABANDONED_AFTER_MINUTES
  const endMinute = localMinuteOfDay(endedAtMs, offsetMinutes)

  if (startMinute >= EVENING_START_MINUTES) return { minutes, pattern: 'evening', abandoned }

  const endedInTheEvening = endMinute >= EVENING_START_MINUTES && endMinute < DAY_END_LIMIT_MINUTES
  // A day start that came back before dark AND inside one day is the day pattern. Anything else
  // from a morning start ran into the night, which is the full pattern.
  const pattern: ShiftPattern = endedInTheEvening && minutes <= DAY_END_LIMIT_MINUTES ? 'day' : 'full'
  return { minutes, pattern, abandoned }
}

/**
 * How far short of its target a shift fell, in minutes. `0` when it met or beat the target.
 *
 * Returns null when there is nothing to judge: a live shift, an unclassified one, or one whose
 * close was forgotten — punishing a driver for a manager's late paperwork would be the wrong
 * reading of the only number on the screen.
 */
export function shortfallMinutes(worked: WorkedTime, targetMinutes: number): number | null {
  if (worked.minutes === null || worked.pattern === 'unknown' || worked.abandoned) return null
  return Math.max(0, targetMinutes - worked.minutes)
}
