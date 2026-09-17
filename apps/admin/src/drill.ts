import type { CalendarDate, RangePreset } from '@ash/domain'
import { type LiveStateParam, type PatternParam, type RouteParams, formatHash } from './route.ts'

/**
 * Typed links into a filtered screen (P2) — what every «›» on the dashboard points at.
 *
 * Built through `formatHash`, so a link carries exactly what the router would accept: an invalid
 * id or date is dropped rather than producing a URL that opens something else.
 */

export interface CompletedShiftsLink {
  readonly range?: RangePreset
  readonly from?: CalendarDate
  readonly to?: CalendarDate
  readonly driver?: string
  readonly vehicle?: string
  readonly pattern?: PatternParam
  readonly short?: boolean
  readonly abandoned?: boolean
}

export interface LiveShiftsLink {
  readonly state?: LiveStateParam
  readonly driver?: string
  readonly vehicle?: string
  readonly over?: boolean
}

export interface ExpensesLink {
  readonly tab?: string
}

/** Drop `undefined`s and `false` flags, so the params object has only what the link means. */
function paramsOf(input: Readonly<Record<string, string | boolean | undefined>>): RouteParams {
  const out: Record<string, string | true> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === false) continue
    out[key] = value === true ? true : value
  }
  return out as RouteParams
}

/**
 * A range for a link: a pair of dates alone is a custom range; a preset with dates keeps them
 * (`week` needs its Sunday, `custom` both ends).
 */
function rangeOf(link: { range?: RangePreset; from?: CalendarDate; to?: CalendarDate }): Record<string, string | undefined> {
  if (link.range === undefined && link.from !== undefined && link.to !== undefined) {
    return { range: 'custom', from: link.from, to: link.to }
  }
  return { range: link.range, from: link.from, to: link.to }
}

export function completedShiftsHref(link: CompletedShiftsLink = {}): string {
  const params = paramsOf({
    ...rangeOf(link),
    driver: link.driver,
    vehicle: link.vehicle,
    pattern: link.pattern,
    short: link.short,
    abandoned: link.abandoned,
  })
  return `#${formatHash({ section: 'completedShifts', openShift: null, params })}`
}

export function liveShiftsHref(link: LiveShiftsLink = {}): string {
  const params = paramsOf({ state: link.state, driver: link.driver, vehicle: link.vehicle, over: link.over })
  return `#${formatHash({ section: 'liveShifts', openShift: null, params })}`
}

export function expensesHref(link: ExpensesLink = {}): string {
  return `#${formatHash({ section: 'expenses', openShift: null, params: paramsOf({ tab: link.tab }) })}`
}

export function shiftHref(id: string): string {
  return `#${formatHash({ section: 'dashboard', openShift: id, params: {} })}`
}

/** One import for a screen that links to several places. */
export const drill = {
  completedShifts: completedShiftsHref,
  liveShifts: liveShiftsHref,
  expenses: expensesHref,
  shift: shiftHref,
} as const
