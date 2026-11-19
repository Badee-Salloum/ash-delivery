import { describe, expect, it } from 'vitest'
import { isDatabaseUnavailable } from '../src/database-availability.ts'
import { makeHarness } from './harness.ts'

describe('database availability failures', () => {
  it('keeps integrity and authentication errors distinct from database timeouts', () => {
    for (const code of ['55P03', '57014', '25P03', '53300', '57P01', '08006']) expect(isDatabaseUnavailable({ code })).toBe(true)
    expect(isDatabaseUnavailable(new Error('timeout exceeded when trying to connect'))).toBe(true)
    for (const code of ['23505', '42501', '25006', 'invalid_credentials']) expect(isDatabaseUnavailable({ code })).toBe(false)
  })
  it('returns a temporary server failure on login, not a bad-password response', async () => {
    const h = await makeHarness()
    try {
      h.deps.users.findByUsername = async () => { throw Object.assign(new Error('lock timeout'), { code: '55P03' }) }
      const response = await h.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'driver1', password: 'unused' } })
      expect(response.statusCode).toBe(503)
      expect(response.json().error).toBe('database_busy')
      expect(response.headers['retry-after']).toBe('5')
    } finally { await h.app.close() }
  })
})
