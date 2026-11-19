import { describe, expect, it } from 'vitest'
import type { GpsTrackerHealth } from '@ash/contracts'
import { hasCurrentTrackingPermissions, hasStartTrackingReadiness } from '../src/tracking-start-gate.ts'

const healthy = {
  appBuild:6, readinessAtMs:100_000, readinessPrecise:true, readinessLocationEnabled:true,
  readinessBackgroundPermission:true, readinessNotificationPermission:true,
  readinessBatteryOptimizationExempt:true, readinessAutostartAcknowledged:true,
  heartbeatAtMs:100_001, permission:'precise', locationEnabled:true, backgroundPermission:true,
  notificationPermission:true, batteryOptimizationExempt:true, autostartAcknowledged:true,
} as GpsTrackerHealth

describe('latest permission gate at opening approval', () => {
  it('accepts the complete current report', () => {expect(hasCurrentTrackingPermissions(healthy,100_010,6)).toBe(true)})
  it.each(['backgroundPermission','notificationPermission','batteryOptimizationExempt','autostartAcknowledged','locationEnabled'] as const)('rejects revoked %s after successful readiness', key => {
    expect(hasCurrentTrackingPermissions({...healthy,[key]:false},100_010,6)).toBe(false)
  })
  it('rejects approximate location and stale reports', () => {
    expect(hasCurrentTrackingPermissions({...healthy,permission:'approximate'},100_010,6)).toBe(false)
    expect(hasCurrentTrackingPermissions(healthy,300_000,6)).toBe(false)
  })
  it('requires an updated native build', () => {expect(hasCurrentTrackingPermissions({...healthy,appBuild:5},100_010,6)).toBe(false)})
  it('keeps browser operations independent from location permissions', () => {
    const browser={...healthy,readinessClient:'browser' as const,appBuild:0,
      backgroundPermission:null,notificationPermission:null,batteryOptimizationExempt:null,autostartAcknowledged:null}
    expect(hasCurrentTrackingPermissions(browser,100_010,6)).toBe(true)
    expect(hasCurrentTrackingPermissions({...browser,permission:'denied'},100_010,6)).toBe(true)
    expect(hasCurrentTrackingPermissions(browser,300_000,6)).toBe(true)
  })
  it('binds the opening request to its own validated client and fresh location', () => {
    const browser={...healthy,readinessClient:'browser' as const,appBuild:0,
      readinessCapturedAtMs:100_000,readinessAccuracyM:12}
    expect(hasStartTrackingReadiness(browser,100_010,6,'browser')).toBe(true)
    expect(hasStartTrackingReadiness(browser,100_010,6,'android')).toBe(false)
    expect(hasStartTrackingReadiness({...browser,readinessAccuracyM:101},100_010,6,'browser')).toBe(true)
    expect(hasStartTrackingReadiness({...browser,readinessPrecise:false},100_010,6,'browser')).toBe(true)
    expect(hasStartTrackingReadiness(null,100_010,6,'browser')).toBe(true)
  })
  it('can continue a pending Android opening from a checked browser without treating that report as native readiness',()=>{
    const switched={...healthy,readinessClient:'android' as const,appBuild:0,
      readinessCapturedAtMs:100_000,readinessAccuracyM:12,readinessQueueAvailable:true,
      backgroundPermission:null,notificationPermission:null,batteryOptimizationExempt:null,autostartAcknowledged:null}
    expect(hasCurrentTrackingPermissions(switched,100_010,6)).toBe(true)
    expect(hasStartTrackingReadiness(switched,100_010,6,'android')).toBe(false)
  })
})
