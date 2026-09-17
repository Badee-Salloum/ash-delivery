import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShiftRecord } from '@ash/contracts'
import { type ShiftState, minor, weekStartFor } from '@ash/domain'
import {
  BRANCH,
  DRIVER2_ID,
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
  overrides: Partial<Pick<
    ShiftRecord,
    'branchId' | 'driverId' | 'vehicleId' | 'businessDate' | 'shiftNo'
    // P2 — the shifts summary judges timing and distance.
    | 'openApprovedAt' | 'windowOpensAt' | 'submittedAt' | 'odoStart' | 'odoEnd'
  >> = {},
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

  it('describes the business day asked for, and today when none is asked for', async () => {
    // `today` comes from the harness clock through `businessDateFor`, so it already carries the
    // 04:00 boundary. A manager reading the board at 01:30 must see the day he is still working.
    const yesterday = '2026-07-19'
    await seedCountShift('picked-day-open', 'open', {
      driverId: 'driver-picked-day',
      vehicleId: 'vehicle-picked-day',
      businessDate: yesterday,
    })

    const manager = await h.loginAs('manager')

    const untouched = (await get(manager, '/dashboard')).json()
    expect(untouched.businessDate).toBe(today)

    const picked = await get(manager, `/dashboard?day=${yesterday}`)
    expect(picked.statusCode).toBe(200)
    expect(picked.json().businessDate).toBe(yesterday)
    // The day-scoped panel followed the selection rather than staying on today.
    expect(picked.json().completeness.openShifts).toBe(1)
    expect(untouched.completeness.openShifts).toBe(0)
  })

  it('refuses a day that is not a calendar date rather than silently showing today', async () => {
    const manager = await h.loginAs('manager')
    expect((await get(manager, '/dashboard?day=not-a-date')).statusCode).toBe(400)
    expect((await get(manager, '/dashboard?day=2026-02-30')).statusCode).toBe(400)
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

  it('counts operating costs as expenses and never the owner’s capital', async () => {
    /*
     * The trap this test exists for.
     *
     * The obvious way to total expenses from the ledger is `fundCode.startsWith('cost_center:')`,
     * and it is wrong: `fundRefFromCode` turns every code it does not recognise into
     * `cost_center:<code>`, so that prefix also carries `owner_funding`, `owner_drawings` and
     * `opening_balance` — the owner putting capital in and taking it out.
     *
     * Measured on production before this was written: the real cost centres total 36,988.81, which
     * is exactly what the `expenses` table holds, while the blanket prefix returns 7,778.39. That is
     * a 79% understatement of cost and an identical overstatement of profit, on the one number the
     * general manager opens the screen to read.
     */
    const post = (occurrenceKey: string, fundCode: string, amount: number): void => {
      h.deps.ledger.entries.push({
        id: 20_000 + h.deps.ledger.entries.length,
        branchId: BRANCH,
        eventType: 'manual',
        shiftId: null,
        occurrenceKey,
        businessDate: '2026-07-22',
        postingDate: '2026-07-22',
        weekStartDate: weekStartFor('2026-07-22'),
        fxDayId: 1, sypMinorPerUsd: null,
        weekLockId: null,
        reason: 'cost centre fixture',
        createdBy: 'u-bm',
        lines: [
          { fundCode, side: 'D', amount: syp(amount), currency: 'SYP_NEW' },
          { fundCode: 'office_cash', side: 'C', amount: syp(amount), currency: 'SYP_NEW' },
        ],
      })
    }

    // Revenue to measure the cost against.
    h.deps.ledger.entries.push({
      id: 21_000, branchId: BRANCH, eventType: 'manual', shiftId: null,
      occurrenceKey: 'cost-centre-revenue', businessDate: '2026-07-22', postingDate: '2026-07-22',
      weekStartDate: weekStartFor('2026-07-22'), fxDayId: 1, sypMinorPerUsd: null, weekLockId: null,
      reason: 'cost centre fixture', createdBy: 'u-bm',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: syp(1_000), currency: 'SYP_NEW' },
        { fundCode: 'company_revenue', side: 'C', amount: syp(1_000), currency: 'SYP_NEW' },
      ],
    })

    // Real operating costs — these MUST reduce profit.
    post('cc-branch', `cost_center:branch:${BRANCH}`, 100)
    post('cc-general', `cost_center:general:${BRANCH}`, 30)
    post('cc-writeoff', 'cost_center:receivable_writeoff_loss', 10)
    post('cc-wallet-adj', `cost_center:wallet_adjustment:${BRANCH}`, 5)

    // Capital movements wearing the same prefix — these must NOT.
    post('cc-owner-funding', 'cost_center:owner_funding', 9_000)
    post('cc-owner-drawings', 'cost_center:owner_drawings', 4_000)
    post('cc-opening', 'cost_center:opening_balance', 2_000)

    const gm = await h.loginAs('gm')
    const profitUrl = `/dashboard/profit?from=2026-07-22&to=2026-07-22&branchId=${BRANCH}`
    const before = (await get(gm, profitUrl)).json()
    expect(before.expenseSyp).toBe('145.00')
    expect(before.netProfitSyp).toBe('855.00')

    /*
     * A VEHICLE's running cost, recorded exactly the way a manager records it: `POST /expenses`
     * with the vehicle cost centre. The route posts it to `cost_center:<vehicle id>` — the bare id —
     * and never to the `cost_center:vehicle:<…>` spelling this test used to hand-write. The old
     * allowlist matched only that spelling, so every real vehicle cost was missing from net profit.
     */
    const admin = await h.loginAs('sysadmin')
    const category = await h.app.inject({
      method: 'POST', url: '/expense-categories', headers: { cookie: h.cookie(admin) },
      payload: { code: 'charging', nameAr: 'شحن الآلية' },
    })
    expect(category.statusCode, category.body).toBe(201)
    const manager = await h.loginAs('manager')
    const vehicleExpense = await h.app.inject({
      method: 'POST', url: '/expenses', headers: { cookie: h.cookie(manager) },
      payload: {
        idempotencyKey: crypto.randomUUID(),
        categoryId: category.json().id,
        costCenterKind: 'vehicle',
        vehicleId: VEHICLE_ID,
        amount: sypStr(20),
        businessDate: '2026-07-22',
        description: 'شحن الآلية',
      },
    })
    expect(vehicleExpense.statusCode, vehicleExpense.body).toBe(201)
    // The code the route really writes — not a `vehicle:` prefix, and not a UUID in this harness.
    expect(await h.deps.ledger.fundBalance(BRANCH, `cost_center:${VEHICLE_ID}`)).toBe(syp(20))

    const res = await get(gm, profitUrl)
    expect(res.statusCode, res.body).toBe(200)

    // 100 + 30 + 20 + 10 + 5 — and not one lira of the 15,000 in capital movements.
    expect(res.json().expenseSyp).toBe('165.00')
    expect(res.json().operatingCostSyp).toBe('130.00')
    expect(res.json().vehicleCostSyp).toBe('20.00')
    expect(res.json().lossSyp).toBe('15.00')
    expect(res.json().expenseLineCount).toBe(5)
    expect(res.json().companyShareSyp).toBe('1000.00')
    expect(res.json().netProfitSyp).toBe('835.00')
    // The vehicle cost reduced net by exactly its own amount, on its own day.
    expect(res.json().days).toEqual([{
      businessDate: '2026-07-22',
      companyShareSyp: '1000.00',
      otherIncomeSyp: '0.00',
      expenseSyp: '165.00',
      vehicleCostSyp: '20.00',
      netProfitSyp: '835.00',
    }])
  })

  it('adds non-delivery income to profit and reports it on its own line', async () => {
    // `other_income` is a separate fund by design so a battery sale cannot overstate the delivery
    // business. It is still the company’s money, so a profit figure that omits it is simply
    // short — by 5,692.37 on production when this was measured.
    h.deps.ledger.entries.push({
      id: 22_000, branchId: BRANCH, eventType: 'income', shiftId: null,
      occurrenceKey: 'other-income-fixture', businessDate: '2026-07-22', postingDate: '2026-07-22',
      weekStartDate: weekStartFor('2026-07-22'), fxDayId: 1, sypMinorPerUsd: null, weekLockId: null,
      reason: 'office share of an outside job', createdBy: 'u-bm',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: syp(250), currency: 'SYP_NEW' },
        { fundCode: 'other_income', side: 'C', amount: syp(250), currency: 'SYP_NEW' },
      ],
    })

    const gm = await h.loginAs('gm')
    const res = await get(gm, `/dashboard/profit?from=2026-07-22&to=2026-07-22&branchId=${BRANCH}`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().otherIncomeSyp).toBe('250.00')
    // Its own line, and inside the net.
    expect(res.json().netProfitSyp).toBe('250.00')
    expect(res.json().companyShareSyp).toBe('0.00')
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
        fxDayId: 1, sypMinorPerUsd: null,
        weekLockId: null,
        reason: 'profit range fixture',
        createdBy: 'u-bm',
        lines: [
          { fundCode: 'office_cash', side: 'D', amount: syp(company + driver + yalago), currency: 'SYP_NEW' },
          { fundCode: 'company_revenue', side: 'C', amount: syp(company), currency: 'SYP_NEW' },
          { fundCode: `driver_share_payable:${DRIVER_ID}`, side: 'C', amount: syp(driver), currency: 'SYP_NEW', role: 'driver_share' },
          { fundCode: 'yalago_income', side: 'C', amount: syp(yalago), currency: 'SYP_NEW' },
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
      fxDayId: 1, sypMinorPerUsd: null,
      weekLockId: null,
      reason: 'legacy profit batch fixture',
      createdBy: 'u-bm',
      lines: [
        { fundCode: 'fee_earned', side: 'D', amount: syp(250), currency: 'SYP_NEW' },
        { fundCode: `driver_share_payable:${DRIVER_ID}`, side: 'C', amount: syp(250), currency: 'SYP_NEW', role: 'driver_share' },
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
      fxDayId: 1, sypMinorPerUsd: null,
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
          { fundCode: 'fee_earned', side: 'D', amount: syp(400), currency: 'SYP_NEW' },
          { fundCode: `driver_share_payable:${DRIVER_ID}`, side: 'C', amount: syp(400), currency: 'SYP_NEW', role: 'driver_share' },
        ],
      },
      {
        ...common,
        id: 20_002,
        eventType: 'driver_cash_deduction',
        occurrenceKey: 'legacy-deduction',
        lines: [
          { fundCode: `driver_share_payable:${DRIVER_ID}`, side: 'D', amount: syp(400), currency: 'SYP_NEW', role: 'cash_deduction_share' },
          { fundCode: `driver_receivable_cash:${DRIVER_ID}`, side: 'D', amount: syp(100), currency: 'SYP_NEW', role: 'cash_deduction_overflow' },
          { fundCode: `driver_cash:${DRIVER_ID}`, side: 'C', amount: syp(500), currency: 'SYP_NEW', role: 'cash_deduction' },
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

  it('counts an outstanding «سلفة» as capital, on its own line beside الذمم', async () => {
    /*
     * The owner's own spreadsheet row, with one more term. Fold advances into `receivablesCash`
     * and the totals would still be right while the screen told a manager that a workshop's loan
     * was a driver's debt; leave them out altogether and paying one reads as a capital shortfall
     * that الترميم would «شحن» out of صندوق الشركة every night.
     */
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(3_500_000))
    await seedFund(manager, `driver_receivable_cash:${DRIVER_ID}`, sypStr(400_000))
    await seedFund(manager, 'advance_receivable_cash:11111111-1111-4111-8111-111111111111', sypStr(100_000))
    await seedFund(manager, 'office_wallet', sypStr(970_000))
    await seedFund(manager, 'advance_receivable_wallet:22222222-2222-4222-8222-222222222222', sypStr(30_000))

    const c = (await get(await scopedGm(), '/dashboard/treasury')).json().capital
    expect(c.advancesCash).toBe(sypStr(100_000))
    expect(c.advancesWallet).toBe(sypStr(30_000))
    expect(c.advancesTotal).toBe(sypStr(130_000))
    // Its own line — never added into الذمم, which stay exactly what the drivers owe.
    expect(c.receivablesCash).toBe(sypStr(400_000))
    expect(c.receivablesWallet).toBe(sypStr(0))

    // …and every total that decides whether money moves tonight includes it.
    expect(c.cashPosition).toBe(sypStr(4_000_000))
    expect(c.walletPosition).toBe(sypStr(1_000_000))
    expect(c.officePosition).toBe(sypStr(5_000_000))
    expect(c.workingCapitalTotal).toBe(sypStr(5_000_000))
    expect(c.restorationDelta).toBe(sypStr(0))
    expect(c.cashDelta).toBe(sypStr(0))
    expect(c.walletDelta).toBe(sypStr(0))
  })

  it('reports a negative advance fund as an integrity error, naming the fund', async () => {
    // A counted asset that has gone negative is corruption whichever kind it is, and the fund code
    // is the difference between an actionable alert and a shrug about "the branch".
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(100_000))
    const bad = 'advance_receivable_cash:33333333-3333-4333-8333-333333333333'
    const res = await post(manager, '/journal/manual', {
      reason: 'كسر متعمَّد',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(5_000) },
        { fundCode: bad, side: 'C', amount: sypStr(5_000) },
      ],
    })
    expect(res.statusCode, res.body).toBe(201)

    const broken = await get(await scopedGm(), '/dashboard/treasury')
    expect(broken.statusCode).toBe(500)
    expect(broken.json().error).toBe('receivable_balance_integrity_error')
    expect(broken.json().detail).toMatchObject({ fundCode: bad })
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

  // Since 2026-09-17 a hand sweep, and reversing one, both move صندوق الشركة and so need
  // `company_fund.manage`: the GM does here what the branch manager used to.
  it('nets a reversed kaish in fundIn and supports a legacy correction without line roles (GM sweeps and reverses)', async () => {
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(9_582_553))
    const gm = await scopedGm()

    for (const amount of [9_078_231, 504_322]) {
      const moved = await post(gm, '/treasury/withdraw', {
        idempotencyKey: crypto.randomUUID(),
        target: 'cash',
        amount: sypStr(amount),
        to: 'company_box',
        reason: 'kaish',
      })
      expect(moved.statusCode, moved.body).toBe(201)
    }

    // Hand sweeps are `manual` entries carrying the `kaish` line role — see `manualKaish`.
    const sweeps = h.deps.ledger.entries.filter((entry) =>
      entry.lines.some((line) => line.fundCode === 'company_box' && line.role === 'kaish'),
    )
    expect(sweeps).toHaveLength(2)
    const corrected = sweeps[1]!
    // The branch manager may no longer reverse it: the reversal moves صندوق الشركة back.
    const refused = await post(manager, `/journal/${corrected.id}/reverse`, { reason: 'visible correction' })
    expect(refused.statusCode, refused.body).toBe(403)
    expect(refused.json().error).toBe('company_fund_forbidden')
    const reversed = await post(gm, `/journal/${corrected.id}/reverse`, { reason: 'visible correction' })
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

  // A الترميم run touches صندوق الشركة, so reversing one is the GM's since 2026-09-17.
  it('nets a reversed shahn in fundOut instead of reporting it as new fundIn (GM reverses)', async () => {
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
    const reversed = await post(await scopedGm(), `/journal/${original.id}/reverse`, { reason: 'reverse shahn' })
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

/**
 * «تاريخ بدء التطبيق» — the go-live date clamps FLOW reports (owner request, 2026-08-28).
 *
 * The first five days of production were a trial. The owner wanted the figures to start on a date
 * he names. What must NOT happen is the positions moving with them: `fundBalance` is a control
 * read, and a box that looks emptier than it is would break the insufficient-funds guards, the
 * cash-count baseline and the restoration plan. So flows clamp; balances do not.
 */
describe('the go-live date clamps the reports, never the positions', () => {
  const post = async (token: string, url: string, payload: unknown = {}): Promise<LightMyRequestResponse> =>
    await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload: payload as object })

  async function scopedGm(): Promise<string> {
    h.deps.users.seed({
      id: 'u-gm', branchId: BRANCH, roleKey: 'general_manager', username: 'gm',
      fullNameAr: 'gm', passwordHash: 'plain:secret', driverId: null,
      failedAttempts: 0, lockedUntilMs: null, active: true,
    })
    return await h.loginAs('gm')
  }

  const declareGoLive = async (date: string): Promise<void> => {
    await h.deps.settings.set('system.go_live_business_date', date, 'u-sa')
  }

  it('moves a report’s start forward to go-live, and leaves a later start alone', async () => {
    await declareGoLive('2026-07-20')
    const gm = await scopedGm()

    const clamped = await get(gm, '/dashboard/profit?from=2026-07-01&to=2026-07-25')
    expect(clamped.statusCode, clamped.body).toBe(200)

    // A start already after go-live is the caller's own and must survive untouched.
    const later = await get(gm, '/dashboard/profit?from=2026-07-22&to=2026-07-25')
    expect(later.statusCode, later.body).toBe(200)
  })

  it('excludes pre-go-live entries from the week’s company share', async () => {
    const manager = await h.loginAs('manager')
    // A company-share credit dated before the epoch, inside the same financial week. Pushed
    // straight onto the ledger like the profit-range fixture above, so the assertion is about the
    // clamp and not about the fx day or the week gate.
    h.deps.ledger.entries.push({
      id: 20_001,
      branchId: BRANCH,
      eventType: 'manual',
      shiftId: null,
      occurrenceKey: 'pre-go-live-share',
      businessDate: '2026-07-20',
      postingDate: '2026-07-20',
      weekStartDate: weekStartFor('2026-07-20'),
      fxDayId: 1, sypMinorPerUsd: null,
      weekLockId: null,
      reason: 'ربح تجريبي',
      createdBy: 'u-bm',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: syp(100_000), currency: 'SYP_NEW' },
        { fundCode: 'company_revenue', side: 'C', amount: syp(100_000), currency: 'SYP_NEW' },
      ],
    })

    const before = (await get(manager, '/dashboard')).json().companyShareSinceSunday
    expect(before).toBe(sypStr(100_000))

    await declareGoLive('2026-07-21')
    const after = await get(manager, '/dashboard')
    expect(after.json().companyShareSinceSunday).toBe(sypStr(0))
    // …and the screen is told the date, so it can say WHY the figure changed.
    expect(after.json().goLiveBusinessDate).toBe('2026-07-21')
  })

  it('does not move the office box — a position is not a flow', async () => {
    const manager = await h.loginAs('manager')
    await post(manager, '/journal/manual', {
      businessDate: '2026-07-20',
      reason: 'رصيد افتتاحي',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: sypStr(500_000) },
        { fundCode: 'opening_balance', side: 'C', amount: sypStr(500_000) },
      ],
    })
    const balanceBefore = (await get(manager, '/treasury/balances')).json().cash

    await declareGoLive('2026-07-21')

    // The money is still in the drawer. Filtering it out would make every insufficient-funds
    // guard, the cash-count baseline and the restoration plan read an empty box.
    expect((await get(manager, '/treasury/balances')).json().cash).toBe(balanceBefore)
  })
})

