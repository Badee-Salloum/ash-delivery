/**
 * «الصرفيات الثابتة» — when a recurring expense falls due (finance redesign P4).
 *
 * The owner's rule: a recurring expense is SHOWN as due and PAID by a human button. Nothing posts
 * on its own and there is no cron, so every due item is computed on read, from the schedule and
 * today's business date. This module is that computation, pure: no `Date`, no clock, no zone.
 * «Today» is injected and must be the server's business date (the day starts at 04:00 Damascus).
 *
 * THREE SCHEDULES, and each is a plain predicate over calendar dates:
 *
 *   weekly         every date on or after `startsOn` whose weekday is `weekday`
 *                  (0 = Sunday … 6 = Saturday, the numbering `dayOfWeek` and PostgreSQL's
 *                  `extract(dow …)` both use);
 *   monthly_first  every first-of-month on or after `startsOn`;
 *   every_n_days   `startsOn`, `startsOn + n`, `startsOn + 2n`, …
 *
 * and every one of them stops after `endsOn` when it is set.
 *
 * `recurrenceMatches` has a SQL twin, `ash_recurrence_matches` (migration 0075), which the
 * occurrence guard uses so a paid or skipped row can only exist on a date the schedule produces.
 * The two are compared on a sample of dates in the PostgreSQL test. Keep them in step.
 */

import {
  type CalendarDate,
  addDays,
  addMonths,
  dayOfWeek,
  daysBetween,
  isCalendarDate,
  monthStartFor,
  parseCalendarDate,
} from '../time/civil.ts'

export type RecurrenceKind = 'weekly' | 'monthly_first' | 'every_n_days'

export const RECURRENCE_KINDS: readonly RecurrenceKind[] = Object.freeze(['weekly', 'monthly_first', 'every_n_days'])

/** The longest «every N days» the schema accepts. A yearly cost is `every_n_days` 365/366. */
export const MAX_RECURRENCE_INTERVAL_DAYS = 366

export interface RecurrenceSchedule {
  readonly kind: RecurrenceKind
  /** The first date the schedule may produce. For `every_n_days` it IS the first occurrence. */
  readonly startsOn: CalendarDate
  /** The last date the schedule may produce, inclusive; `null` means open-ended. */
  readonly endsOn: CalendarDate | null
  /** `weekly` only: 0 = Sunday … 6 = Saturday. `null` for the other kinds. */
  readonly weekday: number | null
  /** `every_n_days` only: 1 … MAX_RECURRENCE_INTERVAL_DAYS. `null` for the other kinds. */
  readonly intervalDays: number | null
}

export type RecurrenceIssue =
  | 'unknown_kind'
  | 'invalid_starts_on'
  | 'invalid_ends_on'
  | 'ends_before_start'
  | 'weekday_required'
  | 'weekday_out_of_range'
  | 'weekday_not_allowed'
  | 'interval_required'
  | 'interval_out_of_range'
  | 'interval_not_allowed'

/**
 * Why a schedule cannot be stored, or `null` when it can.
 *
 * The same shape the schema's CHECK constraints demand, returned as a code so the API can name the
 * problem instead of letting the database refuse it with a constraint name.
 */
export function recurrenceIssue(s: RecurrenceSchedule): RecurrenceIssue | null {
  if (!(RECURRENCE_KINDS as readonly string[]).includes(s.kind)) return 'unknown_kind'
  if (!isCalendarDate(s.startsOn)) return 'invalid_starts_on'
  if (s.endsOn !== null) {
    if (!isCalendarDate(s.endsOn)) return 'invalid_ends_on'
    if (s.endsOn < s.startsOn) return 'ends_before_start'
  }
  if (s.kind === 'weekly') {
    if (s.weekday === null) return 'weekday_required'
    if (!Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6) return 'weekday_out_of_range'
  } else if (s.weekday !== null) {
    return 'weekday_not_allowed'
  }
  if (s.kind === 'every_n_days') {
    if (s.intervalDays === null) return 'interval_required'
    if (
      !Number.isInteger(s.intervalDays) ||
      s.intervalDays < 1 ||
      s.intervalDays > MAX_RECURRENCE_INTERVAL_DAYS
    ) {
      return 'interval_out_of_range'
    }
  } else if (s.intervalDays !== null) {
    return 'interval_not_allowed'
  }
  return null
}

