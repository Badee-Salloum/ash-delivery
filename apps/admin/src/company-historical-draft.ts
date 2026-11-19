import type { Currency } from '@ash/domain'

/** Wire DTO: administrative evidence only, deliberately separate from ledger movements. */
export interface HistoricalDraftPayload {
  type: 'deposit' | 'withdrawal' | 'expense' | 'income' | 'exchange' | 'branch_receipt' | 'branch_payment' | 'asset_payment' | 'refund'
  occurredOn: string
  occurredPrecision: 'day' | 'month'
  occurredMonth: string | null
  description: string
  currency: Currency | null
  amount: string | null
  paidFrom: 'pocket' | 'owner_outside'
  categoryId: string | null
  account: 'opening' | 'owner_funding' | null
  historicalRate: string | null
  sypMinorPerUsd: string | null
  rateBasis: 'documented' | 'estimated' | null
  fromCurrency: Currency | null
  fromAmount: string | null
  toCurrency: Currency | null
  toAmount: string | null
  sourceUnit: string | null
  receiptReference: string | null
  branchId: string | null
  assetId: string | null
}
export interface CompanyHistoricalDraft {
  id: string
  companyBranchId: string
  status: 'draft'
  version: number
  payload: HistoricalDraftPayload
  revisions: Array<{ requestId: string; version: number; actorId: string; createdAtMs: number; payload: HistoricalDraftPayload }>
}
