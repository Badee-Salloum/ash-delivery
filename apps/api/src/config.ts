import { z } from 'zod'

/**
 * Configuration, validated at boot.
 *
 * A missing or malformed setting must stop the process immediately with a message naming the
 * variable — not surface at 2am as an undefined threaded three layers deep. Secrets are never
 * defaulted: if `SESSION_SECRET` or `DATABASE_URL` is absent in production, the app refuses to
 * start rather than running with something guessable.
 */
/**
 * The per-shift OCR read ceiling, in ONE place.
 *
 * It was written as a literal here and as `?? 15` in five route handlers. Raising the real default
 * while five fallbacks stayed at 15 would have looked like a fix and changed nothing on any request
 * that did not pass the option — which is exactly the kind of half-applied change this incident
 * cost a night's work to.
 */
export const DEFAULT_MAX_OCR_READS_PER_SHIFT = 40

const explicitBoolean = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .default(true)
  .transform((value) => value === true || value === 'true')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1).optional(),

  /** Emergency kill switch for the one public account-creation path. */
  DRIVER_SELF_REGISTRATION_ENABLED: explicitBoolean,

  /**
   * The hardware-tracker ingest seam (SRS K-1). OFF by default and until the first device is
   * fitted: no device exists yet, and an open ingest port with no token is an attack surface. The
   * gateway authenticates with `TRACKER_GATEWAY_TOKEN`, which must be set for ingest to accept.
   */
  TRACKER_INGEST_ENABLED: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .default(false)
    .transform((value) => value === true || value === 'true'),
  TRACKER_GATEWAY_TOKEN: z.string().min(16).optional(),

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
  /**
   * Minutes past branch-local midnight at which the business day rolls over. 240 = 04:00, the
   * owner's own day: a shift closed at 01:30 books under the day it was worked. Configurable
   * rather than constant so a branch that changes its hours does not need a deploy.
   */
  DAY_START_MINUTES: z.coerce.number().int().min(0).max(1439).default(240),

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
  OCR_DRIVER: z.enum(['none', 'openai', 'openrouter']).default('none'),
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
   *
   * ── 2026-08-17: gpt-5.4, ON COST ─────────────────────────────────────────────────────────
   *
   * Same 48 screens, same 311 rows, same prompt, same scorer — so the two runs above are already
   * a like-for-like comparison and no new measurement was needed to read this off:
   *
   *              MISREAD   missed   ok    cost
   *   gpt-5.5      24        21     290   $1.58
   *   gpt-5.4      26        30     281   $0.44     ← 28% of the price
   *
   * Two more wrong numbers across 311 rows, for a 72% cut. Production was measured at ~$174/month
   * at ten bikes and would have been ~$1,740 at a hundred; this makes those ~$49 and ~$490.
   *
   * WHAT IS ACTUALLY GIVEN UP, stated precisely rather than glossed: gpt-5.4 reads NINE fewer rows
   * correctly and misses nine more. A missed row is one the driver types — visible, and therefore
   * safe. The dangerous column, a different number sitting where a real one should be, moves by
   * two. That is the trade: a little more typing for two thirds off the bill.
   *
   * Two caveats worth carrying. That gpt-5.4 run is from 2026-08-12 and the corpus has since grown
   * from 48 images to 66, so it is a valid comparison on the images both saw and silent about the
   * eighteen newer ones. And changing the model changes `cacheSignature`, so every previously-read
   * screenshot is re-read once at the new price — a one-off cost, by design, because an answer
   * from a different reader is a different answer.
   *
   * gpt-5.5 remains one env var away: `OPENAI_OCR_MODEL=gpt-5.5`.
   */
  OPENAI_OCR_MODEL: z.string().default('gpt-5.4'),
  OPENAI_OCR_EFFORT: z.enum(['default', 'low', 'medium', 'high']).default('default'),
  OPENAI_OCR_VERBOSITY: z.enum(['default', 'low', 'medium', 'high']).default('default'),

  /**
   * OpenRouter, and why the reader moved here.
   *
   * MEASURED over the 66-image corpus against the 319-row answer key, with three full passes:
   *
   *              MISREAD   disagrees with ITSELF on money   cost/run
   *   gemini-3.7-flash   5        0 of 3 passes             $0.180
   *   gpt-5.4         26-34      14 of 48 images            $0.550
   *
   * The misread column is five to one, but the column that decided it is the second one. Asked the
   * same image twice, gpt-5.4 read `-16500` where its own other pass read `-165.50`. A reader that
   * changes its mind puts a number in the ledger that depends on which second the request fired,
   * and BR1 balances a wrong fee against itself, so nobody ever finds it.
   *
   * THINKING IS DELIBERATELY UNCAPPED. Capping it at 256 tokens measured 3x faster and 40% cheaper
   * with the same 5 misreads — and a second pass showed it disagreeing with itself twice in fifty
   * images, once tenfold. The misread COUNT hid it because both passes scored 5 on different rows.
   * There is no effort/verbosity knob on this path; `temperature: 0` is what was measured instead.
   *
   * `google/gemini-3.7-flash` is a ROUTED ALIAS, not a pinned endpoint. Upstreams can differ in
   * quantisation, latency and retention, which is one more reason the request pins
   * `provider.data_collection: 'deny'` (ASSUMPTIONS A-30).
   */
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_OCR_MODEL: z.string().default('google/gemini-3.7-flash'),
  /**
   * Strictly below the platform's function ceiling (`vercel.json`), so a slow read returns a clean
   * 504 instead of the socket dying at the same instant the platform gives up.
   *
   * 50s against a 60s ceiling. **The owner asked for two minutes and this is not it** — Vercel's
   * Hobby plan caps a Node function at 60 seconds, full stop, so 120s is unreachable without Pro.
   * Raise `maxDuration` to 120 there and the deploy is rejected outright.
   *
   * Worth knowing before paying for it: across the first live reads the slowest was **18.8s** and
   * the average **10.6s**, with zero timeouts. 50s is already 2.7× the worst case observed. If a
   * genuine timeout ever appears in `ocr_reads` (`result->>'reason' = 'timeout'`) that is the
   * evidence for the upgrade; until then this is headroom, not a fix.
   */
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(50_000),
  /**
   * A runaway guard, not a business rule — the same framing `MAX_SHIFTS_PER_DAY` uses.
   *
   * RAISED FROM 15 AFTER 2026-08-24, WHERE 15 COST A NIGHT'S WORK. امجد عبدالله's shift spent
   * exactly fifteen — three at open, then five dashboard pages, four payments-log pages, wallet and
   * odometer at close — so the two BMS reads BR5 actually REQUIRES were refused, and his close was
   * never submitted. Fifteen was measured against a bike's mandatory photos and did not allow for
   * a real scrollable Recent-Orders list.
   *
   * The cost of raising it is small: most shifts use 6–11 reads, so the ceiling only binds on a
   * heavy night. `MANDATORY_READ_RESERVE` in `ocr.service.ts` is the other half — a budget that is
   * merely larger would still let optional pages crowd out the readings the gate depends on.
   */
  OCR_MAX_READS_PER_SHIFT: z.coerce.number().int().positive().default(DEFAULT_MAX_OCR_READS_PER_SHIFT),
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

  if (config.OCR_DRIVER === 'openrouter' && !config.OPENROUTER_API_KEY) {
    throw new Error('OCR_DRIVER=openrouter requires OPENROUTER_API_KEY')
  }

  return config
}