/**
 * The capital position, split by BOX (owner request, 2026-08-29).
 *
 * A single «زيادة عن رأس المال» hides which side it sits on, and the two boxes are restored
 * against separate targets — so a surplus in cash and a shortfall in the wallet can cancel to a
 * reassuring total while both boxes are wrong.
 */
describe('the capital position is reported per box', () => {
  const post = async (token: string, url: string, payload: unknown = {}): Promise<LightMyRequestResponse> =>
    await h.app.inject({ method: 'POST', url, headers: { cookie: h.cookie(token) }, payload: payload as object })
  const put = async (token: string, url: string, payload: unknown = {}): Promise<LightMyRequestResponse> =>
    await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie(token) }, payload: payload as object })

  async function scopedGm(): Promise<string> {
    h.deps.users.seed({
      id: 'u-gm', branchId: BRANCH, roleKey: 'general_manager', username: 'gm',
      fullNameAr: 'gm', passwordHash: 'plain:secret', driverId: null,
      failedAttempts: 0, lockedUntilMs: null, active: true,
    })
    return await h.loginAs('gm')
  }

  const seedFund = async (token: string, fundCode: string, amount: string): Promise<void> => {
    const res = await post(token, '/journal/manual', {
      reason: 'رصيد افتتاحي',
      lines: [
        { fundCode, side: 'D', amount },
        { fundCode: 'opening_balance', side: 'C', amount },
      ],
    })
    expect(res.statusCode, res.body).toBe(201)
  }

  it('splits the surplus between cash and wallet instead of only totalling it', async () => {
    const admin = await h.loginAs('sysadmin')
    await put(admin, '/treasury/capital-targets', {
      cashTarget: sypStr(50_000), walletTarget: sypStr(10_000),
      reason: 'رأس المال', branchId: BRANCH,
    })
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(50_900))   // +900 over its own target
    await seedFund(manager, 'office_wallet', sypStr(10_565)) // +565 over its own target

    const res = await get(await scopedGm(), `/dashboard/treasury?branchId=${BRANCH}`)
    expect(res.statusCode, res.body).toBe(200)
    const c = res.json().capital
    expect(c.cashTarget).toBe(sypStr(50_000))
    expect(c.walletTarget).toBe(sypStr(10_000))
    expect(c.cashDelta).toBe(sypStr(900))
    expect(c.walletDelta).toBe(sypStr(565))
    // And the two still reconcile to the headline figure.
    expect(c.delta).toBe(sypStr(1_465))
  })

  it('marks the surplus provisional while a shift is open, because the day has earned nothing yet', async () => {
    /*
     * PRODUCTION, 2026-08-29. The card asserted «زيادة عن رأس المال: 6,502.00» with five shifts
     * open. The ledger said today had moved working capital by exactly 0.00 — every lira of that
     * surplus accumulated between 22 and 28 August, before the epoch was declared.
     *
     * An open shift posts nothing after its float leaves the box: orders, share and variance all
     * land at approval. So a surplus read off the position mid-shift is true about the balance and
     * false about the day, and the day is what the reader takes from it.
     */
    const admin = await h.loginAs('sysadmin')
    await put(admin, '/treasury/capital-targets', {
      cashTarget: sypStr(50_000), walletTarget: sypStr(10_000),
      reason: 'رأس المال', branchId: BRANCH,
    })
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(56_502))
    await seedFund(manager, 'office_wallet', sypStr(10_000))

    // Nothing open yet: the surplus is a fact and is stated as one.
    const before = (await get(await scopedGm(), `/dashboard/treasury?branchId=${BRANCH}`)).json().capital
    expect(before.delta).toBe(sypStr(6_502))
    expect(before.deltaProvisional).toBe(false)

    // One shift opens. The float leaves the box for the driver's hands, so working capital — and
    // therefore the surplus — is UNCHANGED. What changed is that it is no longer a settled fact.
    const driver = await h.loginAs('driver1')
    const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })
    expect(created.statusCode, created.body).toBe(201)
    const shiftId = created.json().id as string
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    expect((await put(driver, `/shifts/${shiftId}/start-package`, {
      odometerKm: 1_000,
      batteryPercent: 90,
    })).statusCode).toBe(200)
    expect((await post(manager, `/shifts/${shiftId}/approve-open`, {
      floatTranches: [sypStr(25_000)],
      topupTranches: [],
    })).statusCode).toBe(200)

    const during = (await get(await scopedGm(), `/dashboard/treasury?branchId=${BRANCH}`)).json().capital
    expect(during.delta).toBe(sypStr(6_502))
    expect(during.deltaProvisional).toBe(true)
    expect(during.activeShiftCount).toBe(1)
  })

  it('leaves active custody OUT of the per-box lines, because the restoration cannot move it', async () => {
    /*
     * PRODUCTION, 2026-08-29. The cash line read «58,218.37 / 50,000.00  +8,218.37» in green while
     * the box held 33,218.37 against that same 50,000 target — SHORT by 16,781.63. The difference
     * was 25,000 of active custody: money in drivers' pockets, folded into the box's position.
     *
     * `planRestoration` takes the position as `counted + receivables`, because custody cannot be
     * swept while a shift is live. So a green surplus on this line sent a manager to sweep money
     * that was not in the drawer, and the restoration would have refused him with
     * `sweep_exceeds_counted` — if he was lucky enough to try through the system.
     */
    const admin = await h.loginAs('sysadmin')
    await put(admin, '/treasury/capital-targets', {
      cashTarget: sypStr(50_000), walletTarget: sypStr(10_000),
      reason: 'رأس المال', branchId: BRANCH,
    })
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(60_000))
    await seedFund(manager, 'office_wallet', sypStr(10_000))

    // One live shift takes 25,000 cash out of the box and into the driver's hands.
    const driver = await h.loginAs('driver1')
    const created = await post(driver, '/shifts', { driverId: DRIVER_ID, vehicleId: VEHICLE_ID })
    expect(created.statusCode, created.body).toBe(201)
    const shiftId = created.json().id as string
    await h.uploadPhoto(driver, shiftId, 'start', 'odometer')
    expect((await put(driver, `/shifts/${shiftId}/start-package`, {
      odometerKm: 1_000,
      batteryPercent: 90,
    })).statusCode).toBe(200)
    expect((await post(manager, `/shifts/${shiftId}/approve-open`, {
      floatTranches: [sypStr(25_000)],
      topupTranches: [],
    })).statusCode).toBe(200)

    const c = (await get(await scopedGm(), `/dashboard/treasury?branchId=${BRANCH}`)).json().capital

    // The box, and what the restoration will actually see: 35,000 against a 50,000 target.
    expect(c.cashPosition).toBe(sypStr(35_000))
    expect(c.cashDelta).toBe(sypStr(-15_000))

    // The custody is not lost — it has its own line, and it still counts as working capital.
    expect(c.activeCustodyCash).toBe(sypStr(25_000))
    expect(c.activeShiftCount).toBe(1)
    expect(c.workingCapitalTotal).toBe(sypStr(70_000))
    expect(c.delta).toBe(sypStr(10_000))

    // And the actionable figure agrees with the per-box lines rather than with the headline.
    expect(c.restorationDelta).toBe(sypStr(-15_000))
  })

  it('shows a cash surplus and a wallet shortfall separately, not cancelled', async () => {
    // The failure this exists to prevent: +900 and −900 read as «on target» while both boxes are
    // wrong and tonight's restoration has two legs to move, not none.
    const admin = await h.loginAs('sysadmin')
    await put(admin, '/treasury/capital-targets', {
      cashTarget: sypStr(50_000), walletTarget: sypStr(10_000),
      reason: 'رأس المال', branchId: BRANCH,
    })
    const manager = await h.loginAs('manager')
    await seedFund(manager, 'office_cash', sypStr(50_900))
    await seedFund(manager, 'office_wallet', sypStr(9_100))

    const c = (await get(await scopedGm(), `/dashboard/treasury?branchId=${BRANCH}`)).json().capital
    expect(c.delta).toBe(sypStr(0))          // the total says "nothing to do"…
    expect(c.cashDelta).toBe(sypStr(900))    // …while cash is over
    expect(c.walletDelta).toBe(sypStr(-900)) // …and the wallet is short
  })
})

