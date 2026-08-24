import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShiftRecord } from '@ash/contracts'
import { type ShiftState, minor, weekStartFor } from '@ash/domain'
import {
  BRANCH,
  DRIVER_ID,
  type Harness,
  NOW_MS,
  OTHER_BRANCH,
  VEHICLE_ID,
  approveFixedClose,
  makeHarness,
  syp,
  sypStr,
  today,
} from './harness.ts'

/**
 * The minimal ops dashboard (SRS I-1). Total profit is GM-only (BR8), which is why it is a
 * separate endpoint behind a separate permission rather than a hidden field.
 */

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})
afterEach(async () => {
  await h.app.close()
})

const get = async (token: string, url: string): Promise<LightMyRequestResponse> =>
  await h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie(token) } })

async function seedCountShift(
  id: string,
  state: ShiftState,
  overrides: Partial<Pick<ShiftRecord, 'branchId' | 'driverId' | 'vehicleId' | 'businessDate' | 'shiftNo'>> = {},
): Promise<void> {
  await h.deps.shifts.create({
    id,
    branchId: BRANCH,
    driverId: `driver-${id}`,
    vehicleId: `vehicle-${id}`,
    shiftNo: 1,
    businessDate: today,
    weekStartDate: '2026-07-19',
    state,
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
    ...overrides,
  }, null)
}

/** Run the canonical §2.3 shift to completion so the tiles have real numbers. */
async function runCanonicalShift(
  options: { cashDeclared?: number; cashDeduction?: number } = {},
): Promise<void> {
  const driver = await h.loginAs('driver1')
  const manager = await h.loginAs('manager')

  const created = await h.app.inject({
    method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
    payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
  })
  const id = created.json().id as string
  await h.uploadPhoto(driver, id, 'start', 'odometer')
  await h.app.inject({
    method: 'PUT', url: `/shifts/${id}/start-package`, headers: { cookie: h.cookie(driver) },
    payload: { odometerKm: 1, batteryPercent: 95 },
  })
  await h.app.inject({
    method: 'POST', url: `/shifts/${id}/approve-open`, headers: { cookie: h.cookie(manager) },
    payload: { floatTranches: [sypStr(100_000)], topupTranches: [sypStr(50_000)] },
  })

  let n = 0
  const orders: Array<{
    clientKey: string; providerOrderNo: string; payMode: 'cash' | 'electronic' | 'free'; fee: string; occurredDate: string; occurredMinute: string
  }> = []
  const add = async (mode: string, count: number) => {
    for (let i = 0; i < count; i++) {
      n += 1
      orders.push({
        clientKey: `dashboard-d-${n}`, providerOrderNo: `D-${n}`,
        payMode: mode as 'cash' | 'electronic' | 'free', fee: sypStr(5_000),
        occurredDate: today, occurredMinute: '08:00',
      })
    }
  }
  await add('cash', 12)
  await add('electronic', 6)
  await add('free', 2)
  h.stageCloseDraftFinancialFixture(id, {
    managerToken: manager,
    orders,
    cashDeductions: options.cashDeduction === undefined ? [] : [{
      clientKey: 'dashboard-deduction',
      operationKey: 'dashboard-deduction',
      amount: sypStr(options.cashDeduction),
      occurredDate: today,
      occurredMinute: '08:30',
    }],
  })

  for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
  await h.submitEndPackage(driver, id, {
    odometerKm: 92,
    batteryPercent: 22,
    cashDeclared: sypStr(options.cashDeclared ?? 160_000),
    walletDeclared: sypStr(70_000),
  })
  const review = await get(manager, `/shifts/${id}/review`)
  await approveFixedClose(h, manager, id, review.json().br1.ordersHash)
}

