/**
 * «فلتر الوقت» — the one time filter every screen shares (owner request 2026-09-17).
 *
 * Pure, like the rest of `time/`: no `Date`, no `Intl`, no clock. «Today» is INJECTED, and it must
 * be the server's business date (`GET /dashboard/meta`), because the day starts at 04:00 Damascus
 * and a browser clock knows neither half of that. A screen that computed «this week» from
 * `new Date()` at 01:30 would show tomorrow's week to a manager still working tonight.
 *
 * WEEKS START ON SUNDAY — BR7's financial week, via `weekStartFor`. The sibling product this
 * filter's look was copied from starts its week on Saturday and does its arithmetic in the
 * browser's zone; neither is copied.
 *
 * Every resolved range is an inclusive pair of business dates with `from <= to`.
 */

import {
  type CalendarDate,
  addDays,
  addMonths,
  daysBetween,
  dayOfWeek,
  isCalendarDate,
  monthEndFor,
  monthStartFor,
  weekStartFor,
} from './civil.ts'

export type RangePreset =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'week'
  | 'custom'

/** Every preset, in the order the filter bar shows them. `week` is the navigator's, not a pill. */
export const RANGE_PRESETS: readonly RangePreset[] = Object.freeze([
  'all',
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'week',
  'custom',
])

/** The presets that need nothing but «today» and the epoch to resolve. */
export type SimpleRangePreset = Exclude<RangePreset, 'week' | 'custom'>

export type RangeSelection =
  | { readonly preset: SimpleRangePreset }
  /** One financial week, named by any date in it (normalised to its Sunday). */
  | { readonly preset: 'week'; readonly week: CalendarDate }
  /** An explicit inclusive pair. Validate it with `validateCustom` before resolving. */
  | { readonly preset: 'custom'; readonly from: CalendarDate; readonly to: CalendarDate }

export interface RangeContext {
  /** The server's current business date (04:00 day start already applied). */
  readonly today: CalendarDate
  /**
   * Where «الكل منذ البدء» starts: the go-live date, else the first ledger activity, else today.
   * The caller resolves that fallback; this module only uses the answer.
   */
  readonly epoch: CalendarDate
}

export interface DateRange {
  readonly from: CalendarDate
  readonly to: CalendarDate
}

export function isRangePreset(value: unknown): value is RangePreset {
  return typeof value === 'string' && (RANGE_PRESETS as readonly string[]).includes(value)
}

const minDate = (a: CalendarDate, b: CalendarDate): CalendarDate => (a <= b ? a : b)

/**
 * The inclusive business-date range a selection means on `ctx.today`.
 *
 * Throws `RangeError` only for a `custom` selection that `validateCustom` would refuse — a caller
 * holding user input validates first and shows the code; everything else always resolves.
 */
export function resolveRange(selection: RangeSelection, ctx: RangeContext): DateRange {
  const { today } = ctx
  switch (selection.preset) {
    case 'all':
      // An epoch in the future (a go-live date set ahead of time) must not invert the range.
      return { from: minDate(ctx.epoch, today), to: today }
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const day = addDays(today, -1)
      return { from: day, to: day }
    }
    case 'this_week':
      return { from: weekStartFor(today), to: today }
    case 'last_week': {
      const start = addDays(weekStartFor(today), -7)
      return { from: start, to: addDays(start, 6) }
    }
    case 'this_month':
      return { from: monthStartFor(today), to: today }
    case 'last_month': {
      const previous = addMonths(monthStartFor(today), -1)
      return { from: previous, to: monthEndFor(previous) }
    }
    case 'week': {
      // A future week is not a range anyone can read yet; it collapses onto the current week.
      const start = minDate(weekStartFor(selection.week), weekStartFor(today))
      return { from: start, to: minDate(addDays(start, 6), today) }
    }
    case 'custom': {
      const checked = validateCustom(selection.from, selection.to)
      if (!checked.ok) throw new RangeError(`invalid custom range: ${checked.code}`)
      return { from: checked.from, to: checked.to }
    }
  }
}

