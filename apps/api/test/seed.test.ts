import { describe, expect, it } from 'vitest'
import { SeedRefused, assertSeedAllowed } from '../src/seed.ts'

/**
 * The seed guard.
 *
 * The design review flagged the original as a three-way AND — which meant a virgin production
 * database happily accepted the full demo dataset. It is now an OR of independent conditions:
 * ANY one of them refuses.
 */
describe('the seed refuses to touch production', () => {
  it.each([
    ['NODE_ENV=production', { NODE_ENV: 'production' }],
    ['APP_ENV=production', { APP_ENV: 'production' }],
    ['a DATABASE_URL mentioning prod', { DATABASE_URL: 'postgres://u:p@db/ash_prod' }],
    ['ALLOW_SEED=false', { ALLOW_SEED: 'false' }],
  ])('refuses on %s — ALONE, not only in combination', (_label, env) => {
    expect(() => assertSeedAllowed(env as NodeJS.ProcessEnv)).toThrow(SeedRefused)
  })

  it('names every reason it refused, so the operator is not guessing', () => {
    try {
      assertSeedAllowed({ NODE_ENV: 'production', ALLOW_SEED: 'false' } as NodeJS.ProcessEnv)
      expect.unreachable('should have refused')
    } catch (err) {
      expect((err as Error).message).toContain('NODE_ENV=production')
      expect((err as Error).message).toContain('ALLOW_SEED=false')
    }
  })

  it('allows a clean development environment', () => {
    expect(() =>
      assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: 'postgres://localhost/ash_dev' } as NodeJS.ProcessEnv),
    ).not.toThrow()
  })

  it('--force overrides, because sometimes you really do mean it', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, true)).not.toThrow()
  })
})
