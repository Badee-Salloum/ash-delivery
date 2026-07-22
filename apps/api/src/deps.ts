import { LocalDiskBlobStore, S3BlobStore, VercelBlobStore, assertDurableBlobStore } from '@ash/adapters/blob'
import { MemoryBlobStore, createMemoryDeps } from '@ash/adapters/memory'
import type { BlobStore, Deps } from '@ash/contracts'
import {
  PgAuditRepo,
  PgCashCountRepo,
  PgDirectoryRepo,
  PgExpenseRepo,
  PgFxRepo,
  PgLedgerRepo,
  PgMediaRepo,
  PgNotificationRepo,
  PgOrderRepo,
  PgSessionRepo,
  PgSettingsRepo,
  PgTierRepo,
  PgAssignmentRepo,
  PgShiftRepo,
  PgUserRepo,
  PgWeekLockRepo,
  assertBigIntParser,
  createPool,
} from '@ash/db'
import type { Config } from './config.ts'
import { BcryptHasher, CryptoIdGen, SystemClock } from './runtime.ts'

/**
 * Dependency wiring, in one place.
 *
 * This is the only file that knows which implementation of each port is in play. Everything
 * above it — every route, every service, every test — is written against the interfaces, which
 * is why the whole HTTP surface can be tested without a database and then run against one
 * unchanged.
 */

export interface BuiltDeps {
  deps: Deps
  /** Call on shutdown. Closes the pool so in-flight queries finish before the process exits. */
  dispose(): Promise<void>
}

function buildBlobStore(config: Config): BlobStore {
  switch (config.BLOB_DRIVER) {
    case 's3':
      return new S3BlobStore({
        endpoint: config.S3_ENDPOINT!,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET!,
        accessKeyId: config.S3_ACCESS_KEY_ID!,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
      })
    case 'vercel':
      return new VercelBlobStore({ token: config.BLOB_READ_WRITE_TOKEN! })
    case 'disk':
      return new LocalDiskBlobStore(config.BLOB_DISK_ROOT)
    case 'memory':
      return new MemoryBlobStore()
  }
}

export async function buildDeps(config: Config): Promise<BuiltDeps> {
  const blobs = buildBlobStore(config)
  // Refuses to boot production against storage that loses evidence on redeploy.
  assertDurableBlobStore(blobs, config.NODE_ENV)

  const clock = new SystemClock(config.TZ_OFFSET_MINUTES)
  const ids = new CryptoIdGen()
  const hasher = new BcryptHasher(config.BCRYPT_ROUNDS)

  if (!config.DATABASE_URL) {
    // Development only — loadConfig() refuses this combination in production.
    const memory = createMemoryDeps(Date.now())
    return {
      deps: { ...memory, clock, ids, hasher, blobs },
      dispose: async () => undefined,
    }
  }

  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX)
  // Prove int8 comes back as a bigint before a single row of money is read.
  await assertBigIntParser(pool)

  return {
    deps: {
      clock,
      ids,
      hasher,
      blobs,
      users: new PgUserRepo(pool),
      sessions: new PgSessionRepo(pool),
      shifts: new PgShiftRepo(pool),
      assignments: new PgAssignmentRepo(pool),
      orders: new PgOrderRepo(pool),
      ledger: new PgLedgerRepo(pool),
      expenses: new PgExpenseRepo(pool),
      cashCounts: new PgCashCountRepo(pool),
      tiers: new PgTierRepo(pool),
      notifications: new PgNotificationRepo(pool),
      settings: new PgSettingsRepo(pool),
      media: new PgMediaRepo(pool),
      fx: new PgFxRepo(pool),
      weekLocks: new PgWeekLockRepo(pool),
      audit: new PgAuditRepo(pool),
      directory: new PgDirectoryRepo(pool),
    },
    dispose: () => pool.end(),
  }
}
