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
export function businessDateFor(epochMs: number, offsetMinutes = DAMASCUS_OFFSET_MINUTES): CalendarDate {
  const localMs = epochMs + offsetMinutes * 60_000
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
