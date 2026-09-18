import { SHIFT_TARGET_MINUTES, type ShiftPattern, type ShiftSlot } from '@ash/domain'
import type { LiveStateParam } from './route.ts'

/**
 * «النوبات الجارية» — the board's filters and its «over target» rule, pure (P2).
 *
 * A running shift has a SLOT but no pattern yet (any shift can still reach ten hours and become a
 * double), so it is measured against its slot's eight hours — the progress bar the mockup draws.
 * The elapsed time is an interval between two instants, so the browser clock is an honest source
 * for it; what the browser must never decide is which business DAY it is.
 */

export interface LiveBoardRow {
  readonly driverId: string
  readonly vehicleId: string
  readonly state: string
  readonly windowOpensAt?: string | null
  readonly worked?: { readonly pattern: ShiftPattern; readonly slot?: ShiftSlot | null } | undefined
}

export interface LiveBoardFilters {
  readonly driver: string
  readonly vehicle: string
  readonly state: '' | LiveStateParam
  readonly slot: '' | ShiftSlot
  readonly over: boolean
}

export const NO_LIVE_FILTERS: LiveBoardFilters = Object.freeze({
  driver: '',
  vehicle: '',
  state: '',
  slot: '',
  over: false,
})

/** Whole minutes since the shift's operation window opened, or null when it has no start yet. */
export function liveElapsedMinutes(windowOpensAt: string | null | undefined, nowMs: number): number | null {
  if (!windowOpensAt) return null
  const started = Date.parse(windowOpensAt)
  if (!Number.isFinite(started)) return null
  return Math.max(0, Math.floor((nowMs - started) / 60_000))
}

/** The target a running shift is measured against: its slot's, never a double's. */
export function liveTargetMinutes(row: Pick<LiveBoardRow, 'worked'>): number | null {
  const slot = row.worked?.slot ?? null
  return slot === null ? null : SHIFT_TARGET_MINUTES[slot]
}

/** Minutes past the slot's target, or 0 when within it, or null when it cannot be said. */
export function liveOverMinutes(row: LiveBoardRow, nowMs: number): number | null {
  const elapsed = liveElapsedMinutes(row.windowOpensAt, nowMs)
  const target = liveTargetMinutes(row)
  if (elapsed === null || target === null) return null
  return Math.max(0, elapsed - target)
}

export function isOverTarget(row: LiveBoardRow, nowMs: number): boolean {
  return (liveOverMinutes(row, nowMs) ?? 0) > 0
}

export function matchesLiveFilters(row: LiveBoardRow, filters: LiveBoardFilters, nowMs: number): boolean {
  if (filters.driver !== '' && row.driverId !== filters.driver) return false
  if (filters.vehicle !== '' && row.vehicleId !== filters.vehicle) return false
  if (filters.state !== '' && row.state !== filters.state) return false
  if (filters.slot !== '' && (row.worked?.slot ?? null) !== filters.slot) return false
  if (filters.over && !isOverTarget(row, nowMs)) return false
  return true
}

/** The three counters above the board, over the UNFILTERED rows. */
export function liveCounts(rows: readonly LiveBoardRow[], nowMs: number): { open: number; suspended: number; over: number } {
  return {
    open: rows.filter((row) => row.state === 'open').length,
    suspended: rows.filter((row) => row.state === 'suspended').length,
    over: rows.filter((row) => isOverTarget(row, nowMs)).length,
  }
}

/** «7:24». Latin digits and a fixed shape, like every other figure in the console. */
export function hoursMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}
