/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import {
  NO_LIVE_FILTERS,
  hoursMinutes,
  isOverTarget,
  liveCounts,
  liveElapsedMinutes,
  liveOverMinutes,
  liveTargetMinutes,
  matchesLiveFilters,
  type LiveBoardRow,
} from './live-shifts.ts'

const liveSource = readFileSync(new URL('./screens/LiveShifts.tsx', import.meta.url), 'utf8')

// 2026-09-17 12:00 Damascus.
const NOW = Date.parse('2026-09-17T09:00:00.000Z')
const row = (over: Partial<LiveBoardRow> & { id?: string }): LiveBoardRow => ({
  driverId: 'd-1',
  vehicleId: 'v-1',
  state: 'open',
  windowOpensAt: '2026-09-17T06:00:00.000Z',
  worked: { pattern: 'unknown', slot: 'day' },
  ...over,
})

describe('a running shift is measured against its slot', () => {
  it('counts elapsed whole minutes from the window start', () => {
    expect(liveElapsedMinutes('2026-09-17T06:00:00.000Z', NOW)).toBe(180)
    expect(liveElapsedMinutes('2026-09-17T08:59:30.000Z', NOW)).toBe(0)
    expect(liveElapsedMinutes('2026-09-17T10:00:00.000Z', NOW)).toBe(0)
    expect(liveElapsedMinutes(null, NOW)).toBeNull()
    expect(liveElapsedMinutes('not a date', NOW)).toBeNull()
  })

  it('uses the slot’s eight hours, because its pattern is not known until it closes', () => {
    expect(liveTargetMinutes(row({}))).toBe(480)
    expect(liveTargetMinutes(row({ worked: { pattern: 'unknown', slot: 'evening' } }))).toBe(480)
    expect(liveTargetMinutes(row({ worked: undefined }))).toBeNull()
    // Nine hours ten minutes after a 02:50 start (the evening slot's tail): over by 70 minutes —
    // not «a double in progress», which only a close can make it.
    const long = row({ windowOpensAt: '2026-09-16T23:50:00.000Z', worked: { pattern: 'unknown', slot: 'evening' } })
    expect(liveOverMinutes(long, NOW)).toBe(70)
    expect(isOverTarget(long, NOW)).toBe(true)
    expect(liveOverMinutes(row({}), NOW)).toBe(0)
    expect(isOverTarget(row({ windowOpensAt: null }), NOW)).toBe(false)
  })

  it('filters by driver, vehicle, status, slot and «over target», and counts the unfiltered board', () => {
    const rows = [
      row({ driverId: 'd-1', vehicleId: 'v-1', state: 'open' }),
      row({ driverId: 'd-2', vehicleId: 'v-2', state: 'suspended', worked: { pattern: 'unknown', slot: 'evening' } }),
      row({ driverId: 'd-3', vehicleId: 'v-3', state: 'open', windowOpensAt: '2026-09-16T20:00:00.000Z' }),
    ]
    const pick = (filters: Partial<typeof NO_LIVE_FILTERS>) =>
      rows.filter((r) => matchesLiveFilters(r, { ...NO_LIVE_FILTERS, ...filters }, NOW)).map((r) => r.driverId)
    expect(pick({})).toEqual(['d-1', 'd-2', 'd-3'])
    expect(pick({ driver: 'd-2' })).toEqual(['d-2'])
    expect(pick({ vehicle: 'v-3' })).toEqual(['d-3'])
    expect(pick({ state: 'suspended' })).toEqual(['d-2'])
    expect(pick({ slot: 'evening' })).toEqual(['d-2'])
    expect(pick({ over: true })).toEqual(['d-3'])
    expect(pick({ state: 'open', over: true, vehicle: 'v-1' })).toEqual([])
    expect(liveCounts(rows, NOW)).toEqual({ open: 2, suspended: 1, over: 1 })
  })

  it('prints hours and minutes with a fixed shape', () => {
    expect(hoursMinutes(0)).toBe('0:00')
    expect(hoursMinutes(70)).toBe('1:10')
    expect(hoursMinutes(725)).toBe('12:05')
  })
})

describe('the live board screen (P2 wiring)', () => {
  it('takes its initial filters from the link and writes them back without a history step', () => {
    expect(liveSource).toContain("const [driverFilter, setDriverFilter] = useState(initial.driver ?? '')")
    expect(liveSource).toContain("const [vehicleFilter, setVehicleFilter] = useState(initial.vehicle ?? '')")
    expect(liveSource).toContain("const [stateFilter, setStateFilter] = useState<'' | LiveStateParam>(initial.state ?? '')")
    expect(liveSource).toContain('const [onlyOver, setOnlyOver] = useState(initial.over === true)')
    expect(liveSource).toContain('sanitizeParams({ state: stateFilter, driver: driverFilter, vehicle: vehicleFilter, over: onlyOver })')
    expect(liveSource).toContain('matchesLiveFilters(row, filters, readAtMs)')
    // Still the date-independent live read.
    expect(liveSource).toContain("'/shifts?live=1'")
  })

  it('has its filter and counter copy in both languages', () => {
    for (const catalog of [ar, en]) {
      expect(catalog.liveShifts.filterVehicle.length).toBeGreaterThan(1)
      expect(catalog.liveShifts.countOver.length).toBeGreaterThan(1)
      expect(catalog.liveShifts.overBy).toContain('{t}')
      expect(catalog.liveShifts.elapsedOfTarget).toContain('{elapsed}')
    }
    expect(ar.liveShifts.countOver).toBe('تجاوزت الهدف الآن')
    expect(ar.liveShifts.stateSuspended).toBe('معلّقة')
  })
})
