import { type Minor, isZero } from '../money/minor.ts'
import type { Currency } from '../money/currency.ts'
import { type CalendarDate, addDays, dayOfWeek, weekClosedOn } from '../time/civil.ts'

/**
 * BR7 / SRS E-6 — the Sunday close.
 *
 * The financial week runs **Sunday 00:00 → Saturday 23:59 Asia/Damascus** and is closed by the
 * **system admin** on the *following* Sunday (product-owner decision D-1). A shift worked on the
 * closing Sunday belongs to the NEW week and is never frozen by that day's close.
 *
 * Once closed, entries are immutable — enforced in this layer, and again by `REVOKE` plus a
 * trigger in the database, because a guard that only exists in application code does not survive
 * the psql session someone opens at 2am.
 */

export interface WeekCloseFacts {
  readonly closeDate: CalendarDate
  /** Shifts in the week not yet `approved` (includes `suspended`). */
  readonly unapprovedShiftCount: number
  /** Days in the week with no sealed cash count (E-5). */
  readonly daysMissingCashCount: readonly CalendarDate[]
  /** Days still carrying a carried-forward rate (BR6). */
  readonly provisionalFxDays: readonly CalendarDate[]
  /** Locks must be contiguous — a gap would leave a week permanently editable. */
  readonly priorWeekClosed: boolean
  /** Σ debits − Σ credits over the week. Must be exactly zero. */
  readonly trialBalanceDiff: Minor
  /**
   * The same difference PER CURRENCY, for a ledger that holds more than one (the company ledger, C1).
   * When given it replaces `trialBalanceDiff`: a dollar surplus and a lira deficit of the same digits
   * sum to zero and are still two broken books. Each non-zero currency is its own blocker.
   */
  readonly trialBalanceByCurrency?: readonly { readonly currency: Currency; readonly diff: Minor }[]
  /** Already closed? Closing twice must be a no-op, not a second seal. */
  readonly alreadyClosed: boolean
}

export type CloseBlocker =
  | { readonly kind: 'not_a_sunday'; readonly closeDate: CalendarDate }
  | { readonly kind: 'already_closed' }
  | { readonly kind: 'unapproved_shifts'; readonly count: number }
  | { readonly kind: 'missing_cash_counts'; readonly dates: readonly CalendarDate[] }
  | { readonly kind: 'provisional_fx'; readonly dates: readonly CalendarDate[] }
  | { readonly kind: 'prior_week_open' }
  | { readonly kind: 'trial_balance_not_zero'; readonly diff: Minor; readonly currency?: Currency }

export interface WeekCloseCheck {
  readonly weekStart: CalendarDate
  readonly weekEnd: CalendarDate
  readonly blockers: readonly CloseBlocker[]
  readonly canClose: boolean
  /**
   * SRS BR7/H-4 also require zero reconciliation against the Yallago weekly PDF before closing.
   * That is section H — Bundle 2 — so Bundle 1 holds its place with a permanently-satisfied
   * placeholder rather than pretending the requirement does not exist (ASSUMPTIONS A-14).
   */
  readonly reconciliationGate: 'deferred_to_bundle_2'
}

export function checkWeekClose(facts: WeekCloseFacts): WeekCloseCheck {
  const blockers: CloseBlocker[] = []

  if (dayOfWeek(facts.closeDate) !== 0) {
    // Return early: without a Sunday there is no well-defined week to report on.
    return {
      weekStart: facts.closeDate,
      weekEnd: facts.closeDate,
      blockers: [{ kind: 'not_a_sunday', closeDate: facts.closeDate }],
      canClose: false,
      reconciliationGate: 'deferred_to_bundle_2',
    }
  }

  const { start, end } = weekClosedOn(facts.closeDate)

  if (facts.alreadyClosed) blockers.push({ kind: 'already_closed' })
  if (facts.unapprovedShiftCount > 0) {
    blockers.push({ kind: 'unapproved_shifts', count: facts.unapprovedShiftCount })
  }
  if (facts.daysMissingCashCount.length > 0) {
    blockers.push({ kind: 'missing_cash_counts', dates: facts.daysMissingCashCount })
  }
  if (facts.provisionalFxDays.length > 0) {
    blockers.push({ kind: 'provisional_fx', dates: facts.provisionalFxDays })
  }
  if (!facts.priorWeekClosed) blockers.push({ kind: 'prior_week_open' })
  if (facts.trialBalanceByCurrency !== undefined) {
    for (const { currency, diff } of facts.trialBalanceByCurrency) {
      if (!isZero(diff)) blockers.push({ kind: 'trial_balance_not_zero', diff, currency })
    }
  } else if (!isZero(facts.trialBalanceDiff)) {
    blockers.push({ kind: 'trial_balance_not_zero', diff: facts.trialBalanceDiff })
  }

  return {
    weekStart: start,
    weekEnd: end,
    blockers,
    canClose: blockers.length === 0,
    reconciliationGate: 'deferred_to_bundle_2',
  }
}

/**
 * Whether a business date falls inside an already-closed week — the question every write path
 * asks before touching the ledger.
 */
export function isDateLocked(
  businessDate: CalendarDate,
  closedWeekStarts: readonly CalendarDate[],
): boolean {
  // ISO date strings compare correctly as plain strings, which is why CalendarDate is one.
  return closedWeekStarts.some(
    (start) => businessDate >= start && businessDate <= addDays(start, 6),
  )
}
