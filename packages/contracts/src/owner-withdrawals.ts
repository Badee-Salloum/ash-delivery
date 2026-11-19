import type { Currency } from '@ash/domain'

/** Read projection only. Amounts are exact decimal wire strings in their original currency. */
export interface OwnerWithdrawal {
  id: string
  journalEntryId: number
  journalEntryIds: number[]
  branchId: string
  branchNameAr: string
  branchNameEn: string
  source: 'company' | 'branch_cash' | 'branch_wallet'
  currency: Currency
  amount: string
  originalAmount: string
  occurredOn: string
  postingDate: string
  recordedAt: string
  occurrenceSource: 'recorded' | 'business_date'
  description: string
  reference: string | null
  sypMinorPerUsd: string | null
  status: 'active' | 'corrected'
  entries: Array<{
    id: number; eventType: string; businessDate: string; postingDate: string; reason: string | null
    lines: Array<{ fundCode: string; side: 'D' | 'C'; currency: Currency; amount: string }>
  }>
}

export interface OwnerWithdrawalsView {
  from: string
  to: string
  asOf: string
  basis: 'current_verified_original_withdrawals'
  /** Always all history through asOf, irrespective of the detail range. */
  totals: Record<Currency, string>
  periodTotals: Record<Currency, string>
  withdrawals: OwnerWithdrawal[]
}
