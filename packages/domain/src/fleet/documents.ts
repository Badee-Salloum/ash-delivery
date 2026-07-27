import type { CalendarDate } from '../time/civil.ts'
import { daysFromCivil, parseCalendarDate } from '../time/civil.ts'

/**
 * SRS B-1 / B-2 (س37) — driver and vehicle documents with expiry alerting.
 *
 * Drivers carry a driving licence, a national ID and a criminal-record certificate; vehicles
 * carry registration and insurance. An expired document must block assignment, and the alerts
 * must arrive early enough to renew one in Damascus.
 */

export type DocumentStatus = 'no_expiry' | 'valid' | 'expiring_soon' | 'expires_today' | 'expired'

/** Alert thresholds in days. Configurable in settings; these are the defaults. */
export const DEFAULT_ALERT_DAYS: readonly number[] = [30, 14, 7, 0]

export function daysUntil(expiresOn: CalendarDate, today: CalendarDate): number {
  const a = parseCalendarDate(expiresOn)
  const b = parseCalendarDate(today)
  return daysFromCivil(a.y, a.m, a.d) - daysFromCivil(b.y, b.m, b.d)
}

export function documentStatusOn(
  expiresOn: CalendarDate | null,
  today: CalendarDate,
  alertDays: readonly number[] = DEFAULT_ALERT_DAYS,
): DocumentStatus {
  if (expiresOn === null) return 'no_expiry'
  const remaining = daysUntil(expiresOn, today)
  if (remaining < 0) return 'expired'
  if (remaining === 0) return 'expires_today'
  const earliest = Math.max(...alertDays)
  return remaining <= earliest ? 'expiring_soon' : 'valid'
}

/**
 * Whether an alert should fire today. Fires ONCE per threshold crossed, not every day — a daily
 * reminder for thirty days trains everyone to ignore the bell, which is worse than no bell.
 */
export function shouldAlertOn(
  expiresOn: CalendarDate | null,
  today: CalendarDate,
  alertDays: readonly number[] = DEFAULT_ALERT_DAYS,
): boolean {
  if (expiresOn === null) return false
  return alertDays.includes(daysUntil(expiresOn, today))
}

/**
 * The alert band a document currently sits in, or null when no threshold has been crossed yet.
 *
 * `shouldAlertOn` fires only on the EXACT threshold day — correct for a daily cron. With no
 * scheduler we sweep on-view, so we need a value that is STABLE across a band: the tightest
 * threshold already reached. Deduping the bell on «docId:band» then rings once per band over the
 * document's life (T-30, T-14, T-7, T-0, then expired) no matter which days the board is opened —
 * never the daily nag that trains everyone to ignore it.
 */
export function alertBandFor(
  expiresOn: CalendarDate | null,
  today: CalendarDate,
  alertDays: readonly number[] = DEFAULT_ALERT_DAYS,
): string | null {
  if (expiresOn === null) return null
  const remaining = daysUntil(expiresOn, today)
  if (remaining < 0) return 'expired'
  const reached = [...alertDays].sort((a, b) => a - b).find((d) => remaining <= d)
  return reached === undefined ? null : `t-${reached}`
}

/** A document that is expired blocks assignment; one merely expiring does not. */
export const blocksAssignment = (status: DocumentStatus): boolean => status === 'expired'

// ── Vehicle operational state (SRS B-2 / س66) ────────────────────────────────────────────

export type VehicleState = 'ready' | 'charging' | 'maintenance' | 'stopped'

/** Only a `ready` vehicle may start a shift. */
export const VEHICLE_TRANSITIONS: Readonly<Record<VehicleState, readonly VehicleState[]>> = {
  ready: ['charging', 'maintenance', 'stopped'],
  charging: ['ready', 'maintenance', 'stopped'],
  maintenance: ['ready', 'stopped'],
  stopped: ['ready', 'maintenance'],
}

export function canTransitionVehicle(from: VehicleState, to: VehicleState): boolean {
  return VEHICLE_TRANSITIONS[from].includes(to)
}

export interface AssignmentCheck {
  readonly vehicleState: VehicleState
  readonly driverDocumentStatuses: readonly DocumentStatus[]
  readonly vehicleDocumentStatuses: readonly DocumentStatus[]
  readonly driverAlreadyLive: boolean
  readonly vehicleAlreadyLive: boolean
  readonly driverActive: boolean
  readonly vehicleActive: boolean
}

export type AssignmentBlocker =
  | 'vehicle_not_ready'
  | 'driver_document_expired'
  | 'vehicle_document_expired'
  | 'driver_already_on_shift'
  | 'vehicle_already_on_shift'
  | 'driver_inactive'
  | 'vehicle_inactive'

/**
 * SRS B-3 (س34) — the mandatory driver ↔ vehicle ↔ shift binding.
 *
 * A vehicle IS shared between drivers across shifts (س23); it just cannot be in two live shifts
 * at once. Same for a driver, who may work up to two shifts a day — sequentially.
 */
export function canOpenShift(check: AssignmentCheck): {
  readonly ok: boolean
  readonly blockers: readonly AssignmentBlocker[]
} {
  const blockers: AssignmentBlocker[] = []
  if (!check.driverActive) blockers.push('driver_inactive')
  if (!check.vehicleActive) blockers.push('vehicle_inactive')
  if (check.vehicleState !== 'ready') blockers.push('vehicle_not_ready')
  if (check.driverDocumentStatuses.some(blocksAssignment)) blockers.push('driver_document_expired')
  if (check.vehicleDocumentStatuses.some(blocksAssignment)) blockers.push('vehicle_document_expired')
  if (check.driverAlreadyLive) blockers.push('driver_already_on_shift')
  if (check.vehicleAlreadyLive) blockers.push('vehicle_already_on_shift')
  return { ok: blockers.length === 0, blockers }
}
