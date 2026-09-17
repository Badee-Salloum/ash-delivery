/**
 * «صافي الربح = حصة الشركة − المصاريف» — which ledger fund counts where in the profit figure.
 *
 * THE FIX THIS MODULE EXISTS FOR (2026-09-17). A vehicle expense is posted to
 * `cost_center:<vehicleUuid>`: `expenses.routes.ts` derives the centre as
 * `record.vehicleId ?? '<kind>:<branchId>'`, and an advance converted into a cost does the same.
 * The dashboard's allowlist only recognised `cost_center:vehicle:<…>`, a spelling no route has
 * ever produced, so EVERY vehicle cost was missing from net profit — the one number the general
 * manager opens the screen for was overstated by the whole of the fleet's running cost.
 *
 * A vehicle cost centre is therefore recognised by its SHAPE (a UUID — the id every real vehicle
 * has) or by MEMBERSHIP in the branch's vehicle ids (the in-memory harness names vehicles
 * `vehicle-1`, and a real install could import non-UUID ids). The legacy `vehicle:` prefix stays.
 *
 * STILL AN ALLOWLIST, and it has to be. `fundRefFromCode` turns any unrecognised code into
 * `cost_center:<code>`, so the prefix also carries the owner's capital — `owner_funding`,
 * `owner_drawings`, `opening_balance` — which must never reach a profit figure. Those, and any
 * other centre this module cannot name, classify as `null`: not profit, not cost.
 *
 * Pure and string-free: it returns a class code, the screens name it.
 */

import { RECEIVABLE_WRITEOFF_LOSS_COST_CENTER } from '../ledger/recipes.ts'

export type ProfitLineClass =
  /** `company_revenue` — the company's share of delivery fees. */
  | 'company'
  /** `other_income` — non-delivery income, kept off `company_revenue` by design. */
  | 'other_income'
  /** A branch or general cost centre — an ordinary expense. */
  | 'operating_cost'
  /** A vehicle's cost centre — charging, repair, parts. */
  | 'vehicle_cost'
  /** Money gone with no expense row: a written-off receivable, a wallet or cash-count gap. */
  | 'loss'
  /** `yalago_income` — Yallago's 20%, reported beside profit, never inside it. */
  | 'yalago'

export interface ProfitClassificationContext {
  /** Every vehicle id of the branch, active or not. A retired bike's old costs are still costs. */
  readonly vehicleIds: ReadonlySet<string>
}

const COST_CENTER_PREFIX = 'cost_center:'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The id shape every persisted vehicle (and every other row) carries in PostgreSQL. */
export function isUuid(value: string): boolean {
  return UUID.test(value)
}

/** Which profit bucket a journal line's fund belongs to, or `null` when it is not a P&L line. */
export function classifyProfitLine(fundCode: string, ctx: ProfitClassificationContext): ProfitLineClass | null {
  switch (fundCode) {
    case 'company_revenue':
      return 'company'
    case 'other_income':
      return 'other_income'
    case 'yalago_income':
      return 'yalago'
  }
  if (!fundCode.startsWith(COST_CENTER_PREFIX)) return null
  const centre = fundCode.slice(COST_CENTER_PREFIX.length)

  // The two `cost_center_kind` values that are not a vehicle. Checked before the UUID test only for
  // clarity: `branch:<uuid>` is not itself a UUID, so the order cannot change an answer.
  if (centre.startsWith('branch:') || centre.startsWith('general:')) return 'operating_cost'
  // Real losses that never write an `expenses` row.
  if (
    centre === RECEIVABLE_WRITEOFF_LOSS_COST_CENTER ||
    centre.startsWith('wallet_adjustment:') ||
    centre.startsWith('cash_count_variance:')
  ) {
    return 'loss'
  }
  // A spelling no current route writes, kept so any historical or hand-made row still counts.
  if (centre.startsWith('vehicle:')) return 'vehicle_cost'
  // What `POST /expenses` actually writes for a vehicle: the bare vehicle id.
  if (isUuid(centre) || ctx.vehicleIds.has(centre)) return 'vehicle_cost'
  // owner_funding, owner_drawings, opening_balance and every other contra account.
  return null
}

