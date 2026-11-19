import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { type Pool, withTransaction } from '../src/pool.ts'
import { PgShiftCloseUnitOfWork } from '../src/repos-close.ts'

describe('shift transaction connection ownership', () => {
  it('reads break policy and break rows on the already-owned connection, not the exhausted pool', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT value FROM settings') ? [{ value: 90 }] : [] }))
    const release = vi.fn()
    const outerQuery = vi.fn(() => { throw new Error('would wait for a second connection') })
    const pool = { connect: vi.fn(async () => Object.assign(new EventEmitter(), { query, release })), query: outerQuery } as unknown as Pool
    const uow = new PgShiftCloseUnitOfWork(pool)
    await expect(uow.run({ shiftId: 'missing-shift', actorId: null }, async tx => Promise.all([
      tx.settings.get('shift.break_limit_minutes'), tx.breaks.listByShift('missing-shift'),
    ]))).resolves.toEqual([90, []])
    expect(outerQuery).not.toHaveBeenCalled()
    expect(pool.connect).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith("SET LOCAL lock_timeout = '5s'")
    expect(query).toHaveBeenCalledWith("SET LOCAL idle_in_transaction_session_timeout = '15s'")
    expect(query).toHaveBeenLastCalledWith('COMMIT')
    expect(release).toHaveBeenCalledWith(false)
  })

  it('destroys the connection when rollback cannot finish, retaining the original failure', async () => {
    const original = new Error('statement failed')
    const query = vi.fn(async (sql: string) => { if (sql === 'ROLLBACK') throw new Error('disconnected'); return { rows: [] } })
    const release = vi.fn()
    const pool = { connect: vi.fn(async () => Object.assign(new EventEmitter(), { query, release })) } as unknown as Pool
    await expect(withTransaction(pool, {}, async () => { throw original })).rejects.toBe(original)
    expect(release).toHaveBeenCalledWith(true)
    expect(query).not.toHaveBeenCalledWith('COMMIT')
  })

  it('handles a disconnected checked-out client without an uncaught error or committing', async () => {
    const original = Object.assign(new Error('idle transaction timeout'), { code: '25P03' })
    const query = vi.fn(async () => ({ rows: [] }))
    const release = vi.fn()
    const client = Object.assign(new EventEmitter(), { query, release })
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    await expect(withTransaction(pool, {}, async () => {
      client.emit('error', original)
      return 'must not commit'
    })).rejects.toBe(original)
    expect(release).toHaveBeenCalledWith(true)
    expect(query).not.toHaveBeenCalledWith('COMMIT')
    expect(client.listenerCount('error')).toBe(0)
  })
})
