import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type Deps, type ShiftRecord, serializeMoney } from '@ash/contracts'
import { isLive, minor, toUsdMinor, weekStartFor } from '@ash/domain'
import { todayFor } from './shifts.service.ts'
import { branchSubject, resolveBranchId } from './branch-scope.ts'

/**
 * The minimal ops dashboard (SRS I-1, in scope per the brief's "minimal ops dashboard").
 *
 * Five indicators the client asked for (س69), minus the cash-difference tile the SRS itself
 * dropped because BR1 makes it always zero:
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

  app.get('/dashboard', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    // The GM and the sysadmin have no branch of their own — they name one with `?branchId=`.
    // Reading `req.actor.branchId` alone was why this endpoint 422'd for exactly the two roles
    // the §3 matrix grants `branch_data.view` at scope 'all'.
    const branchId = resolveBranchId(req)

    const today = todayFor(deps)
    const shifts = await deps.shifts.listByBranchAndDate(branchId, today)

    // ── Orders and revenue, from today's approved shifts ────────────────────────────────────
    const perDriver = new Map<string, { orders: number; fees: bigint }>()
    let feeTotal = 0n
    let orderTotal = 0
    for (const shift of shifts) {
      if (shift.state !== 'approved' && shift.state !== 'week_locked') continue
      const orders = await deps.orders.listByShift(shift.id)
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
    const weekEntries = await deps.ledger.listByWeek(branchId, weekStart)
    let companyShareWeek = 0n
    for (const e of weekEntries) {
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
   * Total profit / share is General-Manager-only (BR8). Everyone else who reaches the dashboard
   * sees the operational tiles above but not this figure — hence a SEPARATE endpoint with a
   * SEPARATE permission, rather than a field the branch dashboard hides.
   */
  app.get('/dashboard/profit', { config: { permission: 'profit.view_total', subject: () => ({}) } }, async (req) => {
    const { from, to } = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query)
    const today = todayFor(deps)
    // The GM is org-wide; totalling across every branch would need a fan-out. Single branch
    // today, so he names the one he means and the figure stays unambiguous.
    const branchId = resolveBranchId(req)

    const weekStart = weekStartFor(from ?? today)
    const entries = await deps.ledger.listByWeek(branchId, weekStart)
    let company = 0n
    let yalago = 0n
    let driverPayable = 0n
    for (const e of entries) {
      for (const l of e.lines) {
        const signed = l.side === 'C' ? l.amount : -l.amount
        if (l.fundCode === 'company_revenue') company += signed
        else if (l.fundCode === 'yalago_income') yalago += signed
        else if (l.fundCode.startsWith('driver_share_payable:')) driverPayable += signed
      }
    }
    void to
    return {
      weekStart,
      companyShareSyp: serializeMoney(minor(company)),
      driverShareSyp: serializeMoney(minor(driverPayable)),
      yalagoShareSyp: serializeMoney(minor(yalago)),
    }
  })
}

function hasCompleteEndPackage(shift: ShiftRecord): boolean {
  const required = ['dashboard', 'wallet', 'odometer', 'wallet_zeroed']
  return required.every((slot) => shift.mediaSlotsEnd.includes(slot))
}
