import { assertBigIntParser, createPool, migrate } from '@ash/db'
import { businessDateFor } from '@ash/domain'
import { loadConfig } from './config.ts'
import { BcryptHasher } from './runtime.ts'
import { SeedRefused, assertSeedAllowed, seed } from './seed.ts'

/**
 * `pnpm seed:demo` — the brief's §5 demo dataset.
 *
 * Refuses to run against anything that smells like production, unless --force. The check is an
 * OR of independent conditions, so one mis-set variable is not enough to drop demo shifts into a
 * live ledger.
 */
async function main(): Promise<void> {
  const force = process.argv.includes('--force')
  const config = loadConfig()
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to seed')

  assertSeedAllowed(process.env, force)

  const pool = createPool(config.DATABASE_URL, 2)
  try {
    await assertBigIntParser(pool)
    await migrate(pool)

    const businessDate = businessDateFor(Date.now(), config.TZ_OFFSET_MINUTES)
    // Cost 10 for the seed: five demo logins at cost 12 is a noticeable wait for no benefit.
    const passwordHash = await new BcryptHasher(10).hash('demo1234')

    const { br1Difference } = await seed(pool, { businessDate, passwordHash, force })

    if (br1Difference !== 0n) {
      throw new Error(`seed produced a non-zero BR1 difference (${br1Difference}) — the demo day is wrong`)
    }

    console.log(`seeded: 1 branch, 5 users, 2 drivers, 10 vehicles, 1 approved shift on ${businessDate}`)
    console.log('BR1 difference on the demo shift: 0 ✓')
    console.log('logins: gm / sysadmin / manager / driver1 / driver2   password: demo1234')
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  if (err instanceof SeedRefused) {
    console.error(`[ash] ${err.message}`)
    process.exit(2)
  }
  console.error('[ash] seed failed:', err)
  process.exit(1)
})
