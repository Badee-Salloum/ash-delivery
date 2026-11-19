// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ar } from '@ash/client/i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({
  probe: vi.fn(), readiness: vi.fn(), status: vi.fn(), setup: vi.fn(), sync: vi.fn(),
  shiftState: vi.fn(), put: vi.fn(), opened: vi.fn(), approved: vi.fn(), toast: vi.fn(),
}))
vi.mock('../src/app-context.tsx', async () => {
  const { ar } = await import('@ash/client/i18n')
  return { useApp: () => ({ t: ar, lang: 'ar', api: {
    shiftState: f.shiftState, put: f.put, confirmGpsReadiness: f.readiness,
  } }) }
})
vi.mock('../src/feedback.tsx', () => ({ useToast: () => ({ error: f.toast }) }))
vi.mock('../src/screens/PhotoSlot.tsx', () => ({ PhotoSlot: () => null }))
vi.mock('../src/screens/BatteryPanel.tsx', () => ({ BatteryPanel: () => null, restorePacks: () => ({}) }))
vi.mock('../src/native-tracker.ts', () => ({
  nativeTrackerAvailable: () => true, preflightNativeTracker: f.probe, nativeTrackerStatus: f.status,
  setupNativeTrackingReliability: f.setup, syncNativeTracking: f.sync,
  openNativeTrackingSettings: vi.fn(), acknowledgeNativeAutostart: vi.fn(),
}))
import { StartPackage } from '../src/screens/Shift.tsx'

let host: HTMLDivElement, root: Root
const valid = (capturedAtMs: number) => ({ ready: true, capturedAtMs, accuracyM: 12, nativeVersionCode: 4,
  backgroundPermission: true, notificationPermission: true, batteryOptimizationExempt: true,
  autostartGuidanceRequired: false, autostartAcknowledged: true })
const refusal = { status: 422, error: 'gps_fix_not_fresh', detail: { reason: 'future', ageMs: -12_000 } }
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent === text)!
beforeEach(async () => {
  vi.clearAllMocks()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  f.shiftState.mockResolvedValue({ state: 'draft' })
  f.setup.mockResolvedValue({ precisePermission: true, locationEnabled: true, backgroundPermission: true,
    notificationPermission: true, batteryOptimizationExempt: true })
  f.probe.mockReset().mockResolvedValue(valid(200))
  f.readiness.mockReset().mockResolvedValue({ ready: true })
  f.status.mockResolvedValue({ queueAvailable: true, serviceRunning: true, activeShiftId: 'shift-test',
    permissionState: 'precise', locationEnabled: true, backgroundPermission: true,
    notificationPermission: true, batteryOptimizationExempt: true })
  f.sync.mockResolvedValue({ started: true })
  f.put.mockResolvedValue({ id: 'shift-test', state: 'awaiting_open_approval', businessDate: '2026-11-01',
    startPackage: { odometerKm: 1683, floatTotal: '0.00', topupTotal: '0.00' } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<StartPackage assignment={{ driverId: 'driver', vehicleId: 'vehicle' }}
    batteries={[]} chargeReadingSource="bms" existingShiftId="shift-test" awaiting={false}
    restore={{ odometerKm: 1683, mediaSlots: ['odometer'], batteries: [] }}
    onOpened={f.opened} onApproved={f.approved} />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('start screen GPS recovery', () => {
  it('automatically requests a new point and continues only after the server accepts it', async () => {
    f.probe.mockResolvedValueOnce(valid(100)).mockResolvedValueOnce(valid(200))
    f.readiness.mockRejectedValueOnce(refusal).mockResolvedValueOnce({ ready: true })
    await act(async () => button(ar.shift.confirmStart).click())
    expect(f.probe.mock.calls).toEqual([[{ forceFresh: false }], [{ forceFresh: true }]])
    expect(f.readiness).toHaveBeenCalledTimes(2)
    expect(f.put).toHaveBeenCalledTimes(1)
    expect(f.opened).toHaveBeenCalledWith('shift-test')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows the server time difference, stays blocked on focus, and clears only after a successful recheck', async () => {
    f.probe.mockResolvedValueOnce(valid(100)).mockResolvedValueOnce(valid(200))
    f.readiness.mockRejectedValueOnce(refusal).mockRejectedValueOnce(refusal)
    await act(async () => button(ar.shift.confirmStart).click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('متقدّم على وقت الخادم بـ12 ثانية')
    expect(button(ar.shift.confirmStart).disabled).toBe(true)
    expect(f.put).not.toHaveBeenCalled()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(button(ar.shift.confirmStart).disabled).toBe(true)
    f.probe.mockResolvedValueOnce(valid(300))
    f.readiness.mockResolvedValueOnce({ ready: true })
    await act(async () => button(ar.gpsTracking.retry).click())
    expect(f.probe.mock.calls.at(-1)).toEqual([{ forceFresh: true }])
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(button(ar.shift.confirmStart).disabled).toBe(false)
    expect(f.put).not.toHaveBeenCalled()
    expect(f.opened).not.toHaveBeenCalled()
  })

  it('rechecks permissions on the fresh point and never submits when background access was lost', async () => {
    f.probe.mockResolvedValueOnce(valid(100)).mockResolvedValueOnce({ ...valid(200), backgroundPermission: false })
    f.readiness.mockRejectedValueOnce(refusal)
    await act(async () => button(ar.shift.confirmStart).click())
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(ar.gpsTracking.background_permission_required)
    expect(f.readiness).toHaveBeenCalledTimes(1)
    expect(f.sync).not.toHaveBeenCalled()
    expect(f.put).not.toHaveBeenCalled()
  })

  it('clears the refreshing message into an actionable network failure rather than leaving a stuck spinner', async () => {
    f.probe.mockResolvedValueOnce(valid(100)).mockResolvedValueOnce(valid(200))
    f.readiness.mockRejectedValueOnce(refusal).mockRejectedValueOnce({ status: 503, error: 'database_busy' })
    await act(async () => button(ar.shift.confirmStart).click())
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(ar.gpsTracking.readinessCheckFailed)
    expect(button(ar.gpsTracking.retry).disabled).toBe(false)
    expect(f.put).not.toHaveBeenCalled()
  })
})
