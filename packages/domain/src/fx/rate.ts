import { type Minor, minor } from '../money/minor.ts'
import type { CalendarDate } from '../time/civil.ts'

/**
 * BR6 / SRS E-4 — the daily exchange rate.
 *
 * ONE rate per business date, entered each morning by the system admin, applied to that entire
 * day's transactions. Reports show new SYP plus a USD equivalent.
 *
 * Stored as **SYP minor units per 1 USD** rather than USD per SYP, because the latter is a tiny
 * fraction and there is no honest way to hold a fraction in an integer. `1_300_000` means
 * 13,000 new SYP to the dollar; the July-2026 seed of ~130 new SYP/USD is `13_000`.
 */
export interface FxDay {
  readonly businessDate: CalendarDate
  readonly sypMinorPerUsd: bigint
  /**
   * True when the rate was carried forward because the admin had not yet entered today's.
   *
   * Posting is NEVER blocked on a missing rate — a failed cron must not be able to freeze the
   * business — so the posting path lazily creates a provisional row and flags it. The Sunday
   * close pre-flight then refuses to close a week that still contains one.
   */
  readonly provisional: boolean
}

export class FxError extends Error {}

/**
 * Convert an amount in SYP minor units to USD minor units (cents).
 *
 * Half-up, because this is a *display* figure: a reader comparing two reports would rather see
 * the nearest cent than a consistently-low floor. It is never the basis of a posting — the
 * ledger is in SYP minor units end to end and the USD equivalent is derived at read time.
 */
export function toUsdMinor(amountSypMinor: Minor, fx: FxDay): Minor {
  if (fx.sypMinorPerUsd <= 0n) throw new FxError(`invalid rate ${fx.sypMinorPerUsd} on ${fx.businessDate}`)
  const negative = amountSypMinor < 0n
  const magnitude = negative ? -amountSypMinor : amountSypMinor
  // × 100 to land in cents, + half the divisor to round half-up.
  const cents = (magnitude * 100n + fx.sypMinorPerUsd / 2n) / fx.sypMinorPerUsd
  return minor(negative ? -cents : cents)
}

/**
 * The rate in force on a business date.
 *
 * If today's rate is absent, the most recent earlier rate is carried forward and returned
 * `provisional: true`. The caller persists that as a real row so every journal entry can hold a
 * non-null `fx_day_id` — acceptance criterion #6 requires the applied rate to be reproducible
 * forever, and a null reference would make a historical report unreconstructable.
 */
export function resolveFxDay(days: readonly FxDay[], businessDate: CalendarDate): FxDay {
  const exact = days.find((d) => d.businessDate === businessDate)
  if (exact) return exact

  const earlier = days
    .filter((d) => d.businessDate < businessDate)
    .sort((a, b) => (a.businessDate < b.businessDate ? 1 : -1))[0]

  if (!earlier) {
    throw new FxError(
      `no exchange rate on or before ${businessDate} — the system admin must enter the first rate before any posting`,
    )
  }
  return { businessDate, sypMinorPerUsd: earlier.sypMinorPerUsd, provisional: true }
}

/** Seed value, July 2026: ~130 new SYP to the dollar. A seed, never a hardcoded rule. */
export const SEED_SYP_MINOR_PER_USD = 13_000n
