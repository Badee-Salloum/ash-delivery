import type { Page, Route } from '@playwright/test'
import type { CompanyReport, CompanyReportRow } from '../apps/admin/src/company-report.ts'

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

const visualVehicle = {
  id: '92000000-0000-4000-8000-000000000001', code: 'VIS-MOTOR-1', groundNo: '1-1-1-1',
  branchId: 'visual-branch-1', typeId: 'visual-motorbike-type', status: 'ready',
  plateNo: null, assetId: null,
}
const visualExpense = {
  id: '93000000-0000-4000-8000-000000000001', kind: 'expense', amount: '25000.00',
  currency: 'SYP_NEW', paidFrom: 'pocket', categoryId: 'visual-category-1', costCenterKind: 'general',
  vehicleId: null, assetId: null, receiptMediaId: null, sypMinorPerUsd: null,
  description: 'Visual company maintenance', occurredOn: '2026-09-18', businessDate: '2026-09-20',
}
const visualRawHeadquartersTransfers = [{
  entry: { id: 71, businessDate: '2026-09-19', postingDate: '2026-09-19',
    eventType: 'company_restoration_mirror', reason: 'Visual branch receipt', sypMinorPerUsd: null,
    lines: [{ fundCode: 'company_cash:SYP_NEW', side: 'D', amount: '8420.00' },
      { fundCode: 'branch_clearing:visual-branch-1', side: 'C', amount: '8420.00' }] },
  command: null,
}, {
  entry: { id: 72, businessDate: '2026-09-18', postingDate: '2026-09-18',
    eventType: 'company_restoration_mirror', reason: 'Visual outgoing branch transfer', sypMinorPerUsd: null,
    lines: [{ fundCode: 'company_cash:SYP_NEW', side: 'C', amount: '2750.50' },
      { fundCode: 'branch_clearing:visual-branch-1', side: 'D', amount: '2750.50' }] },
  command: null,
}]
const visualRestoration = {
  id: '94000000-0000-4000-8000-000000000001', restorationId: 41,
  branchId: 'visual-branch-1', companyBranchId: 'visual-company', businessDate: '2026-09-19',
  createdAtMs: 1_789_776_000_000, reason: 'Visual executed branch restoration', runNo: 1,
  version: 0, status: 'pending_review', branchStatus: 'executed', currency: 'SYP_NEW',
  originalNet: '8420.00', confirmedNet: '0.00', pendingDifference: '8420.00', matched: false,
  legs: [{ sourceEntryId: 117, fundCode: 'office_cash', direction: 'to_company', amount: '8420.00',
    originalAmount: '8420.00', proposedAmount: '8000.00', confirmedAmount: null,
    sourceBusinessDate: '2026-09-19', sourcePostingDate: '2026-09-19' }],
  confirmedLegs: [{ sourceEntryId: 117, amount: '8000.00' }], revisions: [],
}

type ExistingVisualAsset = {
  id: string; vehicleId: string; name: string; price: string | null; currency: string;
  purchasedOn: string | null; useStartedOn: string | null; fundingSource: string;
  description: string; status: string; accountingStatus: string; version: number;
  depreciation: null; sale: null;
  recognition: null; bookValue: null; pendingEdit: null;
}

export type CompanyFundFixtureOptions = {
  existingAsset?: boolean
  expenseForCorrection?: boolean
  restorationReviewEnabled?: boolean
  reportingBreakdown?: boolean
  secondBranch?: boolean
  rawHeadquartersTransfers?: boolean
  ownerBranchFunding?: boolean
}

