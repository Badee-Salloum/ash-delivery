import { describe, expect, it, vi } from 'vitest'
import { bindPoolToTransaction, type Pool, type PoolClient, withTransaction } from '../src/pool.ts'
import { PgShiftCloseUnitOfWork } from '../src/repos-close.ts'

type LoggedQuery = { text: string; values: unknown[] }

function fakeDatabase(identity: { driver_id: string; business_date: string } | null = {
  driver_id: 'driver-1',
  business_date: '2026-08-14',
}): {
  pool: Pool
  client: PoolClient
  queries: LoggedQuery[]
  connect: ReturnType<typeof vi.fn>
  poolQuery: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
} {
  const queries: LoggedQuery[] = []
  const release = vi.fn()
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      queries.push({ text, values })
      return text.includes("to_char(business_date, 'YYYY-MM-DD')")
        ? { rows: identity === null ? [] : [identity], rowCount: identity === null ? 0 : 1 }
        : { rows: [], rowCount: 0 }
    }),
    release,
  } as unknown as PoolClient
  const connect = vi.fn(async () => client)
  const poolQuery = vi.fn(async () => {
    throw new Error('a transaction-bound repository escaped to pool.query')
  })
  const pool = { connect, query: poolQuery } as unknown as Pool
  return { pool, client, queries, connect, poolQuery, release }
}

describe('transaction-bound pool', () => {
  it('routes direct queries and nested repository transactions to the owning client', async () => {
    const db = fakeDatabase()

    await withTransaction(db.pool, { actorId: 'actor-1', requestId: 'request-1' }, async (client) => {
      const bound = bindPoolToTransaction(db.pool, client, {
        actorId: 'actor-1',
        requestId: 'request-1',
      })
      await bound.query('SELECT direct')
      await withTransaction(bound, { actorId: 'actor-1' }, async (nested) => {
        expect(nested).toBe(client)
        await nested.query('SELECT nested')
      })
    })

    expect(db.connect).toHaveBeenCalledTimes(1)
    expect(db.poolQuery).not.toHaveBeenCalled()
    expect(db.release).toHaveBeenCalledTimes(1)
    expect(db.queries.map((query) => query.text)).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
      'SELECT set_config($1, $2, true)',
      'SELECT direct',
      'SELECT nested',
      'COMMIT',
    ])
  })
})

describe('PgShiftCloseUnitOfWork', () => {
  it('locks driver/day before the target and keeps all repositories on one transaction', async () => {
    const db = fakeDatabase()
    const unit = new PgShiftCloseUnitOfWork(db.pool)

    const result = await unit.run(
      {
        shiftId: 'shift-1',
        actorId: 'actor-1',
        requestId: 'request-1',
        serializeDriverDay: true,
      },
      async (repos) => {
        // A direct-read repository and one whose write method normally opens its own transaction
        // both have to stay on the outer client.
        expect(await repos.orders.listByShift('shift-1')).toEqual([])
        expect(
          await repos.ledger.post('branch-1', [], {
            shiftId: 'shift-1',
            businessDate: '2026-08-14',
            postingDate: '2026-08-14',
            weekStartDate: '2026-08-09',
            fxDayId: 1,
            createdBy: 'actor-1',
          }),
        ).toEqual([])
        return 'committed'
      },
    )

    expect(result).toBe('committed')
    expect(db.connect).toHaveBeenCalledTimes(1)
    expect(db.poolQuery).not.toHaveBeenCalled()
    expect(db.release).toHaveBeenCalledTimes(1)

    const sql = db.queries.map((query) => query.text.replace(/\s+/g, ' ').trim())
    const advisory = sql.findIndex((text) => text.includes('pg_advisory_xact_lock'))
    const target = sql.findIndex((text) => text.includes('FROM shifts') && text.includes('FOR UPDATE'))
    const orders = sql.findIndex((text) => text.startsWith('SELECT id FROM shift_orders'))
    const deductions = sql.findIndex((text) => text.startsWith('SELECT id FROM cash_deductions'))
    const movements = sql.findIndex((text) => text.startsWith('SELECT id FROM shift_wallet_movements'))

    expect(advisory).toBeGreaterThan(-1)
    expect(target).toBeGreaterThan(advisory)
    expect(orders).toBeGreaterThan(target)
    expect(deductions).toBeGreaterThan(orders)
    expect(movements).toBeGreaterThan(deductions)
    expect(sql.at(-1)).toBe('COMMIT')
  })

  it('lets the callback map a missing shift without taking unrelated locks', async () => {
    const db = fakeDatabase(null)
    const unit = new PgShiftCloseUnitOfWork(db.pool)

    const found = await unit.run(
      { shiftId: 'missing', actorId: 'actor-1', serializeDriverDay: true },
      async (repos) => repos.shifts.findById('missing'),
    )

    expect(found).toBeNull()
    const sql = db.queries.map((query) => query.text.replace(/\s+/g, ' ').trim())
    expect(sql.some((text) => text.includes('pg_advisory_xact_lock'))).toBe(false)
    expect(sql.some((text) => text.includes('FOR UPDATE'))).toBe(false)
    expect(sql.at(-1)).toBe('COMMIT')
  })
})