/** The Sunday `delta` weeks away from the week containing `date`. */
export function shiftWeek(date: CalendarDate, delta: number): CalendarDate {
  if (!Number.isInteger(delta)) throw new RangeError(`non-integer week delta: ${delta}`)
  return addDays(weekStartFor(date), delta * 7)
}

/** «التالي» is disabled once the navigator shows the current week. */
export function canGoNextWeek(week: CalendarDate, today: CalendarDate): boolean {
  return weekStartFor(week) < weekStartFor(today)
}

export type CustomRangeError = 'dates_required' | 'date_order' | 'range_too_large'

export type CustomRangeCheck =
  | { readonly ok: true; readonly from: CalendarDate; readonly to: CalendarDate; readonly days: number }
  | { readonly ok: false; readonly code: CustomRangeError }

/**
 * Check a user-typed pair. Codes, never sentences (the screens resolve them):
 *   `dates_required` — either side missing or not a real date (2026-02-31 included);
 *   `date_order`     — «إلى» before «من»;
 *   `range_too_large`— longer than `maxDays` inclusive days, when a cap is given.
 */
export function validateCustom(from: unknown, to: unknown, maxDays?: number): CustomRangeCheck {
  if (!isCalendarDate(from) || !isCalendarDate(to)) return { ok: false, code: 'dates_required' }
  if (to < from) return { ok: false, code: 'date_order' }
  const days = daysBetween(from, to) + 1
  if (maxDays !== undefined && days > maxDays) return { ok: false, code: 'range_too_large' }
  return { ok: true, from, to, days }
}

/** How a trend over a range is bucketed, so a year never draws 365 bars. */
export type RangeBucket = 'day' | 'week' | 'month'

/** Up to this many inclusive days a trend is drawn per day (two calendar months). */
export const DAY_BUCKET_MAX_DAYS = 62
/** Up to this many weeks (182 days) it is drawn per financial week; beyond, per month. */
export const WEEK_BUCKET_MAX_WEEKS = 26

export function bucketFor(from: CalendarDate, to: CalendarDate): RangeBucket {
  const days = Math.abs(daysBetween(from, to)) + 1
  if (days <= DAY_BUCKET_MAX_DAYS) return 'day'
  if (days <= WEEK_BUCKET_MAX_WEEKS * 7) return 'week'
  return 'month'
}

/**
 * The bucket a business date falls in, named by the bucket's FIRST day — the date itself, its
 * Sunday, or the first of its month. A calendar date rather than a label, so keys sort and a
 * screen formats them in its own language.
 */
export function bucketKey(date: CalendarDate, bucket: RangeBucket): CalendarDate {
  switch (bucket) {
    case 'day':
      return addDays(date, 0) // through the parser, so an impossible date cannot become a key
    case 'week':
      return weekStartFor(date)
    case 'month':
      return monthStartFor(date)
  }
}

/**
 * Every bucket key the inclusive range touches, oldest first — so a trend can draw an empty
 * bucket as an empty bar instead of silently closing the gap.
 */
export function bucketKeys(from: CalendarDate, to: CalendarDate, bucket: RangeBucket): CalendarDate[] {
  if (to < from) return []
  const keys: CalendarDate[] = []
  let cursor = bucketKey(from, bucket)
  const last = bucketKey(to, bucket)
  while (cursor <= last) {
    keys.push(cursor)
    cursor = bucket === 'day' ? addDays(cursor, 1) : bucket === 'week' ? addDays(cursor, 7) : addMonths(cursor, 1)
  }
  return keys
}

/** True when `date` is a Sunday — the only day a `week` selection may be stored as. */
export function isWeekStart(date: CalendarDate): boolean {
  return dayOfWeek(date) === 0
}
