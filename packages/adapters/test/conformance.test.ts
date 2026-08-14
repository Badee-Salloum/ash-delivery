import { runConformanceSuite } from '@ash/testkit/conformance'
import type { ShiftRecord } from '@ash/contracts'
import { minor } from '@ash/domain'
import { createMemoryDeps } from '../src/memory/index.ts'

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
  openApprovedBy: null,
  submittedAt: null,
  equationDiff: null,
  cashDiff: null,
  walletDiff: null,
  ordersHash: null,
  approvedBy: null,
})

// The same suite the PostgreSQL adapters must pass. If these two ever disagree, one is wrong.
runConformanceSuite({
  label: 'in-memory',
  makeDeps: async () => {
    const deps = createMemoryDeps(NOW_MS)
    await deps.shifts.create(conformanceShift(), USER)
    return deps
  },
})
