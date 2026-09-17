import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  type Deps,
  LEDGER_RANGE_MAX_DAYS,
  type ShiftOrderRecord,
  type ShiftRecord,
  type ShiftTimingRecord,
  serializeMoney,
} from '@ash/contracts'
import {
  type CalendarDate,
  type ShiftPattern,
  type WorkedTime,
  type DistanceTotal,
  type FxDay,
  REQUIRED_END_SLOTS,
  SHIFT_TARGET_MINUTES,
  addProfitLine,
  addShiftDistance,
  can,
  classifyProfitLine,
  daysBetween,
  EMPTY_DISTANCE_TOTAL,
  emptyProfitTotals,
  isCalendarDate,
  isDriverBlockLine,
  isLive,
  minor,
  monthStartFor,
  netProfit,
  resolveFxDay,
  shiftDistance,
  shiftShapeForDay,
  shortfallMinutes,
  signedCost,
  splitFixedDriverShare,
  toUsdMinor,
  totalCost,
  vehicleIdOfCostLine,
  weekStartFor,
  workedTime,
} from '@ash/domain'
import { ServiceError, includedOrders, todayFor } from './shifts.service.ts'
import { branchSubject, resolveBranchId } from './branch-scope.ts'
import { clampToGoLive, goLiveDate } from './go-live.ts'
import { grantsFromRows } from './rbac.ts'

/**
 * The minimal ops dashboard (SRS I-1, in scope per the brief's "minimal ops dashboard").
 *
 * Five original indicators from the brief (س69), minus the cash-difference tile the SRS itself
 * dropped because BR1 makes it always zero. The two live working counts are served separately
 * below so their frequent refresh never reloads these heavier financial reads:
 *   1. today's fee revenue (SYP + USD)
 *   2. orders, total and per driver
 *   3. the company's accumulated share since the last Sunday
 *   4. fleet readiness (ready / charging / maintenance / stopped)
 *   5. data completeness — open shifts, shifts awaiting approval, missing packages
 *
 * Every figure is branch-scoped and read-only. Nothing here writes.
 */
