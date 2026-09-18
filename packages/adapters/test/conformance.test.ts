import { COMPANY_BRANCH, CONFORMANCE_BRANCH, runConformanceSuite } from '@ash/testkit/conformance'
import type { BranchRecord, ShiftRecord } from '@ash/contracts'
import { minor } from '@ash/domain'
import { type MemoryLedgerRepo, createMemoryDeps } from '../src/memory/index.ts'

const NOW_MS = Date.UTC(2026, 6, 21, 5, 0, 0)
const USER = '22222222-2222-2222-2222-222222222222'

const conformanceShift = (): ShiftRecord => ({
  id: '55555555-5555-5555-5555-555555555555',
  branchId: '11111111-1111-1111-1111-111111111111',
  driverId: '77777777-7777-7777-7777-777777777777',
  vehicleId: '88888888-8888-8888-8888-888888888888',
  shiftNo: 1,
  businessDate: '2026-07-21',
  weekStartDate: '2026-07-19',
  state: 'draft',
  floatTranches: [],
  topupTranches: [],
  carriedTranches: [],
  keptAsReceivable: minor(0n),
  driverSharePaid: minor(0n),
  mediaSlotsStart: [],
  mediaSlotsEnd: [],
  odoStart: null,
  odoEnd: null,
  batteryStart: null,
  batteryEnd: null,
  endCashDeclared: null,
  endWalletDeclared: null,
  odoStartOcr: null,
  odoEndOcr: null,
  odoEndAnomalyConfirmedAt: null,
  odoEndAnomalyConfirmedBy: null,
  batteryStartOcr: null,
  endWalletDeclaredOcr: null,
  driverConfirmedAt: null,
  openApprovedAt: null,
  windowOpensAt: null,
  openApprovedBy: null,
  submittedAt: null,
  equationDiff: null,
  cashDiff: null,
  walletDiff: null,
  ordersHash: null,
  approvedBy: null,
  approvedAt: null,
  managerCharge: minor(0n),
  managerChargeReason: null,
})

const GOVERNORATE = '99999999-9999-9999-9999-999999999999'

const branchRow = (id: string, code: string, branchNo: number, kind: BranchRecord['kind']): BranchRecord => ({
  id,
  code,
  nameAr: code,
  nameEn: code,
  timezone: 'Asia/Damascus',
  governorateId: GOVERNORATE,
  branchNo,
  lat: null,
  lng: null,
  checkinRadiusM: 150,
  kind,
})

// The same suite the PostgreSQL adapters must pass. If these two ever disagree, one is wrong.
runConformanceSuite({
  label: 'in-memory',
  makeDeps: async () => {
    const deps = createMemoryDeps(NOW_MS)
    // What a migrated, seeded database holds: the branch, and the company row 0066 adds.
    deps.directory.branches.set(CONFORMANCE_BRANCH, branchRow(CONFORMANCE_BRANCH, 'DAM', 1, 'branch'))
    deps.directory.branches.set(COMPANY_BRANCH, branchRow(COMPANY_BRANCH, 'HQ', 0, 'company'))
    await deps.shifts.create(conformanceShift(), USER)
    return deps
  },
  plantFund: async (deps, branchId, fund) => {
    ;(deps.ledger as MemoryLedgerRepo).setFundCurrency(branchId, fund.code, fund.currency)
  },
})