describe('the operational dashboard', () => {
  it('counts exactly open shifts and excludes every other state, including suspended', async () => {
    const states: ShiftState[] = [
      'draft',
      'awaiting_open_approval',
      'open',
      'pending_review',
      'approved',
      'suspended',
      'week_locked',
      'cancelled',
    ]
    for (const [index, state] of states.entries()) {
      await seedCountShift(`state-${state}`, state, { shiftNo: index + 1 })
    }

    const manager = await h.loginAs('manager')
    const res = await get(manager, '/dashboard/working-now')

    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.json()).toEqual({
      asOf: new Date(NOW_MS).toISOString(),
      drivers: 1,
      vehicles: 1,
    })
  })

  it('is date-independent, branch-isolated and counts distinct driver and vehicle IDs', async () => {
    await seedCountShift('overnight-first', 'open', {
      driverId: 'driver-overnight',
      vehicleId: 'vehicle-overnight',
      businessDate: '2026-07-20',
    })
    await seedCountShift('overnight-distinct', 'open', {
      driverId: 'driver-distinct',
      vehicleId: 'vehicle-distinct',
      businessDate: '2026-07-19',
    })
    await seedCountShift('other-branch-open', 'open', {
      branchId: OTHER_BRANCH,
      driverId: 'driver-other-branch',
      vehicleId: 'vehicle-other-branch',
      businessDate: '2026-07-20',
    })

    const manager = await h.loginAs('manager')
    expect((await get(manager, '/dashboard/working-now')).json()).toMatchObject({ drivers: 2, vehicles: 2 })

    const otherManager = await h.loginAs('manager2')
    expect((await get(otherManager, '/dashboard/working-now')).json()).toMatchObject({ drivers: 1, vehicles: 1 })

    const sysadmin = await h.loginAs('sysadmin')
    expect((await get(sysadmin, '/dashboard/working-now')).statusCode).toBe(422)
    expect((await get(sysadmin, `/dashboard/working-now?branchId=${BRANCH}`)).json()).toMatchObject({
      drivers: 2,
      vehicles: 2,
    })
  })

  it('removes the driver and vehicle as soon as the end package is submitted, before approval', async () => {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const created = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    const id = created.json().id as string
    await h.uploadPhoto(driver, id, 'start', 'odometer')
    await h.app.inject({
      method: 'PUT', url: `/shifts/${id}/start-package`, headers: { cookie: h.cookie(driver) },
      payload: { odometerKm: 100, batteryPercent: 90 },
    })
    await h.app.inject({
      method: 'POST', url: `/shifts/${id}/approve-open`, headers: { cookie: h.cookie(manager) },
      payload: { floatTranches: [], topupTranches: [] },
    })
    expect((await get(manager, '/dashboard/working-now')).json()).toMatchObject({ drivers: 1, vehicles: 1 })

    h.stageCloseDraftFinancialFixture(id, {
      managerToken: manager,
      orders: [{
        clientKey: 'working-count-close',
        providerOrderNo: 'WORKING-COUNT-1',
        payMode: 'free',
        fee: sypStr(0),
        occurredDate: today,
        occurredMinute: '08:00',
      }],
    })
    for (const slot of ['dashboard', 'wallet', 'odometer']) await h.uploadPhoto(driver, id, 'end', slot)
    const submitted = await h.submitEndPackage(driver, id, {
      odometerKm: 110,
      batteryPercent: 70,
      cashDeclared: sypStr(0),
      walletDeclared: sypStr(0),
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(submitted.json().state).toBe('pending_review')
    expect((await get(manager, '/dashboard/working-now')).json()).toMatchObject({ drivers: 0, vehicles: 0 })
  })

  it('reports today’s revenue, orders and fleet after a completed shift', async () => {
    await runCanonicalShift()
    const manager = await h.loginAs('manager')

    const res = await get(manager, '/dashboard')
    expect(res.statusCode, res.body).toBe(200)

    // 20 orders × 5,000 = 100,000 SYP in fees.
    expect(res.json().revenue.feesSyp).toBe('100000.00')
    expect(res.json().orders.total).toBe(20)
    // Enriched with the driver's name/code so the UI shows a driver, not his UUID.
    const perDriver = res.json().orders.perDriver as Array<Record<string, unknown>>
    expect(perDriver.find((d) => d.driverId === DRIVER_ID)).toMatchObject({
      driverId: DRIVER_ID,
      name: 'سائق ١',
      code: 'DRV-1',
      orders: 20,
      feesSyp: '100000.00',
    })

    // The company's accrued share this week: 40% of 100,000 = 40,000.
    expect(res.json().companyShareSinceSunday).toBe('40000.00')

    // Two vehicles seeded, both ready.
    expect(res.json().fleet.ready).toBe(2)
    expect(res.json().completeness.openShifts).toBe(0)
  })

  it('shows a USD equivalent from the day’s rate (AC #6, the display half)', async () => {
    const admin = await h.loginAs('sysadmin')
    await h.app.inject({
      method: 'PUT', url: '/fx', headers: { cookie: h.cookie(admin) },
      payload: { businessDate: '2026-07-21', sypMinorPerUsd: 13000 },
    })
    await runCanonicalShift()

    const manager = await h.loginAs('manager')
    const res = await get(manager, '/dashboard')
    // 100,000 SYP / 130 ≈ 769.23 USD.
    expect(res.json().revenue.feesUsd).toBe('769.23')
    expect(res.json().revenue.fxProvisional).toBe(false)
  })

  it('counts what still needs a human when a shift is mid-flight', async () => {
    const driver = await h.loginAs('driver1')
    const created = await h.app.inject({
      method: 'POST', url: '/shifts', headers: { cookie: h.cookie(driver) },
      payload: { driverId: DRIVER_ID, vehicleId: VEHICLE_ID, shiftNo: 1 },
    })
    await h.uploadPhoto(driver, created.json().id, 'start', 'odometer')
    await h.app.inject({
      method: 'PUT', url: `/shifts/${created.json().id}/start-package`, headers: { cookie: h.cookie(driver) },
      payload: { odometerKm: 1, batteryPercent: 90 },
    })

    const manager = await h.loginAs('manager')
    const res = await get(manager, '/dashboard')
    expect(res.json().completeness.openShifts).toBe(1)
    expect(res.json().completeness.awaitingApproval).toBe(1)
  })
})

describe('total profit is General-Manager-only (BR8, AC #12)', () => {
  it('the GM sees it; the branch manager does not', async () => {
    await runCanonicalShift()

    const gm = await h.loginAs('gm')
    // The GM is org-wide; the seeded GM has no branch, so the endpoint needs one. Give the GM a
    // branch for this assertion to prove the FIGURE, not the fan-out (single branch today).
    h.deps.users.seed({
      id: 'u-gm', branchId: 'branch-damascus', roleKey: 'general_manager', username: 'gm',
      fullNameAr: 'gm', passwordHash: 'plain:secret', driverId: null,
      failedAttempts: 0, lockedUntilMs: null, active: true,
    })
    const scopedGm = await h.loginAs('gm')

    const res = await get(scopedGm, '/dashboard/profit')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().companyShareSyp).toBe('40000.00')
    expect(res.json().driverShareSyp).toBe('40000.00')
    expect(res.json().yalagoShareSyp).toBe('20000.00')
    void gm

    // The branch manager is refused outright.
    const manager = await h.loginAs('manager')
    expect((await get(manager, '/dashboard/profit')).statusCode).toBe(403)
    // ...but still sees the operational dashboard.
    expect((await get(manager, '/dashboard')).statusCode).toBe(200)
  })

  it('a driver sees none of the dashboard endpoints', async () => {
    const driver = await h.loginAs('driver1')
    expect((await get(driver, '/dashboard')).statusCode).toBe(403)
    expect((await get(driver, '/dashboard/working-now')).statusCode).toBe(403)
    expect((await get(driver, '/dashboard/profit')).statusCode).toBe(403)
  })

  it('uses an inclusive cross-week range and excludes dates outside its partial weeks', async () => {
    const addProfitEntry = (
      businessDate: string,
      occurrenceKey: string,
      company: number,
      driver: number,
      yalago: number,
    ): void => {
      h.deps.ledger.entries.push({
        id: 10_000 + h.deps.ledger.entries.length,
        branchId: BRANCH,
        eventType: 'manual',
        shiftId: null,
        occurrenceKey,
        businessDate,
        postingDate: businessDate,
        weekStartDate: weekStartFor(businessDate),
        fxDayId: 1,
        weekLockId: null,
        reason: 'profit range fixture',
        createdBy: 'u-bm',
        lines: [
          { fundCode: 'office_cash', side: 'D', amount: syp(company + driver + yalago) },
          { fundCode: 'company_revenue', side: 'C', amount: syp(company) },
          { fundCode: `driver_share_payable:${DRIVER_ID}`, side: 'C', amount: syp(driver), role: 'driver_share' },
          { fundCode: 'yalago_income', side: 'C', amount: syp(yalago) },
        ],
      })
    }

    addProfitEntry('2026-07-19', 'outside-start', 100, 10, 1)
    addProfitEntry('2026-07-20', 'inclusive-start', 200, 20, 2)
    addProfitEntry('2026-07-25', 'first-week', 300, 30, 3)
    addProfitEntry('2026-07-26', 'second-week', 400, 40, 4)
    addProfitEntry('2026-07-27', 'inclusive-end', 500, 50, 5)
    addProfitEntry('2026-07-28', 'outside-end', 600, 60, 6)

    const res = await get(await scopedProfitReader(), '/dashboard/profit?from=2026-07-20&to=2026-07-27')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      from: '2026-07-20',
      to: '2026-07-27',
      weekStart: '2026-07-19',
      companyShareSyp: sypStr(1_400),
      driverShareSyp: sypStr(140),
      yalagoShareSyp: sypStr(14),
    })
  })

  it('reports net earned share after deductions without adding settlement variance', async () => {
    // The deduction lowers earned share from 40,000 to 39,000. Declaring the old balanced cash
    // amount creates a 1,000 surplus, so finalEmployeeCash is 40,000. Profit must still say 39,000.
    await runCanonicalShift({ cashDeduction: 1_000, cashDeclared: 160_000 })

    const res = await get(await scopedProfitReader(), '/dashboard/profit')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().driverShareSyp).toBe(sypStr(39_000))

    const settlement = [...h.deps.settlements.rows.values()][0]
    expect(settlement?.baseDriverShare).toBe(syp(39_000))
    expect(settlement?.variance).toBe(syp(1_000))
    expect(settlement?.finalEmployeeCash).toBe(syp(40_000))
  })

  it('loads settlements once for multiple shifts and retains the legacy ledger fallback', async () => {
    await runCanonicalShift()
    const settled = [...h.deps.settlements.rows.values()][0]
    if (!settled) throw new Error('canonical settlement missing')

    const legacyShiftId = 'legacy-profit-batch'
    h.deps.ledger.entries.push({
      id: 19_999,
      branchId: BRANCH,
      eventType: 'share_split',
      shiftId: legacyShiftId,
      occurrenceKey: 'legacy-profit-batch',
      businessDate: today,
      postingDate: today,
      weekStartDate: weekStartFor(today),
      fxDayId: 1,
      weekLockId: null,
      reason: 'legacy profit batch fixture',
      createdBy: 'u-bm',
      lines: [
        { fundCode: 'fee_earned', side: 'D', amount: syp(250) },
        { fundCode: `driver_share_payable:${DRIVER_ID}`, side: 'C', amount: syp(250), role: 'driver_share' },
      ],
    })

    const batchLookup = vi.spyOn(h.deps.settlements, 'listByShiftIds')
    const singleLookup = vi.spyOn(h.deps.settlements, 'findByShift')
    const res = await get(await scopedProfitReader(), '/dashboard/profit')

    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().driverShareSyp).toBe(sypStr(40_250))
    expect(batchLookup).toHaveBeenCalledTimes(1)
    expect(new Set(batchLookup.mock.calls[0]?.[0])).toEqual(new Set([settled.shiftId, legacyShiftId]))
    expect(singleLookup).not.toHaveBeenCalled()
  })

  it('includes deduction overflow when deriving a legacy shift net share', async () => {
    const shiftId = 'legacy-deduction-overflow'
    const common = {
      branchId: BRANCH,
      shiftId,
      businessDate: today,
      postingDate: today,
      weekStartDate: weekStartFor(today),
      fxDayId: 1,
      weekLockId: null,
      createdBy: 'u-bm',
      reason: 'legacy profit fixture',
    }
    h.deps.ledger.entries.push(
      {
        ...common,
        id: 20_001,
        eventType: 'share_split',
        occurrenceKey: 'legacy-share',
        lines: [
          { fundCode: 'fee_earned', side: 'D', amount: syp(400) },
          { fundCode: `driver_share_payable:${DRIVER_ID}`, side: 'C', amount: syp(400), role: 'driver_share' },
        ],
      },
      {
        ...common,
        id: 20_002,
        eventType: 'driver_cash_deduction',
        occurrenceKey: 'legacy-deduction',
        lines: [
          { fundCode: `driver_share_payable:${DRIVER_ID}`, side: 'D', amount: syp(400), role: 'cash_deduction_share' },
          { fundCode: `driver_receivable_cash:${DRIVER_ID}`, side: 'D', amount: syp(100), role: 'cash_deduction_overflow' },
          { fundCode: `driver_cash:${DRIVER_ID}`, side: 'C', amount: syp(500), role: 'cash_deduction' },
        ],
      },
    )

    const response = await get(await scopedProfitReader(), '/dashboard/profit')
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().driverShareSyp).toBe(sypStr(-100))
  })

  it('rejects reversed and impossible calendar ranges instead of silently truncating them', async () => {
    const gm = await scopedProfitReader()
    expect((await get(gm, '/dashboard/profit?from=2026-07-22&to=2026-07-21')).statusCode).toBe(400)
    expect((await get(gm, '/dashboard/profit?from=2026-02-30&to=2026-03-01')).statusCode).toBe(400)
    expect((await get(gm, '/dashboard/profit?from=2015-01-01&to=2026-07-27')).statusCode).toBe(400)
  })
})

