import type { CalendarDate, Currency, Minor } from '@ash/domain'

/** Operational registration is not a purchase, payment, debt or opening journal. */
export interface ExistingAssetRecord {
  id: string
  branchId: string
  vehicleId: string
  name: string
  currency: Currency
  price: Minor | null
  purchasedOn: CalendarDate | null
  useStartedOn: CalendarDate | null
  fundingSource: 'company' | 'owner_outside' | 'unknown'
  description: string
  status: 'draft' | 'registered' | 'sold'
  accountingStatus: 'pending_review' | 'approved' | 'needs_correction'
  version: number
  depreciation: ExistingAssetDepreciationPolicy | null
  recognition: ExistingAssetRecognition | null
  sale: ExistingAssetSaleRecord | null
  /** Financially linked edits remain proposals until their accounting consequences are reviewed. */
  pendingEdit?: ExistingAssetEditProposal | null
  /** Frozen calculation rows; future price revisions never recalculate completed months. */
  depreciationSchedule?: Array<{ period: number; periodMonth: CalendarDate; startsOn: CalendarDate; endsOn: CalendarDate; amount: Minor }>
  lastEditReview?: { requestId: string; effectiveOn: CalendarDate; reason: string; journalEntryId: number | null }
  createdBy: string
  createdAtMs: number
  updatedBy: string
  updatedAtMs: number
}

export interface ExistingAssetEditProposal {
  requestId: string
  sourceVersion: number
  vehicleId: string
  name: string
  currency: Currency
  price: Minor | null
  purchasedOn: CalendarDate | null
  useStartedOn: CalendarDate | null
  fundingSource: 'company' | 'owner_outside' | 'unknown'
  description: string
  reason: string
  requestedBy: string
  requestedAtMs: number
}

/** Approved calculation policy, not a posted expense and not reserve funding. */
export interface ExistingAssetDepreciationPolicy {
  startsOn: CalendarDate
  /** Frozen business date of activation; no new policy can charge an earlier date. */
  activatedOn: CalendarDate
  usefulMonths: number
  residualValue: Minor
  activatedBy: string
  activatedAtMs: number
  activationReason: string
}

/** Recognition may only link verified existing book entries. No default counterpart is inferred. */
export interface ExistingAssetRecognition {
  journalEntryId: number
  accountAssetId: string
  cost: Minor
  accumulatedDepreciation: Minor
  asOf: CalendarDate
  approvedBy: string
  approvedAtMs: number
  reason: string
}

/** A draft is not cash received, a buyer debt or a completed asset disposal. */
export interface ExistingAssetSaleRecord {
  id: string
  /** Undefined on older financial-disposal snapshots; documentary sale never posts a journal. */
  kind?: 'financial' | 'documentary'
  buyer: string
  currency: Currency
  price: Minor
  occurredOn: CalendarDate
  receivedAmount: Minor
  receiptDestination: 'company' | 'owner_outside'
  receiptEntryId: number | null
  debtId: string | null
  status: 'draft' | 'confirmed'
  disposalEntryId: number | null
  bookValue: Minor | null
  confirmedBy: string | null
  confirmedAtMs: number | null
  reason: string
}

/** Evidence deliberately has no allocatedAmount and never counts as an asset payment. */
export interface ExistingAssetEvidenceRecord {
  id: string
  assetId: string
  operationId: string | null
  journalEntryId: number | null
  mediaId: string | null
  description: string
  createdBy: string
  createdAtMs: number
}

/** Immutable request receipt + full revision. The current card is a guarded projection of it. */
export interface ExistingAssetEventRecord {
  id: string
  assetId: string
  branchId: string
  kind: 'register' | 'edit' | 'edit_confirm' | 'edit_reject' | 'depreciation_activate' | 'recognition_link' | 'sale_draft' | 'sale_confirm' | 'sale_documentary' | 'evidence_link'
  expectedVersion: number
  version: number
  requestFingerprint: string
  reason: string
  snapshot: ExistingAssetRecord
  createdBy: string
  createdAtMs: number
}

export interface ExistingAssetRepo {
  /** Separate, append-only payment allocations/reminders; never asset recognition or cash. */
  paymentEvents(branchId: string): Promise<ExistingAssetPaymentEvent[]>
  addPaymentEvent(row: ExistingAssetPaymentEvent): Promise<void>
  get(id: string): Promise<ExistingAssetRecord | null>
  getByVehicle(vehicleId: string): Promise<ExistingAssetRecord | null>
  list(companyBranchId: string): Promise<ExistingAssetRecord[]>
  getEvent(id: string): Promise<ExistingAssetEventRecord | null>
  listEvents(assetId: string): Promise<ExistingAssetEventRecord[]>
  /** Atomically persist the event and its optimistic-version current projection. */
  apply(event: ExistingAssetEventRecord): Promise<void>
  listEvidence(assetId: string): Promise<ExistingAssetEvidenceRecord[]>
  addEvidence(row: ExistingAssetEvidenceRecord): Promise<void>
  /** Correction approval must review any recognized/depreciating/sold card that uses this fact. */
  linkedToOperation(operationId: string, journalEntryId: number): Promise<ExistingAssetRecord[]>
}

export interface ExistingAssetPaymentEvent {
  id: string
  assetId: string
  branchId: string
  version: number
  kind: 'link' | 'unlink' | 'schedule' | 'cancel_schedule'
  requestHash: string
  reason: string
  data: {
    sourceKey?: string
    sourceHash?: string
    amount?: string
    currency?: Currency
    occurredOn?: CalendarDate
    paidFrom?: string
    description?: string
    newExpense?: boolean
    paymentId?: string
    supplier?: string
    reminderDays?: number
    priceSnapshot?: string
    baselinePaid?: string
    installments?: Array<{ dueOn: CalendarDate; amount: string }>
  }
  createdBy: string
  createdAtMs: number
}
