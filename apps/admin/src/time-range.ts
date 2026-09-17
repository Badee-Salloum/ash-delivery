import {
  type CalendarDate,
  type DateRange,
  type RangeSelection,
  type SimpleRangePreset,
  addDays,
  daysBetween,
  isCalendarDate,
  isRangePreset,
  resolveRange,
  validateCustom,
  weekStartFor,
} from '@ash/domain'
import type { RouteParams } from './route.ts'

/**
 * The console half of «فلتر الوقت» (P2), pure: which selection a screen starts with, how it is
 * written to the URL and to the browser, and how it becomes dates.
 *
 * PRECEDENCE: the URL hash (a shared or drilled-into link means exactly what it says) → this
 * user's last choice in `localStorage` → «الكل منذ البدء».
 *
 * «Today» and the epoch come from `GET /dashboard/meta` and nowhere else. `session.businessDate`
 * is stamped at sign-in and is stale after 04:00; `new Date()` knows neither Damascus nor the
 * 04:00 day start.
 */

export const RANGE_STORAGE_PREFIX = 'ash.admin.range.v1:'

export const DEFAULT_SELECTION: RangeSelection = Object.freeze({ preset: 'all' })

/** The pills, in the mockup's order. `week` belongs to the navigator and `custom` to its form. */
export const SIMPLE_PRESETS: readonly SimpleRangePreset[] = Object.freeze([
  'all',
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
])

export function rangeStorageKey(userId: string): string {
  return `${RANGE_STORAGE_PREFIX}${userId}`
}

/** The selection a URL names, or null when it names none (or names it badly). */
export function selectionFromParams(params: RouteParams): RangeSelection | null {
  const { range, from, to } = params
  if (range === undefined) {
    if (from !== undefined && to !== undefined) {
      const checked = validateCustom(from, to)
      return checked.ok ? { preset: 'custom', from: checked.from, to: checked.to } : null
    }
    return null
  }
  if (range === 'custom') {
    const checked = validateCustom(from, to)
    return checked.ok ? { preset: 'custom', from: checked.from, to: checked.to } : null
  }
  if (range === 'week') {
    return from !== undefined && isCalendarDate(from) ? { preset: 'week', week: weekStartFor(from) } : null
  }
  return { preset: range }
}

/** The URL fields for a selection. Always all three keys, so stale ones are overwritten. */
export function paramsFromSelection(
  selection: RangeSelection,
): { range: RangeSelection['preset']; from: CalendarDate | undefined; to: CalendarDate | undefined } {
  switch (selection.preset) {
    case 'custom':
      return { range: 'custom', from: selection.from, to: selection.to }
    case 'week':
      return { range: 'week', from: weekStartFor(selection.week), to: undefined }
    default:
      return { range: selection.preset, from: undefined, to: undefined }
  }
}

/** `all` · `week:2026-09-13` · `custom:2026-09-01..2026-09-17` */
export function serializeSelection(selection: RangeSelection): string {
  switch (selection.preset) {
    case 'custom':
      return `custom:${selection.from}..${selection.to}`
    case 'week':
      return `week:${weekStartFor(selection.week)}`
    default:
      return selection.preset
  }
}

/** The inverse of `serializeSelection`; anything else is null, never a throw. */
export function parseSelection(raw: unknown): RangeSelection | null {
  if (typeof raw !== 'string') return null
  if (raw.startsWith('week:')) {
    const week = raw.slice('week:'.length)
    return isCalendarDate(week) ? { preset: 'week', week: weekStartFor(week) } : null
  }
  if (raw.startsWith('custom:')) {
    const [from, to, ...rest] = raw.slice('custom:'.length).split('..')
    if (rest.length > 0) return null
    const checked = validateCustom(from, to)
    return checked.ok ? { preset: 'custom', from: checked.from, to: checked.to } : null
  }
  if (!isRangePreset(raw) || raw === 'week' || raw === 'custom') return null
  return { preset: raw }
}

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

/** A private window or disabled site data throws on access; that simply means «nothing stored». */
export function readStoredSelection(storage: ReadableStorage | null | undefined, userId: string): RangeSelection | null {
  if (!storage) return null
  try {
    return parseSelection(storage.getItem(rangeStorageKey(userId)))
  } catch {
    return null
  }
}

export function writeStoredSelection(
  storage: WritableStorage | null | undefined,
  userId: string,
  selection: RangeSelection,
): boolean {
  if (!storage) return false
  try {
    storage.setItem(rangeStorageKey(userId), serializeSelection(selection))
    return true
  } catch {
    return false
  }
}

/** The browser's storage, or null where even touching `localStorage` throws. */
export function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Hash → this user's stored choice → «الكل منذ البدء». */
export function initialSelection(input: {
  params: RouteParams
  storage: ReadableStorage | null | undefined
  userId: string | null | undefined
}): RangeSelection {
  return (
    selectionFromParams(input.params) ??
    (input.userId ? readStoredSelection(input.storage, input.userId) : null) ??
    DEFAULT_SELECTION
  )
}

/** What `GET /dashboard/meta` answers. */
export interface RangeMeta {
  today: CalendarDate
  goLiveBusinessDate: CalendarDate | null
  firstActivityDate: CalendarDate | null
  /** Absent on an older API; derived below. */
  epoch?: CalendarDate
  weekStart: CalendarDate
  monthStart: CalendarDate
  dayStartMinutes?: number
  maxRangeDays?: number
}

/** go-live → first ledger activity → today, exactly as the server derives it. */
export function epochOf(meta: RangeMeta): CalendarDate {
  return meta.epoch ?? meta.goLiveBusinessDate ?? meta.firstActivityDate ?? meta.today
}

/** The dates a selection means, on the server's today. A selection that no longer resolves reads as «all». */
export function resolveSelection(selection: RangeSelection, meta: RangeMeta): DateRange {
  const ctx = { today: meta.today, epoch: epochOf(meta) }
  try {
    return resolveRange(selection, ctx)
  } catch {
    return resolveRange(DEFAULT_SELECTION, ctx)
  }
}

/** Inclusive length of a range, in business days. */
export function rangeDays(range: DateRange): number {
  return daysBetween(range.from, range.to) + 1
}

/** The last `maxDays` days of a range, ending where it ended and never starting before it did. */
export function cappedRange(range: DateRange, maxDays: number): DateRange {
  const from = addDays(range.to, -(maxDays - 1))
  return { from: from > range.from ? from : range.from, to: range.to }
}

/** «ضيّق الفترة» — adopt the capped range as the manager's own selection. */
export function narrowedSelection(range: DateRange, maxDays: number): RangeSelection {
  return { preset: 'custom', ...cappedRange(range, maxDays) }
}

/** «04:00» from minutes past midnight. Latin digits, fixed shape, like every figure here. */
export function dayStartLabel(minutes = 240): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Do two selections mean the same thing? */
export function sameSelection(a: RangeSelection, b: RangeSelection): boolean {
  return serializeSelection(a) === serializeSelection(b)
}
