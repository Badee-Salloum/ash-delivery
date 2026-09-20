import { isCalendarDate, type CalendarDate } from '@ash/domain'

export * from './api.ts'
export * from './order-entry.ts'
export * from './order-match.ts'
export * from './slot-label.ts'
export * from './compress.ts'
export * from './close-draft.ts'
export * from './ocr-delta.ts'
export * from './fleet.ts'
export * from './reading-checks.ts'
export * from './numerals.ts'
export * from './client-uuid.ts'

/** Pluralization travels with the catalogues, but app code imports it from the root. */
export { plural, pluralCategory, type PluralForms } from './i18n/index.ts'

/**
 * One timestamp format for the whole console.
 *
 * Three screens each rolled their own: the decision log used the BROWSER's locale, so it
 * rendered «8/8/2026, 3:04:11 PM» inside an otherwise Arabic, ISO-dated UI; the audit table
 * sliced the ISO string; the dashboard used a time-only format. Latin digits deliberately —
 * the whole product shows Western numerals (the ar-SY-u-nu-latn policy in styles.css).
 */
export function formatDateTime(iso: string, lang: 'ar' | 'en'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  void lang // the shape is identical in both; the parameter keeps call sites honest
  return damascusParts(d).stamp
}

/** Audit-grade Damascus timestamp; seconds distinguish rapid consecutive money movements. */
export function formatDateTimeSeconds(iso: string, lang: 'ar' | 'en'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  void lang
  return damascusParts(d).stampSeconds
}

/**
 * The branch's wall clock, from an instant.
 *
 * The fix that removed the browser's LOCALE left the browser's ZONE in place: `getHours()` and
 * friends are local-time getters, and there was no `Asia/Damascus` anywhere in the admin app. On a
 * laptop set to UTC a close confirmed at 01:30 in Damascus rendered as 22:30 — the PREVIOUS DAY —
 * beside a business-date column that correctly said otherwise. Two dates for one event, and the
 * one a manager would have trusted was the wrong one.
 *
 * `Intl` rather than a fixed +3: the offset is the adapter layer's job to know, and a formatter
 * that reads the tz database stays right if Syria ever restores DST. This is the client package,
 * not `packages/domain` — the domain stays free of `Intl` by rule.
 */
export function damascusParts(value: Date): {
  readonly date: string
  readonly time: string
  readonly stamp: string
  readonly stampSeconds: string
  /** 0 = Sunday. For naming the day, which is how a manager actually recalls a shift. */
  readonly weekday: number
} {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Damascus',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(value)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  // `hour12: false` still yields "24" at midnight in some engines; normalise it to "00".
  const hour = get('hour') === '24' ? '00' : get('hour')
  const date = `${get('year')}-${get('month')}-${get('day')}`
  const time = `${hour}:${get('minute')}`
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    date,
    time,
    stamp: `${date} ${time}`,
    stampSeconds: `${date} ${time}:${get('second')}`,
    weekday: Math.max(0, WEEKDAYS.indexOf(get('weekday'))),
  }
}

/**
 * A business date is already a written Damascus calendar day, not an instant. Formatting it via
 * `new Date('YYYY-MM-DD')` at the browser's local zone can move it backwards for users west of
 * UTC, so this formatter anchors the date at UTC noon and fixes the formatter to UTC.
 *
 * Arabic still uses Arabic month names, while the product's `u-nu-latn` policy preserves Latin
 * digits in both languages. Screens should use this instead of making their own `Intl` formatter.
 */
function businessDateAtNoon(value: CalendarDate): Date | null {
  if (!isCalendarDate(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day!, 12))
}

const businessDateLocale = (lang: 'ar' | 'en'): string =>
  lang === 'ar' ? 'ar-SY-u-ca-gregory-nu-latn' : 'en-GB-u-ca-gregory-nu-latn'

/** A compact local label for a written business date, e.g. «Tue, 26 Sep» / «الثلاثاء، 26 سبتمبر». */
export function formatBusinessDate(value: CalendarDate, lang: 'ar' | 'en'): string {
  const date = businessDateAtNoon(value)
  if (date === null) return value
  return new Intl.DateTimeFormat(businessDateLocale(lang), {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date)
}

/**
 * Localized endpoints for a concise business-date range. The caller owns the surrounding words,
 * so Arabic can render «من 20 إلى 26 سبتمبر» and English «From 20 to 26 September» naturally.
 */
export function formatBusinessDateRange(
  from: CalendarDate,
  to: CalendarDate,
  lang: 'ar' | 'en',
): { from: string; to: string } {
  const start = businessDateAtNoon(from)
  const end = businessDateAtNoon(to)
  if (start === null || end === null) return { from, to }
  const locale = businessDateLocale(lang)
  const format = (date: Date, options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(date)
  const sameMonth = from.slice(0, 7) === to.slice(0, 7)
  const sameYear = from.slice(0, 4) === to.slice(0, 4)
  if (sameMonth) {
    return {
      from: format(start, { day: 'numeric' }),
      to: format(end, { day: 'numeric', month: 'long' }),
    }
  }
  if (sameYear) {
    return {
      from: format(start, { day: 'numeric', month: 'long' }),
      to: format(end, { day: 'numeric', month: 'long' }),
    }
  }
  return {
    from: format(start, { day: 'numeric', month: 'long', year: 'numeric' }),
    to: format(end, { day: 'numeric', month: 'long', year: 'numeric' }),
  }
}

/**
 * The wire's ceiling on a training sample, re-exported for the DRIVER.
 *
 * It has to check before sending: an oversized sample failed validation and returned 400 on the
 * whole start package, so a picture kept for a future model stopped a shift. `apps/driver` does not
 * depend on `@ash/contracts`, and this is the package it does depend on.
 */
export { MAX_OCR_SAMPLE_CHARS } from '@ash/contracts'
