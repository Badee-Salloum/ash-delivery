import type { CalendarDate, CompanyPaidFrom, Currency } from '@ash/domain'

/** Extra historical evidence never changes an immutable journal or invents an exact day. */
export interface CompanyMovementMetadata {
  commandId: string
  branchId: string
  occurredPrecision: 'day' | 'month'
  occurredMonth: string | null
  rateBasis: 'documented' | 'estimated' | null
  sourceUnit: string | null
  receiptReference: string | null
  intakeSessionId: string | null
  /** Atomic direct edit/delete receipt. Stored on the immutable reversal, never on its target. */
  operationChange?: {
    action: 'edit' | 'delete'
    targetId: string
    replacementId: string | null
    requestHash: string
  }
}

/** Explicit, reviewed authority to append missing history to a nonempty live book. No cash reset. */
export interface CompanyHistoricalIntakeSession {
  id: string
  branchId: string
  from: CalendarDate
  to: CalendarDate
  reason: string
  reconciliationNote: string
  baselineEntryId: number
  baselinePockets: Record<Currency, string>
  reviewedSourceUnits: true
  reviewedExistingEntries: true
  createdBy: string
  createdAtMs: number
  closedBy: string | null
  closedAtMs: number | null
  closureReason: string | null
}

/** Money is serialized decimal text, so snapshots are JSON-safe and exact. */
export interface CompanyExpenseCorrectionValues {
  currency: Currency
  amount: string
  paidFrom: CompanyPaidFrom
  categoryId: string
  costCenterKind: 'general' | 'vehicle' | 'asset'
  vehicleId: string | null
  assetId: string | null
  receiptMediaId: string | null
  occurredOn: CalendarDate
  description: string
  /** SYP minor per USD, NOT a decimal money wire. Null exactly for SYP. */
  sypMinorPerUsd: string | null
  occurredPrecision: 'day' | 'month'
  occurredMonth: string | null
  rateBasis: 'documented' | 'estimated' | null
  sourceUnit: string | null
  receiptReference: string | null
}

/** Append-only revision of a correction request. A confirmed version cannot be edited. */
export interface CompanyMovementCorrection {
  id: string
  branchId: string
  targetId: string
  targetVersion: number
  /** Which currently effective command will be reversed, not necessarily the first receipt. */
  effectiveCommandId: string
  version: number
  status: 'draft' | 'confirmed'
  reason: string
  values: CompanyExpenseCorrectionValues
  financial: boolean
  blockingReasons: string[]
  reversalId: string
  replacementId: string
  reversalEntryId: number | null
  replacementEntryId: number | null
  /** Globally unique UUID for this revision/action, separate from the correction identity. */
  actionId: string
  actionFingerprint: string
  createdBy: string
  createdAtMs: number
  actedBy: string
  actedAtMs: number
  confirmedBy: string | null
  confirmedAtMs: number | null
}

export interface CompanyMovementReviewRepo {
  listHistoricalSourceCorrections(branchId: string, sourceReference?: string): Promise<CompanyHistoricalSourceCorrection[]>
  findHistoricalSourceCorrection(id: string): Promise<CompanyHistoricalSourceCorrection | null>
  saveHistoricalSourceCorrection(row: CompanyHistoricalSourceCorrection, expectedVersion: number): Promise<void>
  findMetadata(commandId: string): Promise<CompanyMovementMetadata | null>
  listMetadata(branchId: string): Promise<CompanyMovementMetadata[]>
  createMetadata(row: CompanyMovementMetadata): Promise<void>
  getIntakeSession(id: string): Promise<CompanyHistoricalIntakeSession | null>
  listIntakeSessions(branchId: string): Promise<CompanyHistoricalIntakeSession[]>
  createIntakeSession(row: CompanyHistoricalIntakeSession): Promise<void>
  closeIntakeSession(row: CompanyHistoricalIntakeSession): Promise<void>
  getCorrection(id: string): Promise<CompanyMovementCorrection | null>
  getCorrectionByAction(actionId: string): Promise<CompanyMovementCorrection | null>
  listCorrections(branchId: string, targetId?: string): Promise<CompanyMovementCorrection[]>
  listCorrectionHistory(id: string): Promise<CompanyMovementCorrection[]>
  /** Expected previous request version; zero creates. Also checks the live target version. */
  saveCorrection(row: CompanyMovementCorrection, expectedVersion: number): Promise<void>
}

/** Administrative effective source revision. Immutable receipts and cash remain unchanged. */
export interface CompanyHistoricalSourceValues {
  currency: Currency | null
  amount: string | null
  occurredOn: CalendarDate
  description: string
  excluded: boolean
  sypMinorPerUsd: string | null
  rateBasis: 'documented' | 'estimated' | null
}
export interface CompanyHistoricalSourceCorrection {
  id: string
  branchId: string
  sourceReference: string
  version: number
  before: CompanyHistoricalSourceValues
  values: CompanyHistoricalSourceValues
  reason: string
  fingerprint: string
  createdBy: string
  createdAtMs: number
}
