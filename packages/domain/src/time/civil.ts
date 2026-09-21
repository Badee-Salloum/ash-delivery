/**
 * Calendar arithmetic, pure. No `Date`, no `Intl`, no ambient clock.
 *
 * The UTC offset is INJECTED AS A VALUE. Asia/Damascus is UTC+3 year-round since Syria
 * abolished DST in October 2022; before that it alternated +2/+3. Rather than bake either
 * into the domain, the adapter layer resolves the correct offset with a real tz database and
 * passes minutes in. That keeps this module deterministic and keeps historical/backfilled
 * data correct.
 */

/** A calendar date with no time and no zone. `2026-07-21`. */
export type CalendarDate = string

export const DAMASCUS_OFFSET_MINUTES = 180

/**
 * When one business day gives way to the next, in minutes past branch-local midnight.
 *
 * A delivery fleet does not stop at midnight. The owner's day runs 04:00 → 04:00, so a shift
 * closed at 01:30 belongs to the day it was WORKED, not to the calendar date the clock had just
 * rolled onto. Booking that close under the next day would split one night's takings across two
 * business dates — and, on a Saturday night, across two FINANCIAL WEEKS, which is the one place
 * BR7 makes entries immutable.
 *
 * INJECTED AS A VALUE for the same reason as the UTC offset: rows already written under a
 * different boundary must stay reproducible. `business_date` is a written column, so changing
 * this never re-buckets stored money — it only decides where NEW entries land.
 */
export const DAY_START_MINUTES = 240

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/** Days since 1970-01-01. Howard Hinnant's `days_from_civil`, valid for the full proleptic range. */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0)
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** Inverse of `daysFromCivil`. */
export function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp + (mp < 10 ? 3 : -9)
  return { y: y + (m <= 2 ? 1 : 0), m, d }
}

const pad = (n: number, width = 2): string => n.toString().padStart(width, '0')

