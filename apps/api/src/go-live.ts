import type { Deps } from '@ash/contracts'
import type { CalendarDate } from '@ash/domain'

/**
 * «تاريخ بدء التطبيق» — the business date the system really went live on.
 *
 * Everything before it is trial data. It stays in the database and stays readable — BR7 forbids
 * deleting a posted entry — but it is excluded from the figures.
 *
 * A DATE, deliberately not a timestamp. Every money column here is keyed on `business_date`, which
 * rolls at 04:00 (`businessDateFor`). A separate go-live instant would be a second, competing time
 * rule, which is the failure BR7's Sunday boundary exists to warn about.
 *
 * ── WHY A DATE ALONE IS NOT ENOUGH ───────────────────────────────────────────────────────────
 *
 * This clamps FLOWS (revenue, orders, company share) and nothing else. Balances are cumulative by
 * construction: `PgLedgerRepo.fundBalance` and `PgTreasuryPositionSource.readCurrent` sum every
 * journal line for a fund with no date predicate, because a balance is a POSITION — pre-epoch
 * entries are what put the money in the box, and excluding them would assert the box was empty.
 *
 * What makes the two agree is the OPENING CEREMONY: a sealed cash count plus a restoration on the
 * go-live date sets each office box to its capital target. `assertOpeningCeremony` refuses to set
 * the date until that has happened, so "ignore everything before" is never a half-truth.
 */
export const GO_LIVE_SETTING_KEY = 'system.go_live_business_date'

/** The configured go-live date, or null when the system has not been declared live yet. */
export async function goLiveDate(deps: Deps): Promise<CalendarDate | null> {
  const raw = await deps.settings.get(GO_LIVE_SETTING_KEY)
  if (raw === null || raw === undefined) return null
  const value = String(raw)
  // A malformed stored value must not silently widen every report back to the beginning of time,
  // nor throw on a screen that merely wanted a total. Treat it as "not configured".
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/**
 * Move a range start forward to go-live, never backward.
 *
 * Calendar dates are ISO `YYYY-MM-DD`, so lexical order is date order — the same property
 * `weekStartFor` and the week-lock comparisons already rely on.
 */
export function clampToGoLive(from: CalendarDate, goLive: CalendarDate | null): CalendarDate {
  return goLive !== null && from < goLive ? goLive : from
}
