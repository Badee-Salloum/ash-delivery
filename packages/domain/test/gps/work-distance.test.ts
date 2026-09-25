import { describe, expect, it } from 'vitest'
import { workDistance, workDistanceForRange, type WorkPing } from '../../src/gps/work-distance.ts'

const minute = 60_000
const ping = (atMinute: number, lng = 36.3, accuracyM: number | null = 10): WorkPing => ({
  lat: 33.5, lng, accuracyM, capturedAtMs: atMinute * minute,
})
const measure = (pings: WorkPing[], breaks: Array<{ startedAtMs: number; endedAtMs: number | null }> = []) =>
  workDistance({ pings, breaks, windowOpensAtMs: 0, submittedAtMs: 20 * minute, asOfMs: 30 * minute })

describe('GPS work distance', () => {
  it('excludes break and post-close motion without joining across boundaries', () => {
    const result = measure([
      ping(0), ping(1, 36.301), ping(2, 36.302),
      ping(5, 36.303), ping(8, 36.304), ping(9, 36.305),
      ping(19, 36.306), ping(20, 36.307), ping(21, 36.308),
    ], [{ startedAtMs: 3 * minute, endedAtMs: 7 * minute }])
    expect(result.phases).toEqual(['work', 'work', 'work', 'break', 'work', 'work', 'work', 'after_close', 'after_close'])
    expect(result.validEdgeCount).toBe(3)
    expect(result.distanceMetres).toBeGreaterThan(0)
    expect(result.edgeMetres[4]).toBeNull() // break -> resumed work
    expect(result.edgeMetres[7]).toBeNull() // close boundary
    expect(workDistanceForRange(result, 0, 3)).toBeGreaterThan(0)
    expect(workDistanceForRange(result, 3, 5)).toBeNull()
    expect(result.workDurationMs).toBe(16 * minute)
  })

  it('rejects impossible speed, long outages and inaccurate fixes', () => {
    const result = measure([
      ping(0), ping(1, 36.31), // ~930 metres/minute: valid
      ping(2, 36.4), // impossible jump
      ping(8, 36.401), // >5 minute gap
      ping(9, 36.402, 101), // poor fix
      ping(10, 36.403), // poor previous fix
    ])
    expect(result.validEdgeCount).toBe(1)
    expect(result.coveragePercent).toBe(5)
  })

  it('accepts the exact five-minute and 100-metre limits, then rejects values beyond them', () => {
    const exact = measure([ping(0, 36.3, 100), ping(5, 36.301, 100)])
    expect(exact.validEdgeCount).toBe(1)
    const late = measure([ping(0, 36.3, 100), { ...ping(5, 36.301, 100), capturedAtMs: 5 * minute + 1 }])
    expect(late.distanceMetres).toBeNull()
    const inaccurate = measure([ping(0, 36.3, 100), ping(5, 36.301, 100.01)])
    expect(inaccurate.distanceMetres).toBeNull()
  })

  it('distinguishes no usable edge from a stationary but valid edge', () => {
    expect(measure([ping(0)]).distanceMetres).toBeNull()
    expect(measure([ping(0), ping(1)]).distanceMetres).toBe(0)
    expect(measure([ping(0), ping(10)]).coveragePercent).toBe(0)
  })

  it('excludes a currently open break from elapsed work and coverage', () => {
    const result = workDistance({
      pings: [ping(0), ping(1), ping(4), ping(9)],
      breaks: [{ startedAtMs: 5 * minute, endedAtMs: null }],
      windowOpensAtMs: 0,
      submittedAtMs: null,
      asOfMs: 15 * minute,
    })
    expect(result.workDurationMs).toBe(5 * minute)
    expect(result.phases.at(-1)).toBe('break')
    expect(result.coveragePercent).toBe(80)
  })
})
