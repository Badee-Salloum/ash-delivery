import type { Page, Route } from '@playwright/test'

/**
 * Deliberately sealed visual fixtures for the two new manager surfaces.  These specs run against
 * Vite, never an authenticated service: an unrecognised request gets a local 503 instead of being
 * allowed through the development proxy.
 */
async function fulfill(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

const dashboardSnapshot = {
  businessDate: '2026-09-20',
  revenue: { feesSyp: '432500.00', feesUsd: '332.69', fxProvisional: false },
  orders: { total: 86, perDriver: [] },
  companyShareSinceSunday: '147000.00',
  fleet: { ready: 9, charging: 1, maintenance: 0, stopped: 0 },
  completeness: { openShifts: 4, awaitingApproval: 2, missingEndPackage: 0, suspended: 0 },
}

const sevenDays = {
  from: '2026-09-14',
  to: '2026-09-20',
  profitVisible: false,
  days: [
    { businessDate: '2026-09-20', shifts: 4, ordinaryShifts: 3, doubleShifts: 1, orders: 31, feesSyp: '155000.00' },
    { businessDate: '2026-09-19', shifts: 5, ordinaryShifts: 4, doubleShifts: 1, orders: 22, feesSyp: '110000.00' },
    { businessDate: '2026-09-18', shifts: 3, ordinaryShifts: 2, doubleShifts: 1, orders: 14, feesSyp: '70000.00' },
    { businessDate: '2026-09-17', shifts: 4, ordinaryShifts: 4, doubleShifts: 0, orders: 11, feesSyp: '55000.00' },
    { businessDate: '2026-09-16', shifts: 2, ordinaryShifts: 2, doubleShifts: 0, orders: 8, feesSyp: '40000.00' },
    { businessDate: '2026-09-15', shifts: 0, ordinaryShifts: 0, doubleShifts: 0, orders: 0, feesSyp: '0.00' },
    { businessDate: '2026-09-14', shifts: 1, ordinaryShifts: 1, doubleShifts: 0, orders: 0, feesSyp: '0.00' },
  ],
}

const rangeMeta = {
  today: '2026-09-20',
  goLiveBusinessDate: '2026-09-01',
  firstActivityDate: '2026-09-01',
  epoch: '2026-09-01',
  weekStart: '2026-09-20',
  monthStart: '2026-09-01',
  dayStartMinutes: 240,
  maxRangeDays: 366,
}

const shiftsSummary = {
  from: '2026-09-01',
  to: '2026-09-20',
  companyShareVisible: false,
  completed: 19,
  byPattern: { day: 11, evening: 6, full: 2, unknown: 0 },
  doubles: { total: 2, fullShifts: 2, multiShiftDays: 0 },
  short: { count: 1, minutes: 38 },
  met: 18,
  unjudged: 0,
  abandoned: 0,
  running: { count: 4, open: 4, suspended: 0, overTarget: 0, slots: { day: 3, evening: 1, unknown: 0 } },
  pendingReview: 2,
  totals: { orders: 86, feesSyp: '432500.00', feesUsd: '332.69', fxProvisional: false, companyShareSyp: null, km: 315, workedMinutes: 8640 },
  byDriver: [],
}

const fleetPerformance = {
  from: '2026-09-01',
  to: '2026-09-20',
  financeVisible: false,
  costsFrom: null,
  unattributedVehicleCostSyp: '0.00',
  totals: { shifts: 19, km: 315, kmUnrecorded: 0, orders: 86, feesSyp: '432500.00' },
  vehicles: [],
}

const profitDigest = {
  from: '2026-09-01', to: '2026-09-20', companyShareSyp: '147000.00', driverShareSyp: '98000.00', yalagoShareSyp: '73500.00',
  otherIncomeSyp: '0.00', expenseSyp: '12000.00', operatingCostSyp: '12000.00', vehicleCostSyp: '0.00', lossSyp: '0.00', feeTotalSyp: '432500.00',
  netProfitSyp: '135000.00', branchNetProfitSyp: '135000.00', companyIncomeSyp: '0.00', companyExpenseSyp: '0.00', companyNetProfitSyp: '0.00', combinedNetProfitSyp: '135000.00',
  days: [{ businessDate: '2026-09-20', companyShareSyp: '62000.00', otherIncomeSyp: '0.00', expenseSyp: '3000.00', vehicleCostSyp: '0.00', netProfitSyp: '59000.00', branchNetProfitSyp: '59000.00', companyNetProfitSyp: '0.00', combinedNetProfitSyp: '59000.00' }],
}

const treasuryDigest = {
  from: '2026-09-01', to: '2026-09-20', companyProfit: '147000.00', companyFund: '650000.00', fundIn: '0.00', fundOut: '0.00', fundNet: '0.00', days: [],
  capital: {
    officeCash: '120000.00', officeWallet: '0.00', receivablesCash: '0.00', receivablesWallet: '0.00', advancesCash: '0.00', advancesWallet: '0.00', advancesTotal: '0.00',
    officePosition: '120000.00', cashPosition: '120000.00', walletPosition: '0.00', cashTarget: '120000.00', walletTarget: '0.00', cashDelta: '0.00', walletDelta: '0.00',
    activeCustodyCash: '0.00', activeCustodyWallet: '0.00', activeCustodyTotal: '0.00', deltaProvisional: false, activeShiftCount: 0, workingCapitalTotal: '120000.00', workingCapitalDelta: '0.00', restorationDelta: '0.00', total: '120000.00', target: '120000.00', delta: '0.00',
  },
}

const companyFundDigest = {
  total: '650000.00', usd: '1500.00', reserve: { SYP_NEW: '78000.00', USD: '100.00' }, depreciationDue: { SYP_NEW: '0.00', USD: '16.67' }, assets: { SYP_NEW: '0.00', USD: '583.33' },
  debts: { SYP_NEW: { payable: '0.00', receivable: '0.00' }, USD: { payable: '420.00', receivable: '0.00' } },
  branches: [{ branchId: 'visual-branch-1', code: 'VIS', nameAr: 'فرع الاختبار', nameEn: 'Visual branch', balance: '125000.00', clearing: '-125000.00', cutOver: true }],
}

/**
 * A privileged desktop snapshot shows the financial columns; the mobile snapshot intentionally
 * takes the branch-manager route, proving the same component respects the omission on the wire.
 */
export async function stubSevenDayDashboard(page: Page, { privileged = false }: { privileged?: boolean } = {}): Promise<void> {
  const sevenDayResponse = privileged
    ? {
        ...sevenDays,
        profitVisible: true,
        days: sevenDays.days.map((day) => ({
          ...day,
          companyShareSyp: day.feesSyp === '0.00' ? '0.00' : '40.00',
          expensesSyp: day.feesSyp === '0.00' ? '0.00' : '10.00',
          netProfitSyp: day.feesSyp === '0.00' ? '0.00' : '30.00',
        })),
      }
    : sevenDays
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/me') return fulfill(route, {
      userId: privileged ? 'visual-general-manager' : 'visual-branch-manager', roleKey: privileged ? 'general_manager' : 'branch_manager', branchId: 'visual-branch-1', driverId: null, businessDate: '2026-09-20',
    })
    if (path === '/api/notifications') return fulfill(route, { unreadCount: 0, notifications: [] })
    if (path === '/api/shifts') return fulfill(route, { shifts: [] })
    if (path === '/api/dashboard/meta') return fulfill(route, rangeMeta)
    if (path === '/api/dashboard/working-now') return fulfill(route, { asOf: '2026-09-20T10:00:00.000Z', drivers: 4, vehicles: 4 })
    if (path === '/api/dashboard/last-seven-days') return fulfill(route, sevenDayResponse)
    if (path === '/api/dashboard/shifts-summary') return fulfill(route, shiftsSummary)
    if (path === '/api/dashboard/fleet-performance') return fulfill(route, fleetPerformance)
    if (path === '/api/dashboard/profit') return fulfill(route, profitDigest)
    if (path === '/api/dashboard/treasury') return fulfill(route, treasuryDigest)
    if (path === '/api/company-fund') return fulfill(route, companyFundDigest)
    if (path === '/api/dashboard') return fulfill(route, dashboardSnapshot)
    if (path === '/api/documents/expiring') return fulfill(route, { documents: [] })
    return fulfill(route, { error: 'visual_fixture_unavailable' }, 503)
  })
}

