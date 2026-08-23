/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import {
  WORKING_NOW_POLL_MS,
  WORKING_NOW_REQUEST_TIMEOUT_MS,
  type WorkingNowSnapshot,
  startWorkingNowPolling,
} from './working-now.ts'

const dashboardSource = readFileSync(new URL('./screens/Dashboard.tsx', import.meta.url), 'utf8')

const snapshot = (drivers: number, vehicles: number): WorkingNowSnapshot => ({
  asOf: '2026-08-22T09:00:00.000Z',
  drivers,
  vehicles,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('working-now dashboard polling', () => {
  it('loads immediately and then refreshes inside the eight-second SLA', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => snapshot(2, 2))
    const onSnapshot = vi.fn()
    const stop = startWorkingNowPolling({ load, onSnapshot, onUnavailable: vi.fn() })

    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(1)
    expect(onSnapshot).toHaveBeenLastCalledWith(snapshot(2, 2))

    await vi.advanceTimersByTimeAsync(WORKING_NOW_POLL_MS - 1)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(2)

    stop()
    await vi.advanceTimersByTimeAsync(WORKING_NOW_POLL_MS)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps the last valid snapshot and marks it unavailable after a failed refresh', async () => {
    vi.useFakeTimers()
    let visible: WorkingNowSnapshot | null = null
    let unavailable = false
    const load = vi.fn()
      .mockResolvedValueOnce(snapshot(3, 2))
      .mockRejectedValueOnce(new Error('offline'))
    const stop = startWorkingNowPolling({
      load,
      onSnapshot: (next) => {
        visible = next
        unavailable = false
      },
      onUnavailable: () => {
        unavailable = true
      },
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(visible).toEqual(snapshot(3, 2))
    expect(unavailable).toBe(false)

    await vi.advanceTimersByTimeAsync(WORKING_NOW_POLL_MS)
    expect(visible).toEqual(snapshot(3, 2))
    expect(unavailable).toBe(true)
    stop()
  })

  it('suppresses a late response from the old branch when branch polling is restarted', async () => {
    vi.useFakeTimers()
    let resolveOld!: (value: WorkingNowSnapshot) => void
    const oldSnapshot = vi.fn()
    const stopOld = startWorkingNowPolling({
      load: () => new Promise((resolve) => {
        resolveOld = resolve
      }),
      onSnapshot: oldSnapshot,
      onUnavailable: vi.fn(),
    })

    stopOld()
    const newSnapshot = vi.fn()
    const stopNew = startWorkingNowPolling({
      load: async () => snapshot(7, 6),
      onSnapshot: newSnapshot,
      onUnavailable: vi.fn(),
    })
    await vi.advanceTimersByTimeAsync(0)

    resolveOld(snapshot(99, 99))
    await vi.advanceTimersByTimeAsync(0)
    expect(oldSnapshot).not.toHaveBeenCalled()
    expect(newSnapshot).toHaveBeenCalledWith(snapshot(7, 6))
    stopNew()
  })

  it('times out a stalled request, marks the count unavailable and permits the next poll', async () => {
    vi.useFakeTimers()
    const load = vi.fn(() => new Promise<WorkingNowSnapshot>(() => undefined))
    const onUnavailable = vi.fn()
    const stop = startWorkingNowPolling({ load, onSnapshot: vi.fn(), onUnavailable })

    await vi.advanceTimersByTimeAsync(WORKING_NOW_REQUEST_TIMEOUT_MS)
    expect(onUnavailable).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(WORKING_NOW_POLL_MS - WORKING_NOW_REQUEST_TIMEOUT_MS)
    expect(load).toHaveBeenCalledTimes(2)
    stop()
  })

  it('uses the lightweight endpoint and clears/restarts it when the branch changes', () => {
    const pollStart = dashboardSource.indexOf('// This poll intentionally calls only')
    const pollEnd = dashboardSource.indexOf('if (!data)', pollStart)
    const pollSource = dashboardSource.slice(pollStart, pollEnd)

    expect(pollSource).toContain("api.get<WorkingNowSnapshot>('/dashboard/working-now',")
    expect(pollSource).toContain("{ cache: 'no-store', signal }")
    expect(pollSource).not.toContain("api.get<DashboardData>('/dashboard')")
    expect(pollSource).toContain('setWorkingNow(null)')
    expect(pollSource).toContain('}, [api, branchId])')
  })
})

describe('working-now dashboard presentation', () => {
  it('has localized driver, vehicle, stale and unavailable labels', () => {
    expect(en.dashboard.workingDrivers).toBe('Drivers working now')
    expect(en.dashboard.workingVehicles).toBe('Vehicles working now')
    expect(ar.dashboard.workingDrivers).toBe('السائقون العاملون الآن')
    expect(ar.dashboard.workingVehicles).toBe('الآليات العاملة الآن')
    for (const catalog of [ar, en]) {
      expect(catalog.dashboard.workingCountsStale.length).toBeGreaterThan(10)
      expect(catalog.dashboard.workingCountsUnavailable.length).toBeGreaterThan(5)
    }
  })

  it('places both live KPIs after Orders in a responsive 2/3/6-column row', () => {
    const orders = dashboardSource.indexOf('label={t.dashboard.orders}')
    const drivers = dashboardSource.indexOf('label={t.dashboard.workingDrivers}')
    const vehicles = dashboardSource.indexOf('label={t.dashboard.workingVehicles}')
    const company = dashboardSource.indexOf('label={t.dashboard.companyShare}')

    expect(dashboardSource).toContain('grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6')
    expect(orders).toBeGreaterThan(-1)
    expect(orders).toBeLessThan(drivers)
    expect(drivers).toBeLessThan(vehicles)
    expect(vehicles).toBeLessThan(company)
    expect(dashboardSource).toContain("workingNow?.drivers ?? '—'")
    expect(dashboardSource).toContain("workingNow?.vehicles ?? '—'")
  })
})
