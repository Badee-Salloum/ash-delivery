import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from '../src/pool.ts'
import { PgFinancialUnitOfWork } from '../src/repos-financial.ts'

type LoggedQuery = { text: string; values: unknown[] }

const fakeDatabase = (): {
  pool: Pool
  queries: LoggedQuery[]
  poolQuery: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
} => {
  const queries: LoggedQuery[] = []
  const release = vi.fn()
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      queries.push({ text, values })
      return { rows: [], rowCount: 0 }
    }),
    release,
  } as unknown as PoolClient
  const poolQuery = vi.fn(async () => {
    throw new Error('a financial transaction repository escaped to pool.query')
  })
  const pool = { connect: vi.fn(async () => client), query: poolQuery } as unknown as Pool
  return { pool, queries, poolQuery, release }
}

describe('PgFinancialUnitOfWork', () => {
  it('binds all financial repositories to one transaction after taking the retry lock', async () => {
    const db = fakeDatabase()
    const unit = new PgFinancialUnitOfWork(db.pool)

    const result = await unit.run(
      { lockKey: 'expense:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorId: 'actor-1', requestId: 'request-1' },
      async (repos) => {
        expect(await repos.expenses.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBeNull()
        expect(await repos.receivableEvents.findByIdempotencyKey('branch-1', 'receivable-1')).toBeNull()
        expect(await repos.cashCounts.find('branch-1', '2026-08-23')).toBeNull()
        expect(await repos.capitalTargets.resolve('branch-1', '2026-08-23')).toEqual({})
        expect(await repos.restorations.find('branch-1', '2026-08-23')).toBeNull()
        expect(
          await repos.ledger.post('branch-1', [], {
            shiftId: null,
            businessDate: '2026-08-23',
            postingDate: '2026-08-23',
            weekStartDate: '2026-08-23',
            fxDayId: 1,
            sypMinorPerUsd: null,
            createdBy: 'actor-1',
          }),
        ).toEqual([])
        return 'committed'
      },
    )

    expect(result).toBe('committed')
    expect(db.poolQuery).not.toHaveBeenCalled()
    expect(db.release).toHaveBeenCalledTimes(1)
    const sql = db.queries.map((query) => query.text.replace(/\s+/g, ' ').trim())
    const lock = sql.findIndex((text) => text.includes('pg_advisory_xact_lock'))
    expect(lock).toBeLessThan(sql.findIndex((text) => text.includes('FROM expenses')))
    expect(lock).toBeLessThan(sql.findIndex((text) => text.includes('FROM receivable_events')))
    expect(lock).toBeLessThan(sql.findIndex((text) => text.includes('FROM cash_counts')))
    expect(lock).toBeLessThan(sql.findIndex((text) => text.includes('FROM office_capital_targets')))
    expect(lock).toBeLessThan(sql.findIndex((text) => text.includes('FROM restorations')))
    expect(sql.at(-1)).toBe('COMMIT')
  })

  it('rolls the whole PostgreSQL transaction back when the expense callback fails', async () => {
    const db = fakeDatabase()
    const unit = new PgFinancialUnitOfWork(db.pool)
    const failure = new Error('expense row failed after journal')

    await expect(
      unit.run({ lockKey: 'expense:retry', actorId: 'actor-1' }, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)

    const sql = db.queries.map((query) => query.text.replace(/\s+/g, ' ').trim())
    expect(sql.at(-1)).toBe('ROLLBACK')
    expect(sql).not.toContain('COMMIT')
  })
})
