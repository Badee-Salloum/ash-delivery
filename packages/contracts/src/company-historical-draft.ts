import type { Currency } from '@ash/domain'

/** Administrative source evidence only. None of these snapshots is a journal or a payment. */
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
  account: 'owner_funding' | 'opening' | null
  historicalRate: string | null
  /** Frozen evidence in integer SYP minor per USD; never a live FX-day lookup. */
  sypMinorPerUsd: string | null
  rateBasis: 'documented' | 'estimated' | null
  fromCurrency: Currency | null
  fromAmount: string | null
  toCurrency: Currency | null
  toAmount: string | null
  sourceUnit: string | null
  receiptReference: string | null
  /** Source context only; this does not transfer or credit the branch. */
  branchId: string | null
  /** Optional evidence link; this does not pay, recognize or depreciate an asset. */
  assetId: string | null
}

export interface CompanyHistoricalDraftIdentity {
  id: string
  companyBranchId: string
  createdBy: string
  createdAtMs: number
  status: 'draft'
}

/** One attributed append-only revision also stores the original UUID retry outcome. */
export interface CompanyHistoricalDraftRevision {
  draftId: string
  version: number
  expectedVersion: number
  requestId: string
  requestHash: string
  actorId: string
  createdAtMs: number
  payload: HistoricalDraftPayload
}

export interface CompanyHistoricalDraft extends CompanyHistoricalDraftIdentity {
  version: number
  updatedBy: string
  updatedAtMs: number
  payload: HistoricalDraftPayload
  revisions: CompanyHistoricalDraftRevision[]
}

export interface CompanyHistoricalDraftRepo {
  get(id: string): Promise<CompanyHistoricalDraft | null>
  list(companyBranchId: string): Promise<CompanyHistoricalDraft[]>
  getByRequest(requestId: string): Promise<CompanyHistoricalDraftRevision | null>
  /** The initial identity and version are one transaction; version one expects zero. */
  create(identity: CompanyHistoricalDraftIdentity, revision: CompanyHistoricalDraftRevision): Promise<void>
  append(revision: CompanyHistoricalDraftRevision, expectedVersion: number): Promise<void>
}
