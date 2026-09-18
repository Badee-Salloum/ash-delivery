/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { parseHash } from './route.ts'

const app = readFileSync(new URL('./AdminApp.tsx', import.meta.url), 'utf8')
const screen = readFileSync(new URL('./screens/VehicleHistory.tsx', import.meta.url), 'utf8')
const fleet = readFileSync(new URL('./screens/Fleet.tsx', import.meta.url), 'utf8')
const bike = readFileSync(new URL('./screens/fleet/BikeCard.tsx', import.meta.url), 'utf8')

describe('P6 vehicle history screen', () => {
  it('routes a bike-card drill into the dedicated range-aware screen', () => {
    expect(parseHash('#vehicle?range=custom&from=2026-09-01&to=2026-09-17&id=vehicle-1')).toEqual({
      section: 'vehicle',
      openShift: null,
      params: { range: 'custom', from: '2026-09-01', to: '2026-09-17', id: 'vehicle-1' },
    })
    expect(app).toContain("section === 'vehicle'")
    expect(app).toContain('<VehicleHistory key={mountKey} initial={liveParams.current}')
    expect(fleet).toContain('location.hash = drill.vehicle({ id })')
    expect(bike).toContain('{t.fleet.fullHistory}')
  })

  it('loads one bounded history and presents shifts, expenses and life-log events', () => {
    expect(screen).toContain('<TimeRangeBar')
    expect(screen).toContain('/history?from=')
    expect(screen).toContain('useDashboardRead<VehicleHistoryResponse>')
    expect(screen).toContain('data.shifts.map')
    expect(screen).toContain('data.expenses.map')
    expect(screen).toContain('data.events.map')
    expect(screen).toContain("'asset' in data")
  })

  it('keeps new labels in Arabic/English parity', () => {
    expect(ar.fleet.fullHistory).toBe('السجل الكامل')
    expect(en.fleet.fullHistory).toBe('Full history')
    for (const catalog of [ar, en]) {
      expect(catalog.vehicleHistory.title.length).toBeGreaterThan(5)
      expect(catalog.vehicleHistory.shiftHistory.length).toBeGreaterThan(5)
      expect(catalog.vehicleHistory.vehicleExpenses.length).toBeGreaterThan(5)
    }
  })
})
