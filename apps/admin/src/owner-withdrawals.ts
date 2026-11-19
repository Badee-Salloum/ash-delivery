import type { OwnerWithdrawal } from '@ash/client'
import { isCalendarDate, type Currency } from '@ash/domain'

export interface OwnerWithdrawalFilters {
  from: string
  to: string
  currency: 'all' | Currency
  source: string
}
export const withdrawalSourceKey = (row: OwnerWithdrawal): string => `${row.source}:${row.branchId}`
export function validWithdrawalFilters(filters: OwnerWithdrawalFilters, today: string): boolean {
  return isCalendarDate(filters.from) && isCalendarDate(filters.to) && filters.from >= '2000-01-01' &&
    filters.from <= filters.to && filters.to <= today
}
/** Details only. The full-history server totals must never be recomputed from this projection. */
export function filterOwnerWithdrawals(rows: OwnerWithdrawal[], filters: OwnerWithdrawalFilters, today: string): OwnerWithdrawal[] {
  if (!validWithdrawalFilters(filters, today)) return []
  return rows.filter(row => row.occurredOn >= filters.from && row.occurredOn <= filters.to &&
    (filters.currency === 'all' || row.currency === filters.currency) &&
    (filters.source === 'all' || withdrawalSourceKey(row) === filters.source))
    .toSorted((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.recordedAt.localeCompare(a.recordedAt) ||
      b.journalEntryId - a.journalEntryId || a.id.localeCompare(b.id))
}
