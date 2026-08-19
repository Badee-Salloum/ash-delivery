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

  it('refuses BLOB_DRIVER=vercel without the token — the misconfig would 500 on first upload', () => {
    expect(() => loadConfig({ BLOB_DRIVER: 'vercel' } as NodeJS.ProcessEnv)).toThrow(/BLOB_READ_WRITE_TOKEN/)
  })

  it('accepts BLOB_DRIVER=vercel when the token is present', () => {
    const c = loadConfig({ BLOB_DRIVER: 'vercel', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' } as NodeJS.ProcessEnv)
    expect(c.BLOB_DRIVER).toBe('vercel')
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

describe('the cloud OCR reader is configured, not assumed', () => {
  // Until this suite existed, NOTHING covered the OCR config: not the key guard, not the model
  // defaults. A model default that no test pins is a default that drifts, and the model is the
  // one setting that decides how often a wrong number lands in the ledger.
  it('defaults to the kill switch, so a deploy that forgets the env var degrades instead of erroring', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv)
    expect(c.OCR_DRIVER).toBe('none')
  })

  it('pins the measured model for each provider', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv)
    expect(c.OPENAI_OCR_MODEL).toBe('gpt-5.4')
    expect(c.OPENROUTER_OCR_MODEL).toBe('google/gemini-3.7-flash')
    // Effort and verbosity are a matched pair with the model; `default` omits both fields.
    expect(c.OPENAI_OCR_EFFORT).toBe('default')
    expect(c.OPENAI_OCR_VERBOSITY).toBe('default')
  })

  it('refuses each driver without its OWN key, naming the variable an operator must set', () => {
    // Naming the right variable matters: the two providers use different keys, and a boot error
    // that names the wrong one sends whoever is on call to the wrong place.
    expect(() => loadConfig({ OCR_DRIVER: 'openai' } as NodeJS.ProcessEnv)).toThrow(/OPENAI_API_KEY/)
    expect(() => loadConfig({ OCR_DRIVER: 'openrouter' } as NodeJS.ProcessEnv)).toThrow(/OPENROUTER_API_KEY/)
  })

  it('accepts each driver with its own key', () => {
    expect(loadConfig({ OCR_DRIVER: 'openai', OPENAI_API_KEY: 'sk-x' } as NodeJS.ProcessEnv).OCR_DRIVER).toBe('openai')
    expect(
      loadConfig({ OCR_DRIVER: 'openrouter', OPENROUTER_API_KEY: 'sk-or-x' } as NodeJS.ProcessEnv).OCR_DRIVER,
    ).toBe('openrouter')
  })

  it('rejects an unknown driver rather than silently reading nothing', () => {
    expect(() => loadConfig({ OCR_DRIVER: 'gemini' } as NodeJS.ProcessEnv)).toThrow(/OCR_DRIVER/)
  })

  it('keeps the read timeout strictly below the 60s platform ceiling in vercel.json', () => {
    // Set the two equal and the socket dies at the same instant the platform gives up, turning a
    // clean timeout into an opaque transport error nobody can diagnose from a log line.
    expect(loadConfig({} as NodeJS.ProcessEnv).OCR_TIMEOUT_MS).toBeLessThan(60_000)
  })
})
