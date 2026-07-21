import { assertBigIntParser, createPool, migrate } from '@ash/db'
import { loadConfig } from './config.ts'

/**
 * The one-shot migration container.
 *
 * Runs to completion and exits. Kept out of the API process on purpose: a failed migration must
 * STOP the deploy, not put a container into a crash-loop that half-applies schema changes while
 * the orchestrator keeps restarting it.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to migrate')

  const pool = createPool(config.DATABASE_URL, 2)
  try {
    // Prove int8 comes back as a bigint BEFORE any money-bearing schema is touched.
    await assertBigIntParser(pool)

    const { applied, skipped } = await migrate(pool)
    for (const file of applied) console.log(`applied  ${file}`)
    console.log(`migrations: ${applied.length} applied, ${skipped.length} already present`)
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  console.error('[ash] migration failed:', err)
  process.exit(1)
})
