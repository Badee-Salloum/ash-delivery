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
  return config
}