function visualCompanyReport(url: URL, options: CompanyFundFixtureOptions): CompanyReport {
  const view = url.searchParams.get('view') === 'current_corrected' ? 'current_corrected' : 'as_booked'
  const current = view === 'current_corrected'
  const row = (patch: Partial<CompanyReportRow>): CompanyReportRow => ({
    id: 'visual-report-row', nature: 'business_event', kind: 'exchange',
    occurredOn: '2026-09-19', occurredPrecision: 'day', occurredMonth: null, occurrenceSource: 'recorded',
    postingDate: '2026-09-19', latestPostingDate: '2026-09-19', canonicalCommandId: 'visual-command-1', activeCommandId: 'visual-command-1',
    originalEntryId: 17, activeEntryId: 17, sourceEntryId: null, relatedEntryIds: [17], correctionIds: [],
    version: 0, reversed: false, currency: null, grossAmount: null, netAmount: null,
    fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null,
    source: 'pocket', branchId: null, description: '', externalReference: 'VISUAL-REPORT-EXCHANGE',
    receiptReference: null, sypMinorPerUsd: null, rateBasis: null, lines: [], ...patch,
  })
  const rows: CompanyReportRow[] = [row({
    id: 'visual-report-exchange', description: 'Visual fixture exchange', fromCurrency: 'USD', fromAmount: '100.00',
    toCurrency: 'SYP_NEW', toAmount: '15000.00', sypMinorPerUsd: '15000', rateBasis: 'documented',
    lines: [
      { fundCode: 'company_cash:USD', currency: 'USD', side: 'C', role: null, grossAmount: '100.00', netAmount: '100.00' },
      { fundCode: 'fx_clearing:USD', currency: 'USD', side: 'D', role: null, grossAmount: '100.00', netAmount: '100.00' },
      { fundCode: 'company_cash:SYP_NEW', currency: 'SYP_NEW', side: 'D', role: null, grossAmount: '15000.00', netAmount: '15000.00' },
      { fundCode: 'fx_clearing:SYP_NEW', currency: 'SYP_NEW', side: 'C', role: null, grossAmount: '15000.00', netAmount: '15000.00' },
    ],
  })]
  if (options.rawHeadquartersTransfers) for (const movement of visualRawHeadquartersTransfers) rows.push(row({
    id: `visual-report-journal-${movement.entry.id}`, nature: 'journal_only', kind: movement.entry.eventType,
    description: movement.entry.reason, occurredOn: movement.entry.businessDate, occurrenceSource: 'posting_fallback',
    postingDate: movement.entry.businessDate, latestPostingDate: movement.entry.businessDate,
    canonicalCommandId: null, activeCommandId: null, originalEntryId: movement.entry.id, activeEntryId: movement.entry.id,
    relatedEntryIds: [movement.entry.id], source: movement.entry.lines[0]!.side === 'D' ? 'to_company' : 'from_company',
    branchId: 'visual-branch-1', externalReference: null,
    lines: movement.entry.lines.map(line => ({ fundCode: line.fundCode, currency: 'SYP_NEW', side: line.side as 'D' | 'C', role: null, grossAmount: line.amount, netAmount: line.amount })),
  }))
  if (options.reportingBreakdown) {
    const amount = current ? '75000.00' : '100000.00'
    rows.push(row({
      id: 'visual-report-company-expense', kind: 'expense', description: 'Visual company-funded report expense', currency: 'SYP_NEW',
      grossAmount: amount, netAmount: amount, occurredOn: current ? '2026-09-17' : '2026-09-18',
      postingDate: '2026-09-18', latestPostingDate: current ? '2026-09-20' : '2026-09-18',
      canonicalCommandId: 'visual-company-book-expense', activeCommandId: current ? 'visual-company-book-correction' : 'visual-company-book-expense',
      originalEntryId: 201, activeEntryId: current ? 202 : 201, relatedEntryIds: current ? [201, 202] : [201],
      correctionIds: current ? ['visual-report-correction-1'] : [], version: current ? 1 : 0, externalReference: 'VISUAL-REPORT-EXPENSE',
      lines: [
        { fundCode: 'expense:visual-category-1', currency: 'SYP_NEW', side: 'D', role: null, grossAmount: amount, netAmount: amount },
        { fundCode: 'company_cash:SYP_NEW', currency: 'SYP_NEW', side: 'C', role: null, grossAmount: amount, netAmount: amount },
      ],
    }), row({
      id: 'visual-report-owner-expense', kind: 'expense', description: 'Visual owner-funded period payment', currency: 'SYP_NEW',
      grossAmount: '50000.00', netAmount: '50000.00', source: 'owner_outside', occurredOn: '2026-09-18',
      canonicalCommandId: 'visual-owner-report-1', activeCommandId: 'visual-owner-report-1', externalReference: 'VISUAL-REPORT-OWNER',
      originalEntryId: 203, activeEntryId: 203, relatedEntryIds: [203],
      lines: [
        { fundCode: 'expense:visual-category-1', currency: 'SYP_NEW', side: 'D', role: null, grossAmount: '50000.00', netAmount: '50000.00' },
        { fundCode: 'owner_capital:SYP_NEW', currency: 'SYP_NEW', side: 'C', role: null, grossAmount: '50000.00', netAmount: '50000.00' },
      ],
    }), row({
      id: 'visual-report-income', kind: 'income', description: 'Visual company report income', currency: 'SYP_NEW',
      grossAmount: '125000.00', netAmount: '125000.00', canonicalCommandId: 'visual-report-income', activeCommandId: 'visual-report-income',
      originalEntryId: 204, activeEntryId: 204, relatedEntryIds: [204], externalReference: 'VISUAL-REPORT-INCOME',
      lines: [
        { fundCode: 'company_cash:SYP_NEW', currency: 'SYP_NEW', side: 'D', role: null, grossAmount: '125000.00', netAmount: '125000.00' },
        { fundCode: 'income:visual-category-1', currency: 'SYP_NEW', side: 'C', role: null, grossAmount: '125000.00', netAmount: '125000.00' },
      ],
    }))
  }
  const raw = options.rawHeadquartersTransfers
  const sypBalance = options.reportingBreakdown ? raw ? current ? '276170.50' : '301170.50' : current ? '265000.00' : '290000.00' : raw ? '26170.50' : '15000.00'
  return {
    from: url.searchParams.get('from') ?? '2000-01-01', to: url.searchParams.get('to') ?? '2026-09-20',
    view, dateBasis: url.searchParams.get('dateBasis') === 'occurrence' ? 'occurrence' : 'posting', generatedAtMs: 1_789_948_800_000,
    periodSemantics: current ? 'current_snapshot_original_posting_anchor' : 'immutable_journals', historicalBookCostPolicy: 'not_reclassified',
    rows, occurrenceFallbackCount: raw ? 2 : 0, journalOnlyCount: raw ? 2 : 0, pendingRestorationCount: 1,
    totals: {
      SYP_NEW: { debits: sypBalance, credits: sypBalance, cashNet: options.reportingBreakdown ? raw ? current ? '70669.50' : '45669.50' : current ? '65000.00' : '40000.00' : raw ? '20669.50' : '15000.00',
        income: options.reportingBreakdown ? '125000.00' : '0.00', expense: options.reportingBreakdown ? current ? '125000.00' : '150000.00' : '0.00',
        companyFundedExpense: options.reportingBreakdown ? current ? '75000.00' : '100000.00' : '0.00', ownerOutsideExpense: options.reportingBreakdown ? '50000.00' : '0.00', otherBookExpense: '0.00' },
      USD: { debits: '100.00', credits: '100.00', cashNet: '-100.00', income: '0.00', expense: '0.00', companyFundedExpense: '0.00', ownerOutsideExpense: '0.00', otherBookExpense: '0.00' },
    },
  }
}