export function registerDashboardRoutes(app: FastifyInstance, deps: Deps): void {
  const ownBranch = branchSubject

  /**
   * The high-frequency dashboard read. Keep this separate from `/dashboard`: polling a pair of
   * counts must not repeatedly load orders, FX, ledger entries, fleet details and notifications.
   * "Working" is exactly the `open` state and intentionally ignores business date, so an open
   * shift remains visible after midnight until the driver submits its end package.
   */
  app.get('/dashboard/working-now', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store')
    const branchId = resolveBranchId(req)
    const counts = await deps.shifts.countOpenActorsForBranch(branchId)
    return {
      asOf: new Date(deps.clock.nowMs()).toISOString(),
      ...counts,
    }
  })

  /**
   * P2 — the dates every time filter is built from.
   *
   * «Today» is the SERVER's business date (the day starts at 04:00 Damascus). The console used to
   * take it from the session, which is stamped at sign-in and goes stale at 04:00 for a manager
   * who stays signed in, and a browser clock knows neither the zone nor the day start.
   *
   * `epoch` is where «الكل منذ البدء» begins: the go-live date, else the branch's first ledger
   * activity, else today.
   */
  app.get('/dashboard/meta', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req, reply) => {
    reply.header('cache-control', 'private, no-store')
    const branchId = resolveBranchId(req)
    const today = todayFor(deps)
    const [goLive, firstActivity] = await Promise.all([
      goLiveDate(deps),
      deps.ledgerRange.firstActivityDate(branchId),
    ])
    return {
      today,
      goLiveBusinessDate: goLive,
      firstActivityDate: firstActivity,
      epoch: goLive ?? firstActivity ?? today,
      weekStart: weekStartFor(today),
      monthStart: monthStartFor(today),
      /** Minutes past local midnight at which the business day turns over (240 = 04:00). */
      dayStartMinutes: deps.clock.dayStartMinutes(),
      /** The widest range the range-based reports accept. */
      maxRangeDays: LEDGER_RANGE_MAX_DAYS,
    }
  })

  app.get('/dashboard', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    // The GM and the sysadmin have no branch of their own — they name one with `?branchId=`.
    // Reading `req.actor.branchId` alone was why this endpoint 422'd for exactly the two roles
    // the §3 matrix grants `branch_data.view` at scope 'all'.
    const branchId = resolveBranchId(req)

    /*
     * Which business day to describe. Omitted means today — and «today» rolls at 04:00, not
     * midnight (`businessDateFor`), so a manager reading this at 01:30 sees the day he is still
     * working rather than an empty one that began ninety minutes ago.
     *
     * Only the day-scoped panels follow it. Fleet readiness below is deliberately left live:
     * `vehicles.state` is a current fact with no history, so pretending to show yesterday's
     * readiness would be inventing data.
     */
    const q = z.object({ day: realCalendarDate.optional() }).parse(req.query)
    const today = q.day ?? todayFor(deps)
    const shifts = await deps.shifts.listByBranchAndDate(branchId, today)

    // ── Orders and revenue, from today's approved shifts ────────────────────────────────────
    const perDriver = new Map<string, { orders: number; fees: bigint }>()
    let feeTotal = 0n
    let orderTotal = 0
    for (const shift of shifts) {
      if (shift.state !== 'approved' && shift.state !== 'week_locked') continue
      // What the shift was APPROVED on: an operation the driver unchecked never entered BR1, the
      // tier band or the ledger, so counting it here would make the dashboard's revenue disagree
      // with the books it is supposed to summarise.
      const orders = includedOrders(await deps.orders.listByShift(shift.id))
      const driverFees = orders.reduce((acc, o) => acc + o.fee, 0n)
      const acc = perDriver.get(shift.driverId) ?? { orders: 0, fees: 0n }
      acc.orders += orders.length
      acc.fees += driverFees
      perDriver.set(shift.driverId, acc)
      feeTotal += driverFees
      orderTotal += orders.length
    }

    // USD equivalent at today's rate (BR6). Provisional is fine to display — it is flagged.
    const fxDays = await deps.fx.list()
    const fx = fxDays.find((d) => d.businessDate === today) ?? fxDays.filter((d) => d.businessDate < today).at(-1)
    const revenueUsd =
      fx !== undefined ? serializeMoney(toUsdMinor(minor(feeTotal), fx)) : null

    // ── The company's share accrued since the last Sunday ───────────────────────────────────
    // `company_revenue` is credited at each approval, so its balance (negated to a positive)
    // over the current financial week is exactly the accrual the GM watches.
    const weekStart = weekStartFor(today)
    const goLive = await goLiveDate(deps)
    const accrualFrom = clampToGoLive(weekStart, goLive)
    const weekEntries = await deps.ledger.listByWeek(branchId, weekStart)
    let companyShareWeek = 0n
    for (const e of weekEntries) {
      // The week is the query unit (BR7 seals weeks), so a go-live mid-week is filtered per entry
      // rather than by asking for a shorter week the ledger has no way to address.
      if (e.businessDate < accrualFrom) continue
      for (const l of e.lines) {
        if (l.fundCode === 'company_revenue') companyShareWeek += l.side === 'C' ? l.amount : -l.amount
      }
    }

    // Names for the per-driver breakdown, so the UI shows a driver, not his UUID.
    const drivers = await deps.directory.listDrivers(branchId)
    const driverInfo = new Map(drivers.map((d) => [d.id, { name: d.fullNameAr, code: d.code }]))

    // ── Fleet readiness ─────────────────────────────────────────────────────────────────────
    const vehicles = await deps.directory.listVehicles(branchId)
    const fleet = { ready: 0, charging: 0, maintenance: 0, stopped: 0 }
    for (const v of vehicles) if (v.active) fleet[v.state] += 1

    // ── Data completeness — the tile that says "what still needs a human" ───────────────────
    const live = shifts.filter((s) => isLive(s.state))
    const awaitingApproval = shifts.filter(
      (s) => s.state === 'awaiting_open_approval' || s.state === 'pending_review',
    )
    const missingEndPackage = shifts.filter(
      (s) => s.state === 'pending_review' && !hasCompleteEndPackage(s),
    )

    return {
      businessDate: today,
      /**
       * The configured go-live date, so the screen can MARK a day that predates it rather than
       * hide it. The day picker is a deliberate historical lookup; silently blanking it would be
       * worse than labelling it «قبل بدء التطبيق».
       */
      goLiveBusinessDate: goLive,
      beforeGoLive: goLive !== null && today < goLive,
      revenue: {
        feesSyp: serializeMoney(minor(feeTotal)),
        feesUsd: revenueUsd,
        fxProvisional: fx?.provisional ?? true,
      },
      orders: {
        total: orderTotal,
        perDriver: [...perDriver.entries()].map(([driverId, v]) => ({
          driverId,
          name: driverInfo.get(driverId)?.name ?? driverId,
          code: driverInfo.get(driverId)?.code ?? null,
          orders: v.orders,
          feesSyp: serializeMoney(minor(v.fees)),
        })),
      },
      companyShareSinceSunday: serializeMoney(minor(companyShareWeek)),
      fleet,
      completeness: {
        openShifts: live.length,
        awaitingApproval: awaitingApproval.length,
        missingEndPackage: missingEndPackage.length,
        suspended: shifts.filter((s) => s.state === 'suspended').length,
      },
    }
  })

  /**
   * P2 — «النوبات» over a date range: how the fleet actually worked, for the dashboard's operations
   * section and the drill-downs into the completed/live shift screens.
   *
   * Judged exactly as `GET /shifts` judges a row — `workedTime` over the operation window, with the
   * owner's targets — and over the SAME population the completed-shifts screen lists (approved and
   * week-locked), so a count here is the count a manager sees after clicking it.
   *
   * `branch_data.view`, like the shift list. The company-share columns are BR8 figures, so they are
   * filled only for a caller who ALSO holds `profit.view_total`; everyone else gets `null`.
   */
  app.get('/dashboard/shifts-summary', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const q = z.object({ from: realCalendarDate, to: realCalendarDate }).parse(req.query)
    if (q.from > q.to) {
      throw new z.ZodError([{ code: 'custom', path: ['from'], message: '`from` must be on or before `to`' }])
    }
    assertWithinRangeCap(q.from, q.to)
    const branchId = resolveBranchId(req)
    const showCompanyShare = await holdsPermission(req, 'profit.view_total')

    const timing = await deps.shifts.listTimingBetween(branchId, q.from, q.to)
    const offset = deps.clock.offsetMinutes()
    const dayStart = deps.clock.dayStartMinutes()
    const nowMs = deps.clock.nowMs()
    const workedOf = (s: ShiftTimingRecord): WorkedTime =>
      workedTime(
        s.windowOpensAt === null ? null : Date.parse(s.windowOpensAt),
        s.submittedAt === null ? null : Date.parse(s.submittedAt),
        offset,
        dayStart,
      )

    const completed = timing.filter((s) => COMPLETED_SHIFT_STATES.has(s.state))
    const live = timing.filter((s) => s.state === 'open' || s.state === 'suspended')
    const completedIds = completed.map((s) => s.id)
    const [orderRows, settlementRows, drivers, vehicles] = await Promise.all([
      deps.orders.listByShiftIds(completedIds),
      showCompanyShare ? deps.settlements.listByShiftIds(completedIds) : Promise.resolve([]),
      deps.directory.listDrivers(branchId),
      deps.directory.listVehicles(branchId),
    ])
    const ordersByShift = new Map<string, ShiftOrderRecord[]>()
    for (const order of orderRows) {
      const grouped = ordersByShift.get(order.shiftId) ?? []
      grouped.push(order)
      ordersByShift.set(order.shiftId, grouped)
    }
    const settled = new Set(settlementRows.map((row) => row.shiftId))

    const byDriver = new Map<string, ShiftTally>()
    const byVehicle = new Map<string, ShiftTally>()
    const tallyFor = (map: Map<string, ShiftTally>, key: string): ShiftTally => {
      const found = map.get(key)
      if (found) return found
      const fresh = emptyShiftTally()
      map.set(key, fresh)
      return fresh
    }
    const total = emptyShiftTally()
    const byPattern: Record<ShiftPattern, number> = { day: 0, evening: 0, full: 0, unknown: 0 }
    let met = 0
    let unjudged = 0
    let abandoned = 0

    /** Fees per business date, so the USD equivalent uses each day's own rate (BR6). */
    const feesByDay = new Map<CalendarDate, bigint>()
    for (const shift of completed) {
      const worked = workedOf(shift)
      byPattern[worked.pattern] += 1
      if (worked.abandoned) abandoned += 1
      const short = shortfallMinutes(worked)
      if (short === null) unjudged += 1
      else if (short === 0) met += 1

      // What the shift was APPROVED on — an unchecked operation never entered the money.
      const counted = includedOrders(ordersByShift.get(shift.id) ?? [])
      const fees = counted.reduce((acc, o) => acc + o.fee, 0n)
      feesByDay.set(shift.businessDate, (feesByDay.get(shift.businessDate) ?? 0n) + fees)
      // The company's share exactly as the shift's financial block states it (`GET /shifts`):
      // fixed 40% over the Yallago fees, plus the company part of every manual order.
      let companyShare = 0n
      if (settled.has(shift.id)) {
        companyShare =
          splitFixedDriverShare(counted.filter((o) => o.kind !== 'manual').map((o) => o.fee)).companyShare +
          counted.filter((o) => o.kind === 'manual').reduce((acc, o) => acc + (o.companyShare ?? 0n), 0n)
      }
      // Distance only when both readings exist and run forwards; a reset odometer is not negative
      // km. The rule is the domain's (`shiftDistance`), shared with `/dashboard/fleet-performance`.
      const distance = shiftDistance({ start: shift.odoStart, end: shift.odoEnd })
      const km = distance.recorded ? distance.km : 0

      for (const tally of [total, tallyFor(byDriver, shift.driverId), tallyFor(byVehicle, shift.vehicleId)]) {
        tally.shifts += 1
        if (worked.pattern === 'full') tally.doubles += 1
        if (short !== null && short > 0) {
          tally.shortCount += 1
          tally.shortMinutes += short
        }
        // A forgotten close has a duration that means nothing; it is not worked time.
        if (worked.minutes !== null && !worked.abandoned) tally.workedMinutes += worked.minutes
        tally.orders += counted.length
        tally.fees += fees
        tally.companyShare += companyShare
        tally.km += km
      }
    }

    // «شيفت عادية او دبل» per driver-day: one ten-hour shift OR two shifts on one date.
    const driverDays = new Map<string, ShiftTimingRecord[]>()
    for (const shift of completed) {
      const key = `${shift.driverId}|${shift.businessDate}`
      const rows = driverDays.get(key) ?? []
      rows.push(shift)
      driverDays.set(key, rows)
    }
    let doubleDays = 0
    let multiShiftDays = 0
    for (const rows of driverDays.values()) {
      if (rows.length > 1) multiShiftDays += 1
      if (shiftShapeForDay(rows.map((row) => ({ worked: workedOf(row) }))) === 'double') doubleDays += 1
    }

    // Running now: its slot is certain, its pattern is not. «Over» is measured against the slot's
    // own eight hours, the same way the live board draws its progress bar.
    let overTarget = 0
    const runningSlots = { day: 0, evening: 0, unknown: 0 }
    for (const shift of live) {
      const worked = workedOf(shift)
      runningSlots[worked.slot ?? 'unknown'] += 1
      if (shift.windowOpensAt !== null && worked.slot !== null) {
        const elapsed = Math.floor((nowMs - Date.parse(shift.windowOpensAt)) / 60_000)
        const target = SHIFT_TARGET_MINUTES[worked.slot]
        if (target !== null && elapsed > target) overTarget += 1
      }
    }

    const driverInfo = new Map(drivers.map((d) => [d.id, d]))
    const vehicleInfo = new Map(vehicles.map((v) => [v.id, v]))
    const money = (value: bigint): string => serializeMoney(minor(value))
    const shareOf = (tally: ShiftTally): string | null => (showCompanyShare ? money(tally.companyShare) : null)
    const feesUsd = usdEquivalentByDay(feesByDay, feesByDay.size === 0 ? [] : await deps.fx.list())
    const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

    return {
      from: q.from,
      to: q.to,
      companyShareVisible: showCompanyShare,
      completed: completed.length,
      byPattern,
      doubles: { total: doubleDays, fullShifts: byPattern.full, multiShiftDays },
      short: { count: total.shortCount, minutes: total.shortMinutes },
      met,
      unjudged,
      abandoned,
      running: {
        count: live.length,
        open: live.filter((s) => s.state === 'open').length,
        suspended: live.filter((s) => s.state === 'suspended').length,
        overTarget,
        slots: runningSlots,
      },
      pendingReview: timing.filter((s) => s.state === 'pending_review').length,
      totals: {
        orders: total.orders,
        feesSyp: money(total.fees),
        /**
         * P3 — the fees in dollars, each business day at ITS OWN rate (BR6), the way the old
         * day tile showed «≈ $». Null when some day of the range has no rate on or before it:
         * a partial dollar total would read as the whole one.
         */
        feesUsd: feesUsd === null ? null : money(feesUsd.usd),
        fxProvisional: feesUsd?.provisional ?? false,
        companyShareSyp: shareOf(total),
        km: total.km,
        workedMinutes: total.workedMinutes,
      },
      byDriver: [...byDriver.entries()]
        .map(([driverId, t]) => ({
          driverId,
          name: driverInfo.get(driverId)?.fullNameAr ?? driverId,
          nameEn: driverInfo.get(driverId)?.fullNameEn ?? null,
          code: driverInfo.get(driverId)?.code ?? null,
          shifts: t.shifts,
          doubles: t.doubles,
          short: { count: t.shortCount, minutes: t.shortMinutes },
          workedMinutes: t.workedMinutes,
          orders: t.orders,
          feesSyp: money(t.fees),
          companyShareSyp: shareOf(t),
        }))
        .sort(byName),
      byVehicle: [...byVehicle.entries()]
        .map(([vehicleId, t]) => ({
          vehicleId,
          name: vehicleInfo.get(vehicleId)?.code ?? vehicleId,
          code: vehicleInfo.get(vehicleId)?.code ?? null,
          groundNo: vehicleInfo.get(vehicleId)?.groundNo ?? null,
          shifts: t.shifts,
          doubles: t.doubles,
          short: { count: t.shortCount, minutes: t.shortMinutes },
          km: t.km,
          workedMinutes: t.workedMinutes,
          orders: t.orders,
          feesSyp: money(t.fees),
          companyShareSyp: shareOf(t),
        }))
        .sort(byName),
    }
  })

  /** Does the caller hold `permission` at all? The same grant table the route guard reads. */
  const holdsPermission = async (req: FastifyRequest, permission: 'profit.view_total'): Promise<boolean> => {
    if (!req.actor) return false
    const grants = grantsFromRows(await deps.directory.grants())
    // `profit.view_total` routes declare an empty subject; ask the same question they ask.
    return can(req.actor, permission, {}, grants).allowed
  }

  /**
   * P3 — «أداء الآليات»: how each bike of the branch worked over a range.
   *
   * `branch_data.view`, like the shifts summary, over the SAME population (approved and
   * week-locked shifts) and with the same fee rule, so a bike's row agrees with the completed-shifts
   * list its link opens. Per vehicle: shifts, kilometres (the domain's `shiftDistance`: both
   * readings present and running forwards; every other shift counted as `kmUnrecorded`), orders and
   * fees.
   *
   * THE MONEY COLUMNS ARE BR8 FIGURES and are OMITTED — the keys are absent, not null — for a
   * caller without `profit.view_total`. Hiding a column in the browser is not security.
   *   - `companyShareSyp`: exactly the shifts summary's company share (settled shifts only).
   *   - `vehicleCostSyp`: every ledger line `classifyProfitLine` calls a vehicle cost, attributed by
   *     `vehicleIdOfCostLine`, read through the range source and clamped to go-live exactly as
   *     `/dashboard/profit` clamps it — so the column always sums to that report's `vehicleCostSyp`
   *     for the same dates (a line whose vehicle cannot be named is reported beside the rows).
   *   - `contributionSyp` = company share − vehicle costs.
   * Book value and unpaid instalments arrive with the fixed-asset register (C4), not here.
   *
   * RANGE CAP: `LEDGER_RANGE_MAX_DAYS`, the same bound as `/dashboard/shifts-summary` and the profit
   * report. This is an aggregate the dashboard asks for over «الكل منذ البدء»; the 31/400-day cap
   * belongs to `GET /shifts`, which returns rows.
   */
  app.get('/dashboard/fleet-performance', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const q = z.object({ from: realCalendarDate, to: realCalendarDate }).parse(req.query)
    if (q.from > q.to) {
      throw new z.ZodError([{ code: 'custom', path: ['from'], message: '`from` must be on or before `to`' }])
    }
    assertWithinRangeCap(q.from, q.to)
    const branchId = resolveBranchId(req)
    const showFinance = await holdsPermission(req, 'profit.view_total')

    const timing = await deps.shifts.listTimingBetween(branchId, q.from, q.to)
    const completed = timing.filter((s) => COMPLETED_SHIFT_STATES.has(s.state))
    const completedIds = completed.map((s) => s.id)
    // Clamped like the profit report: the trial period is readable but never totalled as cost.
    const costsFrom = showFinance ? clampToGoLive(q.from, await goLiveDate(deps)) : null
    const [orderRows, settlementRows, vehicles, range] = await Promise.all([
      deps.orders.listByShiftIds(completedIds),
      showFinance ? deps.settlements.listByShiftIds(completedIds) : Promise.resolve([]),
      // Every vehicle of the branch, retired ones included: a stopped bike's old work is work.
      deps.directory.listVehicles(branchId),
      costsFrom !== null && costsFrom <= q.to
        ? deps.ledgerRange.readRange(branchId, costsFrom, q.to)
        : Promise.resolve(null),
    ])
    const ordersByShift = new Map<string, ShiftOrderRecord[]>()
    for (const order of orderRows) {
      const grouped = ordersByShift.get(order.shiftId) ?? []
      grouped.push(order)
      ordersByShift.set(order.shiftId, grouped)
    }
    const settled = new Set(settlementRows.map((row) => row.shiftId))

    const rows = new Map<string, FleetTally>()
    const rowFor = (vehicleId: string): FleetTally => {
      const found = rows.get(vehicleId)
      if (found) return found
      const fresh = emptyFleetTally()
      rows.set(vehicleId, fresh)
      return fresh
    }
    const total = emptyFleetTally()

    for (const shift of completed) {
      const counted = includedOrders(ordersByShift.get(shift.id) ?? [])
      const fees = counted.reduce((acc, o) => acc + o.fee, 0n)
      let companyShare = 0n
      if (settled.has(shift.id)) {
        companyShare =
          splitFixedDriverShare(counted.filter((o) => o.kind !== 'manual').map((o) => o.fee)).companyShare +
          counted.filter((o) => o.kind === 'manual').reduce((acc, o) => acc + (o.companyShare ?? 0n), 0n)
      }
      const distance = shiftDistance({ start: shift.odoStart, end: shift.odoEnd })
      for (const tally of [total, rowFor(shift.vehicleId)]) {
        tally.shifts += 1
        tally.distance = addShiftDistance(tally.distance, distance)
        tally.orders += counted.length
        tally.fees += fees
        tally.companyShare += companyShare
      }
    }

    // Vehicle costs, only for a caller who may see them — and only then does a bike with costs but
    // no shifts in the range earn a row.
    const classification = { vehicleIds: new Set(vehicles.map((vehicle) => vehicle.id)) }
    let allVehicleCost = 0n
    for (const line of range?.lines ?? []) {
      if (classifyProfitLine(line.fundCode, classification) !== 'vehicle_cost') continue
      const cost = signedCost(line.side, line.amount)
      allVehicleCost += cost
      const vehicleId = vehicleIdOfCostLine(line.fundCode, classification)
      if (vehicleId === null) continue
      rowFor(vehicleId).cost += cost
      total.cost += cost
    }

    const vehicleInfo = new Map(vehicles.map((v) => [v.id, v]))
    const money = (value: bigint): string => serializeMoney(minor(value))
    const shape = (tally: FleetTally) => ({
      shifts: tally.shifts,
      km: tally.distance.km,
      kmUnrecorded: tally.distance.unrecordedShifts,
      orders: tally.orders,
      feesSyp: money(tally.fees),
      ...(showFinance
        ? {
            companyShareSyp: money(tally.companyShare),
            vehicleCostSyp: money(tally.cost),
            contributionSyp: money(tally.companyShare - tally.cost),
          }
        : {}),
    })
    // Code-unit order on the printed code; a bike the directory cannot name sorts after them, by id.
    const byCode = ([a]: [string, FleetTally], [b]: [string, FleetTally]): number => {
      const ca = vehicleInfo.get(a)?.code ?? null
      const cb = vehicleInfo.get(b)?.code ?? null
      if (ca !== cb) {
        if (ca === null) return 1
        if (cb === null) return -1
        return ca < cb ? -1 : 1
      }
      return a < b ? -1 : a > b ? 1 : 0
    }

    return {
      from: q.from,
      to: q.to,
      financeVisible: showFinance,
      ...(showFinance
        ? {
            /** Where the cost read started — `from` moved forward to go-live, if it had to be. */
            costsFrom,
            /** Vehicle costs no row could name. Zero unless a cost centre is malformed. */
            unattributedVehicleCostSyp: money(allVehicleCost - total.cost),
          }
        : {}),
      totals: shape(total),
      vehicles: [...rows.entries()].sort(byCode).map(([vehicleId, tally]) => {
        const vehicle = vehicleInfo.get(vehicleId)
        return {
          vehicleId,
          code: vehicle?.code ?? null,
          groundNo: vehicle?.groundNo ?? null,
          active: vehicle?.active ?? null,
          ...shape(tally),
        }
      }),
    }
  })

  /**
   * Total profit / share is General-Manager-only (BR8). Everyone else who reaches the dashboard
   * sees the operational tiles above but not this figure — hence a SEPARATE endpoint with a
   * SEPARATE permission, rather than a field the branch dashboard hides.
   */
  app.get('/dashboard/profit', { config: { permission: 'profit.view_total', subject: () => ({}) } }, async (req) => {
    const q = z.object({ from: realCalendarDate.optional(), to: realCalendarDate.optional() }).parse(req.query)
    const today = todayFor(deps)
    const to = q.to ?? today
    // Clamped to go-live: the trial period stays in the database and stays readable, but it is
    // never totalled into a profit figure. Clamping the START only — the caller's `to` is his own.
    const from = clampToGoLive(q.from ?? weekStartFor(to), await goLiveDate(deps))
    if (from > to) {
      throw new z.ZodError([{
        code: 'custom',
        path: ['from'],
        message: '`from` must be on or before `to`',
      }])
    }
    assertWithinRangeCap(from, to)
    // The GM is org-wide; totalling across every branch would need a fan-out. Single branch
    // today, so he names the one he means and the figure stays unambiguous.
    const branchId = resolveBranchId(req)

    const weekStart = weekStartFor(from)
    /*
     * ONE aggregate over the range (P2). This walked the ledger a financial week at a time — up to
     * 520 reads — and totalled every line here. The range source groups the lines in the database
     * and resolves the driver share exactly as this route used to: the immutable settlement's
     * `baseDriverShare` for every shift the range touches, and the legacy share lines otherwise.
     */
    const [range, vehicles] = await Promise.all([
      deps.ledgerRange.readRange(branchId, from, to),
      // Every vehicle of the branch, retired ones included: a stopped bike's old costs are costs.
      deps.directory.listVehicles(branchId),
    ])
    const classification = { vehicleIds: new Set(vehicles.map((vehicle) => vehicle.id)) }

    const totals = emptyProfitTotals()
    /*
     * The GROSS block share, and it has to be its own accumulator.
     *
     * `driverShareSyp` below is the SETTLEMENT figure — net of cash deductions — while `shareSplit`
     * credits the gross 40%. Building the fee bridge on the settlement number would leave it short
     * by every deduction ever taken: measured here, 83,195.50 against a gross 82,698.00. A waterfall
     * whose rows do not sum is worse than no waterfall.
     */
    let driverBlock = 0n
    /** Per business date, so the screen can show WHY one day differs from its neighbours. */
    const perDay = new Map<string, ReturnType<typeof emptyProfitTotals>>()
    for (const line of range.lines) {
      /*
       * `classifyProfitLine` is the allowlist this route used to keep inline, with the fix of
       * 2026-09-17: a vehicle expense lands on `cost_center:<vehicle id>`, which the old list never
       * matched, so every vehicle cost was missing from net profit. Capital movements wearing the
       * same prefix (`owner_funding`, `owner_drawings`, `opening_balance`) still classify as null.
       *
       * «No cost recorded» and «costs that net to zero» stay different facts: the aggregate carries
       * how many LINES it summarises, and `costLineCount` counts those, not the total.
       */
      const cls = classifyProfitLine(line.fundCode, classification)
      if (cls !== null) {
        addProfitLine(totals, cls, line.side, line.amount, line.lineCount)
        const day = perDay.get(line.businessDate) ?? emptyProfitTotals()
        addProfitLine(day, cls, line.side, line.amount, line.lineCount)
        perDay.set(line.businessDate, day)
      }
      // NOT part of the classification above: the gross block share is a question about the
      // `share_split` credit only, never about the deduction lines the legacy share also reads.
      if (isDriverBlockLine(line.fundCode, line.role)) {
        driverBlock += line.side === 'C' ? line.amount : -line.amount
      }
    }
    // A surplus/shortage is a settlement difference, not earned driver share. New immutable
    // snapshots expose the exact net earned share after cash deductions and before variance.
    // Legacy approvals have no snapshot and retain their historical share_split less
    // cash-deduction calculation. Payout/return debits are settlement, not reduced earnings.
    const driverShare = range.settledDriverShare + range.legacyDriverShare
    return {
      from,
      to,
      weekStart,
      companyShareSyp: serializeMoney(minor(totals.company)),
      driverShareSyp: serializeMoney(minor(driverShare)),
      yalagoShareSyp: serializeMoney(minor(totals.yalago)),
      otherIncomeSyp: serializeMoney(minor(totals.otherIncome)),
      // Every cost together, as it has always meant — now including the vehicles.
      expenseSyp: serializeMoney(minor(totalCost(totals))),
      /** P2 — the parts of `expenseSyp`, so a screen can show the fleet's running cost on its own. */
      operatingCostSyp: serializeMoney(minor(totals.operatingCost)),
      vehicleCostSyp: serializeMoney(minor(totals.vehicleCost)),
      lossSyp: serializeMoney(minor(totals.loss)),
      expenseLineCount: totals.costLineCount,
      driverBlockShareSyp: serializeMoney(minor(driverBlock)),
      // DERIVED, never read from `fee_earned`: `orderFee` credits that fund and `shareSplit` debits
      // it in the same batch, so its balance over any period is exactly zero. Deriving it from the
      // three shares instead makes the bridge reconcile by construction — `shareSplit` already
      // refuses to post a split that does not exhaust the fee total.
      feeTotalSyp: serializeMoney(minor(driverBlock + totals.company + totals.yalago)),
      // The whole point of the endpoint, and the one figure the general manager opens it for.
      // Company share is GROSS — expenses never touch `company_revenue` — so it is not profit and
      // was never presented as any. This is: company + other income − (operating + vehicle + loss).
      // Depreciation is not subtracted (owner decision 2026-09-17); it is shown beside profit.
      netProfitSyp: serializeMoney(minor(netProfit(totals))),
      // One row per business date that moved, so a day can be read against its neighbours. It is
      // what turns «we lost 13,543 on the 3rd» into «salaries were paid on the 3rd».
      days: [...perDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([businessDate, d]) => ({
          businessDate,
          companyShareSyp: serializeMoney(minor(d.company)),
          otherIncomeSyp: serializeMoney(minor(d.otherIncome)),
          expenseSyp: serializeMoney(minor(totalCost(d))),
          vehicleCostSyp: serializeMoney(minor(d.vehicleCost)),
          netProfitSyp: serializeMoney(minor(netProfit(d))),
        })),
    }
  })

  /**
   * The owner's own sheet: «راس المال المدور · ربح الشركة · دخل الصندوق · خرج الصندوق · الصافي».
   *
   * His spreadsheet gets these by `SUMIF`-ing a hand-typed Arabic word in a column — one typo away
   * from a wrong total, and unavailable the moment somebody writes «كيش» instead of «كييش». Here
   * they come from the LEDGER EVENT: a `restoration` entry that DEBITS `company_box` is كييش,
   * one that CREDITS it is شحن من الصندوق. Nothing depends on how anybody spelt it.
   *
   * `profit.view_total` — BR8's «رؤية الأرباح والحصص الإجمالية», i.e. the GM and, since decision 9,
   * the system admin. The branch manager sees his own box's position on the الترميم card instead.
   */
  app.get('/dashboard/treasury', { config: { permission: 'profit.view_total', subject: () => ({}) } }, async (req) => {
    // Real calendar dates or a 400 — an impossible date used to reach `weekStartFor` and 500.
    const q = z.object({ from: realCalendarDate.optional(), to: realCalendarDate.optional() }).parse(req.query)
    const branchId = resolveBranchId(req)
    const today = todayFor(deps)
    const to = q.to ?? today
    // Clamped to go-live, like the profit report. The CAPITAL block below is deliberately NOT
    // clamped: it is a position read as it stands, made true at go-live by the opening ceremony.
    // A range that ends before go-live clamps past its own end and simply reads no flows.
    const from = clampToGoLive(q.from ?? weekStartFor(to), await goLiveDate(deps))
    if (from <= to) assertWithinRangeCap(from, to)

    /*
     * ONE range read (P2) instead of walking the financial weeks the range touches — and, for a
     * legacy correction, walking every closed week back to find its original.
     *
     * The range source classifies each `company_box` line with the domain's `treasuryRoleOf`:
     * its LINE ROLE first (every current writer stamps `kaish`/`shahn` — the hand «كييش» moved to
     * `manual` because `restoration_journal_fact_from_entry` refuses a restoration entry without an
     * immutable `restorations` row, and would have vanished from «دخل الصندوق» had this kept
     * guessing from the event type), then a legacy `restoration` by side, then a legacy
     * `correction` through its `reversal-of-<id>` link to the original. A correction stays in its
     * original's column with the opposite sign; a correction of an unrelated manual company-box
     * entry is not a restoration flow at all.
     */
    const range = from <= to ? await deps.ledgerRange.readRange(branchId, from, to) : null
    let profit = 0n
    for (const line of range?.lines ?? []) {
      if (line.fundCode === 'company_revenue') profit += line.side === 'C' ? line.amount : -line.amount
    }
    const treasuryDays = range?.treasuryDays ?? []
    const fundIn = treasuryDays.reduce((a, d) => a + d.kaish, 0n)
    const fundOut = treasuryDays.reduce((a, d) => a + d.shahn, 0n)

    // Working capital is a POSITION, read as it stands now rather than a flow over the range.
    // Restoration still settles only the office boxes plus receivables; active custody is exposed
    // separately because it remains company capital but cannot be swept while a shift is live.
    const position = await deps.treasuryPosition.readCurrent(branchId)
    if (position.negativeReceivableFundCode !== null) {
      throw new ServiceError(500, 'receivable_balance_integrity_error', {
        fundCode: position.negativeReceivableFundCode,
      })
    }
    const targets = await deps.capitalTargets.resolve(branchId, to)
    const targetTotal = (targets.office_cash ?? 0n) + (targets.office_wallet ?? 0n)
    const advancesTotal = position.advancesCash + position.advancesWallet
    const officePosition =
      position.officeCash +
      position.officeWallet +
      position.receivablesCash +
      position.receivablesWallet +
      // «السلف»: money that left a box but is still the company's, so الترميم counts it exactly as
      // it counts a ذمة. Omit it and paying an advance would read as a capital shortfall.
      advancesTotal
    const activeCustodyTotal = position.activeCustodyCash + position.activeCustodyWallet
    const workingCapitalTotal = officePosition + activeCustodyTotal

    /*
     * The same position, split by BOX — and split the way THE RESTORATION reads it.
     *
     * A single «زيادة عن رأس المال» hides which side it sits on, and the two boxes are restored
     * against separate targets, so a surplus in cash and a shortfall in the wallet can cancel to a
     * reassuring total while both boxes are wrong.
     *
     * ACTIVE CUSTODY IS NOT IN THESE LINES, AND USED TO BE. `planRestoration` takes the position as
     * `counted + receivables` — money in the drawer and money owed to it — because custody is out
     * in a driver's pocket and cannot be swept while his shift is live. Adding it here made a box
     * read as a surplus while the drawer was empty: on 2026-08-29 the cash line showed
     * «58,218.37 / 50,000.00  +8,218.37» in green, when the box held 33,218.37 against the same
     * 50,000 target — SHORT by 16,781.63. A manager reading that green figure would go to sweep a
     * surplus that is not there, and the restoration would refuse him with `sweep_exceeds_counted`
     * if he was lucky.
     *
     * Custody keeps its own line directly beneath, split by box, because it is still company money
     * — it is simply not money tonight's restoration can move.
     */
    const cashPosition = position.officeCash + position.receivablesCash + position.advancesCash
    const walletPosition = position.officeWallet + position.receivablesWallet + position.advancesWallet
    const cashTarget = targets.office_cash ?? 0n
    const walletTarget = targets.office_wallet ?? 0n

    return {
      from,
      to,
      capital: {
        officeCash: serializeMoney(position.officeCash),
        officeWallet: serializeMoney(position.officeWallet),
        receivablesCash: serializeMoney(position.receivablesCash),
        receivablesWallet: serializeMoney(position.receivablesWallet),
        advancesCash: serializeMoney(position.advancesCash),
        advancesWallet: serializeMoney(position.advancesWallet),
        advancesTotal: serializeMoney(minor(advancesTotal)),
        officePosition: serializeMoney(minor(officePosition)),
        activeCustodyCash: serializeMoney(position.activeCustodyCash),
        activeCustodyWallet: serializeMoney(position.activeCustodyWallet),
        activeCustodyTotal: serializeMoney(minor(activeCustodyTotal)),
        activeShiftCount: position.activeShiftCount,
        /*
         * A SURPLUS CANNOT BE ASSERTED WHILE A SHIFT IS OPEN.
         *
         * An open shift has posted nothing since its float left the box; its orders, its share and
         * its variance all land at approval. So the position is a snapshot taken mid-sentence, and
         * any «زيادة» read off it is money the day has not yet earned.
         *
         * Production proved it on 2026-08-29: the card showed «زيادة عن رأس المال 6,502.00» with
         * five shifts open, and the ledger says today moved working capital by exactly 0.00 — every
         * lira of that surplus accumulated between 22 and 28 August, before the epoch. The figure
         * was true about the balance and false about the day, and the day is what a reader takes
         * from it.
         *
         * A SHORTFALL still shows. Suppressing premature good news protects the reader; suppressing
         * bad news hides the one direction that means money is missing.
         */
        deltaProvisional: position.activeShiftCount > 0,
        workingCapitalTotal: serializeMoney(minor(workingCapitalTotal)),
        total: serializeMoney(minor(workingCapitalTotal)),
        target: serializeMoney(minor(targetTotal)),
        /** Existing consumers receive the full working-capital delta. */
        workingCapitalDelta: serializeMoney(minor(workingCapitalTotal - targetTotal)),
        delta: serializeMoney(minor(workingCapitalTotal - targetTotal)),
        /** Only this office/receivables delta is actionable by tonight's restoration. */
        restorationDelta: serializeMoney(minor(officePosition - targetTotal)),
        /** Per box, so a surplus on one side cannot hide a shortfall on the other. */
        cashPosition: serializeMoney(minor(cashPosition)),
        walletPosition: serializeMoney(minor(walletPosition)),
        cashTarget: serializeMoney(minor(cashTarget)),
        walletTarget: serializeMoney(minor(walletTarget)),
        cashDelta: serializeMoney(minor(cashPosition - cashTarget)),
        walletDelta: serializeMoney(minor(walletPosition - walletTarget)),
      },
      companyProfit: serializeMoney(minor(profit)),
      companyFund: serializeMoney(await deps.ledger.fundBalance(branchId, 'company_box')),
      fundIn: serializeMoney(minor(fundIn)),
      fundOut: serializeMoney(minor(fundOut)),
      fundNet: serializeMoney(minor(fundIn - fundOut)),
      // D company_box is money ARRIVING in صندوق الشركة — «كييش» (`in`). C is «شحن من الصندوق» (`out`).
      days: treasuryDays.map((d) => ({
        businessDate: d.businessDate,
        in: serializeMoney(d.kaish),
        out: serializeMoney(d.shahn),
        net: serializeMoney(minor(d.kaish - d.shahn)),
      })),
    }
  })
}

const realCalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  // The domain's own parser: 2026-02-31 is refused here exactly as everywhere else.
  .refine((value) => isCalendarDate(value), 'expected a real calendar date')

/**
 * P2 — the widest range a range-based report answers: `LEDGER_RANGE_MAX_DAYS` (3653 days, ten
 * years and change) inclusive. It replaces the 520-financial-week walk, whose limit existed only
 * because each week was a separate ledger read. Wider is a 400, never a silently partial total.
 */
function assertWithinRangeCap(from: CalendarDate, to: CalendarDate): void {
  if (daysBetween(from, to) + 1 > LEDGER_RANGE_MAX_DAYS) {
    throw new z.ZodError([{
      code: 'custom',
      path: ['from', 'to'],
      message: `range cannot exceed ${LEDGER_RANGE_MAX_DAYS} days`,
    }])
  }
}

/**
 * Σ per business date of `toUsdMinor(amount, that day's rate)` — BR6's one daily rate, applied to
 * that day's figures, never one rate across a range. A day with no rate on or before it makes the
 * whole equivalent unknowable (`null`); a carried-forward or provisional rate marks it provisional.
 */
function usdEquivalentByDay(
  amounts: ReadonlyMap<CalendarDate, bigint>,
  fxDays: readonly FxDay[],
): { usd: bigint; provisional: boolean } | null {
  let usd = 0n
  let provisional = false
  for (const [businessDate, amount] of amounts) {
    // Nothing to convert: a day of zero fees needs no rate, and must not make the total unknown.
    if (amount === 0n) continue
    let fx: FxDay
    try {
      fx = resolveFxDay(fxDays, businessDate)
    } catch {
      return null
    }
    usd += toUsdMinor(minor(amount), fx)
    if (fx.provisional) provisional = true
  }
  return { usd, provisional }
}

