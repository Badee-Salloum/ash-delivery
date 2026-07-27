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

  return config
}
