import type {
  AssetDepreciationPeriodRecord,
  CompanyDebtEventRecord,
  CompanyDebtRecord,
  CompanyFinanceRepo,
  DepreciationAllocationRecord,
  DepreciationReleaseRecord,
  DepreciationTransferRecord,
  FixedAssetRecord,
} from '@ash/contracts'
import type { Currency } from '@ash/domain'

interface State {
  debts: CompanyDebtRecord[]
  debtEvents: CompanyDebtEventRecord[]
  assets: FixedAssetRecord[]
  schedule: AssetDepreciationPeriodRecord[]
  allocations: DepreciationAllocationRecord[]
  transfers: DepreciationTransferRecord[]
  releases: DepreciationReleaseRecord[]
}

const clone = <T>(value: T): T => structuredClone(value)
const duplicate = (code: string): Error & { code: string } => Object.assign(new Error(code), { code })

export class MemoryCompanyFinanceRepo implements CompanyFinanceRepo {
  private state: State = {
    debts: [], debtEvents: [], assets: [], schedule: [], allocations: [], transfers: [], releases: [],
  }

  snapshot(): State { return clone(this.state) }
  restore(state: State): void { this.state = clone(state) }

  async getDebt(id: string): Promise<CompanyDebtRecord | null> {
    return clone(this.state.debts.find((row) => row.id === id) ?? null)
  }
  async listDebts(companyBranchId: string): Promise<CompanyDebtRecord[]> {
    return clone(this.state.debts.filter((row) => row.branchId === companyBranchId))
  }
  async createDebt(row: CompanyDebtRecord): Promise<void> {
    if (this.state.debts.some((stored) => stored.id === row.id)) throw duplicate('DUPLICATE_COMPANY_DEBT')
    this.state.debts.push(clone(row))
  }
  async listDebtEvents(debtId: string): Promise<CompanyDebtEventRecord[]> {
    return clone(this.state.debtEvents.filter((row) => row.debtId === debtId))
  }
  async createDebtEvent(row: CompanyDebtEventRecord): Promise<void> {
    if (this.state.debtEvents.some((stored) => stored.id === row.id)) throw duplicate('DUPLICATE_COMPANY_DEBT_EVENT')
    this.state.debtEvents.push(clone(row))
  }

  async getAsset(id: string): Promise<FixedAssetRecord | null> {
    return clone(this.state.assets.find((row) => row.id === id) ?? null)
  }
  async getAssetByVehicle(vehicleId: string): Promise<FixedAssetRecord | null> {
    return clone(this.state.assets.find((row) => row.vehicleId === vehicleId) ?? null)
  }
  async listAssets(companyBranchId: string): Promise<FixedAssetRecord[]> {
    return clone(this.state.assets.filter((row) => row.branchId === companyBranchId))
  }
  async createAsset(row: FixedAssetRecord): Promise<void> {
    if (this.state.assets.some((stored) => stored.id === row.id || (row.vehicleId !== null && stored.vehicleId === row.vehicleId))) {
      throw duplicate('DUPLICATE_FIXED_ASSET')
    }
    this.state.assets.push(clone(row))
  }
  async listAssetSchedule(assetId?: string): Promise<AssetDepreciationPeriodRecord[]> {
    return clone(this.state.schedule.filter((row) => assetId === undefined || row.assetId === assetId))
  }
  async createAssetSchedule(rows: readonly AssetDepreciationPeriodRecord[]): Promise<void> {
    for (const row of rows) {
      if (this.state.schedule.some((stored) => stored.assetId === row.assetId && stored.period === row.period)) {
        throw duplicate('DUPLICATE_ASSET_SCHEDULE')
      }
      this.state.schedule.push(clone(row))
    }
  }

  async listDepreciationAllocations(
    companyBranchId: string,
    currency?: Currency,
  ): Promise<DepreciationAllocationRecord[]> {
    const assets = new Set(this.state.assets
      .filter((row) => row.branchId === companyBranchId && (currency === undefined || row.currency === currency))
      .map((row) => row.id))
    return clone(this.state.allocations.filter((row) => assets.has(row.assetId)))
  }
  async createDepreciationTransfer(
    row: DepreciationTransferRecord,
    allocations: readonly DepreciationAllocationRecord[],
  ): Promise<void> {
    if (this.state.transfers.some((stored) => stored.id === row.id)) throw duplicate('DUPLICATE_DEPRECIATION_TRANSFER')
    this.state.transfers.push(clone(row))
    this.state.allocations.push(...clone(allocations))
  }
  async listDepreciationTransfers(companyBranchId: string): Promise<DepreciationTransferRecord[]> {
    return clone(this.state.transfers.filter((row) => row.branchId === companyBranchId))
  }
  async createDepreciationRelease(row: DepreciationReleaseRecord): Promise<void> {
    if (this.state.releases.some((stored) => stored.id === row.id)) throw duplicate('DUPLICATE_DEPRECIATION_RELEASE')
    this.state.releases.push(clone(row))
  }
  async listDepreciationReleases(companyBranchId: string): Promise<DepreciationReleaseRecord[]> {
    return clone(this.state.releases.filter((row) => row.branchId === companyBranchId))
  }
}