function assertValid(s: RecurrenceSchedule): void {
  const issue = recurrenceIssue(s)
  if (issue !== null) throw new RangeError(`invalid recurrence schedule: ${issue}`)
}

/** `a` or `b`, whichever is later. Calendar dates compare correctly as strings. */
const later = (a: CalendarDate, b: CalendarDate): CalendarDate => (a > b ? a : b)

/**
 * Does the schedule produce `date`?
 *
 * The TypeScript twin of `ash_recurrence_matches` PLUS the `endsOn` bound the SQL guard checks
 * beside it. A date before `startsOn` or after `endsOn` is never produced.
 */
export function recurrenceMatches(s: RecurrenceSchedule, date: CalendarDate): boolean {
  assertValid(s)
  if (!isCalendarDate(date)) return false
  if (date < s.startsOn) return false
  if (s.endsOn !== null && date > s.endsOn) return false
  switch (s.kind) {
    case 'weekly':
      return dayOfWeek(date) === s.weekday
    case 'monthly_first':
      return parseCalendarDate(date).d === 1
    case 'every_n_days':
      return daysBetween(s.startsOn, date) % (s.intervalDays as number) === 0
  }
}

/**
 * The first date on or after `date` that the schedule produces, or `null` when the schedule has
 * ended before it. Arithmetic, not a search: this is O(1) for every kind.
 */
export function nextOccurrenceOnOrAfter(s: RecurrenceSchedule, date: CalendarDate): CalendarDate | null {
  assertValid(s)
  if (!isCalendarDate(date)) throw new RangeError(`not a calendar date: ${JSON.stringify(date)}`)
  const from = later(date, s.startsOn)
  let candidate: CalendarDate
  switch (s.kind) {
    case 'weekly': {
      const delta = ((s.weekday as number) - dayOfWeek(from) + 7) % 7
      candidate = addDays(from, delta)
      break
    }
    case 'monthly_first': {
      const first = monthStartFor(from)
      candidate = first === from ? from : addMonths(first, 1)
      break
    }
    case 'every_n_days': {
      const n = s.intervalDays as number
      const elapsed = daysBetween(s.startsOn, from)
      candidate = addDays(s.startsOn, Math.ceil(elapsed / n) * n)
      break
    }
  }
  return s.endsOn !== null && candidate > s.endsOn ? null : candidate
}

/** The step from one produced date to the next. */
function following(s: RecurrenceSchedule, date: CalendarDate): CalendarDate {
  switch (s.kind) {
    case 'weekly':
      return addDays(date, 7)
    case 'monthly_first':
      return addMonths(date, 1)
    case 'every_n_days':
      return addDays(date, s.intervalDays as number)
  }
}

/**
 * Every date in the inclusive range `[from, to]` the schedule produces, in order.
 *
 * `limit` is a runaway guard for the caller that forgot to bound its range: a daily schedule over a
 * decade is 3,650 rows nobody asked for. Exceeding it throws rather than silently truncating,
 * because a truncated due list would hide a debt.
 */
export function occurrencesBetween(
  s: RecurrenceSchedule,
  from: CalendarDate,
  to: CalendarDate,
  limit = 5_000,
): CalendarDate[] {
  assertValid(s)
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    throw new RangeError(`not a calendar range: ${JSON.stringify(from)}..${JSON.stringify(to)}`)
  }
  const out: CalendarDate[] = []
  if (from > to) return out
  const last = s.endsOn !== null && s.endsOn < to ? s.endsOn : to
  let next = nextOccurrenceOnOrAfter(s, from)
  while (next !== null && next <= last) {
    if (out.length >= limit) {
      throw new RangeError(`more than ${limit} occurrences between ${from} and ${to}`)
    }
    out.push(next)
    next = following(s, next)
  }
  return out
}

