import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { BufferedOperationalDiagnostics, databaseFailureCause, installOperationalDiagnostics } from '../src/operational-diagnostics.ts'

describe('30-day diagnostic collection', () => {
  it('lets the serverless bridge await a started write without flushing healthy request tails', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const write = vi.fn().mockReturnValue(gate)
    const sink = new BufferedOperationalDiagnostics(write)
    const sample = { route: '/health', method: 'GET', status: 200, cause: 'none', durationMs: 1 }
    await sink.record(sample)
    await sink.settled()
    expect(write).not.toHaveBeenCalled()
    const recording = sink.record({ ...sample, status: 503, cause: 'lock_timeout' })
    let completed = false
    const waiting = sink.settled().then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    release()
    await Promise.all([recording, waiting])
    expect(completed).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
  })
  it('aggregates successes, flushes errors and never stores URL queries, bodies or identity', async () => {
    let now = Date.parse('2026-10-27T10:00:00Z')
    const write = vi.fn().mockResolvedValue(undefined)
    const sink = new BufferedOperationalDiagnostics(write, () => now)
    const app = Fastify()
    installOperationalDiagnostics(app, sink)
    app.get('/shifts/:id/gps', async () => ({ ok: true }))
    app.get('/failure', async () => { throw Object.assign(new Error('private database detail'), { code: '55P03' }) })
    await app.inject('/shifts/private-user/gps?token=secret&lat=33.1')
    await app.inject('/shifts/another-user/gps?token=other')
    expect(write).not.toHaveBeenCalled()
    now += 10
    await app.inject('/failure')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: '/shifts/:id/gps', count: 2, status: 200 }),
      expect.objectContaining({ route: '/failure', count: 1, status: 500, cause: 'lock_timeout' }),
    ]))
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/secret|private|another-user|lat=|33\.1|database detail/)
    await app.close()
  })

  it('contains a diagnostic outage, backs off and never replays uncertain increments', async () => {
    let now = 0
    const warn = vi.fn(), write = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined)
    const sink = new BufferedOperationalDiagnostics(write, () => now, warn)
    const sample = { route: '/health', method: 'GET', status: 503, cause: 'connection_timeout', durationMs: 8_400 }
    await sink.record(sample)
    await sink.record(sample)
    expect(write).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    now = 60_000
    await sink.record(sample)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]![0].reduce((sum: number, b: {count: number}) => sum + b.count, 0)).toBe(2)
  })

  it('coalesces an error storm instead of adding a database write to every failed request', async () => {
    let now = 0
    const write = vi.fn().mockResolvedValue(undefined)
    const sink = new BufferedOperationalDiagnostics(write, () => now)
    const sample = { route: '/shifts/:id/gps', method: 'POST', status: 503, cause: 'lock_timeout', durationMs: 5_000 }
    for (let i = 0; i < 100; i++) await sink.record(sample)
    expect(write).toHaveBeenCalledTimes(1)
    now = 5_000
    await sink.record(sample)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]![0][0].count).toBe(100)
  })

  it('uses the registered catch-all route rather than an untrusted URL', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const app = Fastify(), sink = new BufferedOperationalDiagnostics(write)
    installOperationalDiagnostics(app, sink)
    app.get('/fixed', async (_request, reply) => reply.code(401).send({ error: 'no_session' }))
    app.post('/auth/login', async (_request, reply) => reply.code(401).send({ error: 'invalid_credentials' }))
    await app.inject('/fixed?password=secret')
    await app.inject('/unknown-private-identifier')
    await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'private-login', password: 'secret' } })
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/secret|private-identifier|password/)
    await app.close()
    expect(write.mock.calls.flatMap(call => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: '/auth/login', cause: 'login_rejected' }),
    ]))
  })

  it.each([
    [{ code: '55P03' }, 'lock_timeout'], [{ code: '53300' }, 'connections_exhausted'],
    [{ code: '23503', message: 'secret' }, 'constraint_23503'],
    [{ message: 'timeout exceeded when trying to connect' }, 'connection_timeout'],
    [null, 'application'],
  ])('classifies failures without retaining their messages', (error, cause) => {
    expect(databaseFailureCause(error)).toBe(cause)
  })
})