/** Per-vehicle counters of `/dashboard/fleet-performance`. */
interface FleetTally {
  shifts: number
  distance: DistanceTotal
  orders: number
  fees: bigint
  companyShare: bigint
  cost: bigint
}

function emptyFleetTally(): FleetTally {
  return { shifts: 0, distance: EMPTY_DISTANCE_TOTAL, orders: 0, fees: 0n, companyShare: 0n, cost: 0n }
}

/** The population the completed-shifts screen lists: a close that was actually settled. */
const COMPLETED_SHIFT_STATES = new Set<string>(['approved', 'week_locked'])

/** Per-driver / per-vehicle / whole-range counters of `/dashboard/shifts-summary`. */
interface ShiftTally {
  shifts: number
  doubles: number
  shortCount: number
  shortMinutes: number
  workedMinutes: number
  orders: number
  fees: bigint
  companyShare: bigint
  km: number
}

function emptyShiftTally(): ShiftTally {
  return {
    shifts: 0,
    doubles: 0,
    shortCount: 0,
    shortMinutes: 0,
    workedMinutes: 0,
    orders: 0,
    fees: 0n,
    companyShare: 0n,
    km: 0,
  }
}

function hasCompleteEndPackage(shift: ShiftRecord): boolean {
  // One source of truth with the BR5 close gate, so this can never drift from what's required.
  return REQUIRED_END_SLOTS.every((slot) => shift.mediaSlotsEnd.includes(slot))
}