/**
 * How many dates in `[from, to]` the schedule produces — without listing them.
 *
 * Used to tell a manager that older dues exist before the window a screen shows, so a debt is
 * never hidden merely because it is old.
 */
export function countOccurrencesBetween(s: RecurrenceSchedule, from: CalendarDate, to: CalendarDate): number {
  assertValid(s)
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    throw new RangeError(`not a calendar range: ${JSON.stringify(from)}..${JSON.stringify(to)}`)
  }
  const last = s.endsOn !== null && s.endsOn < to ? s.endsOn : to
  const first = nextOccurrenceOnOrAfter(s, from)
  if (first === null || first > last) return 0
  switch (s.kind) {
    case 'weekly':
      return Math.floor(daysBetween(first, last) / 7) + 1
    case 'every_n_days':
      return Math.floor(daysBetween(first, last) / (s.intervalDays as number)) + 1
    case 'monthly_first': {
      const a = parseCalendarDate(first)
      const b = parseCalendarDate(last)
      return (b.y * 12 + b.m) - (a.y * 12 + a.m) + 1
    }
  }
}

// ── Due status ──────────────────────────────────────────────────────────────────────────────

/** How far ahead «خلال 7 أيام» looks, in days after today. */
export const DUE_LOOKAHEAD_DAYS = 7

/**
 * How far back the default due list looks for unpaid dates, in days before today.
 *
 * 92 days covers three whole months, so a monthly rent missed for a quarter is still listed one by
 * one. Anything older is COUNTED rather than listed (`countOccurrencesBetween`), so the screen can
 * say that older dues exist instead of silently dropping them. It also bounds the daily template:
 * at most 92 + 7 rows each.
 */
export const OVERDUE_LOOKBACK_DAYS = 92

/** The longest explicit range the due read accepts, in days, both ends included. */
export const MAX_DUE_RANGE_DAYS = 366

export type DueStatus = 'overdue' | 'today' | 'upcoming' | 'later'

/**
 * Where a due date sits relative to today: before it, on it, within the next
 * `DUE_LOOKAHEAD_DAYS` days, or further out.
 */
export function dueStatus(dueDate: CalendarDate, today: CalendarDate, lookaheadDays = DUE_LOOKAHEAD_DAYS): DueStatus {
  if (!isCalendarDate(dueDate) || !isCalendarDate(today)) {
    throw new RangeError(`not a calendar date: ${JSON.stringify(dueDate)} / ${JSON.stringify(today)}`)
  }
  if (dueDate < today) return 'overdue'
  if (dueDate === today) return 'today'
  return daysBetween(today, dueDate) <= lookaheadDays ? 'upcoming' : 'later'
}

/** The default window of the due read: `OVERDUE_LOOKBACK_DAYS` back, `DUE_LOOKAHEAD_DAYS` ahead. */
export function defaultDueWindow(today: CalendarDate): { from: CalendarDate; to: CalendarDate } {
  return { from: addDays(today, -OVERDUE_LOOKBACK_DAYS), to: addDays(today, DUE_LOOKAHEAD_DAYS) }
}

/**
 * The business date a payment is booked on when the manager does not choose one.
 *
 * The due date's own day when its financial week is still open — so the cost lands in the period
 * it belongs to — and otherwise today, because a sealed week takes no new postings (BR7) and the
 * money is leaving now. Never a date after today: a due date in the future is not payable yet.
 */
export function defaultPayDate(
  dueDate: CalendarDate,
  today: CalendarDate,
  weekIsOpen: (date: CalendarDate) => boolean,
): CalendarDate {
  if (dueDate > today) return today
  return weekIsOpen(dueDate) ? dueDate : today
}

/**
 * Whether a manager-chosen payment date is acceptable for a due date: on or after the due date,
 * and never after today. The week lock is checked separately, where the locks are known.
 */
export function payDateInRange(payDate: CalendarDate, dueDate: CalendarDate, today: CalendarDate): boolean {
  return isCalendarDate(payDate) && payDate >= dueDate && payDate <= today
}
