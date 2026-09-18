import { LocalDiskBlobStore, S3BlobStore, VercelBlobStore, assertDurableBlobStore } from '@ash/adapters/blob'
import { MemoryBlobStore, createMemoryDeps } from '@ash/adapters/memory'
import { cipherFromKey } from '@ash/adapters/crypto'
import { MemoryOcrReader, ChatCompletionsOcrReader } from '@ash/adapters/ocr'
import type { OcrProviderErrorEvent } from '@ash/adapters/ocr'
import type { BlobStore, Deps, OcrReader } from '@ash/contracts'
import {
  PgAuditRepo,
  PgCashCountRepo,
  PgCashDeductionRepo,
  PgOfficeCapitalTargetRepo,
  PgRestorationRepo,
  PgDirectoryRepo,
  PgExpenseRepo,
  PgAdvanceRepo,
  PgIncomeRepo,
  PgFxRepo,
  PgFinancialUnitOfWork,
  PgCompanyLedgerRepo,
  PgCompanyLedgerSource,
  PgReceivableEventRepo,
  PgLedgerRepo,
  PgTreasuryPositionSource,
  PgLedgerRangeSource,
  PgMediaRepo,
  PgNotificationRepo,
  PgOcrReadRepo,
  PgOrderRepo,
  PgOperationBatchRepo,
  PgOperationWindowRepo,
  PgPreapprovedShiftRuleRepo,
  PgWalletMovementRepo,
  PgSessionRepo,
  PgSettingsRepo,
  PgTierRepo,
  PgAssignmentRepo,
  PgAttendanceRepo,
  PgCheckInRepo,
  PgBatteryReadingRepo,
  PgBatterySwapRepo,
  PgOperationRemovalRepo,
  PgShiftDecisionRepo,
  PgShiftCloseUnitOfWork,
  PgShiftSettlementRepo,
  PgCloseDraftRepo,
  PgGpsPingRepo,
  PgShiftRepo,
  PgUserRepo,
  PgVehicleEventRepo,
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

/**
 * `none` returns a reader that reports `available: false` and never calls out. That is the DEFAULT,
 * so a deploy that forgets the env var degrades to the on-device reader rather than to an error.
 */
function buildOcrReader(config: Config): OcrReader {
  /*
   * One structured line per failed pass. The durable copy rides into `ocr_reads.result.detail`;
   * this is the live one, and it is the difference between "reads stopped" and "the screen-kind
   * pass is exhausting its 512-token ceiling".
   */
  const onProviderError = (event: OcrProviderErrorEvent): void => {
    console.warn(JSON.stringify({ event: 'ocr_provider_error', ...event }))
  }
  switch (config.OCR_DRIVER) {
    case 'openai':
      return new ChatCompletionsOcrReader({
        provider: 'openai',
        apiKey: config.OPENAI_API_KEY!,
        model: config.OPENAI_OCR_MODEL,
        effort: config.OPENAI_OCR_EFFORT,
        verbosity: config.OPENAI_OCR_VERBOSITY,
        timeoutMs: config.OCR_TIMEOUT_MS,
        onProviderError,
      })
    case 'openrouter':
      /*
       * Effort and verbosity are OpenAI-only and are pinned to `default` here rather than plumbed:
       * the adapter refuses to send them on this provider anyway, and a config value that cannot
       * take effect is a lie waiting to be believed.
       */
      return new ChatCompletionsOcrReader({
        provider: 'openrouter',
        apiKey: config.OPENROUTER_API_KEY!,
        model: config.OPENROUTER_OCR_MODEL,
        effort: 'default',
        verbosity: 'default',
        timeoutMs: config.OCR_TIMEOUT_MS,
        onProviderError,
      })
    case 'none':
      return new MemoryOcrReader()
  }
}

export async function buildDeps(config: Config): Promise<BuiltDeps> {
  const blobs = buildBlobStore(config)
  // Refuses to boot production against storage that loses evidence on redeploy.
  assertDurableBlobStore(blobs, config.NODE_ENV)
  const ocr = buildOcrReader(config)

  const clock = new SystemClock(config.TZ_OFFSET_MINUTES, config.DAY_START_MINUTES)
  const ids = new CryptoIdGen()
  const hasher = new BcryptHasher(config.BCRYPT_ROUNDS)
  // A parse error here (wrong-length key) stops the boot naming the variable, per config's contract.
  const cipher = cipherFromKey(config.ENCRYPTION_KEY)

  if (!config.DATABASE_URL) {
    // Development only — loadConfig() refuses this combination in production.
    const memory = createMemoryDeps(Date.now())
    return {
      deps: { ...memory, clock, ids, hasher, cipher, blobs, ocr },
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
      cipher,
      blobs,
      ocr,
      ocrReads: new PgOcrReadRepo(pool),
      users: new PgUserRepo(pool),
      sessions: new PgSessionRepo(pool),
      shifts: new PgShiftRepo(pool),
      preapprovedShiftRules: new PgPreapprovedShiftRuleRepo(pool),
      assignments: new PgAssignmentRepo(pool),
      batteryReadings: new PgBatteryReadingRepo(pool),
      batterySwaps: new PgBatterySwapRepo(pool),
      orders: new PgOrderRepo(pool),
      cashDeductions: new PgCashDeductionRepo(pool),
      operationWindows: new PgOperationWindowRepo(pool),
      operationBatches: new PgOperationBatchRepo(pool),
      movements: new PgWalletMovementRepo(pool),
      ledger: new PgLedgerRepo(pool),
      treasuryPosition: new PgTreasuryPositionSource(pool),
      ledgerRange: new PgLedgerRangeSource(pool),
      expenses: new PgExpenseRepo(pool),
      checkIns: new PgCheckInRepo(pool),
      incomes: new PgIncomeRepo(pool),
      advances: new PgAdvanceRepo(pool),
      receivableEvents: new PgReceivableEventRepo(pool),
      financialUnitOfWork: new PgFinancialUnitOfWork(pool),
      companyLedger: new PgCompanyLedgerRepo(pool),
      companyLedgerSource: new PgCompanyLedgerSource(pool),
      cashCounts: new PgCashCountRepo(pool),
      capitalTargets: new PgOfficeCapitalTargetRepo(pool),
      restorations: new PgRestorationRepo(pool),
      tiers: new PgTierRepo(pool),
      notifications: new PgNotificationRepo(pool),
      settings: new PgSettingsRepo(pool),
      media: new PgMediaRepo(pool),
      fx: new PgFxRepo(pool),
      weekLocks: new PgWeekLockRepo(pool),
      audit: new PgAuditRepo(pool),
      directory: new PgDirectoryRepo(pool),
      vehicleEvents: new PgVehicleEventRepo(pool),
      attendance: new PgAttendanceRepo(pool),
      operationRemovals: new PgOperationRemovalRepo(pool),
    decisions: new PgShiftDecisionRepo(pool),
      settlements: new PgShiftSettlementRepo(pool),
      closeDrafts: new PgCloseDraftRepo(pool),
      gps: new PgGpsPingRepo(pool),
      closeUnitOfWork: new PgShiftCloseUnitOfWork(pool),
    },
    dispose: () => pool.end(),
  }
}
