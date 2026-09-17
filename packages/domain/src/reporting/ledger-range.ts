/**
 * The shape rules of the range read model (`LedgerRangeSource`), shared by both adapters.
 *
 * The dashboard used to walk the ledger a financial week at a time — up to 520 reads for a
 * ten-year window — and total the lines in the route. The range source answers the same question
 * with one aggregate over journal lines between two business dates. These predicates decide which
 * lines that aggregate keeps, and the comparator fixes the order, so the PostgreSQL and in-memory
 * twins return byte-identical rows no matter what collation the database uses.
 */

import { COMPANY_BOX_FUND } from './treasury-flow.ts'

/**
 * A legacy driver-share line, exactly as `/dashboard/profit` has always read it: the `share_split`
 * credit and the cash-deduction debit on the driver's share payable, and the part of a deduction
 * that overflowed into his cash receivable. Shifts with an immutable settlement use the snapshot's
 * `baseDriverShare` instead; these lines are the fallback for everything older.
 */
export function isLegacyDriverShareLine(fundCode: string, role: string | null | undefined): boolean {
  return (
    (fundCode.startsWith('driver_share_payable:') && (role === 'driver_share' || role === 'cash_deduction_share')) ||
    (fundCode.startsWith('driver_receivable_cash:') && role === 'cash_deduction_overflow')
  )
}

/** The GROSS block share credited by `share_split` — the fee bridge's driver row. */
export function isDriverBlockLine(fundCode: string, role: string | null | undefined): boolean {
  return fundCode.startsWith('driver_share_payable:') && role === 'driver_share'
}

/**
 * Does the range aggregate keep this line? Only what the dashboard reads: the P&L funds, every
 * cost centre (the profit classifier decides which of them count), the company fund, and the
 * legacy driver-share lines. Office boxes, driver cash and wallets are positions, not flows, and
 * stay out of the aggregate.
 */
export function isRangeReportLine(fundCode: string, role: string | null | undefined): boolean {
  return (
    fundCode === 'company_revenue' ||
    fundCode === 'other_income' ||
    fundCode === 'yalago_income' ||
    fundCode === COMPANY_BOX_FUND ||
    fundCode.startsWith('cost_center:') ||
    isLegacyDriverShareLine(fundCode, role)
  )
}

export interface LedgerRangeLineKey {
  readonly businessDate: string
  readonly eventType: string
  readonly fundCode: string
  readonly role: string | null
  readonly side: 'D' | 'C'
  readonly currency: string
}

/** Code-unit order, never locale order: both adapters must agree whatever the DB collation is. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Canonical order: date, event, fund, role (none first), side, currency. */
export function compareLedgerRangeLines(a: LedgerRangeLineKey, b: LedgerRangeLineKey): number {
  return (
    byCodeUnit(a.businessDate, b.businessDate) ||
    byCodeUnit(a.eventType, b.eventType) ||
    byCodeUnit(a.fundCode, b.fundCode) ||
    (a.role === b.role ? 0 : a.role === null ? -1 : b.role === null ? 1 : byCodeUnit(a.role, b.role)) ||
    byCodeUnit(a.side, b.side) ||
    byCodeUnit(a.currency, b.currency)
  )
}