const companyOverview = {
  pockets: { SYP_NEW: '650000.00', USD: '1500.00' },
  reserves: { SYP_NEW: '78000.00', USD: '100.00' },
  period: {
    SYP_NEW: { income: '800000.00', expense: '150000.00', deposits: '0.00', withdrawals: '0.00', net: '650000.00' },
    USD: { income: '1500.00', expense: '0.00', deposits: '0.00', withdrawals: '0.00', net: '1500.00' },
  },
  branches: [{ branchId: 'visual-branch-1', companyBox: '125000.00', clearing: '-125000.00', balanced: true }],
}

const installmentPlan = {
  id: 'visual-plan-1',
  assetId: 'visual-asset-1',
  debtId: 'visual-debt-1',
  branchId: 'visual-branch-1',
  currency: 'USD',
  amount: '100.00',
  paidFrom: 'pocket',
  scheduleKind: 'monthly_first',
  weekday: null,
  intervalDays: null,
  startsOn: '2026-09-01',
  active: true,
  deactivatedOn: null,
  deactivatedAtMs: null,
  deactivatedBy: null,
  deactivationReason: null,
  createdBy: 'visual-system-admin',
  createdAtMs: 1_789_776_000_000,
}

const companyAssets = [{
  id: 'visual-asset-1',
  kind: 'equipment',
  name: 'Thermal delivery printer',
  currency: 'USD',
  price: '600.00',
  purchasedOn: '2026-09-01',
  bookValue: '583.33',
  outstanding: '420.00',
  depreciationDue: '16.67',
  debtId: 'visual-debt-1',
  installmentPlans: [installmentPlan],
  activeInstallmentPlan: installmentPlan,
}, {
  id: 'visual-asset-2',
  kind: 'equipment',
  name: 'Dispatch tablet',
  currency: 'SYP_NEW',
  price: '300000.00',
  purchasedOn: '2026-09-15',
  bookValue: '291666.67',
  outstanding: '240000.00',
  depreciationDue: '8333.33',
  debtId: 'visual-debt-2',
  installmentPlans: [],
  activeInstallmentPlan: null,
}]

