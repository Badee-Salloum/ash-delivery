import { z } from 'zod'

/**
 * Configuration, validated at boot.
 *
 * A missing or malformed setting must stop the process immediately with a message naming the
 * variable — not surface at 2am as an undefined threaded three layers deep. Secrets are never
 * defaulted: if `SESSION_SECRET` or `DATABASE_URL` is absent in production, the app refuses to
 * start rather than running with something guessable.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1).optional(),

  /** bcrypt cost. SRS §7 mandates bcrypt; 12 is the current sane floor. */
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  /**
   * BR1's component gate. `advisory` during the pilot, while the equation is calibrated against
   * Yallago's real arithmetic; `strict` once the first real shift sample confirms the model.
   * See RUNBOOK §1 and ASSUMPTIONS A-26.
   */
  BR1_SPLIT_GATE: z.enum(['advisory', 'strict']).default('advisory'),

  /** Asia/Damascus is UTC+3 year-round since October 2022. Injected, never assumed. */
  TZ_OFFSET_MINUTES: z.coerce.number().int().default(180),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * Pool size. Serverless (Vercel) opens a pool PER INSTANCE, so a large value multiplied by the
   * concurrency limit exhausts Postgres. Neon's pooled connection string handles the fan-in;
   * keep this small there. On a VPS with one long-lived process, 10 is fine.
   */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /**
   * Where evidence photos live. `disk` is correct on a VPS with a mounted volume; on a
   * serverless host the filesystem is ephemeral, so production there MUST be `s3`.
   */
  BLOB_DRIVER: z.enum(['memory', 'disk', 's3', 'vercel']).default('disk'),
  BLOB_DISK_ROOT: z.string().default('./media'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  /** Injected by linking a Vercel Blob store to the project; required when BLOB_DRIVER=vercel. */
  BLOB_READ_WRITE_TOKEN: z.string().optional(),

  /**
   * AES-256-GCM key for PII at rest (a driver's national ID). 32 bytes, as 64 hex chars or base64.
   * Optional: without it the app runs, but storing a national ID fails closed rather than writing
   * plaintext. Never defaulted — a guessable key is no key. See RUNBOOK for generation.
   */
  ENCRYPTION_KEY: z.string().optional(),

  /**
   * The cloud OCR reader. `none` is the default and the kill switch.
   *
   * Flip this to `none` and every read falls back to the on-device reader with no code deploy —
   * which is what you want at 3 a.m. when the provider is down, the bill is running away, or a new
   * model turns out to read Arabic-Indic digits worse than the last one. `BLOB_DRIVER` is the
   * pattern; this is the same shape for the same reason.
   */
  OCR_DRIVER: z.enum(['none', 'openai']).default('none'),
  OPENAI_API_KEY: z.string().optional(),
  /**
   * MEASURED, not chosen from a price page. 48 real screens, 311 hand-transcribed rows,
   * `scripts/vision-bench.mjs`, scored by `scripts/ocr-compare.mjs`:
   *
   *   gpt-5.5   medium/medium   35/48 clean   290 ok   24 misread   1 magnitude error   $1.58
   *   gpt-5.6-sol                34/48        287      27           —                   $1.25
   *   gpt-5.4                    28/48        281      26           —                   $0.44
   *   gpt-5.5   low/low          32/48        283      31           4 magnitude errors   $0.91
   *
   * The effort dial is the whole story. Dropping gpt-5.5 from medium to low cut reasoning tokens
   * 16× and saved 42% of the bill — and bought SEVEN more wrong numbers and three more
   * hundredfold errors. On a ledger with zero tolerance that is not a saving.
   *
   * These three move together. Changing one without re-running the benchmark is changing the
   * reader blind: `medium` effort with `low` verbosity has never been measured, so it is not the
   * default even though it looks like the cheap half of a good setting.
   */
  OPENAI_OCR_MODEL: z.string().default('gpt-5.5'),
  OPENAI_OCR_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  OPENAI_OCR_VERBOSITY: z.enum(['low', 'medium', 'high']).default('medium'),
  /**
   * Strictly below the platform's function ceiling (`vercel.json`), so a slow read returns a clean
   * 504 instead of the socket dying at the same instant the platform gives up.
   */
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  /**
   * A runaway guard, not a business rule — the same framing `MAX_SHIFTS_PER_DAY` uses.
   *
   * A three-pack bike needs ten mandatory photos a shift plus extra dashboard and payments-log
   * pages. Fifteen covers that with room for retakes; past it the driver still has the on-device
   * reader and a keyboard.
   */
  OCR_MAX_READS_PER_SHIFT: z.coerce.number().int().positive().default(15),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`invalid configuration:\n${detail}`)
  }
  const config = parsed.data

  if (config.NODE_ENV === 'production' && !config.DATABASE_URL) {
    throw new Error('DATABASE_URL is required in production — refusing to start against an in-memory store')
  }

  if (config.BLOB_DRIVER === 's3') {
    // Fail here, naming the variable, rather than on the first photo a driver uploads.
    const missing = (['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter(
      (k) => !config[k],
    )
    if (missing.length > 0) {
      throw new Error(`BLOB_DRIVER=s3 requires: ${missing.join(', ')}`)
    }
  }

  if (config.BLOB_DRIVER === 'vercel' && !config.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_DRIVER=vercel requires BLOB_READ_WRITE_TOKEN (link a Vercel Blob store to the project)')
  }

  if (config.OCR_DRIVER === 'openai' && !config.OPENAI_API_KEY) {
    throw new Error('OCR_DRIVER=openai requires OPENAI_API_KEY')
  }

  return config
}