export function toCalendarDate(y: number, m: number, d: number): CalendarDate {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new RangeError(`non-integer date part: ${y}-${m}-${d}`)
  }
  if (m < 1 || m > 12) throw new RangeError(`month out of range: ${m}`)
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0
  if (d < 1 || d > dim) throw new RangeError(`day out of range for ${y}-${pad(m)}: ${d}`)
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`
}

export function parseCalendarDate(date: CalendarDate): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new RangeError(`not a calendar date: ${JSON.stringify(date)}`)
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  toCalendarDate(y, mo, d) // revalidate
  return { y, m: mo, d }
}

/**
 * The business date an instant belongs to.
 *
 * This value is WRITTEN into `journal_entries.business_date` and `shifts.business_date`.
 * It is deliberately NOT a Postgres generated column: `(occurred_at AT TIME ZONE 'Asia/Damascus')::date`
 * is STABLE, not IMMUTABLE, and Postgres refuses it in a generated column. Computing it here
 * and storing it also means a tz-database update can never silently re-bucket historical money.
 */
export function businessDateFor(
  epochMs: number,
  offsetMinutes = DAMASCUS_OFFSET_MINUTES,
  dayStartMinutes = DAY_START_MINUTES,
): CalendarDate {
  // Rolling the clock BACK by the day-start pushes the small hours onto the previous date, which
  // is the whole rule: 01:30 on the 28th is hour 21.5 of the 27th's working day.
  const localMs = epochMs + (offsetMinutes - dayStartMinutes) * 60_000
  const { y, m, d } = civilFromDays(Math.floor(localMs / 86_400_000))
  return toCalendarDate(y, m, d)
}

/** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday, hence the +4. */
export function dayOfWeek(date: CalendarDate): number {
  const { y, m, d } = parseCalendarDate(date)
  return (((daysFromCivil(y, m, d) + 4) % 7) + 7) % 7
}

export function addDays(date: CalendarDate, delta: number): CalendarDate {
  const { y, m, d } = parseCalendarDate(date)
  const next = civilFromDays(daysFromCivil(y, m, d) + delta)
  return toCalendarDate(next.y, next.m, next.d)
}

/**
 * The Sunday that starts the financial week containing `date` (BR7, product-owner confirmed:
 * the week runs Sunday → Saturday and is closed by the system admin the FOLLOWING Sunday).
 *
 * Never use Postgres `date_trunc('week', …)` for this — it is ISO, i.e. MONDAY-based, and
 * would put the boundary one day off in exactly the place where entries become immutable.
 * `week_start_date` is stored explicitly on every journal entry for the same reason.
 */
export function weekStartFor(date: CalendarDate): CalendarDate {
  return addDays(date, -dayOfWeek(date))
}

export function weekEndFor(date: CalendarDate): CalendarDate {
  return addDays(weekStartFor(date), 6)
}

/** The week whose entries a Sunday close freezes: the one that ended yesterday. */
export function weekClosedOn(closeDate: CalendarDate): { start: CalendarDate; end: CalendarDate } {
  if (dayOfWeek(closeDate) !== 0) {
    throw new RangeError(`the financial week is closed on a Sunday; ${closeDate} is not one`)
  }
  const start = addDays(closeDate, -7)
  return { start, end: addDays(start, 6) }
}

// ── Months, spans and validation (P2: the shared time filter) ───────────────────────────────
//
// Everything below is calendar arithmetic on business DATES, exactly like `addDays` above: no
// `Date`, no `Intl`, no zone. A «month» is the calendar month the business date falls in, and the
// business date already carries the 04:00 day start, so «هذا الشهر» needs no second time rule.

/** `true` when `value` is a real `YYYY-MM-DD` date — the same parser every other helper uses. */
export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== 'string') return false
  try {
    parseCalendarDate(value)
    return true
  } catch {
    return false
  }
}

/** How many days month `m` (1–12) of year `y` has. */
export function daysInMonth(y: number, m: number): number {
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new RangeError(`not a month: ${y}-${m}`)
  }
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0
}

/** The first day of the calendar month `date` falls in. */
export function monthStartFor(date: CalendarDate): CalendarDate {
  const { y, m } = parseCalendarDate(date)
  return toCalendarDate(y, m, 1)
}

/** The last day of the calendar month `date` falls in. */
export function monthEndFor(date: CalendarDate): CalendarDate {
  const { y, m } = parseCalendarDate(date)
  return toCalendarDate(y, m, daysInMonth(y, m))
}

/**
 * The same day `n` months later (or earlier, for a negative `n`), CLAMPED to the target month's
 * last day: 2026-01-31 plus one month is 2026-02-28, never an overflow into March. Clamping is
 * the only reading under which «the previous month» of the 31st is still the previous month.
 */
export function addMonths(date: CalendarDate, n: number): CalendarDate {
  if (!Number.isInteger(n)) throw new RangeError(`non-integer month delta: ${n}`)
  const { y, m, d } = parseCalendarDate(date)
  const index = y * 12 + (m - 1) + n
  const ty = Math.floor(index / 12)
  const tm = index - ty * 12 + 1
  return toCalendarDate(ty, tm, Math.min(d, daysInMonth(ty, tm)))
}

/** `YYYY-MM` — the month a date belongs to, as a sortable key. */
export function monthKey(date: CalendarDate): string {
  // Through the parser, so an impossible date is refused rather than keyed by its first 7 chars.
  return monthStartFor(date).slice(0, 7)
}

/**
 * Signed count of calendar-month boundaries from `a`'s month to `b`'s month: 2026-01-31 → 2026-02-01
 * is 1, and any two dates in the same month are 0. Days inside the months are ignored on purpose;
 * a caller that wants «the Nth month, counting the first as 1» adds one.
 */
export function monthsBetween(a: CalendarDate, b: CalendarDate): number {
  const pa = parseCalendarDate(a)
  const pb = parseCalendarDate(b)
  return (pb.y * 12 + pb.m) - (pa.y * 12 + pa.m)
}

/** Signed whole days from `a` to `b`: `addDays(a, daysBetween(a, b)) === b`. */
export function daysBetween(a: CalendarDate, b: CalendarDate): number {
  const pa = parseCalendarDate(a)
  const pb = parseCalendarDate(b)
  return daysFromCivil(pb.y, pb.m, pb.d) - daysFromCivil(pa.y, pa.m, pa.d)
}

// ── Branch-local minute keys (GPS ↔ order path linking) ──────────────────────────────────────
//
// A `"YYYY-MM-DD HH:MM"` string whose lexical order is chronological, so a ping's captured instant
// and an order's printed clock compare like for like, and a prior-calendar-day order sorts first.
// This is the WALL-CLOCK local minute (offset only — NOT the 04:00 business-day shift), because an
// order's `occurred_date`/`occurred_minute` is the actual local date and clock printed on the
// screen, not a business date. It is the pure, `Date`-free twin of the fallback branch in
// `contracts/operation-window.ts`.

/** The branch-local minute an epoch instant falls in, as a chronological `"YYYY-MM-DD HH:MM"` key. */
export function minuteKeyForOffset(epochMs: number, offsetMinutes = DAMASCUS_OFFSET_MINUTES): string {
  const localMs = epochMs + offsetMinutes * 60_000
  const dayIndex = Math.floor(localMs / 86_400_000)
  const { y, m, d } = civilFromDays(dayIndex)
  const minuteOfDay = Math.floor((localMs - dayIndex * 86_400_000) / 60_000)
  return `${pad(y, 4)}-${pad(m)}-${pad(d)} ${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`
}

/**
 * The same key for a printed calendar date + `"HH:MM"` clock, or `null` when either is unreadable.
 * Mirrors the validation of `operationMinuteKey` in the operation-window classifier, so the two
 * agree on which order times are usable.
 */
export function printedMinuteKey(date: string | null, minute: string | null): string | null {
  if (date === null || minute === null) return null
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(minute)) return null
  if (!isCalendarDate(date)) return null
  return `${date} ${minute}`
}
