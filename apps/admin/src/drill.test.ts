import { describe, expect, it } from 'vitest'
import { completedShiftsHref, drill, expensesHref, liveShiftsHref, shiftHref, vehicleHref } from './drill.ts'
import { parseHash } from './route.ts'

const UUID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e'

describe('drill-down links', () => {
  it('opens completed shifts filtered by period, driver, vehicle, pattern and the two checks', () => {
    const href = completedShiftsHref({
      range: 'this_week',
      driver: UUID,
      vehicle: 'vehicle-1',
      pattern: 'full',
      short: true,
      abandoned: false,
    })
    expect(href).toBe(`#completedShifts?range=this_week&driver=${UUID}&vehicle=vehicle-1&pattern=full&short=1`)
    expect(parseHash(href)).toEqual({
      section: 'completedShifts',
      openShift: null,
      params: { range: 'this_week', driver: UUID, vehicle: 'vehicle-1', pattern: 'full', short: true },
    })
  })

  it('turns a bare date pair into a custom range, and keeps a week’s Sunday', () => {
    expect(completedShiftsHref({ from: '2026-09-01', to: '2026-09-17' })).toBe(
      '#completedShifts?range=custom&from=2026-09-01&to=2026-09-17',
    )
    expect(completedShiftsHref({ range: 'week', from: '2026-09-13' })).toBe('#completedShifts?range=week&from=2026-09-13')
    expect(completedShiftsHref()).toBe('#completedShifts')
  })

  it('never builds a link the router would refuse', () => {
    // Reversed dates, an impossible date and a hostile id are all dropped, not encoded.
    expect(completedShiftsHref({ from: '2026-09-17', to: '2026-09-01' })).toBe('#completedShifts')
    expect(completedShiftsHref({ from: '2026-02-31', to: '2026-03-01', driver: 'x"><img' })).toBe('#completedShifts')
    expect(shiftHref('not a shift id')).toBe('#dashboard')
  })

  it('opens the live board by status, driver, vehicle and «over target»', () => {
    expect(liveShiftsHref({ state: 'suspended' })).toBe('#liveShifts?state=suspended')
    expect(liveShiftsHref({ over: true, vehicle: 'vehicle-2' })).toBe('#liveShifts?vehicle=vehicle-2&over=1')
    expect(liveShiftsHref({ over: false })).toBe('#liveShifts')
    expect(parseHash(liveShiftsHref({ state: 'open', driver: UUID, over: true })).params).toEqual({
      state: 'open',
      driver: UUID,
      over: true,
    })
  })

  it('opens an expenses tab and a single shift', () => {
    expect(expensesHref({ tab: 'due' })).toBe('#expenses?tab=due')
    expect(expensesHref()).toBe('#expenses')
    expect(shiftHref(UUID)).toBe(`#shift:${UUID}`)
    expect(parseHash(shiftHref(UUID)).openShift).toBe(UUID)
  })

  it('keeps period context in expense and vehicle drill-downs', () => {
    expect(expensesHref({ from: '2026-09-01', to: '2026-09-17' })).toBe(
      '#expenses?range=custom&from=2026-09-01&to=2026-09-17',
    )
    expect(vehicleHref({ id: 'vehicle-1', from: '2026-09-01', to: '2026-09-17' })).toBe(
      '#vehicle?range=custom&from=2026-09-01&to=2026-09-17&id=vehicle-1',
    )
    expect(parseHash(vehicleHref({ id: 'vehicle-1' }))).toEqual({
      section: 'vehicle', openShift: null, params: { id: 'vehicle-1' },
    })
  })

  it('exposes the builders as one object', () => {
    expect(drill.completedShifts).toBe(completedShiftsHref)
    expect(drill.liveShifts).toBe(liveShiftsHref)
    expect(drill.expenses).toBe(expensesHref)
    expect(drill.vehicle).toBe(vehicleHref)
    expect(drill.shift).toBe(shiftHref)
  })
})
