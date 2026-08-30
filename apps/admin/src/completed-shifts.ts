import { formatMinor, parseMinor, sum } from '@ash/domain'

/** A manager-facing shift is financially complete only after the close settlement was approved. */
export const FINANCIALLY_COMPLETED_SHIFT_STATES = new Set(['approved', 'week_locked'])

/**
 * The history endpoint is date-scoped. Keep a range read bounded so one browser cannot fan out an
 * unbounded number of requests (and each shift row asks the API for its included-order count).
 */
export const MAX_COMPLETED_SHIFT_RANGE_DAYS = 31

export type CompletedShiftRangeError = 'dates_required' | 'date_order' | 'range_too_large'

export interface CompletedShiftHistoryRow {
  id: string
  businessDate: string
  shiftNo: number
  state: string
}

/** Additive financial snapshot returned by GET /shifts for rows with an immutable settlement. */
export interface CompletedShiftFinancial {
  policyCode: string
  deliveryFees: string
  companyShare: string
  yalagoShare: string
  grossDriverShare: string
  deductions: string
  netDriverShare: string
  expectedTotal: string
  actualCash: string
  actualWallet: string
  actualTotal: string
  variance: string
  varianceDirection: 'surplus' | 'shortage' | 'balanced'
  finalEmployeeCash: string
  cashClaimToOffice: string
  walletClaimToOffice: string
  cashReceivableDeferred: string
  walletReceivableDeferred: string
  cashShortageReceivable: string
  cashToOffice: string
  walletToOffice: string
  officeReturn: string
}

export interface CompletedShiftFinancialTotals {
  availableCount: number
  missingCount: number
  deliveryFees: string
  companyShare: string
  netDriverShare: string
  deductions: string
  variance: string
  cashShortageReceivable: string
  officeReturn: string
}

export interface CompletedShiftRangeResult {
  ok: true
  dates: string[]
}

export interface InvalidCompletedShiftRangeResult {
  ok: false
  reason: CompletedShiftRangeError
}

const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Parse a written business date without involving the browser's timezone. */
function businessDateMs(value: string): number | null {
  if (!ISO_DATE.test(value)) return null
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return null
  // Date.parse normalises impossible dates such as 2026-02-31; a business date must not.
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null
}

function dateFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addBusinessDays(value: string, days: number): string {
  const ms = businessDateMs(value)
  return ms === null ? value : dateFromMs(ms + days * DAY_MS)
}

/** The most recent seven business dates, including today. */
export function defaultCompletedShiftRange(today: string): { from: string; to: string } {
  return { from: addBusinessDays(today, -6), to: today }
}

/** Every date the existing date-scoped API must read, inclusive and oldest first. */
export function completedShiftDates(
  from: string,
  to: string,
  maxDays = MAX_COMPLETED_SHIFT_RANGE_DAYS,
): CompletedShiftRangeResult | InvalidCompletedShiftRangeResult {
  const fromMs = businessDateMs(from)
  const toMs = businessDateMs(to)
  if (fromMs === null || toMs === null) return { ok: false, reason: 'dates_required' }
  if (fromMs > toMs) return { ok: false, reason: 'date_order' }

  const count = Math.floor((toMs - fromMs) / DAY_MS) + 1
  if (count > maxDays) return { ok: false, reason: 'range_too_large' }
  return {
    ok: true,
    dates: Array.from({ length: count }, (_, index) => dateFromMs(fromMs + index * DAY_MS)),
  }
}

function newestFirst(a: CompletedShiftHistoryRow, b: CompletedShiftHistoryRow): number {
  return (
    b.businessDate.localeCompare(a.businessDate) ||
    b.shiftNo - a.shiftNo ||
    a.id.localeCompare(b.id)
  )
}

/**
 * Approved/week-locked rows are real completed settlements. Cancelled rows are terminal too, but
 * they explicitly discarded the work and reversed the funding, so they must not be mixed into the
 * completed-financial list.
 */
export function classifyShiftHistory<T extends CompletedShiftHistoryRow>(rows: readonly T[]): {
  completed: T[]
  cancelled: T[]
} {
  return {
    completed: rows.filter((row) => FINANCIALLY_COMPLETED_SHIFT_STATES.has(row.state)).sort(newestFirst),
    cancelled: rows.filter((row) => row.state === 'cancelled').sort(newestFirst),
  }
}

/**
 * Sum the selected completed period without ever converting money to floating-point `Number`.
 * Missing legacy snapshots stay visible via `missingCount` and do not invent zero-valued detail.
 */
export function completedShiftFinancialTotals<T extends { financial?: CompletedShiftFinancial | null }>(
  rows: readonly T[],
): CompletedShiftFinancialTotals {
  const financial = rows.flatMap((row) => row.financial == null ? [] : [row.financial])
  const total = (pick: (row: CompletedShiftFinancial) => string): string =>
    formatMinor(sum(financial.map((row) => parseMinor(pick(row)))))

  return {
    availableCount: financial.length,
    missingCount: rows.length - financial.length,
    deliveryFees: total((row) => row.deliveryFees),
    companyShare: total((row) => row.companyShare),
    netDriverShare: total((row) => row.netDriverShare),
    deductions: total((row) => row.deductions),
    variance: total((row) => row.variance),
    cashShortageReceivable: total((row) => row.cashShortageReceivable),
    officeReturn: total((row) => row.officeReturn),
  }
}