const installmentDue = {
  today: '2026-09-20',
  from: '2026-09-13',
  to: '2026-09-27',
  olderUnresolved: 1,
  due: [{
    ...installmentPlan,
    assetName: 'Thermal delivery printer',
    dueDate: '2026-09-20',
    status: 'today',
    outstanding: '420.00',
    amountDue: '100.00',
  }],
}

const depreciation = {
  asOfMonth: '2026-09-01',
  currencies: {
    SYP_NEW: { totalDue: '0.00', transferAmount: '0.00', remainingDue: '0.00', allocations: [] },
    USD: { totalDue: '16.67', transferAmount: '16.67', remainingDue: '0.00', allocations: [] },
  },
}

/**
 * A system-admin fixture is required because Company Fund is intentionally not a branch-manager
 * screen. It responds to every eager load from the fund tabs and to the two write endpoints the
 * visual tests can reach, so an accidental confirmation never touches a real ledger.
 */
export async function stubCompanyFund(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/me') return fulfill(route, {
      userId: 'visual-system-admin', roleKey: 'system_admin', branchId: null, driverId: null, businessDate: '2026-09-20',
    })
    if (path === '/api/branches') return fulfill(route, {
      branches: [{ id: 'visual-branch-1', code: 'VIS', nameAr: 'فرع الاختبار', nameEn: 'Visual branch' }],
    })
    if (path === '/api/notifications') return fulfill(route, { unreadCount: 0, notifications: [] })
    if (path === '/api/shifts') return fulfill(route, { shifts: [] })
    if (path === '/api/company/overview') return fulfill(route, companyOverview)
    if (path === '/api/company/movements') return fulfill(route, {
      movements: [{
        entry: { id: 17, businessDate: '2026-09-19', eventType: 'exchange', reason: 'Visual fixture exchange', sypMinorPerUsd: '15000' },
        command: {
          id: 'visual-command-1', kind: 'exchange', fromCurrency: 'USD', fromAmount: '100.00',
          toCurrency: 'SYP_NEW', toAmount: '15000.00', sypMinorPerUsd: '15000', reason: 'Visual fixture exchange',
        },
      }],
    })
    if (path === '/api/company/debts') return fulfill(route, {
      debts: [{ id: 'visual-debt-1', direction: 'payable', partyName: 'Visual supplier', currency: 'USD', principal: '420.00', outstanding: '420.00', openedOn: '2026-09-01', dueOn: null }],
    })
    if (path === '/api/company/assets/installment-plans/due') return fulfill(route, installmentDue)
    if (path === '/api/company/assets') return fulfill(route, { assets: companyAssets })
    if (path === '/api/company/depreciation') return fulfill(route, depreciation)
    if (path === '/api/vehicles') return fulfill(route, { vehicles: [] })
    if (path === '/api/company/recurring-expenses/due') return fulfill(route, { due: [] })
    if (path === '/api/company/recurring-expenses') return fulfill(route, { templates: [] })
    if (path === '/api/expense-categories') return fulfill(route, { categories: [] })
    if (request.method() === 'POST' && path === '/api/company/exchanges') return fulfill(route, { ok: true })
    if (request.method() === 'POST' && /\/installment-plans\/.+\/(pay|skip)$/.test(path)) return fulfill(route, { ok: true })
    return fulfill(route, { error: 'visual_fixture_unavailable' }, 503)
  })
}
