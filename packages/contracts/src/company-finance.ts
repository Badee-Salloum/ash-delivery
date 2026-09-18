import type {
  AssetPaidFrom,
  CalendarDate,
  CompanyDebtDirection,
  CompanyDebtOrigin,
  CompanyPaidFrom,
  Currency,
  Minor,
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
  listDebtEvents(debtId: string): Promise<CompanyDebtEventRecord[]>
  createDebtEvent(row: CompanyDebtEventRecord): Promise<void>

  getAsset(id: string): Promise<FixedAssetRecord | null>
  getAssetByVehicle(vehicleId: string): Promise<FixedAssetRecord | null>
  listAssets(companyBranchId: string): Promise<FixedAssetRecord[]>
  createAsset(row: FixedAssetRecord): Promise<void>
  listAssetSchedule(assetId?: string): Promise<AssetDepreciationPeriodRecord[]>
  createAssetSchedule(rows: readonly AssetDepreciationPeriodRecord[]): Promise<void>

  listDepreciationAllocations(companyBranchId: string, currency?: Currency): Promise<DepreciationAllocationRecord[]>
  createDepreciationTransfer(
    row: DepreciationTransferRecord,
    allocations: readonly DepreciationAllocationRecord[],
  ): Promise<void>
  listDepreciationTransfers(companyBranchId: string): Promise<DepreciationTransferRecord[]>
  createDepreciationRelease(row: DepreciationReleaseRecord): Promise<void>
  listDepreciationReleases(companyBranchId: string): Promise<DepreciationReleaseRecord[]>
}
