import { createMemoryDeps } from '@ash/adapters/memory'
import type { Deps } from '@ash/contracts'
import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'
import { BcryptHasher, CryptoIdGen, SystemClock } from './runtime.ts'

/**
 * Process entry point.
 *
 * Wiring is explicit and in one place: swap `createMemoryDeps` for the PostgreSQL adapters and
 * nothing above this line changes. That is the whole point of the port layer.
 */
async function main(): Promise<void> {
  const config = loadConfig()

  if (!config.DATABASE_URL) {
    // Guarded in loadConfig for production; this is the development path.
    console.warn('[ash] no DATABASE_URL — running against the IN-MEMORY store. Data will not persist.')
  }

  const deps: Deps = {
    ...createMemoryDeps(Date.now()),
    clock: new SystemClock(config.TZ_OFFSET_MINUTES),
    ids: new CryptoIdGen(),
    hasher: new BcryptHasher(config.BCRYPT_ROUNDS),
  }

  const app = await buildApp({ deps, logger: true, splitGate: config.BR1_SPLIT_GATE })

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down')
    // Close the server before the process exits so in-flight approvals finish rather than being
    // cut mid-transaction. A half-posted shift is far worse than a slow deploy.
    await app.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await app.listen({ port: config.PORT, host: config.HOST })
  app.log.info(
    { port: config.PORT, splitGate: config.BR1_SPLIT_GATE, tzOffset: config.TZ_OFFSET_MINUTES },
    'ash-delivery api listening',
  )
}

main().catch((err: unknown) => {
  console.error('[ash] failed to start:', err)
  process.exit(1)
})
