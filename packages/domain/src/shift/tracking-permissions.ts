export interface TrackingPermissionReport {
  permission: 'precise' | 'approximate' | 'denied' | 'unknown' | null
  locationEnabled: boolean | null
  backgroundPermission: boolean | null
  notificationPermission: boolean | null
  batteryOptimizationExempt: boolean | null
  autostartAcknowledged: boolean | null
}

export function trackingPermissionStates(report: TrackingPermissionReport) {
  return {
    location: report.permission === null || report.permission === 'unknown' ? null : report.permission === 'precise',
    location_enabled: report.locationEnabled,
    background: report.backgroundPermission,
    notifications: report.notificationPermission,
    battery: report.batteryOptimizationExempt,
    autostart: report.autostartAcknowledged,
  }
}
