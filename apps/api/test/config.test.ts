import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { BcryptHasher } from '../src/runtime.ts'

describe('configuration is validated at boot, not discovered at 2am', () => {
  it('applies sane defaults in development', () => {
    const c = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)
    expect(c.PORT).toBe(3000)
    expect(c.BCRYPT_ROUNDS).toBe(12) // SRS §7 mandates bcrypt; 12 is the current floor
    expect(c.BR1_SPLIT_GATE).toBe('advisory') // pilot default until BR1 is calibrated
    expect(c.TZ_OFFSET_MINUTES).toBe(180) // Asia/Damascus, UTC+3 year-round since Oct 2022
  })

  it('REFUSES to start in production without a database', () => {
    // Otherwise a misconfigured deploy silently runs against an in-memory store and every
    // shift approved that day evaporates on restart.
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/)
  })

  it('accepts a production config with a database', () => {
    const c = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y' } as NodeJS.ProcessEnv)
    expect(c.NODE_ENV).toBe('production')
  })

  it('rejects a bcrypt cost below the floor rather than quietly weakening hashing', () => {
    expect(() => loadConfig({ BCRYPT_ROUNDS: '4' } as NodeJS.ProcessEnv)).toThrow(/BCRYPT_ROUNDS/)
  })

  it('rejects an unknown split-gate value', () => {
    expect(() => loadConfig({ BR1_SPLIT_GATE: 'maybe' } as NodeJS.ProcessEnv)).toThrow(/BR1_SPLIT_GATE/)
  })

  it('names the offending variable in the error', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' } as NodeJS.ProcessEnv)).toThrow(/PORT/)
  })
})

describe('bcrypt hasher (SRS §7)', () => {
  // Cost 10 keeps the test quick; production uses 12 from config.
  const hasher = new BcryptHasher(10)

  it('round-trips a password', async () => {
    const hash = await hasher.hash('correct horse battery staple')
    expect(hash).not.toContain('correct')
    expect(await hasher.verify('correct horse battery staple', hash)).toBe(true)
    expect(await hasher.verify('wrong', hash)).toBe(false)
  })

  it('salts: the same password hashes differently every time', async () => {
    expect(await hasher.hash('same')).not.toBe(await hasher.hash('same'))
  })

  it('treats a malformed stored hash as a wrong password, not a 500', async () => {
    // A crash here would tell an attacker this account is interesting.
    expect(await hasher.verify('anything', 'not-a-bcrypt-hash')).toBe(false)
    expect(await hasher.verify('anything', '')).toBe(false)
  })
})