/** The seeded GM is org-wide; bind the test identity to Damascus for a single-branch read. */
async function scopedProfitReader(): Promise<string> {
  h.deps.users.seed({
    id: 'u-gm', branchId: BRANCH, roleKey: 'general_manager', username: 'gm',
    fullNameAr: 'gm', passwordHash: 'plain:secret', driverId: null,
    failedAttempts: 0, lockedUntilMs: null, active: true,
  })
  return await h.loginAs('gm')
}

/**
 * «كشف الصندوق ورأس المال» — the owner's own sheet.
 *
 * The point of these is that «كييش» and «شحن من الصندوق» are read off the LEDGER EVENT and not off
 * a hand-typed Arabic word in a column. Nothing here spells anything.
 */
describe('the owner’s treasury sheet (I-1, decision 10)', () => {
  const post = async (token: string, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload })

  /** The GM is org-wide and the seeded one has no branch; give him this branch to read a figure. */
  async function scopedGm(): Promise<string> {
    h.deps.users.seed({
      id: 'u-gm', branchId: BRANCH, roleKey: 'general_manager', username: 'gm',
      fullNameAr: 'gm', passwordHash: 'plain:secret', driverId: null,
      failedAttempts: 0, lockedUntilMs: null, active: true,
    })
    return await h.loginAs('gm')
  }

  async function seedFund(token: string, fundCode: string, amount: string): Promise<void> {
    const res = await post(token, '/journal/manual', {
      reason: 'رصيد افتتاحي',
      lines: [
        { fundCode, side: 'D', amount },
        { fundCode: 'opening_balance', side: 'C', amount },
      ],
    })
    expect(res.statusCode, res.body).toBe(201)
  }

  async function openFundedShift(): Promise<string> {
    const driver = await h.loginAs('driver1')
    const manager = await h.loginAs('manager')
    const created = await post(driver, '/shifts', {
      driverId: DRIVER_ID,
      vehicleId: VEHICLE_ID,
      shiftNo: 1,
    })
    expect(created.statusCode, created.body).toBe(201)
    const shiftId = created.json().id as string
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    const submitted = await h.app.inject({
      method: 'PUT',
      url: `/shifts/${shiftId}/start-package`,
      headers: { cookie: h.cookie(driver) },
      payload: { odometerKm: 1, batteryPercent: 95 },
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    const review = await get(manager, `/shifts/${shiftId}/review`)
    expect(review.statusCode, review.body).toBe(200)
    const funding = review.json().shiftFunding as { cash: string; wallet: string }
    const opened = await post(manager, `/shifts/${shiftId}/approve-open`, {
      floatTranches: [sypStr(100_000)],
      topupTranches: [sypStr(50_000)],
      carriedTranches: funding.cash === sypStr(0) ? [] : [funding.cash],
      carriedWalletTranches: funding.wallet === sypStr(0) ? [] : [funding.wallet],
    })
    expect(opened.statusCode, opened.body).toBe(200)
    return shiftId
  }

  it('reports رأس المال المدوّر as both boxes PLUS everything out on ذمم', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(3_600_000))
    await seedFund(manager, `driver_receivable_cash:${DRIVER_ID}`, sypStr(350_000))
    await seedFund(manager, `driver_shift_funding_cash:${DRIVER_ID}`, sypStr(50_000))
    await seedFund(manager, 'office_wallet', sypStr(970_000))
    await seedFund(manager, `driver_receivable_wallet:${DRIVER_ID}`, sypStr(20_000))
    await seedFund(manager, `driver_shift_funding_wallet:${DRIVER_ID}`, sypStr(10_000))

    const res = await get(await scopedGm(), '/dashboard/treasury')
    expect(res.statusCode, res.body).toBe(200)
    const c = res.json().capital
    expect(c.officeCash).toBe(sypStr(3_600_000))
    expect(c.receivablesCash).toBe(sypStr(400_000))
    expect(c.receivablesWallet).toBe(sypStr(30_000))
    expect(c.officePosition).toBe(sypStr(5_000_000))
    expect(c.activeCustodyCash).toBe(sypStr(0))
    expect(c.activeCustodyWallet).toBe(sypStr(0))
    expect(c.activeCustodyTotal).toBe(sypStr(0))
    expect(c.activeShiftCount).toBe(0)
    expect(c.workingCapitalTotal).toBe(sypStr(5_000_000))
    // 3,600,000 + 400,000 + 970,000 + 30,000 — his 4,000,000 and 1,000,000, side by side.
    expect(c.total).toBe(sypStr(5_000_000))
    expect(c.target).toBe(sypStr(5_000_000))
    expect(c.workingCapitalDelta).toBe(sypStr(0))
    expect(c.delta).toBe(sypStr(0))
    expect(c.restorationDelta).toBe(sypStr(0))
  })

  it('keeps approved shift custody in working capital after it leaves the office boxes', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_000_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await openFundedShift()

    const res = await get(await scopedGm(), '/dashboard/treasury')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().capital).toMatchObject({
      officeCash: sypStr(3_900_000),
      officeWallet: sypStr(950_000),
      receivablesCash: sypStr(0),
      receivablesWallet: sypStr(0),
      officePosition: sypStr(4_850_000),
      activeCustodyCash: sypStr(100_000),
      activeCustodyWallet: sypStr(50_000),
      activeCustodyTotal: sypStr(150_000),
      activeShiftCount: 1,
      workingCapitalTotal: sypStr(5_000_000),
      total: sypStr(5_000_000),
      target: sypStr(5_000_000),
      workingCapitalDelta: sypStr(0),
      delta: sypStr(0),
      restorationDelta: sypStr(-150_000),
    })
  })

  it('moves carried shift funding from receivables to active custody without changing capital', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(3_990_000))
    await seedFund(manager, 'office_wallet', sypStr(997_000))
    await seedFund(manager, `driver_shift_funding_cash:${DRIVER_ID}`, sypStr(10_000))
    await seedFund(manager, `driver_shift_funding_wallet:${DRIVER_ID}`, sypStr(3_000))

    const before = (await get(await scopedGm(), '/dashboard/treasury')).json().capital
    expect(before.officePosition).toBe(sypStr(5_000_000))
    expect(before.activeCustodyTotal).toBe(sypStr(0))
    expect(before.total).toBe(sypStr(5_000_000))

    await openFundedShift()
    const after = (await get(await scopedGm(), '/dashboard/treasury')).json().capital
    expect(after).toMatchObject({
      officeCash: sypStr(3_890_000),
      officeWallet: sypStr(947_000),
      receivablesCash: sypStr(0),
      receivablesWallet: sypStr(0),
      officePosition: sypStr(4_837_000),
      activeCustodyCash: sypStr(110_000),
      activeCustodyWallet: sypStr(53_000),
      activeCustodyTotal: sypStr(163_000),
      workingCapitalTotal: sypStr(5_000_000),
      total: sypStr(5_000_000),
      delta: sypStr(0),
    })
  })

  it('counts review and suspended custody only when the immutable open marker exists', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_000_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    const shiftId = await openFundedShift()
    const gm = await scopedGm()
    const stored = h.deps.shifts.rows.get(shiftId)!

    for (const state of ['pending_review', 'suspended'] as const) {
      h.deps.shifts.rows.set(shiftId, { ...stored, state })
      const capital = (await get(gm, '/dashboard/treasury')).json().capital
      expect(capital.activeShiftCount).toBe(1)
      expect(capital.activeCustodyTotal).toBe(sypStr(150_000))
      expect(capital.total).toBe(sypStr(5_000_000))
    }

    h.deps.shifts.rows.set(shiftId, { ...stored, state: 'suspended', openApprovedAt: null })
    const withoutOpenMarker = (await get(gm, '/dashboard/treasury')).json().capital
    expect(withoutOpenMarker.activeShiftCount).toBe(0)
    expect(withoutOpenMarker.activeCustodyTotal).toBe(sypStr(0))
    expect(withoutOpenMarker.total).toBe(sypStr(4_850_000))
    expect(withoutOpenMarker.delta).toBe(sypStr(-150_000))
  })

  it('drops cancelled custody after the void restores both office boxes', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_000_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    const shiftId = await openFundedShift()

    const voided = await post(manager, `/shifts/${shiftId}/void`, { reason: 'cancel before work' })
    expect(voided.statusCode, voided.body).toBe(200)
    const capital = (await get(await scopedGm(), '/dashboard/treasury')).json().capital
    expect(capital).toMatchObject({
      officePosition: sypStr(5_000_000),
      activeCustodyCash: sypStr(0),
      activeCustodyWallet: sypStr(0),
      activeCustodyTotal: sypStr(0),
      activeShiftCount: 0,
      workingCapitalTotal: sypStr(5_000_000),
      total: sypStr(5_000_000),
      delta: sypStr(0),
    })
  })

  it('sums «كييش» and «شحن من الصندوق» from the ledger event, not from a typed word', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(4_500_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await post(manager, '/cash-counts', {
      lines: [
        { fundCode: 'office_cash', counted: sypStr(4_500_000) },
        { fundCode: 'office_wallet', counted: sypStr(1_000_000) },
      ],
    })
    expect((await post(manager, '/treasury/restoration', { reason: 'ترميم اليوم' })).statusCode).toBe(201)

    const res = await get(await scopedGm(), '/dashboard/treasury')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().fundIn).toBe(sypStr(500_000))
    expect(res.json().fundOut).toBe(sypStr(0))
    expect(res.json().fundNet).toBe(sypStr(500_000))
    expect(res.json().companyFund).toBe(sypStr(500_000))
    // One row per working day — his sheet, a line at a time.
    expect(res.json().days).toEqual([{ businessDate: '2026-07-21', in: sypStr(500_000), out: sypStr(0), net: sypStr(500_000) }])
    // And the box is back on its capital, so nothing is «مدوَّر» beyond the target.
    expect(res.json().capital.delta).toBe(sypStr(0))
  })

  it('a shortfall reads as خرج الصندوق, and the net goes negative', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(3_000_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await post(manager, '/cash-counts', {
      lines: [
        { fundCode: 'office_cash', counted: sypStr(3_000_000) },
        { fundCode: 'office_wallet', counted: sypStr(1_000_000) },
      ],
    })
    await post(manager, '/treasury/restoration', { reason: 'ترميم اليوم' })

    const res = await get(await scopedGm(), '/dashboard/treasury')
    expect(res.json().fundIn).toBe(sypStr(0))
    expect(res.json().fundOut).toBe(sypStr(1_000_000))
    expect(res.json().fundNet).toBe(sypStr(-1_000_000))
  })

  it('nets a reversed kaish in fundIn and supports a legacy correction without line roles', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(9_582_553))

    for (const amount of [9_078_231, 504_322]) {
      const moved = await post(manager, '/treasury/withdraw', {
        target: 'cash',
        amount: sypStr(amount),
        to: 'company_box',
        reason: 'kaish',
      })
      expect(moved.statusCode, moved.body).toBe(201)
    }

    const restorations = h.deps.ledger.entries.filter((entry) => entry.eventType === 'restoration')
    const corrected = restorations[1]!
    const reversed = await post(manager, `/journal/${corrected.id}/reverse`, { reason: 'visible correction' })
    expect(reversed.statusCode, reversed.body).toBe(201)
    const correction = h.deps.ledger.entries.find((entry) => entry.id === reversed.json().reversalEntryId)!
    expect(correction.lines.find((line) => line.fundCode === 'company_box')?.role).toBe('kaish')

    // Simulate a correction written before roles were preserved. The occurrence key is the stable
    // compatibility link; the dashboard must use it instead of guessing from the reversed side.
    for (const line of correction.lines) delete line.role

    const res = await get(await scopedGm(), '/dashboard/treasury')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().fundIn).toBe(sypStr(9_078_231))
    expect(res.json().fundOut).toBe(sypStr(0))
    expect(res.json().fundNet).toBe(sypStr(9_078_231))
  })

  it('nets a reversed shahn in fundOut instead of reporting it as new fundIn', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(3_000_000))
    await seedFund(manager, 'office_wallet', sypStr(1_000_000))
    await post(manager, '/cash-counts', {
      lines: [
        { fundCode: 'office_cash', counted: sypStr(3_000_000) },
        { fundCode: 'office_wallet', counted: sypStr(1_000_000) },
      ],
    })
    const restored = await post(manager, '/treasury/restoration', { reason: 'restore capital' })
    expect(restored.statusCode, restored.body).toBe(201)

    const original = h.deps.ledger.entries.find((entry) => entry.eventType === 'restoration')!
    const reversed = await post(manager, `/journal/${original.id}/reverse`, { reason: 'reverse shahn' })
    expect(reversed.statusCode, reversed.body).toBe(201)

    const res = await get(await scopedGm(), '/dashboard/treasury')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().fundIn).toBe(sypStr(0))
    expect(res.json().fundOut).toBe(sypStr(0))
    expect(res.json().fundNet).toBe(sypStr(0))
  })

  it('is BR8-scoped: the branch manager and the driver are refused, the sysadmin is not', async () => {
    expect((await get(await h.loginAs('manager'), '/dashboard/treasury')).statusCode).toBe(403)
    expect((await get(await h.loginAs('driver1'), '/dashboard/treasury')).statusCode).toBe(403)
    // Decision 9 — every permission at scope `all`. He still has to name a branch.
    const sysadmin = await h.loginAs('sysadmin')
    expect((await get(sysadmin, `/dashboard/treasury?branchId=${BRANCH}`)).statusCode).toBe(200)
  })
})
