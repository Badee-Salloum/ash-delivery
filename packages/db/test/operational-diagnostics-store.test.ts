import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), on: vi.fn(), removeListener: vi.fn(), end: vi.fn(), createPool: vi.fn() }))
vi.mock('../src/pool.ts', () => ({ createPool: fake.createPool }))
import { createOperationalDiagnosticsStore } from '../src/operational-diagnostics.ts'
beforeEach(() => {
  vi.clearAllMocks()
  fake.query.mockResolvedValue({ rows: [] })
  fake.createPool.mockReturnValue({ connect: async () => fake, end: fake.end })
})
const bucket = { minute: '2026-10-27T10:00:00Z', route: '/shifts/:id/gps', method: 'POST', status: 503,
  cause: 'lock_timeout', count: 4, durationMs: 20_000, maxDurationMs: 5_500, slowCount: 4 }
describe('isolated diagnostic storage lane', () => {
  it('bounds pool/time/retention without joining or touching financial transactions', async () => {
    const store = createOperationalDiagnosticsStore('test-only')
    await store.write([bucket])
    expect(fake.createPool).toHaveBeenCalledWith('test-only', 1, { connectionTimeoutMillis: 1_000, applicationName: 'ash-diagnostics' })
    const sql = fake.query.mock.calls.map(call => call[0]).join('\n')
    expect(sql).toContain("lock_timeout = '100ms'")
    expect(sql).toContain("statement_timeout = '1s'")
    expect(sql).toContain("interval '30 days'")
    expect(sql).toContain('LIMIT 500')
    expect(sql).not.toMatch(/journal|funds|shifts|pg_advisory/)
    expect(fake.query.mock.calls.at(-1)![0]).toBe('COMMIT')
    expect(fake.release).toHaveBeenCalledWith(false)
    await store.dispose()
    expect(fake.end).toHaveBeenCalledTimes(1)
  })

  it('rolls back a diagnostic failure and releases its connection', async () => {
    fake.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO operational_request_batches')) throw Object.assign(new Error('unavailable'), { code: '55P03' })
      return { rows: [] }
    })
    await expect(createOperationalDiagnosticsStore('test-only').write([bucket])).rejects.toMatchObject({ code: '55P03' })
    expect(fake.query.mock.calls.at(-1)![0]).toBe('ROLLBACK')
    expect(fake.release).toHaveBeenCalledTimes(1)
  })

  it('adds only expiring diagnostics in the migration; existing facts are untouched', () => {
    const sql = readFileSync(new URL('../migrations/0111_operational_request_history.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE operational_request_batches')
    expect(sql).toContain('REVOKE UPDATE, TRUNCATE')
    expect(sql).not.toMatch(/(?:UPDATE|DELETE FROM|ALTER TABLE|DROP TABLE)\s+(?:public\.)?(?:journal_entries|journal_lines|shifts|funds|audit_log)/i)
  })
})
