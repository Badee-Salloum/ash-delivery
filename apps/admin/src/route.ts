import {
  LEDGER_EVENTS,
  type CalendarDate,
  type LedgerEvent,
  type RangePreset,
  isCalendarDate,
  isRangePreset,
} from '@ash/domain'

/**
 * The console's URL-hash router, pure (P2).
 *
 * A view is a SECTION, optionally carrying filter PARAMS, or `shift:<id>` for the review overlay:
 *
 *     #completedShifts?range=this_week&driver=<id>&short=1
 *     #shift:<id>
 *
 * The console used to accept only `#section` and `#shift:<id>`, and its reflect effect rewrote the
 * hash to the bare section, so a link such as `#completedShifts?from=…` landed on the dashboard.
 * Parameters now survive, and a dashboard tile can open a screen already filtered.
 *
 * EVERYTHING FROM THE URL IS UNTRUSTED. Unknown keys are dropped; a value that fails its own
 * validator is dropped; dates go through the domain's calendar parser, so `2026-02-31` never
 * reaches a request. `formatHash` runs the same validators, so a link builder cannot produce what
 * the parser would refuse.
 */

/** Every screen the rail can show. A section the parser does not know opens the dashboard. */
export const SECTIONS = [
  'dashboard',
  'queue',
  'liveShifts',
  'completedShifts',
  'preapprovedShifts',
  'gpsLive',
  'fleet',
  'vehicle',
  'fleetConfig',
  'treasury',
  'treasuryMovements',
  'companyFund',
  'expenses',
  'checkin',
  'accounts',
  'audit',
  'removals',
  'permissions',
  'settings',
] as const
export type Section = (typeof SECTIONS)[number]

export function isSection(value: string): value is Section {
  return (SECTIONS as readonly string[]).includes(value)
}

export type PatternParam = 'day' | 'evening' | 'full'
export type LiveStateParam = 'open' | 'suspended'
export type TreasuryChannelParam = 'cash' | 'wallet'
export type TreasuryFlowParam = 'in' | 'out' | 'internal'

/** The filters a view may carry. Every field optional; absence means «no filter». */
export interface RouteParams {
  readonly range?: RangePreset
  readonly from?: CalendarDate
  readonly to?: CalendarDate
  readonly eventType?: LedgerEvent
  readonly channel?: TreasuryChannelParam
  readonly flow?: TreasuryFlowParam
  readonly actor?: string
  readonly q?: string
  readonly driver?: string
  readonly vehicle?: string
  readonly pattern?: PatternParam
  readonly short?: true
  readonly abandoned?: true
  readonly state?: LiveStateParam
  readonly over?: true
  readonly tab?: string
  readonly id?: string
}

export interface RouteView {
  readonly section: Section
  /** The shift under review, or null. The section behind it is kept so closing returns there. */
  readonly openShift: string | null
  readonly params: RouteParams
}

/** Written in this order, always, so one view has exactly one spelling. */
export const PARAM_KEYS = [
  'range',
  'from',
  'to',
  'eventType',
  'channel',
  'flow',
  'actor',
  'q',
  'driver',
  'vehicle',
  'pattern',
  'short',
  'abandoned',
  'state',
  'over',
  'tab',
  'id',
] as const satisfies readonly (keyof RouteParams)[]

/** Row ids: UUIDs in production, `vehicle-1` in the harness. Nothing else. */
const ID = /^[A-Za-z0-9-]{1,64}$/
/** A tab is a code, never text. */
const TAB = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
/** A shift id in `#shift:<id>` — kept as permissive as the old router, minus whitespace and `?`. */
const SHIFT_ID = /^[A-Za-z0-9._:-]{1,128}$/

const PATTERNS: readonly PatternParam[] = ['day', 'evening', 'full']
const LIVE_STATES: readonly LiveStateParam[] = ['open', 'suspended']
const TREASURY_CHANNELS: readonly TreasuryChannelParam[] = ['cash', 'wallet']
const TREASURY_FLOWS: readonly TreasuryFlowParam[] = ['in', 'out', 'internal']

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Keep only what is valid, and only what is coherent: a `custom` range needs both ends in order,
 * a `week` range needs its date, and a lone `to` means nothing.
 */
