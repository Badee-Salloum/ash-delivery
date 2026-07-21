import { createHash } from 'node:crypto'
import type { Deps, ShiftOrderRecord, ShiftRecord } from '@ash/contracts'
import {
  type Actor,
  type Br1Cause,
  type Br1Result,
  type CalendarDate,
  type Minor,
  type ShiftAction,
  type ShiftOrder,
  type TransitionResult,
  DEFAULT_BANDS,
  bpsForCount,
  businessDateFor,
  canOpenShift,
  diagnoseBr1,
  evaluateBr1,
  minWalletBalance,
  minor,
  postingsForApproval,
  postingsForOpen,
  resolveFxDay,
  splitBlock,
  sum,
  totalFees,
  transition,
  trueUp,
  weekStartFor,
} from '@ash/domain'
import { fundCodeOf } from '@ash/adapters/memory'
import { grantsFromRows } from './rbac.ts'

export class ServiceError extends Error {
  readonly status: number
  readonly code: string
  readonly detail?: unknown
  constructor(status: number, code: string, detail?: unknown) {
    super(code)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/**
 * A stable fingerprint of the shift's orders.
 *
 * The branch manager reviews a set of numbers; between loading that screen and pressing approve,
 * the driver may have edited an order. Approving then posts against numbers nobody reviewed. The
 * hash is re-checked inside the approval path so that becomes a 409 instead of a silent
 * discrepancy.
 */
export function ordersHash(orders: readonly ShiftOrderRecord[]): string {
  const canonical = [...orders]
    .sort((a, b) => (a.providerOrderNo < b.providerOrderNo ? -1 : 1))
    .map((o) => `${o.providerOrderNo}|${o.payMode}|${o.fee}`)
    .join(';')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

const toDomainOrders = (rows: readonly ShiftOrderRecord[]): ShiftOrder[] =>
  rows.map((o) => ({ orderNo: o.providerOrderNo, payMode: o.payMode, fee: o.fee }))

export function todayFor(deps: Deps): CalendarDate {
  return businessDateFor(deps.clock.nowMs(), deps.clock.offsetMinutes())
}

async function guard(deps: Deps, shift: ShiftRecord, action: ShiftAction, actor: Actor, extra: Record<string, unknown> = {}): Promise<TransitionResult> {
  const grants = grantsFromRows(await deps.directory.grants())
  return transition(shift.state, action, {
    actor,
    driverId: shift.driverId,
    branchId: shift.branchId,
    grants,
    ...extra,
  })
}

function fail(result: TransitionResult): never {
  if (result.ok) throw new Error('unreachable')
  const status = result.reason === 'forbidden' ? 403 : result.reason === 'orders_changed_since_review' ? 409 : 422
  throw new ServiceError(status, result.reason, result.gaps)
}

// ── Create ────────────────────────────────────────────────────────────────────────────────

export async function createShift(
  deps: Deps,
  actor: Actor,
  input: { driverId: string; vehicleId: string; shiftNo: number },
): Promise<ShiftRecord> {
  const driver = await deps.directory.driver(input.driverId)
  const vehicle = await deps.directory.vehicle(input.vehicleId)
  if (!driver || !vehicle) throw new ServiceError(404, 'driver_or_vehicle_not_found')
  if (driver.branchId !== vehicle.branchId) throw new ServiceError(422, 'cross_branch_assignment')

  const [driverLive, vehicleLive] = await Promise.all([
    deps.shifts.listLiveForDriver(driver.id),
    deps.shifts.listLiveForVehicle(vehicle.id),
  ])

  // SRS B-3 (س34): the binding is mandatory, and a vehicle is shared between drivers across
  // shifts (س23) — just never simultaneously.
  const check = canOpenShift({
    vehicleState: vehicle.state,
    driverDocumentStatuses: [],
    vehicleDocumentStatuses: [],
    driverAlreadyLive: driverLive.length > 0,
    vehicleAlreadyLive: vehicleLive.length > 0,
    driverActive: driver.active,
    vehicleActive: vehicle.active,
  })
  if (!check.ok) throw new ServiceError(409, 'cannot_open_shift', check.blockers)

  const businessDate = todayFor(deps)
  const shift: ShiftRecord = {
    id: deps.ids.uuid(),
    branchId: driver.branchId,
    driverId: driver.id,
    vehicleId: vehicle.id,
    shiftNo: input.shiftNo,
    businessDate,
    weekStartDate: weekStartFor(businessDate),
    state: 'draft',
    floatTranches: [],
    topupTranches: [],
    mediaSlotsStart: [],
    mediaSlotsEnd: [],
    odoStart: null,
    odoEnd: null,
    batteryStart: null,
    batteryEnd: null,
    endCashDeclared: null,
    endWalletDeclared: null,
    driverConfirmedAt: null,
    equationDiff: null,
    cashDiff: null,
    walletDiff: null,
    ordersHash: null,
    approvedBy: null,
  }
  await deps.shifts.create(shift)
  return shift
}

// ── The OPEN gate (BR5) ───────────────────────────────────────────────────────────────────

export async function submitStartPackage(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: {
    odometerKm: number
    batteryPercent: number
    floatTranches: Minor[]
    topupTranches: Minor[]
  },
): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const draft: ShiftRecord = {
    ...shift,
    odoStart: input.odometerKm,
    batteryStart: input.batteryPercent,
    floatTranches: input.floatTranches,
    topupTranches: input.topupTranches,
    // mediaSlotsStart is NOT taken from the caller — it is whatever actually uploaded.
  }

  const result = await guard(deps, draft, 'driver_confirm_start', actor, {
    startPackage: {
      mediaSlots: draft.mediaSlotsStart,
      batteryPercent: draft.batteryStart,
      odometerKm: draft.odoStart,
      floatTotal: sum(draft.floatTranches),
      topupTotal: sum(draft.topupTranches),
      driverConfirmedAt: null,
    },
  })
  if (!result.ok) fail(result)

  const updated: ShiftRecord = {
    ...draft,
    state: result.next,
    driverConfirmedAt: new Date(deps.clock.nowMs()).toISOString(),
  }
  await deps.shifts.update(updated)
  return updated
}

export async function approveOpen(deps: Deps, actor: Actor, shiftId: string): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const result = await guard(deps, shift, 'manager_approve_open', actor, {
    startPackage: {
      mediaSlots: shift.mediaSlotsStart,
      batteryPercent: shift.batteryStart,
      odometerKm: shift.odoStart,
      floatTotal: sum(shift.floatTranches),
      topupTotal: sum(shift.topupTranches),
      driverConfirmedAt: shift.driverConfirmedAt,
    },
  })
  if (!result.ok) fail(result)

  // The float and top-up postings land HERE, at approval — not when the driver typed the
  // amounts. Money moves when a manager says it moved.
  const fxDayId = await ensureFxDay(deps, shift.businessDate)
  await deps.ledger.post(
    shift.branchId,
    postingsForOpen({
      driverId: shift.driverId,
      floatTranches: shift.floatTranches,
      topupTranches: shift.topupTranches,
      orders: [],
    }),
    {
      shiftId: shift.id,
      businessDate: shift.businessDate,
      postingDate: todayFor(deps),
      weekStartDate: shift.weekStartDate,
      fxDayId,
      createdBy: actor.userId,
    },
  )

  const updated: ShiftRecord = { ...shift, state: result.next }
  await deps.shifts.update(updated)
  return updated
}

// ── Orders ────────────────────────────────────────────────────────────────────────────────

export async function addOrder(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: { providerOrderNo: string; payMode: ShiftOrder['payMode']; fee: Minor; zone: string | null },
): Promise<ShiftOrderRecord> {
  const shift = await mustFind(deps, shiftId)
  if (shift.state !== 'open' && shift.state !== 'suspended') {
    throw new ServiceError(409, 'shift_not_open')
  }
  const grants = grantsFromRows(await deps.directory.grants())
  const allowed = transition(shift.state, 'driver_submit_end', {
    actor,
    driverId: shift.driverId,
    branchId: shift.branchId,
    grants,
    endPackage: {
      mediaSlots: [...['dashboard', 'wallet', 'odometer', 'wallet_zeroed']],
      odometerKm: 0,
      batteryPercent: 0,
      cashDeclared: minor(0n),
      walletDeclared: minor(0n),
      orderCount: 1,
      allOrdersConfirmed: true,
    },
  })
  if (!allowed.ok && allowed.reason === 'forbidden') throw new ServiceError(403, 'forbidden')

  const order: ShiftOrderRecord = {
    id: deps.ids.uuid(),
    shiftId,
    providerOrderNo: input.providerOrderNo,
    payMode: input.payMode,
    fee: input.fee,
    zone: input.zone,
    driverConfirmed: true,
  }
  try {
    await deps.orders.create(order)
  } catch (err) {
    if ((err as { code?: string }).code === 'DUPLICATE_ORDER_NO') {
      // Catching this as it is typed is the point: Yallago's order number is the reconciliation
      // key, and a duplicate is a data-entry slip worth surfacing immediately.
      throw new ServiceError(409, 'duplicate_order_no', { providerOrderNo: input.providerOrderNo })
    }
    throw err
  }
  return order
}

// ── BR1 ───────────────────────────────────────────────────────────────────────────────────

export interface Br1View {
  result: Br1Result
  causes: Br1Cause[]
  minWallet: Minor
  ordersHash: string
}

export async function evaluateShift(deps: Deps, shift: ShiftRecord): Promise<Br1View> {
  const orderRows = await deps.orders.listByShift(shift.id)
  const orders = toDomainOrders(orderRows)
  const result = evaluateBr1({
    floatTotal: sum(shift.floatTranches),
    topupTotal: sum(shift.topupTranches),
    endCashDeclared: shift.endCashDeclared ?? minor(0n),
    endWalletDeclared: shift.endWalletDeclared ?? minor(0n),
    orders,
  })
  return {
    result,
    causes: diagnoseBr1(result, orders),
    minWallet: minWalletBalance({
      driverId: shift.driverId,
      floatTranches: shift.floatTranches,
      topupTranches: shift.topupTranches,
      orders,
    }),
    ordersHash: ordersHash(orderRows),
  }
}

// ── The CLOSE gate (BR5) ──────────────────────────────────────────────────────────────────

export async function submitEndPackage(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: {
    odometerKm: number
    batteryPercent: number
    cashDeclared: Minor
    walletDeclared: Minor
  },
): Promise<{ shift: ShiftRecord; br1: Br1View }> {
  const shift = await mustFind(deps, shiftId)
  const orderRows = await deps.orders.listByShift(shiftId)

  const staged: ShiftRecord = {
    ...shift,
    odoEnd: input.odometerKm,
    batteryEnd: input.batteryPercent,
    endCashDeclared: input.cashDeclared,
    endWalletDeclared: input.walletDeclared,
    // mediaSlotsEnd likewise comes from uploaded evidence, not from the request.
  }

  const result = await guard(deps, staged, 'driver_submit_end', actor, {
    endPackage: {
      mediaSlots: staged.mediaSlotsEnd,
      odometerKm: staged.odoEnd,
      batteryPercent: staged.batteryEnd,
      cashDeclared: staged.endCashDeclared,
      walletDeclared: staged.endWalletDeclared,
      orderCount: orderRows.length,
      allOrdersConfirmed: orderRows.every((o) => o.driverConfirmed),
    },
  })
  if (!result.ok) fail(result)

  const br1 = await evaluateShift(deps, staged)
  const updated: ShiftRecord = {
    ...staged,
    state: result.next,
    equationDiff: br1.result.scalarDiff,
    cashDiff: br1.result.cashDiff,
    walletDiff: br1.result.walletDiff,
    ordersHash: br1.ordersHash,
  }
  await deps.shifts.update(updated)
  return { shift: updated, br1 }
}

export async function approveClose(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  reviewedOrdersHash: string,
  splitGate: 'advisory' | 'strict' = 'advisory',
): Promise<{ shift: ShiftRecord; postings: number }> {
  const shift = await mustFind(deps, shiftId)
  const orderRows = await deps.orders.listByShift(shiftId)
  const br1 = await evaluateShift(deps, shift)

  const result = await guard(deps, shift, 'manager_approve_close', actor, {
    endPackage: {
      mediaSlots: shift.mediaSlotsEnd,
      odometerKm: shift.odoEnd,
      batteryPercent: shift.batteryEnd,
      cashDeclared: shift.endCashDeclared,
      walletDeclared: shift.endWalletDeclared,
      orderCount: orderRows.length,
      allOrdersConfirmed: orderRows.every((o) => o.driverConfirmed),
    },
    br1: { balanced: br1.result.balanced, splitBalanced: br1.result.splitBalanced },
    splitGate,
    reviewedOrdersHash,
    currentOrdersHash: br1.ordersHash,
  })
  if (!result.ok) fail(result)

  // ── The tier band is a property of the DAY, not the shift (SRS F-1) ────────────────────
  // A second shift can push the day across a band, which restates the first. So the split is
  // computed over every approved shift of this driver on this business date, plus this one, and
  // the DIFFERENCE against what was already posted is what gets written.
  const priorShifts = await deps.shifts.listApprovedForDriverOnDate(shift.driverId, shift.businessDate)
  const priorOrders: ShiftOrder[] = []
  for (const prior of priorShifts) {
    if (prior.id === shift.id) continue
    priorOrders.push(...toDomainOrders(await deps.orders.listByShift(prior.id)))
  }
  const todaysOrders = toDomainOrders(orderRows)
  const dayFees = [...priorOrders, ...todaysOrders].map((o) => o.fee)

  const rule = {
    basis: 'orders' as const,
    mode: 'whole' as const,
    vehicleTypeId: null,
    bands: DEFAULT_BANDS,
    effectiveFrom: '2026-01-01',
  }
  const priorTotals = totalFees(priorOrders.map((o) => o.fee))
  const alreadyPosted =
    priorOrders.length > 0
      ? splitBlock(priorTotals, bpsForCount(DEFAULT_BANDS, priorOrders.length))
      : { driverShare: minor(0n), companyShare: minor(0n), yalagoShare: minor(0n) }

  const settlement = trueUp(dayFees, rule, {
    driver: alreadyPosted.driverShare,
    company: alreadyPosted.companyShare,
    yalago: alreadyPosted.yalagoShare,
  })

  const shiftSplit = {
    driverShare: settlement.driverDelta,
    companyShare: settlement.companyDelta,
    yalagoShare: settlement.yalagoDelta,
  }

  const fxDayId = await ensureFxDay(deps, shift.businessDate)
  const postings = postingsForApproval(
    {
      driverId: shift.driverId,
      floatTranches: shift.floatTranches,
      topupTranches: shift.topupTranches,
      orders: todaysOrders,
    },
    shiftSplit,
  )

  const written = await deps.ledger.post(shift.branchId, postings, {
    shiftId: shift.id,
    businessDate: shift.businessDate,
    postingDate: todayFor(deps),
    weekStartDate: shift.weekStartDate,
    fxDayId,
    createdBy: actor.userId,
  })

  const updated: ShiftRecord = { ...shift, state: result.next, approvedBy: actor.userId }
  await deps.shifts.update(updated)
  return { shift: updated, postings: written.length }
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────

async function mustFind(deps: Deps, shiftId: string): Promise<ShiftRecord> {
  const shift = await deps.shifts.findById(shiftId)
  if (!shift) throw new ServiceError(404, 'shift_not_found')
  return shift
}

/**
 * Guarantee a rate row exists for the business date, carrying yesterday's forward if the admin
 * has not entered today's.
 *
 * Posting must never be blocked on a missing rate: a failed cron cannot be allowed to stop the
 * business from recording money that physically moved. The carried-forward row is flagged
 * `provisional`, and the Sunday close then refuses to seal a week still containing one.
 */
export async function ensureFxDay(deps: Deps, businessDate: CalendarDate): Promise<number> {
  const existing = await deps.fx.idFor(businessDate)
  if (existing !== null) return existing
  const resolved = resolveFxDay(await deps.fx.list(), businessDate)
  return deps.fx.upsert(resolved)
}

export { fundCodeOf }