// ── P2: the time filter's server half ─────────────────────────────────────────────────────────

describe('GET /dashboard/meta — the dates every time filter is built from (P2)', () => {
  it('answers today, the week and month starts from the server clock, and falls back to today for the epoch', async () => {
    const manager = await h.loginAs('manager')
    const res = await get(manager, '/dashboard/meta')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    // NOW_MS is 2026-07-21 08:00 Damascus, a Tuesday.
    expect(res.json()).toEqual({
      today: '2026-07-21',
      goLiveBusinessDate: null,
      firstActivityDate: null,
      epoch: '2026-07-21',
      weekStart: '2026-07-19',
      monthStart: '2026-07-01',
      dayStartMinutes: 240,
      maxRangeDays: 3653,
    })
  })

  it('starts «الكل منذ البدء» at the first ledger activity, and at go-live once it is declared', async () => {
    h.deps.ledger.entries.push({
      id: 30_001, branchId: BRANCH, eventType: 'manual', shiftId: null,
      occurrenceKey: 'meta-first-activity', businessDate: '2026-07-02', postingDate: '2026-07-02',
      weekStartDate: weekStartFor('2026-07-02'), fxDayId: 1, sypMinorPerUsd: null, weekLockId: null,
      reason: 'meta fixture', createdBy: 'u-bm',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: syp(1), currency: 'SYP_NEW' },
        { fundCode: 'cost_center:opening_balance', side: 'C', amount: syp(1), currency: 'SYP_NEW' },
      ],
    })
    // Another branch's older activity is not this branch's epoch.
    h.deps.ledger.entries.push({
      id: 30_002, branchId: OTHER_BRANCH, eventType: 'manual', shiftId: null,
      occurrenceKey: 'meta-other-branch', businessDate: '2026-06-01', postingDate: '2026-06-01',
      weekStartDate: weekStartFor('2026-06-01'), fxDayId: 1, sypMinorPerUsd: null, weekLockId: null,
      reason: 'meta fixture', createdBy: 'u-bm2',
      lines: [
        { fundCode: 'office_cash', side: 'D', amount: syp(1), currency: 'SYP_NEW' },
        { fundCode: 'cost_center:opening_balance', side: 'C', amount: syp(1), currency: 'SYP_NEW' },
      ],
    })
    const manager = await h.loginAs('manager')
    expect((await get(manager, '/dashboard/meta')).json()).toMatchObject({
      goLiveBusinessDate: null,
      firstActivityDate: '2026-07-02',
      epoch: '2026-07-02',
    })

    await h.deps.settings.set('system.go_live_business_date', '2026-07-10', 'u-sa')
    expect((await get(manager, '/dashboard/meta')).json()).toMatchObject({
      goLiveBusinessDate: '2026-07-10',
      firstActivityDate: '2026-07-02',
      epoch: '2026-07-10',
    })
  })

  it('is branch data: a driver is refused and an organisation-wide role names a branch', async () => {
    expect((await get(await h.loginAs('driver1'), '/dashboard/meta')).statusCode).toBe(403)
    const admin = await h.loginAs('sysadmin')
    expect((await get(admin, '/dashboard/meta')).statusCode).toBe(422)
    expect((await get(admin, `/dashboard/meta?branchId=${BRANCH}`)).statusCode).toBe(200)
  })
})

