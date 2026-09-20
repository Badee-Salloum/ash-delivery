import type {
  AssetPaidFrom,
  CalendarDate,
  CompanyDebtDirection,
  CompanyDebtOrigin,
  CompanyPaidFrom,
  Currency,
  Minor,
  RecurrenceKind,
} from '@ash/domain'

export interface CompanyDebtRecord {
  id: string
  branchId: string
  direction: CompanyDebtDirection
  partyName: string
  partyKey: string
  currency: Currency
  principal: Minor
  sypMinorPerUsd: bigint | null
  openedOn: CalendarDate
  businessDate: CalendarDate
  dueOn: CalendarDate | null
  note: string | null
  origin: CompanyDebtOrigin
  expenseCategoryId: string | null
  incomeCategoryId: string | null
  costCenterKind: 'general' | 'vehicle' | null
  vehicleId: string | null
  assetId: string | null
  journalEntryId: number
  createdBy: string
  createdAtMs: number
}

export interface CompanyDebtEventRecord {
  id: string
  debtId: string
  branchId: string
  kind: 'payment' | 'writeoff'
  amount: Minor
  source: CompanyPaidFrom | null
  sypMinorPerUsd: bigint | null
  occurredOn: CalendarDate
  businessDate: CalendarDate
  reason: string
  journalEntryId: number
  createdBy: string
  createdAtMs: number
}

export interface FixedAssetRecord {
  id: string
  branchId: string
  kind: 'vehicle' | 'equipment' | 'property' | 'other'
  vehicleId: string | null
  name: string
  currency: Currency
  price: Minor
  sypMinorPerUsd: bigint | null
  purchasedOn: CalendarDate
  businessDate: CalendarDate
  usefulMonths: 36
  paidNow: Minor
  paidFrom: AssetPaidFrom
  debtId: string | null
  description: string
  journalEntryId: number
  createdBy: string
  createdAtMs: number
}

export interface AssetDepreciationPeriodRecord {
  assetId: string
  period: number
  periodMonth: CalendarDate
  amount: Minor
}

/**
 * A human-confirmed payment promise for the one payable created by a financed fixed asset.
 *
 * It is deliberately not a debt payment: the underlying `CompanyDebtEventRecord` remains the
 * sole monetary fact. This row only supplies the recurring reminder and its default source.
 */
export interface AssetInstallmentPlanRecord {
  /** Client-owned UUID: identity and create-retry key. */
  id: string
  assetId: string
  debtId: string
  branchId: string
  currency: Currency
  amount: Minor
  paidFrom: CompanyPaidFrom
  scheduleKind: RecurrenceKind
  weekday: number | null
  intervalDays: number | null
  startsOn: CalendarDate
  active: boolean
  /** The first calendar date no longer generated after a reasoned deactivation. */
  deactivatedOn: CalendarDate | null
  deactivatedAtMs: number | null
  deactivatedBy: string | null
  deactivationReason: string | null
  createdBy: string
  createdAtMs: number
}

/** One human resolution of one generated asset-installment due date. */
export interface AssetInstallmentOccurrenceRecord {
  /** Client-owned UUID: the payment or skip retry key. */
  id: string
  planId: string
  branchId: string
  dueDate: CalendarDate
  status: 'paid' | 'skipped'
  /** The existing immutable debt-payment fact when paid; null for a skip. */
  debtEventId: string | null
  /** Required for a skip; payment details live on the debt event. */
  reason: string | null
  actedBy: string
  actedAtMs: number
}

export interface DepreciationAllocationRecord {
  transferId: string
  assetId: string
  period: number
  amount: Minor
}

export interface DepreciationTransferRecord {
  id: string
  branchId: string
  currency: Currency
  amount: Minor
  expectedAmount: Minor
  sypMinorPerUsd: bigint | null
  asOfMonth: CalendarDate
  businessDate: CalendarDate
  reason: string
  journalEntryId: number
  createdBy: string
  createdAtMs: number
}

export interface DepreciationReleaseRecord {
  id: string
  branchId: string
  currency: Currency
  amount: Minor
  sypMinorPerUsd: bigint | null
  occurredOn: CalendarDate
  businessDate: CalendarDate
  reason: string
  journalEntryId: number
  createdBy: string
  createdAtMs: number
}

/** Immutable company-finance facts written beside their guarded journals. */
export interface CompanyFinanceRepo {
  getDebt(id: string): Promise<CompanyDebtRecord | null>
  listDebts(companyBranchId: string): Promise<CompanyDebtRecord[]>
  createDebt(row: CompanyDebtRecord): Promise<void>
  getDebtEvent(id: string): Promise<CompanyDebtEventRecord | null>
  listDebtEvents(debtId: string): Promise<CompanyDebtEventRecord[]>
  createDebtEvent(row: CompanyDebtEventRecord): Promise<void>

  getAsset(id: string): Promise<FixedAssetRecord | null>
  getAssetByVehicle(vehicleId: string): Promise<FixedAssetRecord | null>
  listAssets(companyBranchId: string): Promise<FixedAssetRecord[]>
  createAsset(row: FixedAssetRecord): Promise<void>
  listAssetSchedule(assetId?: string): Promise<AssetDepreciationPeriodRecord[]>
  createAssetSchedule(rows: readonly AssetDepreciationPeriodRecord[]): Promise<void>

  getAssetInstallmentPlan(id: string): Promise<AssetInstallmentPlanRecord | null>
  /** All plans owned by one fixed asset, newest plan last. */
  listAssetInstallmentPlans(assetId: string, includeInactive?: boolean): Promise<AssetInstallmentPlanRecord[]>
  /** Company-wide read used by the due-reminders feed. */
  listInstallmentPlans(companyBranchId: string, includeInactive?: boolean): Promise<AssetInstallmentPlanRecord[]>
  createAssetInstallmentPlan(row: AssetInstallmentPlanRecord): Promise<void>
  deactivateAssetInstallmentPlan(row: AssetInstallmentPlanRecord): Promise<void>
  getAssetInstallmentOccurrence(
    planId: string,
    dueDate: CalendarDate,
  ): Promise<AssetInstallmentOccurrenceRecord | null>
  /** Global occurrence id lookup: client retry keys cannot resolve two different dues. */
  getAssetInstallmentOccurrenceById(id: string): Promise<AssetInstallmentOccurrenceRecord | null>
  listAssetInstallmentOccurrencesForPlan(planId: string): Promise<AssetInstallmentOccurrenceRecord[]>
  listAssetInstallmentOccurrences(
    companyBranchId: string,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<AssetInstallmentOccurrenceRecord[]>
  countAssetInstallmentOccurrencesBefore(planId: string, before: CalendarDate): Promise<number>
  createAssetInstallmentOccurrence(row: AssetInstallmentOccurrenceRecord): Promise<void>

  listDepreciationAllocations(companyBranchId: string, currency?: Currency): Promise<DepreciationAllocationRecord[]>
  createDepreciationTransfer(
    row: DepreciationTransferRecord,
    allocations: readonly DepreciationAllocationRecord[],
  ): Promise<void>
  listDepreciationTransfers(companyBranchId: string): Promise<DepreciationTransferRecord[]>
  createDepreciationRelease(row: DepreciationReleaseRecord): Promise<void>
  listDepreciationReleases(companyBranchId: string): Promise<DepreciationReleaseRecord[]>
}
