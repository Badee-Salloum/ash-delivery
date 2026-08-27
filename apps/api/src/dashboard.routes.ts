import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type Deps, type JournalEntryRecord, type ShiftRecord, serializeMoney } from '@ash/contracts'
import { REQUIRED_END_SLOTS, isLive, minor, toUsdMinor, weekStartFor } from '@ash/domain'
import { ServiceError, includedOrders, todayFor } from './shifts.service.ts'
import { branchSubject, resolveBranchId } from './branch-scope.ts'

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
    const q = z.object({ from: realCalendarDate.optional(), to: realCalendarDate.optional() }).parse(req.query)
    const today = todayFor(deps)
    const to = q.to ?? today
    const from = q.from ?? weekStartFor(to)
    if (from > to) {
      throw new z.ZodError([{
        code: 'custom',
        path: ['from'],
        message: '`from` must be on or before `to`',
      }])
    }
    // The GM is org-wide; totalling across every branch would need a fan-out. Single branch
    // today, so he names the one he means and the figure stays unambiguous.
    const branchId = resolveBranchId(req)

    const weekStart = weekStartFor(from)
    const entries: JournalEntryRecord[] = []
    for (const start of weekStartsBetween(from, to)) {
      entries.push(...(await deps.ledger.listByWeek(branchId, start)))
    }
    let company = 0n
    let yalago = 0n
    const legacyDriverShareByShift = new Map<string | null, bigint>()
    const shiftIds = new Set<string>()
    for (const e of entries) {
      if (e.businessDate < from || e.businessDate > to) continue
      if (e.shiftId !== null) shiftIds.add(e.shiftId)
      for (const l of e.lines) {
        const signed = l.side === 'C' ? l.amount : -l.amount
        if (l.fundCode === 'company_revenue') company += signed
        else if (l.fundCode === 'yalago_income') yalago += signed
        else if (
          (
            l.fundCode.startsWith('driver_share_payable:') &&
            (l.role === 'driver_share' || l.role === 'cash_deduction_share')
          ) || (
            l.fundCode.startsWith('driver_receivable_cash:') &&
            l.role === 'cash_deduction_overflow'
          )
        ) {
          legacyDriverShareByShift.set(
            e.shiftId,
            (legacyDriverShareByShift.get(e.shiftId) ?? 0n) + signed,
          )
        }
      }
    }
    let driverShare = legacyDriverShareByShift.get(null) ?? 0n
    const settlements = await deps.settlements.listByShiftIds([...shiftIds])
    const settlementByShift = new Map(settlements.map((settlement) => [settlement.shiftId, settlement]))
    for (const shiftId of shiftIds) {
      // A surplus/shortage is a settlement difference, not earned driver share. New immutable
      // snapshots expose the exact net earned share after cash deductions and before variance.
      // Legacy approvals have no snapshot and retain their historical share_split less
      // cash-deduction calculation. Payout/return debits are settlement, not reduced earnings.
      const settlement = settlementByShift.get(shiftId)
      driverShare += settlement?.baseDriverShare ?? legacyDriverShareByShift.get(shiftId) ?? 0n
    }
    return {
      from,
      to,
      weekStart,
      companyShareSyp: serializeMoney(minor(company)),
      driverShareSyp: serializeMoney(minor(driverShare)),
      yalagoShareSyp: serializeMoney(minor(yalago)),
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
    const q = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query)
    const branchId = resolveBranchId(req)
    const today = todayFor(deps)
    const to = q.to ?? today
    const from = q.from ?? weekStartFor(to)

    // No port reads a date RANGE — the ledger is addressed by week, because that is the unit BR7
    // seals. Walking the weeks the range touches keeps this to existing queries; a month is five.
    const rangeWeekStarts = weekStartsBetween(from, to)
    const entries: JournalEntryRecord[] = []
    for (const start of rangeWeekStarts) entries.push(...(await deps.ledger.listByWeek(branchId, start)))

    // New corrections keep the original treasury role on every reversed line. Corrections written
    // before that guarantee have no role, however, so resolve their `reversal-of-<id>` link back to
    // the visible original entry. Weeks are loaded lazily and cached; the ordinary path performs no
    // extra ledger reads, while a legacy row remains explainable without a schema migration.
    const entriesById = new Map(entries.map((entry) => [entry.id, entry]))
    const loadedWeekStarts = new Set(rangeWeekStarts)
    let legacyLookupStarts: string[] | null = null
    const findEntryById = async (entryId: number): Promise<JournalEntryRecord | null> => {
      const loaded = entriesById.get(entryId)
      if (loaded) return loaded
      legacyLookupStarts ??= [
        ...new Set([
          weekStartFor(today),
          ...(await deps.weekLocks.listClosedStarts(branchId)).sort().reverse(),
        ]),
      ]
      for (const start of legacyLookupStarts) {
        if (loadedWeekStarts.has(start)) continue
        loadedWeekStarts.add(start)
        const batch = await deps.ledger.listByWeek(branchId, start)
        for (const entry of batch) entriesById.set(entry.id, entry)
        const found = entriesById.get(entryId)
        if (found) return found
      }
      return null
    }

    type TreasuryRole = 'kaish' | 'shahn'
    const treasuryRoleOf = async (
      entry: JournalEntryRecord,
      line: JournalEntryRecord['lines'][number],
      visited = new Set<number>(),
    ): Promise<TreasuryRole | null> => {
      if (line.role === 'kaish' || line.role === 'shahn') return line.role
      if (entry.eventType === 'restoration') return line.side === 'D' ? 'kaish' : 'shahn'
      if (entry.eventType !== 'correction' || visited.has(entry.id)) return null

      const match = /^reversal-of-(\d+)$/.exec(entry.occurrenceKey)
      if (!match) return null
      visited.add(entry.id)
      const original = await findEntryById(Number(match[1]))
      const originalLine = original?.lines.find((candidate) => candidate.fundCode === 'company_box')
      return original && originalLine ? treasuryRoleOf(original, originalLine, visited) : null
    }

    const perDay = new Map<string, { in: bigint; out: bigint }>()
    let profit = 0n
    for (const e of entries) {
      if (e.businessDate < from || e.businessDate > to) continue
      for (const l of e.lines) {
        if (l.fundCode === 'company_revenue') profit += l.side === 'C' ? l.amount : -l.amount
        if ((e.eventType !== 'restoration' && e.eventType !== 'correction') || l.fundCode !== 'company_box') continue
        const role = await treasuryRoleOf(e, l)
        // A correction of an unrelated manual company-box entry is not a restoration flow.
        if (role === null) continue
        const day = perDay.get(e.businessDate) ?? { in: 0n, out: 0n }
        // D company_box is money ARRIVING in صندوق الشركة — «كييش». C is «شحن من الصندوق».
        // Keep corrections in the same column as their original movement, with the opposite sign.
        // Otherwise reversing kaish would be misreported as new shahn (and vice versa).
        if (role === 'kaish') day.in += l.side === 'D' ? l.amount : -l.amount
        else day.out += l.side === 'C' ? l.amount : -l.amount
        perDay.set(e.businessDate, day)
      }
    }
    const fundIn = [...perDay.values()].reduce((a, d) => a + d.in, 0n)
    const fundOut = [...perDay.values()].reduce((a, d) => a + d.out, 0n)

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
    const officePosition =
      position.officeCash + position.officeWallet + position.receivablesCash + position.receivablesWallet
    const activeCustodyTotal = position.activeCustodyCash + position.activeCustodyWallet
    const workingCapitalTotal = officePosition + activeCustodyTotal

    return {
      from,
      to,
      capital: {
        officeCash: serializeMoney(position.officeCash),
        officeWallet: serializeMoney(position.officeWallet),
        receivablesCash: serializeMoney(position.receivablesCash),
        receivablesWallet: serializeMoney(position.receivablesWallet),
        officePosition: serializeMoney(minor(officePosition)),
        activeCustodyCash: serializeMoney(position.activeCustodyCash),
        activeCustodyWallet: serializeMoney(position.activeCustodyWallet),
        activeCustodyTotal: serializeMoney(minor(activeCustodyTotal)),
        activeShiftCount: position.activeShiftCount,
        workingCapitalTotal: serializeMoney(minor(workingCapitalTotal)),
        total: serializeMoney(minor(workingCapitalTotal)),
        target: serializeMoney(minor(targetTotal)),
        /** Existing consumers receive the full working-capital delta. */
        workingCapitalDelta: serializeMoney(minor(workingCapitalTotal - targetTotal)),
        delta: serializeMoney(minor(workingCapitalTotal - targetTotal)),
        /** Only this office/receivables delta is actionable by tonight's restoration. */
        restorationDelta: serializeMoney(minor(officePosition - targetTotal)),
      },
      companyProfit: serializeMoney(minor(profit)),
      companyFund: serializeMoney(await deps.ledger.fundBalance(branchId, 'company_box')),
      fundIn: serializeMoney(minor(fundIn)),
      fundOut: serializeMoney(minor(fundOut)),
      fundNet: serializeMoney(minor(fundIn - fundOut)),
      days: [...perDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([businessDate, d]) => ({
          businessDate,
          in: serializeMoney(minor(d.in)),
          out: serializeMoney(minor(d.out)),
          net: serializeMoney(minor(d.in - d.out)),
        })),
    }
  })
}

const realCalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number]
    const parsed = new Date(Date.UTC(year, month - 1, day))
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    )
  }, 'expected a real calendar date')

/** Every financial-week start the inclusive range [from, to] touches, in order. */
function weekStartsBetween(from: string, to: string): string[] {
  const starts: string[] = []
  let cursor = weekStartFor(from)
  const last = weekStartFor(to)
  while (cursor <= last) {
    // Never return a plausible-looking partial total. A ten-year reporting window is already far
    // beyond the operational use case and means 520 weekly ledger reads with the current port; a
    // wider request must be narrowed (or served by a future range-query adapter) explicitly.
    if (starts.length >= 520) {
      throw new z.ZodError([{
        code: 'custom',
        path: ['from', 'to'],
        message: 'profit range cannot exceed 520 financial weeks',
      }])
    }
    starts.push(cursor)
    cursor = addDays(cursor, 7)
  }
  return starts
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const next = new Date(Date.UTC(y, m - 1, d + days))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}

function hasCompleteEndPackage(shift: ShiftRecord): boolean {
  // One source of truth with the BR5 close gate, so this can never drift from what's required.
  return REQUIRED_END_SLOTS.every((slot) => shift.mediaSlotsEnd.includes(slot))
}