const LEGACY_VEHICLE_PREFIX = 'vehicle:'

/**
 * WHICH vehicle a vehicle-cost line belongs to (P3 — the fleet table's «كلف» column).
 *
 * Answers only for a line `classifyProfitLine` already calls `vehicle_cost`, so a per-vehicle
 * breakdown can never count a line the profit figure does not, and the two always reconcile. The
 * id is the bare centre `POST /expenses` writes, or the part after the legacy `vehicle:` spelling.
 */
export function vehicleIdOfCostLine(fundCode: string, ctx: ProfitClassificationContext): string | null {
  if (classifyProfitLine(fundCode, ctx) !== 'vehicle_cost') return null
  const centre = fundCode.slice(COST_CENTER_PREFIX.length)
  const id = centre.startsWith(LEGACY_VEHICLE_PREFIX) ? centre.slice(LEGACY_VEHICLE_PREFIX.length) : centre
  return id === '' ? null : id
}

/**
 * A cost line's contribution to a cost total, positive when it is a cost: a DEBIT adds, a credit
 * (a reversal) takes away — exactly as `addProfitLine` moves `vehicleCost`.
 */
export function signedCost(side: 'D' | 'C', amount: bigint): bigint {
  return side === 'D' ? amount : -amount
}

/** The three classes that reduce profit. */
export function isProfitCost(cls: ProfitLineClass | null): cls is 'operating_cost' | 'vehicle_cost' | 'loss' {
  return cls === 'operating_cost' || cls === 'vehicle_cost' || cls === 'loss'
}

/**
 * Running totals, all POSITIVE-when-normal: revenue is credit-positive, cost is debit-positive.
 * Minor units, `bigint`, never a float.
 */
export interface ProfitTotals {
  company: bigint
  otherIncome: bigint
  yalago: bigint
  operatingCost: bigint
  vehicleCost: bigint
  loss: bigint
  /** How many cost LINES were seen. «No cost recorded» and «costs that net to zero» differ. */
  costLineCount: number
}

export function emptyProfitTotals(): ProfitTotals {
  return { company: 0n, otherIncome: 0n, yalago: 0n, operatingCost: 0n, vehicleCost: 0n, loss: 0n, costLineCount: 0 }
}

/**
 * Add one (possibly aggregated) journal line to the totals, in place.
 *
 * `lineCount` lets a pre-aggregated row count as the lines it summarises.
 */
export function addProfitLine(
  totals: ProfitTotals,
  cls: ProfitLineClass | null,
  side: 'D' | 'C',
  amount: bigint,
  lineCount = 1,
): void {
  if (cls === null) return
  const credit = side === 'C' ? amount : -amount
  switch (cls) {
    case 'company':
      totals.company += credit
      return
    case 'other_income':
      totals.otherIncome += credit
      return
    case 'yalago':
      totals.yalago += credit
      return
    // A cost is a DEBIT, so its sign flips relative to revenue.
    case 'operating_cost':
      totals.operatingCost -= credit
      break
    case 'vehicle_cost':
      totals.vehicleCost -= credit
      break
    case 'loss':
      totals.loss -= credit
      break
  }
  totals.costLineCount += lineCount
}

/** Every cost together — what `expenseSyp` has always meant. */
export function totalCost(totals: ProfitTotals): bigint {
  return totals.operatingCost + totals.vehicleCost + totals.loss
}

/**
 * Net = company share + other income − (operating + vehicle + loss).
 *
 * Depreciation is deliberately NOT here (owner decision 2026-09-17): it is shown beside profit,
 * never subtracted from it.
 */
export function netProfit(totals: ProfitTotals): bigint {
  return totals.company + totals.otherIncome - totalCost(totals)
}
