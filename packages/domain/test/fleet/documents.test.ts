import { describe, expect, it } from 'vitest'
import {
  type AssignmentCheck,
  type VehicleState,
  alertBandFor,
  canOpenShift,
  canTransitionVehicle,
  daysUntil,
  documentStatusOn,
  shouldAlertOn,
} from '../../src/fleet/documents.ts'

const TODAY = '2026-07-21'

describe('document expiry (SRS B-1 / س37)', () => {
  it.each([
    ['2026-08-30', 'valid'],
    ['2026-08-20', 'expiring_soon'], // 30 days out
    ['2026-07-28', 'expiring_soon'],
    ['2026-07-21', 'expires_today'],
    ['2026-07-20', 'expired'],
    ['2025-01-01', 'expired'],
  ])('a document expiring %s is %s', (expiresOn, expected) => {
    expect(documentStatusOn(expiresOn, TODAY)).toBe(expected)
  })

  it('a document with no expiry never expires', () => {
    expect(documentStatusOn(null, TODAY)).toBe('no_expiry')
  })

  it('counts days across a month boundary', () => {
    expect(daysUntil('2026-08-01', '2026-07-21')).toBe(11)
    expect(daysUntil('2026-07-21', '2026-08-01')).toBe(-11)
  })

  it('fires an alert once per threshold, not every day for a month', () => {
    // A daily reminder for thirty days trains everyone to ignore the bell.
    expect(shouldAlertOn('2026-08-20', TODAY)).toBe(true) // T-30
    expect(shouldAlertOn('2026-08-04', TODAY)).toBe(true) // T-14
    expect(shouldAlertOn('2026-07-28', TODAY)).toBe(true) // T-7
    expect(shouldAlertOn('2026-07-21', TODAY)).toBe(true) // T-0
    expect(shouldAlertOn('2026-08-19', TODAY)).toBe(false) // T-29, silent
    expect(shouldAlertOn('2026-07-25', TODAY)).toBe(false) // T-4, silent
  })

  it('does not alert for a document with no expiry', () => {
    expect(shouldAlertOn(null, TODAY)).toBe(false)
  })

  it('names a STABLE band per threshold, so an on-view sweep rings once per band, not daily', () => {
    // Unlike shouldAlertOn (exact-day), alertBandFor holds steady across the whole band — the key
    // the bell dedupes on. Two dates in the same band share a band id; crossing a threshold changes it.
    expect(alertBandFor('2026-08-15', TODAY)).toBe('t-30') // 25 days out → within 30
    expect(alertBandFor('2026-08-10', TODAY)).toBe('t-30') // 20 days out → still t-30 (stable)
    expect(alertBandFor('2026-08-01', TODAY)).toBe('t-14') // 11 days out → within 14
    expect(alertBandFor('2026-07-26', TODAY)).toBe('t-7') // 5 days out → within 7
    expect(alertBandFor('2026-07-21', TODAY)).toBe('t-0') // today
    expect(alertBandFor('2026-07-19', TODAY)).toBe('expired')
  })

  it('has no band before the first threshold, or with no expiry', () => {
    expect(alertBandFor('2026-09-30', TODAY)).toBeNull() // 71 days out — nothing crossed yet
    expect(alertBandFor(null, TODAY)).toBeNull()
  })
})

describe('vehicle state (SRS B-2 / س66)', () => {
  it.each([
    ['ready', 'charging', true],
    ['ready', 'maintenance', true],
    ['charging', 'ready', true],
    ['maintenance', 'ready', true],
    ['stopped', 'ready', true],
    ['ready', 'ready', false],
    ['maintenance', 'charging', false],
  ])('%s → %s is %s', (from, to, expected) => {
    expect(canTransitionVehicle(from as VehicleState, to as VehicleState)).toBe(expected)
  })
})

describe('the mandatory driver ↔ vehicle ↔ shift binding (SRS B-3 / س34)', () => {
  const ok = (over: Partial<AssignmentCheck> = {}): AssignmentCheck => ({
    vehicleState: 'ready',
    driverDocumentStatuses: ['valid', 'valid', 'valid'],
    vehicleDocumentStatuses: ['valid'],
    driverAlreadyLive: false,
    vehicleAlreadyLive: false,
    driverActive: true,
    vehicleActive: true,
    ...over,
  })

  it('allows a clean assignment', () => {
    expect(canOpenShift(ok())).toEqual({ ok: true, blockers: [] })
  })

  it('blocks a vehicle that is not ready', () => {
    for (const state of ['charging', 'maintenance', 'stopped'] as VehicleState[]) {
      expect(canOpenShift(ok({ vehicleState: state })).blockers).toContain('vehicle_not_ready')
    }
  })

  it('blocks an expired driving licence but tolerates one merely expiring', () => {
    expect(canOpenShift(ok({ driverDocumentStatuses: ['expired'] })).blockers).toContain('driver_document_expired')
    expect(canOpenShift(ok({ driverDocumentStatuses: ['expiring_soon'] })).ok).toBe(true)
  })

  it('blocks an expired vehicle document', () => {
    expect(canOpenShift(ok({ vehicleDocumentStatuses: ['expired'] })).blockers).toContain('vehicle_document_expired')
  })

  it('blocks a driver or vehicle already on a live shift', () => {
    expect(canOpenShift(ok({ driverAlreadyLive: true })).blockers).toContain('driver_already_on_shift')
    expect(canOpenShift(ok({ vehicleAlreadyLive: true })).blockers).toContain('vehicle_already_on_shift')
  })

  it('blocks an inactive driver or vehicle', () => {
    expect(canOpenShift(ok({ driverActive: false })).blockers).toContain('driver_inactive')
    expect(canOpenShift(ok({ vehicleActive: false })).blockers).toContain('vehicle_inactive')
  })

  it('reports every blocker at once', () => {
    const result = canOpenShift(
      ok({
        vehicleState: 'maintenance',
        driverDocumentStatuses: ['expired'],
        driverAlreadyLive: true,
      }),
    )
    expect(result.blockers).toHaveLength(3)
    expect(result.ok).toBe(false)
  })
})
