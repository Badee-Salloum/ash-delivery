import type { Currency } from '@ash/domain'

export interface DashboardSnapshot {
  businessDate: string
  revenue: { feesSyp: string; feesUsd: string | null; fxProvisional: boolean }
  orders: {
    total: number
    perDriver: Array<{ driverId: string; name: string; code: string | null; orders: number; feesSyp: string }>
  }
  companyShareSinceSunday: string
  fleet: { ready: number; charging: number; maintenance: number; stopped: number }
  completeness: { openShifts: number; awaitingApproval: number; missingEndPackage: number; suspended: number }
}

export interface ShiftSummaryTally {
  shifts: number
  doubles: number
  short: { count: number; minutes: number }
  workedMinutes: number
  orders: number
  feesSyp: string
  companyShareSyp: string | null
}

export interface ShiftsSummary {
  from: string
  to: string
  companyShareVisible: boolean
  completed: number
  byPattern: { day: number; evening: number; full: number; unknown: number }
  doubles: { total: number; fullShifts: number; multiShiftDays: number }
  short: { count: number; minutes: number }
  met: number
  unjudged: number
  abandoned: number
  running: {
    count: number
    open: number
    suspended: number
    overTarget: number
    slots: { day: number; evening: number; unknown: number }
  }
  pendingReview: number
  totals: {
    orders: number
    feesSyp: string
    feesUsd: string | null
    fxProvisional: boolean
    companyShareSyp: string | null
    km: number
    workedMinutes: number
  }
  byDriver: Array<
    ShiftSummaryTally & {
      driverId: string
      name: string
      nameEn: string | null
      code: string | null
    }
  >
}

export interface ProfitDay {
  businessDate: string
  companyShareSyp: string
  otherIncomeSyp: string
  expenseSyp: string
  vehicleCostSyp: string
  netProfitSyp: string
  branchNetProfitSyp: string
  companyNetProfitSyp: string
  combinedNetProfitSyp: string
}

export interface ProfitDigest {
  from: string
  to: string
  companyShareSyp: string
  driverShareSyp: string
  yalagoShareSyp: string
  otherIncomeSyp: string
  expenseSyp: string
  operatingCostSyp: string
  vehicleCostSyp: string
  lossSyp: string
  feeTotalSyp: string
  netProfitSyp: string
  branchNetProfitSyp: string
  companyIncomeSyp: string
  companyExpenseSyp: string
  companyNetProfitSyp: string
  combinedNetProfitSyp: string
  days: ProfitDay[]
}

export interface FleetPerformanceTally {
  shifts: number
  km: number
  kmUnrecorded: number
  orders: number
  feesSyp: string
  companyShareSyp?: string
  vehicleCostSyp?: string
  contributionSyp?: string
}

export interface FleetPerformance {
  from: string
  to: string
  financeVisible: boolean
  costsFrom?: string | null
  unattributedVehicleCostSyp?: string
  totals: FleetPerformanceTally
  vehicles: Array<
    FleetPerformanceTally & {
      vehicleId: string
      code: string | null
      groundNo: string | null
      active: boolean | null
    }
  >
}

export interface TreasuryDigest {
  from: string
  to: string
  capital: {
    officeCash: string
    officeWallet: string
    receivablesCash: string
    receivablesWallet: string
    advancesCash?: string
    advancesWallet?: string
    advancesTotal?: string
    officePosition: string
    cashPosition: string
    walletPosition: string
    cashTarget: string
    walletTarget: string
    cashDelta: string
    walletDelta: string
    activeCustodyCash: string
    activeCustodyWallet: string
    activeCustodyTotal: string
    deltaProvisional: boolean
    activeShiftCount: number
    workingCapitalTotal: string
    workingCapitalDelta: string
    restorationDelta: string
    total: string
    target: string
    delta: string
  }
  companyProfit: string
  companyFund: string
  fundIn: string
  fundOut: string
  fundNet: string
  days: Array<{ businessDate: string; in: string; out: string; net: string }>
}

export interface CompanyFundLegacyDigest {
  total: string
  usd: string
  reserve: { SYP_NEW: string; USD: string }
  depreciationDue: { SYP_NEW: string; USD: string }
  assets: { SYP_NEW: string; USD: string }
  debts: Record<'SYP_NEW' | 'USD', { payable: string; receivable: string }>
  branches: Array<{ branchId: string; code: string; nameAr: string; balance: string; clearing: string; cutOver: boolean }>
}

export interface ExpiringDocument {
  id: string
  kind: string
  ownerKind: 'driver' | 'vehicle'
  ownerName: string | null
  driverId: string | null
  vehicleId: string | null
  expiresOn: string | null
  status: string
}

/** Reserved for C2/C6 responses; keeping currency explicit prevents a bare cross-currency total. */
export interface CurrencyAmount {
  currency: Currency
  amount: string
}