describe('the range read behind /dashboard/profit and /dashboard/treasury (P2)', () => {
  it('reads ten years and a day, and refuses one day more with a 400', async () => {
    const gm = await scopedProfitReader()
    // 2016-07-21 → 2026-07-21 inclusive is 3,653 days (two leap days).
    expect((await get(gm, '/dashboard/profit?from=2016-07-21&to=2026-07-21')).statusCode).toBe(200)
    const tooWide = await get(gm, '/dashboard/profit?from=2016-07-20&to=2026-07-21')
    expect(tooWide.statusCode).toBe(400)
    expect(tooWide.json().error).toBe('invalid_request')
    expect((await get(gm, '/dashboard/treasury?from=2016-07-20&to=2026-07-21')).statusCode).toBe(400)
  })

  it('does not walk the ledger week by week any more', async () => {
    const byWeek = vi.spyOn(h.deps.ledger, 'listByWeek')
    const range = vi.spyOn(h.deps.ledgerRange, 'readRange')
    const gm = await scopedProfitReader()
    expect((await get(gm, '/dashboard/profit?from=2026-01-01&to=2026-07-21')).statusCode).toBe(200)
    expect((await get(gm, '/dashboard/treasury?from=2026-01-01&to=2026-07-21')).statusCode).toBe(200)
    expect(byWeek).not.toHaveBeenCalled()
    expect(range).toHaveBeenCalledTimes(2)
    expect(range.mock.calls[0]).toEqual([BRANCH, '2026-01-01', '2026-07-21'])
  })

  it('refuses impossible treasury dates, and reads no flows for a range that ends before go-live', async () => {
    const gm = await scopedProfitReader()
    expect((await get(gm, '/dashboard/treasury?from=2026-02-30&to=2026-03-01')).statusCode).toBe(400)
    expect((await get(gm, '/dashboard/treasury?to=not-a-date')).statusCode).toBe(400)

    await h.deps.settings.set('system.go_live_business_date', '2026-07-20', 'u-sa')
    const res = await get(gm, '/dashboard/treasury?from=2026-07-01&to=2026-07-10')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      from: '2026-07-20',
      to: '2026-07-10',
      companyProfit: '0.00',
      fundIn: '0.00',
      fundOut: '0.00',
      days: [],
    })
  })

  it('reports a legacy restoration and its reversal chain in the original column', async () => {
    const common = {
      branchId: BRANCH, shiftId: null, postingDate: '2026-07-20', fxDayId: 1, sypMinorPerUsd: null, weekLockId: null,
      createdBy: 'u-bm', reason: 'legacy restoration fixture',
    }
    h.deps.ledger.entries.push(
      {
        ...common, id: 40_001, eventType: 'restoration', occurrenceKey: '2026-07-12:office_cash',
        businessDate: '2026-07-12', weekStartDate: '2026-07-12',
        // A legacy row: no roles at all. D company_box is «كييش».
        lines: [
          { fundCode: 'company_box', side: 'D', amount: syp(700), currency: 'SYP_NEW' },
          { fundCode: 'office_cash', side: 'C', amount: syp(700), currency: 'SYP_NEW' },
        ],
      },
      {
        ...common, id: 40_002, eventType: 'correction', occurrenceKey: 'reversal-of-40001',
        businessDate: '2026-07-20', weekStartDate: '2026-07-19',
        lines: [
          { fundCode: 'office_cash', side: 'D', amount: syp(700), currency: 'SYP_NEW' },
          { fundCode: 'company_box', side: 'C', amount: syp(700), currency: 'SYP_NEW' },
        ],
      },
      {
        ...common, id: 40_003, eventType: 'correction', occurrenceKey: 'reversal-of-40002',
        businessDate: '2026-07-21', weekStartDate: '2026-07-19',
        lines: [
          { fundCode: 'company_box', side: 'D', amount: syp(700), currency: 'SYP_NEW' },
          { fundCode: 'office_cash', side: 'C', amount: syp(700), currency: 'SYP_NEW' },
        ],
      },
    )
    const res = await get(await scopedProfitReader(), '/dashboard/treasury?from=2026-07-20&to=2026-07-21')
    expect(res.statusCode, res.body).toBe(200)
    // The original lives in an earlier, unclosed week outside the range; both corrections still
    // land in the كييش column: first as its reversal, then as its reinstatement.
    expect(res.json().days).toEqual([
      { businessDate: '2026-07-20', in: sypStr(-700), out: sypStr(0), net: sypStr(-700) },
      { businessDate: '2026-07-21', in: sypStr(700), out: sypStr(0), net: sypStr(700) },
    ])
    expect(res.json().fundIn).toBe(sypStr(0))
    expect(res.json().fundOut).toBe(sypStr(0))
  })
})

