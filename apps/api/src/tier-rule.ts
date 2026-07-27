import type { Deps, TierRuleRecord } from '@ash/contracts'
import { type CalendarDate, type TierRule, DEFAULT_BANDS, resolveRule } from '@ash/domain'

/**
 * One resolver for the tier rule that governs pay, shared by the close path (`approveClose`) and
 * the admin simulator. Both must agree on which rule applied on a given day for a given vehicle
 * type, or a simulation would preview a number the real close never pays.
 */
export type StoredRule = TierRule & { status: 'active' | 'superseded' | 'withdrawn' }

export const asDomainRule = (r: TierRuleRecord): StoredRule => ({
  basis: r.basis,
  mode: r.mode,
  vehicleTypeId: r.vehicleTypeId,
  bands: r.bands,
  effectiveFrom: r.effectiveFrom,
  status: r.status,
})

/** The client's F-1 default, used when nothing has been published yet — a close is never blocked. */
const FALLBACK: TierRule = {
  basis: 'orders',
  mode: 'whole',
  vehicleTypeId: null,
  bands: DEFAULT_BANDS,
  effectiveFrom: '1970-01-01',
}

/**
 * The rule in force on a date for a vehicle type, or the F-1 default when none is published.
 * `resolveRule` filters status IN ('active','superseded') — a rule since replaced still governs its
 * own past — and prefers a type-specific table over the catch-all (F-4).
 */
export function ruleInForceOn(
  rules: readonly StoredRule[],
  date: CalendarDate,
  vehicleTypeId: string | null = null,
): TierRule {
  try {
    return resolveRule(rules, date, vehicleTypeId)
  } catch {
    return FALLBACK
  }
}

/** Load the stored rules and resolve the one that pays this shift: its business date + vehicle type. */
export async function resolveTierRule(
  deps: Deps,
  businessDate: CalendarDate,
  vehicleTypeId: string | null,
): Promise<TierRule> {
  const stored = (await deps.tiers.list()).map(asDomainRule)
  return ruleInForceOn(stored, businessDate, vehicleTypeId)
}
