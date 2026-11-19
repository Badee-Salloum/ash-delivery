import type { GpsTrackerHealth } from '@ash/contracts'
import { trackingPermissionStates } from '@ash/domain'

/** Approving an opening must use the latest report, including revocations after preflight. */
export function hasCurrentTrackingPermissions(health: GpsTrackerHealth | null, nowMs: number, minBuild: number): boolean {
  if (!health) return false
  if (health.readinessClient === 'browser' || health.appBuild === 0) return true
  if ((health.appBuild ?? 0) < minBuild) return false
  const heartbeatIsLatest = health.heartbeatAtMs !== null && health.heartbeatAtMs >= (health.readinessAtMs ?? 0)
  const at = heartbeatIsLatest ? health.heartbeatAtMs : health.readinessAtMs
  if (at === null || nowMs < at || nowMs - at > 120_000) return false
  const report = heartbeatIsLatest ? health : {
    permission: health.readinessPrecise ? 'precise' as const : 'denied' as const,
    locationEnabled: health.readinessLocationEnabled,
    backgroundPermission: health.readinessBackgroundPermission,
    notificationPermission: health.readinessNotificationPermission,
    batteryOptimizationExempt: health.readinessBatteryOptimizationExempt,
    autostartAcknowledged: health.readinessAutostartAcknowledged,
  }
  return Object.values(trackingPermissionStates(report)).every(value => value === true)
}

/** Opening evidence must come from a recent check using this client's permission model. */
export function hasStartTrackingReadiness(health: GpsTrackerHealth | null, nowMs: number, minBuild: number, client: 'android' | 'browser'): boolean {
  if (client === 'browser') return true
  if (!health || (health.readinessClient ?? 'android') !== client) return false
  if (health.readinessAtMs === null || nowMs < health.readinessAtMs || nowMs - health.readinessAtMs > 120_000 ||
      health.readinessCapturedAtMs === null || Math.abs(nowMs - health.readinessCapturedAtMs) > 120_000 ||
      health.readinessAccuracyM === null || health.readinessAccuracyM > 100 ||
      health.readinessPrecise !== true || health.readinessLocationEnabled !== true) return false
  if (client === 'android' && ((health.appBuild ?? 0) < minBuild || health.readinessBackgroundPermission !== true ||
      health.readinessNotificationPermission !== true || health.readinessBatteryOptimizationExempt !== true ||
      health.readinessAutostartAcknowledged !== true || health.readinessQueueAvailable !== true)) return false
  return hasCurrentTrackingPermissions(health,nowMs,minBuild)
}
