import { describe, expect, it, vi } from 'vitest'
import { PgGpsTrackerHealthRepo } from '../src/repos-gps-health.ts'
import type { Pool } from '../src/pool.ts'

describe('GPS timing event persistence', () => {
  it('uses a bounded transaction with only a coordinate-free diagnostic insert', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const client = { query, release: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    const pool = { connect: async () => client } as unknown as Pool
    await new PgGpsTrackerHealthRepo(pool).recordReadinessTimingRejection({
      shiftId: 'test-shift', atMs: 100_000, capturedAtMs: 110_000, ageMs: -10_000, reason: 'future', appBuild: 4,
    })
    const insert = query.mock.calls.find(call => String(call[0]).includes('INSERT INTO gps_tracker_health_events'))!
    expect(insert[1][0]).toBe('test-shift')
    expect(JSON.parse(insert[1][2])).toEqual({ reason: 'future', serverTimeMs: 100_000, capturedAtMs: 110_000,
      ageMs: -10_000, appBuild: 4, maxAgeMs: 30_000, maxFutureSkewMs: 5_000 })
    const sql = query.mock.calls.map(call => call[0]).join('\n')
    expect(sql).toContain("lock_timeout = '100ms'")
    expect(sql).toContain("statement_timeout = '1s'")
    expect(sql).not.toMatch(/(?:UPDATE|DELETE|INSERT INTO)\s+(?:shifts|journal_entries|journal_lines|funds|gps_tracker_health)\b/)
    expect(insert[1][2]).not.toMatch(/latitude|longitude|lat|lng|token|cookie/)
    expect(query.mock.calls.at(-1)![0]).toBe('COMMIT')
  })
})
