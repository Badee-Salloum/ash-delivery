import { describe, expect, it, vi } from 'vitest'
import { minor, type Posting } from '@ash/domain'
import { bindPoolToTransaction, type Pool, type PoolClient } from '../src/pool.ts'
import { PgLedgerRepo } from '../src/repos.ts'

export const batchMeta = { shiftId: null, businessDate: '2026-10-27', postingDate: '2026-10-27',
  weekStartDate: '2026-10-25', fxDayId: 1, createdBy: '22222222-2222-4222-8222-222222222222',
  sypMinorPerUsd: null } as const
export const batchPosting = (key: string, amount = 9007199254740993n): Posting => ({
  eventType: 'manual', occurrenceKey: key, lines: [
    { fund: { kind: 'office_cash' }, side: 'D', amount: minor(amount) },
    { fund: { kind: 'office_wallet' }, side: 'C', amount: minor(amount) },
  ],
})

describe('ledger batched transport', () => {
  it('writes 65 journals/130 exact lines with five financial SQL calls, preserving input order', async () => {
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('INSERT INTO journal_entries')) return { rows: JSON.parse(values[11] as string)
        .map((p: { event_type: string; occurrence_key: string }, i: number) => ({ ...p, id: String(i + 1), created_at: new Date(0) })).reverse() }
      if (sql.includes('INSERT INTO funds')) return { rows: JSON.parse(values[1] as string)
        .map((f: { code: string; currency: string }, i: number) => ({ ...f, id: String(i + 1) })) }
      return { rows: [] }
    })
    const client = { query } as unknown as PoolClient
    const repo = new PgLedgerRepo(bindPoolToTransaction({} as Pool, client, { actorId: batchMeta.createdBy }))
    const postings = Array.from({ length: 65 }, (_, i) => batchPosting(`item:${i}`))
    const result = await repo.post('11111111-1111-4111-8111-111111111111', postings, batchMeta)
    expect(result.map(row => row.occurrenceKey)).toEqual(postings.map(row => row.occurrenceKey))
    expect(query).toHaveBeenCalledTimes(5)
    const stored = JSON.parse(query.mock.calls.find(([sql]) => sql.includes('INSERT INTO journal_lines'))![1]![0] as string)
    expect(stored).toHaveLength(130)
    expect(stored[0].amount_minor).toBe('9007199254740993')
    expect(result[0]?.lines[0]?.amount).toBe(9007199254740993n)
  })

  it('skips replayed headers and duplicate identities without creating funds or lines for them', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('INSERT INTO journal_entries')
      ? { rows: [{ event_type: 'manual', occurrence_key: 'fresh', id: '9', created_at: new Date(0) }] }
      : sql.startsWith('SELECT id, code, currency FROM funds')
        ? { rows: [{ id: '1', code: 'office_cash', currency: 'SYP_NEW' }, { id: '2', code: 'office_wallet', currency: 'SYP_NEW' }] }
        : { rows: [] })
    const repo = new PgLedgerRepo(bindPoolToTransaction({} as Pool, { query } as unknown as PoolClient))
    const result = await repo.post('branch', [batchPosting('old'), batchPosting('fresh'), batchPosting('fresh')], batchMeta)
    expect(result.map(row => row.id)).toEqual([9])
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO journal_lines'))).toHaveLength(1)
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO funds'))).toBe(false)
  })

  it('rejects an unbalanced batch before checking out a connection', async () => {
    const connect = vi.fn()
    const good = batchPosting('bad')
    const invalid = { ...good, lines: good.lines.map((line, i) => i === 0 ? { ...line, amount: minor(1n) } : line) }
    await expect(new PgLedgerRepo({ connect } as unknown as Pool).post('branch', [invalid], batchMeta)).rejects.toThrow('unbalanced')
    expect(connect).not.toHaveBeenCalled()
  })

  it('refuses a wrong stored currency instead of reusing the fund', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('INSERT INTO journal_entries')
      ? { rows: [{ event_type: 'manual', occurrence_key: 'new', id: '9', created_at: new Date(0) }] }
      : { rows: [{ id: '1', code: 'office_cash', currency: 'USD' }] })
    const repo = new PgLedgerRepo(bindPoolToTransaction({} as Pool, { query } as unknown as PoolClient))
    await expect(repo.post('branch', [batchPosting('new')], batchMeta)).rejects.toThrow('fund_currency_mismatch')
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO journal_lines'))).toBe(false)
  })
})