describe('GET /dashboard/shifts-summary (P2)', () => {
  const day = '2026-07-21'
  const dayBefore = '2026-07-20'

  async function seedSummaryFixture(): Promise<void> {
    // One real, settled shift: 20 orders, 100,000 in fees, 40,000 company share, 91 km.
    await runCanonicalShift()
    // A double on the second driver's bike: 09:00 to 19:30 local, 630 minutes, 90 short of twelve hours.
    await seedCountShift('sum-full', 'approved', {
      driverId: DRIVER2_ID, vehicleId: 'vehicle-2', businessDate: day, shiftNo: 1,
      openApprovedAt: '2026-07-21T06:00:00.000Z', windowOpensAt: '2026-07-21T06:00:00.000Z',
      submittedAt: '2026-07-21T16:30:00.000Z', odoStart: 100, odoEnd: 180,
    })
    // An evening shift on the same day: 18:00 to 02:00, exactly on target. A second row that day
    // makes the driver-day a double by shape as well. Its odometer was reset: no negative km.
    await seedCountShift('sum-evening', 'week_locked', {
      driverId: DRIVER2_ID, vehicleId: 'vehicle-2', businessDate: day, shiftNo: 2,
      openApprovedAt: '2026-07-21T15:00:00.000Z', windowOpensAt: '2026-07-21T15:00:00.000Z',
      submittedAt: '2026-07-21T23:00:00.000Z', odoStart: 180, odoEnd: 150,
    })
    // A forgotten close (19 hours): counted, never judged. Its driver is not in the directory.
    await seedCountShift('sum-abandoned', 'approved', {
      businessDate: dayBefore,
      openApprovedAt: '2026-07-20T05:00:00.000Z', windowOpensAt: '2026-07-20T05:00:00.000Z',
      submittedAt: '2026-07-21T00:00:00.000Z',
    })
    // Running: an evening start nine hours ago (over its eight), and a morning one an hour old.
    await seedCountShift('sum-open', 'open', {
      businessDate: dayBefore,
      openApprovedAt: '2026-07-20T20:00:00.000Z', windowOpensAt: '2026-07-20T20:00:00.000Z',
    })
    await seedCountShift('sum-suspended', 'suspended', {
      businessDate: day,
      openApprovedAt: '2026-07-21T04:00:00.000Z', windowOpensAt: '2026-07-21T04:00:00.000Z',
    })
    // None of these is judged: a waiting close is not completed, a cancelled shift is not work,
    // and the last one is outside the range.
    await seedCountShift('sum-pending', 'pending_review', { businessDate: day })
    await seedCountShift('sum-cancelled', 'cancelled', { businessDate: day })
    await seedCountShift('sum-outside', 'approved', {
      businessDate: '2026-07-22',
      openApprovedAt: '2026-07-22T06:00:00.000Z', windowOpensAt: '2026-07-22T06:00:00.000Z',
      submittedAt: '2026-07-22T14:00:00.000Z',
    })
  }

  it('judges completed shifts with the owner schedule and counts running ones by slot', async () => {
    await seedSummaryFixture()

    const res = await get(await h.loginAs('manager'), `/dashboard/shifts-summary?from=${dayBefore}&to=${day}`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      from: dayBefore,
      to: day,
      companyShareVisible: false,
      completed: 4,
      // The canonical shift opened and closed on the frozen harness clock: a zero-minute morning.
      byPattern: { day: 2, evening: 1, full: 1, unknown: 0 },
      doubles: { total: 1, fullShifts: 1, multiShiftDays: 1 },
      short: { count: 2, minutes: 480 + 90 },
      met: 1,
      unjudged: 1,
      abandoned: 1,
      running: { count: 2, open: 1, suspended: 1, overTarget: 1, slots: { day: 1, evening: 1, unknown: 0 } },
      pendingReview: 1,
      // 91 km on the canonical bike and 80 on the double; the reset odometer adds none.
      totals: { orders: 20, feesSyp: sypStr(100_000), companyShareSyp: null, km: 171, workedMinutes: 630 + 480 },
    })
    expect(body.byDriver).toEqual([
      {
        driverId: 'driver-sum-abandoned', name: 'driver-sum-abandoned', nameEn: null, code: null,
        shifts: 1, doubles: 0, short: { count: 0, minutes: 0 }, workedMinutes: 0,
        orders: 0, feesSyp: sypStr(0), companyShareSyp: null,
      },
      {
        driverId: DRIVER_ID, name: 'سائق ١', nameEn: null, code: 'DRV-1',
        shifts: 1, doubles: 0, short: { count: 1, minutes: 480 }, workedMinutes: 0,
        orders: 20, feesSyp: sypStr(100_000), companyShareSyp: null,
      },
      {
        driverId: DRIVER2_ID, name: 'سائق ٢', nameEn: null, code: 'DRV-2',
        shifts: 2, doubles: 1, short: { count: 1, minutes: 90 }, workedMinutes: 1110,
        orders: 0, feesSyp: sypStr(0), companyShareSyp: null,
      },
    ])
    expect(
      (body.byVehicle as Array<{ vehicleId: string; shifts: number; km: number }>).map((v) => [v.vehicleId, v.shifts, v.km]),
    ).toEqual([
      [VEHICLE_ID, 1, 91],
      ['vehicle-2', 2, 80],
      ['vehicle-sum-abandoned', 1, 0],
    ])
  })

  it('shows the company share only to a caller who may see profit (BR8)', async () => {
    await seedSummaryFixture()
    const manager = await get(await h.loginAs('manager'), `/dashboard/shifts-summary?from=${day}&to=${day}`)
    expect(manager.json().companyShareVisible).toBe(false)
    expect(manager.json().totals.companyShareSyp).toBeNull()

    const gm = await get(await scopedProfitReader(), `/dashboard/shifts-summary?from=${day}&to=${day}`)
    expect(gm.statusCode, gm.body).toBe(200)
    expect(gm.json().companyShareVisible).toBe(true)
    expect(gm.json().totals.companyShareSyp).toBe(sypStr(40_000))
    const byDriver = gm.json().byDriver as Array<{ driverId: string; companyShareSyp: string | null }>
    expect(byDriver.find((d) => d.driverId === DRIVER_ID)?.companyShareSyp).toBe(sypStr(40_000))
    // No settlement snapshot, no company share: never an invented one.
    expect(byDriver.find((d) => d.driverId === DRIVER2_ID)?.companyShareSyp).toBe(sypStr(0))
  })

  it('needs a real, ordered, bounded range and branch access', async () => {
    const manager = await h.loginAs('manager')
    expect((await get(manager, '/dashboard/shifts-summary')).statusCode).toBe(400)
    expect((await get(manager, `/dashboard/shifts-summary?from=${day}&to=${dayBefore}`)).statusCode).toBe(400)
    expect((await get(manager, '/dashboard/shifts-summary?from=2026-02-30&to=2026-03-01')).statusCode).toBe(400)
    expect((await get(manager, '/dashboard/shifts-summary?from=2016-07-20&to=2026-07-21')).statusCode).toBe(400)
    expect((await get(await h.loginAs('driver1'), `/dashboard/shifts-summary?from=${day}&to=${day}`)).statusCode).toBe(403)
    const other = await get(await h.loginAs('manager2'), `/dashboard/shifts-summary?from=${day}&to=${day}&branchId=${BRANCH}`)
    expect(other.statusCode).toBe(403)
  })
})