/**
 * A system-admin fixture is required because Company Fund is intentionally not a branch-manager
 * screen. It responds to every eager load from the fund tabs and to the two write endpoints the
 * visual tests can reach, so an accidental confirmation never touches a real ledger.
 */
export async function stubCompanyFund(page: Page, options: CompanyFundFixtureOptions = {}): Promise<void> {
  const existingAssets: ExistingVisualAsset[] = options.existingAsset ? [{
    id: '95000000-0000-4000-8000-000000000001', vehicleId: visualVehicle.id, name: 'Visual motorcycle',
    price: '1200.00', currency: 'USD', purchasedOn: '2026-07-10', useStartedOn: '2026-07-15',
    fundingSource: 'owner_outside', description: 'Historical motor, no new payment', status: 'registered',
    accountingStatus: 'pending_review', version: 1, depreciation: null, sale: null,
    recognition: null, bookValue: null, pendingEdit: null,
  }] : []
  const restoration = structuredClone(visualRestoration)
  const corrections: Array<Record<string, unknown>> = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/me') return fulfill(route, {
      userId: 'visual-system-admin', roleKey: 'system_admin', branchId: null, driverId: null, businessDate: '2026-09-20',
    })
    if (path === '/api/branches') return fulfill(route, {
      branches: [{ id: 'visual-branch-1', code: 'VIS', nameAr: 'فرع الاختبار', nameEn: 'Visual branch' },
        ...(options.secondBranch ? [{ id: 'visual-branch-2', code: 'VIS2', nameAr: 'فرع الاختبار الثاني', nameEn: 'Second visual branch' }] : [])],
    })
    if (path === '/api/notifications') return fulfill(route, { unreadCount: 0, notifications: [] })
    if (path === '/api/shifts') return fulfill(route, { shifts: [] })
    if (path === '/api/company/overview') return fulfill(route, options.reportingBreakdown ? {
      ...companyOverview, period: {
        SYP_NEW: { ...companyOverview.period.SYP_NEW, companyFundedExpense: '100000.00', ownerOutsideExpense: '50000.00', otherBookExpense: '0.00' },
        USD: { ...companyOverview.period.USD, companyFundedExpense: '0.00', ownerOutsideExpense: '0.00', otherBookExpense: '0.00' },
      },
    } : companyOverview)
    if (path === '/api/company/reports') return fulfill(route, visualCompanyReport(new URL(request.url()), options))
    if (path === '/api/company/custody') return fulfill(route, { balances: { SYP_NEW: '0.00', USD: '0.00' }, transfers: [] })
    if (path === '/api/company/owner-withdrawals') return fulfill(route, { from: '2000-01-01', to: '2026-09-20', asOf: '2026-09-20', basis: 'current_verified_original_withdrawals', totals: { SYP_NEW: '0.00', USD: '0.00' }, periodTotals: { SYP_NEW: '0.00', USD: '0.00' }, withdrawals: [] })
    if (path === '/api/company/movements') return fulfill(route, {
      movements: [{
        entry: { id: 17, businessDate: '2026-09-19', eventType: 'exchange', reason: 'Visual fixture exchange', sypMinorPerUsd: '15000' },
        command: {
          id: 'visual-command-1', kind: 'exchange', fromCurrency: 'USD', fromAmount: '100.00',
          toCurrency: 'SYP_NEW', toAmount: '15000.00', sypMinorPerUsd: '15000', reason: 'Visual fixture exchange',
        },
      }, ...(options.expenseForCorrection ? [{
        entry: { id: 18, businessDate: '2026-09-20', postingDate: '2026-09-20', eventType: 'company_expense', reason: visualExpense.description, sypMinorPerUsd: null },
        command: visualExpense,
      }] : []), ...(options.rawHeadquartersTransfers ? visualRawHeadquartersTransfers : [])],
    })
    if (path === '/api/company/owner-payments') return fulfill(route, options.reportingBreakdown ? {
      from: new URL(request.url()).searchParams.get('from'), to: new URL(request.url()).searchParams.get('to'),
      totals: { SYP_NEW: '50000.00', USD: '0.00' },
      payments: [{ id: 'visual-owner-report-1', currency: 'SYP_NEW', amount: '50000.00', description: 'Visual owner-funded period payment', occurredOn: '2026-09-18' }],
    } : options.ownerBranchFunding ? {
      from: '2000-01-01', to: '2026-09-20', totals: { SYP_NEW: '51000.00', USD: '1200.00' },
      expenseTotals: { SYP_NEW: '51000.00', USD: '0.00' },
      capitalAndDebtTotals: { SYP_NEW: '0.00', USD: '1200.00' },
      payments: [
        { id: 'visual-owner-direct-expense', kind: 'expense', currency: 'SYP_NEW', amount: '51000.00', description: 'Visual owner-funded direct expense', occurredOn: '2026-09-18' },
        { id: 'visual-owner-1', kind: 'asset_payment', currency: 'USD', amount: '1200.00', description: 'Visual owner-funded motor', occurredOn: '2026-07-10' },
      ],
      branchFundingTotals: { SYP_NEW: '200000.00', USD: '0.00' },
      branchFundingBasis: 'current_verified_receipts_by_business_date',
      branchFundingPayments: [
        { id: 'visual-owner-branch-cash', branchNameAr: 'فرع الاختبار', channel: 'cash', currency: 'SYP_NEW', amount: '150000.00', description: 'Visual owner cash funding', occurredOn: '2026-09-19' },
        { id: 'visual-owner-branch-wallet', branchNameAr: 'فرع الاختبار', channel: 'wallet', currency: 'SYP_NEW', amount: '50000.00', description: 'Visual owner wallet funding', occurredOn: '2026-09-18' },
      ],
    } : {
      from: '2000-01-01', to: '2026-09-20', totals: { SYP_NEW: '51000.00', USD: '1200.00' },
      payments: [{ id: 'visual-owner-1', currency: 'USD', amount: '1200.00', description: 'Visual owner-funded motor', occurredOn: '2026-07-10' }],
    })
    if (path === '/api/company/historical-intake-sessions') {
      if (request.method() === 'GET') return fulfill(route, { sessions: [] })
      return fulfill(route, { session: { id: 'visual-intake-1', from: '2000-01-01', to: '2026-09-20', closedAtMs: null } }, 201)
    }
    if (path === '/api/company/existing-assets/payment-summaries') return fulfill(route, { summaries: existingAssets.map(asset=>({assetId:asset.id,totalPaid:'0.00',remaining:asset.price,status:'not_documented',installments:[]})),reminders:[] })
    if (/^\/api\/company\/existing-assets\/[^/]+\/payments$/.test(path)) return fulfill(route, { version:0,totalPaid:'0.00',remaining:'1200.00',status:'not_documented',sources:[],payments:[],history:[],plan:null,installments:[] })
    if (path === '/api/company/existing-assets/vehicles') return fulfill(route, { vehicles: [{ ...visualVehicle,
      assetId: existingAssets.find(asset => asset.vehicleId === visualVehicle.id)?.id ?? null,
    }] })
    if (path === '/api/company/existing-assets') {
      if (request.method() === 'GET') return fulfill(route, { assets: existingAssets, legacyAssets: [] })
      const body = request.postDataJSON() as Record<string, unknown>
      const asset: ExistingVisualAsset = {
        id: String(body.idempotencyKey ?? body.id), vehicleId: String(body.vehicleId), name: String(body.name),
        price: body.price === null ? null : String(body.price), currency: String(body.currency),
        purchasedOn: body.purchasedOn === null ? null : String(body.purchasedOn),
        useStartedOn: body.useStartedOn === null ? null : String(body.useStartedOn),
        fundingSource: String(body.fundingSource), description: String(body.description ?? ''),
        status: body.price === null || body.useStartedOn === null ? 'draft' : 'registered',
        accountingStatus: 'pending_review', version: 1, depreciation: null, sale: null,
        recognition: null, bookValue: null, pendingEdit: null,
      }
      existingAssets.push(asset)
      return fulfill(route, { asset, cashEffect: { SYP_NEW: '0.00', USD: '0.00' } }, 201)
    }
    if (path === '/api/company/restoration-reviews') return fulfill(route, {
      enabled: options.restorationReviewEnabled ?? true, proposals: [restoration],
      legacy: [{ id: 'visual-legacy-1', restorationId: 40, branchId: 'visual-branch-1', sourceEntryId: 116,
        journalEntryId: 216, direction: 'to_company', amount: '7500.00', currency: 'SYP_NEW', status: 'posted_legacy' }],
    })
    if (/^\/api\/company\/restoration-reviews\/[^/]+\/(revisions|confirm|correct|defer)$/.test(path)) {
      const body = request.postDataJSON() as { confirmedLegs?: typeof restoration.confirmedLegs; reason: string }
      restoration.version += 1
      if (body.confirmedLegs) restoration.confirmedLegs = body.confirmedLegs
      if (path.endsWith('/confirm')) restoration.status = 'confirmed'
      if (path.endsWith('/defer')) restoration.status = 'deferred'
      return fulfill(route, { ...restoration, replayed: false }, 201)
    }
    if (path === `/api/company/movements/${visualExpense.id}/review`) return fulfill(route, {
      original: visualExpense, effective: visualExpense, version: 0, metadata: null, corrections,
    })
    if (path === '/api/company/movement-corrections' && request.method() === 'GET') return fulfill(route, { corrections })
    if (path === '/api/company/movement-corrections' && request.method() === 'POST') {
      const body = request.postDataJSON() as { values: Record<string, unknown>; reason: string }
      const correction = { id: '96000000-0000-4000-8000-000000000001', targetId: visualExpense.id,
        targetVersion: 0, version: 1, reason: body.reason, values: { ...visualExpense, ...body.values },
        status: 'draft', blockingReasons: [], financial: true }
      corrections.push(correction)
      return fulfill(route, {
        correction,
        impact: { pockets: { SYP_NEW: '-1000.00', USD: '0.00' }, reserves: { SYP_NEW: '0.00', USD: '0.00' },
          ownerPayments: { SYP_NEW: '0.00', USD: '0.00' }, branchEffect: 'none' },
      }, 201)
    }
    if (/^\/api\/company\/movement-corrections\/[^/]+\/confirm$/.test(path)) return fulfill(route, { confirmed: true }, 201)
    if (path === '/api/company/historical-movements/preflight') return fulfill(route, {
      pockets: { SYP_NEW: '0.00', USD: '0.00' }, canStart: true,
    })
    if (path === '/api/company/historical-movements' && request.method() === 'GET') return fulfill(route, { movements: [] })
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
    if (path === '/api/income-categories') return fulfill(route, { categories: [] })
    if (request.method() === 'POST' && path === '/api/company/exchanges') return fulfill(route, { ok: true })
    if (request.method() === 'POST' && path === '/api/company/historical-movements') return fulfill(route, { ok: true })
    if (request.method() === 'POST' && /\/installment-plans\/.+\/(pay|skip)$/.test(path)) return fulfill(route, { ok: true })
    return fulfill(route, { error: 'visual_fixture_unavailable' }, 503)
  })
}