export function sanitizeParams(input: Readonly<Record<string, unknown>>): RouteParams {
  const out: Mutable<RouteParams> = {}
  const text = (key: string): string | null => {
    const value = input[key]
    return typeof value === 'string' ? value : null
  }
  const flag = (key: string): boolean => {
    const value = input[key]
    return value === true || value === '1'
  }

  const range = text('range')
  const from = text('from')
  const to = text('to')
  const validFrom = from !== null && isCalendarDate(from) ? from : null
  const validTo = to !== null && isCalendarDate(to) ? to : null
  if (range !== null && isRangePreset(range)) {
    if (range === 'custom') {
      if (validFrom !== null && validTo !== null && validFrom <= validTo) {
        out.range = range
        out.from = validFrom
        out.to = validTo
      }
    } else if (range === 'week') {
      if (validFrom !== null) {
        out.range = range
        out.from = validFrom
      }
    } else {
      out.range = range
    }
  } else if (range === null && validFrom !== null && validTo !== null && validFrom <= validTo) {
    // An explicit pair with no preset is a custom range — the shape a hand-typed link takes.
    out.from = validFrom
    out.to = validTo
  }

  const eventType = text('eventType')
  if (eventType !== null && (LEDGER_EVENTS as readonly string[]).includes(eventType)) {
    out.eventType = eventType as LedgerEvent
  }
  const channel = text('channel')
  if (channel !== null && (TREASURY_CHANNELS as readonly string[]).includes(channel)) {
    out.channel = channel as TreasuryChannelParam
  }
  const flow = text('flow')
  if (flow !== null && (TREASURY_FLOWS as readonly string[]).includes(flow)) {
    out.flow = flow as TreasuryFlowParam
  }
  const actor = text('actor')
  if (actor !== null && ID.test(actor)) out.actor = actor
  const query = text('q')?.trim()
  if (query && query.length <= 200) out.q = query

  const driver = text('driver')
  if (driver !== null && ID.test(driver)) out.driver = driver
  const vehicle = text('vehicle')
  if (vehicle !== null && ID.test(vehicle)) out.vehicle = vehicle
  const pattern = text('pattern')
  if (pattern !== null && (PATTERNS as readonly string[]).includes(pattern)) out.pattern = pattern as PatternParam
  if (flag('short')) out.short = true
  if (flag('abandoned')) out.abandoned = true
  const state = text('state')
  if (state !== null && (LIVE_STATES as readonly string[]).includes(state)) out.state = state as LiveStateParam
  if (flag('over')) out.over = true
  const tab = text('tab')
  if (tab !== null && TAB.test(tab)) out.tab = tab
  const id = text('id')
  if (id !== null && ID.test(id)) out.id = id
  return out
}

/** A malformed escape must not throw out of the router; the raw text is then simply unmatched. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Read `location.hash` (with or without its `#`). Never throws. */
export function parseHash(hash: string): RouteView {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const q = raw.indexOf('?')
  const head = safeDecode(q < 0 ? raw : raw.slice(0, q)).trim()
  const query = q < 0 ? '' : raw.slice(q + 1)

  if (head.startsWith('shift:')) {
    const id = head.slice('shift:'.length)
    // The section behind an overlay is not in the URL; the shell keeps whatever it had.
    return SHIFT_ID.test(id)
      ? { section: 'dashboard', openShift: id, params: {} }
      : { section: 'dashboard', openShift: null, params: {} }
  }
  if (!isSection(head)) return { section: 'dashboard', openShift: null, params: {} }

  const values: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(query)) {
    // First occurrence wins and unknown keys never enter the record.
    if ((PARAM_KEYS as readonly string[]).includes(key) && !(key in values)) values[key] = value
  }
  return { section: head, openShift: null, params: sanitizeParams(values) }
}

/** The query string of a params object, without `?`. Empty for no params. */
export function formatParams(params: RouteParams): string {
  const clean = sanitizeParams(params as Readonly<Record<string, unknown>>)
  const parts: string[] = []
  for (const key of PARAM_KEYS) {
    const value = clean[key]
    if (value === undefined) continue
    parts.push(`${key}=${value === true ? '1' : encodeURIComponent(value)}`)
  }
  return parts.join('&')
}

/** The hash for a view, WITHOUT its leading `#`. */
export function formatHash(view: RouteView): string {
  // An id the parser would refuse is not written either; the section is shown instead.
  if (view.openShift !== null && SHIFT_ID.test(view.openShift)) return `shift:${view.openShift}`
  const query = formatParams(view.params)
  return query === '' ? view.section : `${view.section}?${query}`
}

/**
 * A stable identity for a params object — the React `key` a filtered screen is mounted with, so
 * following a link to the same screen with different filters starts it afresh.
 */
export function paramsKey(params: RouteParams): string {
  return formatParams(params)
}

/** Do two hashes name the same view once both are normalised? */
export function sameView(a: RouteView, b: RouteView): boolean {
  return formatHash(a) === formatHash(b)
}
