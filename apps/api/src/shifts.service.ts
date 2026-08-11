import { createHash } from 'node:crypto'
import type {
  BatteryReadingFields,
  BatteryReadingRecord,
  BatteryRecord,
  BatterySwapRecord,
  Deps,
  OrderPointRecord,
  DocumentRecord,
  ShiftOrderRecord,
  WalletMovementRecord,
  ShiftRecord,
  VehicleEventKind,
  VehicleEventRecord,
} from '@ash/contracts'
import { serializeMoney } from '@ash/contracts'
import {
  type Actor,
  type Br1Cause,
  type Br1Result,
  type CalendarDate,
  type DocumentStatus,
  type Minor,
  type Posting,
  type ShiftAction,
  type BatteryReading,
  type ShiftOrder,
  type TransitionResult,
  WALLET_LOG_FEEDS_BR1,
  add,
  businessDateFor,
  can,
  canOpenShift,
  closingBalances,
  documentStatusOn,
  diagnoseBr1,
  evaluateBr1,
  floatOut,
  floatReturn,
  isDateLocked,
  minWalletBalance,
  minor,
  postingsForApproval,
  postingsForOpen,
  walletReturn,
  walletTopup,
  REQUIRED_END_SLOTS,
  resolveFxDay,
  splitDay,
  sum,
  transition,
  trueUp,
  weekStartFor,
} from '@ash/domain'
import { fundCodeOf } from '@ash/adapters/memory'
import { grantsFromRows } from './rbac.ts'
import { resolveTierRule } from './tier-rule.ts'

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
export function ordersHash(
  orders: readonly ShiftOrderRecord[],
  movements: readonly WalletMovementRecord[] = [],
): string {
  const orderPart = [...orders]
    .sort((a, b) => (a.providerOrderNo < b.providerOrderNo ? -1 : 1))
    // The kind and the typed shares are hashed too: they decide the money as much as the fee does,
    // so a manager must not be able to approve against a split he never reviewed. `included` and
    // `walletAmount` are here for exactly the same reason and neither touches any older field:
    // unchecking a row removes it from BR1, the tier band and the ledger outright, and the measured
    // wallet amount moves money between the cash and wallet sides.
    .map(
      (o) =>
        `${o.providerOrderNo}|${o.payMode}|${o.fee}|${o.kind}|${o.driverShare ?? ''}|${o.companyShare ?? ''}` +
        `|${o.included ? 1 : 0}|${o.walletAmount ?? ''}`,
    )
    .join(';')
  // The movements are hashed as well, because toggling one changes `walletAdjustments` — hence BR1,
  // hence the postings — with every order left untouched. A digest that could not see that would
  // let the approval post against a wallet the manager never reviewed.
  const movementPart = [...movements]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((m) => `${m.occurredMinute}|${m.amount}|${m.seq}|${m.role}|${m.orderId ?? ''}|${m.included ? 1 : 0}`)
    .join(';')
  return createHash('sha256').update(`${orderPart}#${movementPart}`).digest('hex').slice(0, 32)
}

/**
 * The orders that count.
 *
 * An unchecked row stays with the shift and stays visible to everyone, but it is out of the money
 * entirely — BR1, the tier band and the ledger. Filtering HERE, at the single point where records
 * become domain values, is what keeps `packages/domain` from having to learn what "excluded" means
 * and keeps the rule from drifting across the several places that ask for a shift's orders.
 */
export const includedOrders = (rows: readonly ShiftOrderRecord[]): ShiftOrderRecord[] =>
  rows.filter((o) => o.included)

const toDomainOrders = (rows: readonly ShiftOrderRecord[]): ShiftOrder[] =>
  includedOrders(rows).map((o) => ({
    orderNo: o.providerOrderNo,
    payMode: o.payMode,
    fee: o.fee,
    kind: o.kind,
    // `?? undefined`, not `?? null`: absent means "nobody measured it" and `orderWalletAmount`
    // falls back to the pay mode, which is what every shift closed before the log was read did.
    ...(o.walletAmount === null ? {} : { walletAmount: o.walletAmount }),
  }))

/**
 * The wallet movements BR1 may add — and ONLY those. Currently NONE: see `WALLET_LOG_FEEDS_BR1`.
 *
 * The payments log is held as evidence and training data rather than as money while the reader that
 * produces it is unproven. This switch must stay identical to the client's, or the driver's live
 * preview and the figure the manager approves are computed from different rules — which is exactly
 * the class of disagreement that makes a shift impossible to close and impossible to explain.
 *
 * The rule below is what gets restored, and why each kind is treated as it is:
 *
 * A `yalago_cut` row is corroboration, never an input: the equation derives the cut from the fee
 * because the 80% block is a residual, so adding the logged one would charge it twice. An
 * `order_credit` is already inside its order's `walletAmount`. That leaves the rows no order
 * explains, which are the very thing this term exists for — an incentive, a merchant paid, a
 * withdrawal — money the wallet moved on its own that BR1 would otherwise blame on the driver.
 */
const toWalletAdjustments = (rows: readonly WalletMovementRecord[]): Minor[] =>
  WALLET_LOG_FEEDS_BR1 ? rows.filter((m) => m.included && m.role === 'unmatched').map((m) => m.amount) : []

/** What the manual jobs on one shift pay out, as typed and already validated to equal their fees. */
const manualShareTotals = (rows: readonly ShiftOrderRecord[]): { driverShare: Minor; companyShare: Minor } => {
  // Excluded first: an excluded manual order's shares would still be handed to `shareSplit`, which
  // would then fail to exhaust `fee_earned` and throw — in front of a manager, at approval.
  const manual = includedOrders(rows).filter((o) => o.kind === 'manual')
  return {
    driverShare: sum(manual.map((o) => o.driverShare ?? minor(0n))),
    companyShare: sum(manual.map((o) => o.companyShare ?? minor(0n))),
  }
}

/**
 * What the day's earlier shifts were ACTUALLY paid — read back out of the ledger, never recomputed.
 *
 * This is `trueUp`'s `alreadyPosted`, and the difference matters. It used to be
 * `splitDay(priorYallagoFees, rule)` where `rule` is the one resolved for THIS shift — its business
 * date and **its vehicle's type**. F-4 makes tier tables per vehicle type, so a driver who takes a
 * bike in the morning and a car in the evening has his morning re-priced under the evening's table,
 * and the delta is the difference between two numbers that were never both true. Measured on the
 * real HTTP stack: 12 orders on a bike (35% table) then 10 on a car (flat 50% table) leaves the
 * driver **900,000 minor units — 9,000 new SYP — short**, and the company over-credited by exactly
 * the same, on one driver, on one day. A rule republished between two approvals does it too.
 *
 * The ledger is the only record of what was actually paid, so it is what we read. Summing the
 * `share_split` roles across the day's earlier shifts — signed by side, so a `correction` reversal
 * nets itself out — gives what those shifts credited each party. The manual jobs come back off:
 * their shares are per-order money a manager typed, folded into the same credit lines at approval,
 * and the tier never allocated them.
 *
 * `driver_day_shares` would be the other place to keep this. It stays unwritten deliberately: it
 * would be a second record of the same fact, and two records of one fact eventually disagree. It is
 * a reporting projection for Bundle 2, not the source of truth.
 */
async function postedDayShares(
  deps: Deps,
  priorShifts: readonly ShiftRecord[],
): Promise<{ driver: Minor; company: Minor; yalago: Minor }> {
  let driver = 0n
  let company = 0n
  let yalago = 0n
  for (const prior of priorShifts) {
    for (const entry of await deps.ledger.listByShift(prior.id)) {
      for (const line of entry.lines) {
        // These three funds are credit-side: a credit pays the party, a debit takes it back.
        const signed = line.side === 'C' ? line.amount : -line.amount
        if (line.role === 'driver_share') driver += signed
        else if (line.role === 'company_share') company += signed
        else if (line.role === 'yalago_share') yalago += signed
      }
    }
    const manual = manualShareTotals(await deps.orders.listByShift(prior.id))
    driver -= manual.driverShare
    company -= manual.companyShare
  }
  return { driver: minor(driver), company: minor(company), yalago: minor(yalago) }
}

export function todayFor(deps: Deps): CalendarDate {
  return businessDateFor(deps.clock.nowMs(), deps.clock.offsetMinutes())
}

/**
 * BR7's gate on every ledger write: a sealed week takes no new postings.
 *
 * Migration 0018 enforces this in the database, which is the guard that matters — it survives the
 * psql session someone opens at 2am, and it is where the invariant belongs. This is the other half:
 * it turns a 25006 into a 409 with a cause the UI can name, instead of letting the manager who
 * back-dated an expense by one day see «خطأ داخلي».
 *
 * `isDateLocked` has existed in the domain since the week module was written and had no caller at
 * all — the check it describes was never performed anywhere. This is that caller.
 */
export async function assertWeekOpen(
  deps: Deps,
  branchId: string,
  businessDate: CalendarDate,
): Promise<void> {
  const closed = await deps.weekLocks.listClosedStarts(branchId)
  if (isDateLocked(businessDate, closed)) {
    throw new ServiceError(409, 'week_locked', { businessDate, weekStart: weekStartFor(businessDate) })
  }
}

/**
 * Append one entry to a vehicle's life log (SRS B-2 / س66). One place so every call site — a state
 * change, a linked expense, a manually recorded incident — writes the same shape. `businessDate`
 * defaults to today but is passed explicitly by callers (like an expense) that carry their own.
 */
export async function recordVehicleEvent(
  deps: Deps,
  input: {
    vehicleId: string
    branchId: string
    kind: VehicleEventKind
    createdBy: string | null
    odometerKm?: number | null
    costMinor?: Minor | null
    expenseId?: string | null
    shiftId?: string | null
    notes?: string | null
    businessDate?: CalendarDate
    occurredAtMs?: number
  },
): Promise<VehicleEventRecord> {
  return deps.vehicleEvents.create({
    vehicleId: input.vehicleId,
    branchId: input.branchId,
    kind: input.kind,
    occurredAtMs: input.occurredAtMs ?? deps.clock.nowMs(),
    businessDate: input.businessDate ?? todayFor(deps),
    odometerKm: input.odometerKm ?? null,
    costMinor: input.costMinor ?? null,
    expenseId: input.expenseId ?? null,
    shiftId: input.shiftId ?? null,
    notes: input.notes ?? null,
    createdBy: input.createdBy,
  })
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

  const [driverLive, vehicleLive, driverDocs, vehicleDocs] = await Promise.all([
    deps.shifts.listLiveForDriver(driver.id),
    deps.shifts.listLiveForVehicle(vehicle.id),
    deps.directory.listDocuments({ driverId: driver.id }),
    deps.directory.listDocuments({ vehicleId: vehicle.id }),
  ])

  // An expired licence or registration must stop the shift at the gate (B-1/B-3, س37). Until now
  // this fed `canOpenShift` empty arrays, so the block was dead — the one screen that showed the
  // «مستندات منتهية» badge could still start the shift. `listDocuments` already excludes superseded
  // (replaced) documents, so a renewed licence never traps its own driver.
  const today = todayFor(deps)
  const liveStatuses = (docs: readonly DocumentRecord[]): DocumentStatus[] =>
    docs.map((d) => documentStatusOn(d.expiresOn, today))

  // SRS B-3 (س34): the binding is mandatory, and a vehicle is shared between drivers across
  // shifts (س23) — just never simultaneously.
  const check = canOpenShift({
    vehicleState: vehicle.state,
    driverDocumentStatuses: liveStatuses(driverDocs),
    vehicleDocumentStatuses: liveStatuses(vehicleDocs),
    driverAlreadyLive: driverLive.length > 0,
    vehicleAlreadyLive: vehicleLive.length > 0,
    driverActive: driver.active,
    vehicleActive: vehicle.active,
  })
  if (!check.ok) throw new ServiceError(409, 'cannot_open_shift', check.blockers)

  const businessDate = today

  // SRS B-3: the manager binds the bike to the driver in advance. Two rules, both enforced here
  // rather than only in the UI:
  //   • if this driver HAS an assignment for the slot, he may only start that bike;
  //   • a bike assigned to somebody else is off limits even to an unassigned driver.
  // Where no assignment exists at all the old free choice stands, so a branch that has not
  // started assigning is not locked out of its own shifts.
  const dayAssignments = await deps.assignments.listByDate(driver.branchId, businessDate)
  const slot = dayAssignments.filter((a) => a.shiftNo === input.shiftNo)
  const mine = slot.find((a) => a.driverId === driver.id)
  if (mine && mine.vehicleId !== vehicle.id) {
    throw new ServiceError(409, 'vehicle_not_assigned', { assignedVehicleId: mine.vehicleId })
  }
  if (!mine && slot.some((a) => a.vehicleId === vehicle.id)) {
    throw new ServiceError(409, 'vehicle_assigned_to_other_driver')
  }
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
    odoStartOcr: null,
    batteryStartOcr: null,
    endWalletDeclaredOcr: null,
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

/**
 * Discard a shift that never opened.
 *
 * A shift abandoned in `draft` or `awaiting_open_approval` still holds its bike: `canOpenShift`
 * sees a live shift on that vehicle and refuses every subsequent one, so a driver who backs out
 * of the start screen can strand the bike for the rest of the day with no way out but a DBA.
 * Deleting is safe for exactly these two states and no others — nothing has posted to the ledger
 * yet, so there is no entry to reverse. Anything from `open` onward must be corrected by the
 * normal shift flow, never erased.
 */
export async function cancelShift(deps: Deps, shiftId: string): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  if (shift.state !== 'draft' && shift.state !== 'awaiting_open_approval') {
    throw new ServiceError(409, 'shift_already_opened', { state: shift.state })
  }
  await deps.shifts.delete(shift.id)
  return shift
}

/**
 * The battery facts the BR5 gates need for a shift: how many packs the bike carries, and what was
 * read off each of them.
 *
 * The count is COUNT(*) of the packs actually fitted, never a number anyone typed — a bike whose
 * second pack was pulled for charging genuinely has one pack today, and the gate should ask for
 * one screenshot, not two. Both gates call this, so open and close can never disagree about how
 * many packs the machine has.
 */
async function batteryContext(
  deps: Deps,
  shift: ShiftRecord,
  pkg: 'start' | 'end',
): Promise<{ batterySlots: number; batteryReadings: BatteryReading[] }> {
  const fitted = await deps.directory.listBatteriesForVehicle(shift.vehicleId)
  const rows = await deps.batteryReadings.listByShift(shift.id)
  const forPackage = rows.filter((r) => r.package === pkg)
  return {
    batterySlots: fitted.length,
    batteryReadings: fitted.map((battery, i) => ({
      slotNo: battery.slotNo ?? i + 1,
      percent: forPackage.find((r) => r.batteryId === battery.id)?.percent ?? null,
    })),
  }
}

// ── The OPEN gate (BR5) ───────────────────────────────────────────────────────────────────

export async function submitStartPackage(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: {
    odometerKm: number
    batteryPercent: number | null
    odometerKmOcr?: number | null
    batteryPercentOcr?: number | null
  },
): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const draft: ShiftRecord = {
    ...shift,
    odoStart: input.odometerKm,
    batteryStart: input.batteryPercent,
    // SRS D-3: the pre-correction OCR reads are evidence, not gate inputs — the guard below reads
    // the confirmed odoStart/batteryStart, never these.
    odoStartOcr: input.odometerKmOcr ?? null,
    batteryStartOcr: input.batteryPercentOcr ?? null,
    // Float and top-up are NOT set here — they are the branch's money, recorded by the manager at
    // approveOpen. mediaSlotsStart is NOT taken from the caller — it is whatever actually uploaded.
  }

  const result = await guard(deps, draft, 'driver_confirm_start', actor, {
    startPackage: {
      mediaSlots: draft.mediaSlotsStart,
      batteryPercent: draft.batteryStart,
      odometerKm: draft.odoStart,
      floatTotal: sum(draft.floatTranches),
      topupTotal: sum(draft.topupTranches),
      driverConfirmedAt: null,
      ...(await batteryContext(deps, draft, 'start')),
    },
  })
  if (!result.ok) fail(result)

  const updated: ShiftRecord = {
    ...draft,
    state: result.next,
    driverConfirmedAt: new Date(deps.clock.nowMs()).toISOString(),
  }
  await deps.shifts.update(updated)
  await notifyBranch(deps, updated, 'shift_awaiting_open_approval')
  return updated
}

/**
 * Ring the branch bell for a shift awaiting a manager (SRS A-6).
 *
 * Addressed to the BRANCH, not to a named user: any approver in the branch should see it, and
 * enumerating users is not this layer's job. The bell query surfaces branch-addressed
 * notifications to every member of that branch.
 *
 * Dedupe-keyed on (shift, kind), so re-submitting after a re-shoot request does not stack the
 * counter. Best-effort: a notification failure must never roll back the shift transition that
 * triggered it — the bell is a convenience, the state change is the record.
 */
async function notifyBranch(deps: Deps, shift: ShiftRecord, kind: string): Promise<void> {
  try {
    await deps.notifications.push({
      recipientId: `branch:${shift.branchId}`,
      branchId: shift.branchId,
      kind,
      payload: { shiftId: shift.id, driverId: shift.driverId, businessDate: shift.businessDate },
      dedupeKey: `${shift.id}:${kind}`,
      readAtMs: null,
      createdAtMs: deps.clock.nowMs(),
    })
  } catch {
    // swallow — the bell is a convenience, never a precondition
  }
}

export { notifyBranch }

export async function approveOpen(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: { floatTranches: Minor[]; topupTranches: Minor[] },
): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  // The manager records the float + top-up here (the driver no longer types them). They are the
  // branch's money, disbursed by the manager, so they become part of the shift at approval time.
  const withFunds: ShiftRecord = {
    ...shift,
    floatTranches: input.floatTranches,
    topupTranches: input.topupTranches,
  }
  const result = await guard(deps, withFunds, 'manager_approve_open', actor, {
    startPackage: {
      mediaSlots: withFunds.mediaSlotsStart,
      batteryPercent: withFunds.batteryStart,
      odometerKm: withFunds.odoStart,
      floatTotal: sum(withFunds.floatTranches),
      topupTotal: sum(withFunds.topupTranches),
      driverConfirmedAt: withFunds.driverConfirmedAt,
      ...(await batteryContext(deps, withFunds, 'start')),
    },
  })
  if (!result.ok) fail(result)

  // The float and top-up postings land HERE, at approval — not when the driver typed the
  // amounts. Money moves when a manager says it moved.
  const fxDayId = await ensureFxDay(deps, withFunds.businessDate)
  await deps.ledger.post(
    withFunds.branchId,
    postingsForOpen({
      driverId: withFunds.driverId,
      floatTranches: withFunds.floatTranches,
      topupTranches: withFunds.topupTranches,
      orders: [],
    }),
    {
      shiftId: withFunds.id,
      businessDate: withFunds.businessDate,
      postingDate: todayFor(deps),
      weekStartDate: withFunds.weekStartDate,
      fxDayId,
      createdBy: actor.userId,
    },
  )

  const updated: ShiftRecord = { ...withFunds, state: result.next }
  await deps.shifts.update(updated)
  await recordDecision(deps, actor, shiftId, 'open', 'approved', null)
  return updated
}

// ── Manager decisions: re-shoot request, reject, and the decision log (C-7) ─────────────────

/** Append one entry to a shift's decision log («سجل قرارات»). */
async function recordDecision(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  gate: 'open' | 'close',
  decision: 'approved' | 'rejected' | 'rephoto_requested',
  notes: string | null,
): Promise<void> {
  await deps.decisions.record({ shiftId, gate, decision, notes, decidedBy: actor.userId, decidedAtMs: deps.clock.nowMs() })
}

/** Tell the driver something happened to his shift — addressed to HIS user id, not the branch. */
async function notifyDriver(deps: Deps, shift: ShiftRecord, kind: string, notes: string | null): Promise<void> {
  try {
    const driver = await deps.directory.driver(shift.driverId)
    if (!driver?.userId) return
    await deps.notifications.push({
      recipientId: driver.userId,
      branchId: shift.branchId,
      kind,
      payload: { shiftId: shift.id, notes },
      dedupeKey: null,
      readAtMs: null,
      createdAtMs: deps.clock.nowMs(),
    })
  } catch {
    // The bell is a convenience, never a precondition.
  }
}

/**
 * The manager sends the package back for a re-shoot (C-7). From `awaiting_open_approval` it returns
 * to `draft` (re-do the start package); from `pending_review` to `open` (re-do the end package).
 * The driver is told WHY, and the request is logged.
 */
export async function requestRephoto(deps: Deps, actor: Actor, shiftId: string, notes: string | null): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const gate = shift.state === 'pending_review' ? 'close' : 'open'
  const result = await guard(deps, shift, 'manager_request_rephoto', actor)
  if (!result.ok) fail(result)
  const updated: ShiftRecord = { ...shift, state: result.next }
  await deps.shifts.update(updated)
  await recordDecision(deps, actor, shiftId, gate, 'rephoto_requested', notes)
  await notifyDriver(deps, updated, 'shift_rephoto_requested', notes)
  return updated
}

/**
 * The manager refuses a shift at the OPEN gate: it returns to `draft` for the driver to redo.
 *
 * Distinct from a re-shoot request, which asks for a better photograph of the same package. This
 * says the shift itself was not acceptable — and until now there was no way to say it: the only
 * kill-path at this gate hard-DELETED the row, so the driver was never told why and nothing was
 * left to look at afterwards. Nothing has posted at `awaiting_open_approval`, so there is nothing
 * to reverse; the reason and the decision-log entry are the whole point.
 */
export async function rejectOpen(deps: Deps, actor: Actor, shiftId: string, notes: string | null): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const result = await guard(deps, shift, 'manager_reject_open', actor)
  if (!result.ok) fail(result)
  const updated: ShiftRecord = { ...shift, state: result.next }
  await deps.shifts.update(updated)
  await recordDecision(deps, actor, shiftId, 'open', 'rejected', notes)
  await notifyDriver(deps, updated, 'shift_open_rejected', notes)
  return updated
}

/** The manager rejects a close: the shift returns to `open` so the driver can correct and resubmit. */
export async function rejectClose(deps: Deps, actor: Actor, shiftId: string, notes: string | null): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const result = await guard(deps, shift, 'manager_reject_close', actor)
  if (!result.ok) fail(result)
  const updated: ShiftRecord = { ...shift, state: result.next }
  await deps.shifts.update(updated)
  await recordDecision(deps, actor, shiftId, 'close', 'rejected', notes)
  await notifyDriver(deps, updated, 'shift_close_rejected', notes)
  return updated
}

// ── Suspended / mid-shift incident (C-1, س29) ──────────────────────────────────────────────

/**
 * A manager suspends a live shift for a mid-shift incident (accident, breakdown, dispute). The
 * shift enters «معلقة»; it can later `resume`, or close directly — always under the SAME BR1, since
 * a suspension is never a way around the zero equation. Legal from
 * draft/awaiting_open_approval/open/pending_review. `suspend` is a manager act (`shift.approve`).
 */
export async function suspendShift(deps: Deps, actor: Actor, shiftId: string, notes: string | null): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const result = await guard(deps, shift, 'suspend', actor)
  if (!result.ok) fail(result)
  const updated: ShiftRecord = { ...shift, state: result.next }
  await deps.shifts.update(updated)
  await notifyDriver(deps, updated, 'shift_suspended', notes)
  return updated
}

/** The driver resumes a suspended shift back to `open` when the incident clears (`shift.operate`). */
export async function resumeShift(deps: Deps, actor: Actor, shiftId: string): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const result = await guard(deps, shift, 'resume', actor)
  if (!result.ok) fail(result)
  const updated: ShiftRecord = { ...shift, state: result.next }
  await deps.shifts.update(updated)
  return updated
}

/**
 * The driver reports a mid-shift incident he can't resolve alone. He can't suspend himself — that's
 * a manager act — so this rings the branch bell with the note; a manager then suspends via
 * `suspendShift` or handles it out of band. No new entity, mirroring `requestManualOrder`.
 */
export async function reportIncident(deps: Deps, _actor: Actor, shiftId: string, notes: string | null): Promise<void> {
  const shift = await mustFind(deps, shiftId)
  try {
    await deps.notifications.push({
      recipientId: `branch:${shift.branchId}`,
      branchId: shift.branchId,
      kind: 'shift_incident_reported',
      payload: { shiftId, driverId: shift.driverId, businessDate: shift.businessDate, notes },
      dedupeKey: null,
      readAtMs: null,
      createdAtMs: deps.clock.nowMs(),
    })
  } catch {
    // The bell is a convenience; a failed push must not error the driver's report.
  }
}

// ── Second float / top-up tranche mid-day (C-5) ────────────────────────────────────────────

/**
 * A second (or later) cash-float or wallet top-up handed to the driver mid-day (SRS C-5). Each
 * tranche posts ONE balanced entry under its own occurrence key
 * — `(shift_id, event_type, occurrence_key)` — so a replay is idempotent and the second tranche is
 * never swallowed by an "idempotent" first. BR1's expected end cash/wallet move automatically,
 * because the equation sums the tranche arrays. Manager money, so this is `shift.approve` (route).
 */
export async function addTranche(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: { kind: 'float' | 'topup'; amount: Minor; occurrenceKey?: string | undefined },
): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  // Money the driver is out with: only while he is live. Not before open, not after review.
  if (shift.state !== 'open' && shift.state !== 'suspended') {
    throw new ServiceError(409, 'shift_not_open_for_tranche')
  }
  if (input.amount <= minor(0n)) throw new ServiceError(422, 'tranche_amount_must_be_positive')

  const existing = input.kind === 'float' ? shift.floatTranches : shift.topupTranches
  const trancheNo = existing.length + 1
  /*
   * The CLIENT's key when it sent one. The ordinal is not an idempotency key: it is recomputed
   * from the current row on every request, so a retry lands on the next number and disburses
   * again. SRS C-5 genuinely allows several tranches a day, so the server cannot tell a second
   * disbursement from a repeated one — only the caller knows, and now it says.
   */
  const key = input.occurrenceKey ?? String(trancheNo)
  const posting =
    input.kind === 'float' ? floatOut(shift.driverId, input.amount, key) : walletTopup(shift.driverId, input.amount, key)

  const fxDayId = await ensureFxDay(deps, shift.businessDate)
  await deps.ledger.post(shift.branchId, [posting], {
    shiftId: shift.id,
    businessDate: shift.businessDate,
    postingDate: todayFor(deps),
    weekStartDate: shift.weekStartDate,
    fxDayId,
    createdBy: actor.userId,
  })

  const updated: ShiftRecord =
    input.kind === 'float'
      ? { ...shift, floatTranches: [...shift.floatTranches, input.amount] }
      : { ...shift, topupTranches: [...shift.topupTranches, input.amount] }
  await deps.shifts.update(updated)
  return updated
}

// ── Mid-shift battery swap (SRS §L seam) ────────────────────────────────────────────────────

/**
 * The driver swapped a depleted pack for a charged spare at a charging stop (new scope beyond the
 * SRS's single «نسبة البطارية»; section L is deferred). Both packs' BMS readings are captured — the
 * outgoing pack's FINAL state and the incoming pack's FIRST — the bike is re-fitted (old pack → a
 * charging spare, new pack → the slot), and the swap is logged. No money moves, so BR1 and the
 * close equation are untouched. `shift.operate` on his own live shift (route), like adding an order.
 *
 * Ordering matters: the outgoing pack is cleared from `(vehicle, slot)` BEFORE the incoming pack
 * takes it, or the `batteries_slot_uq (vehicle_id, slot_no)` index would reject the second write.
 */
export async function swapBattery(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: { slotNo: number; inBatteryId: string; outReading: BatteryReadingFields; inReading: BatteryReadingFields },
): Promise<{ swap: BatterySwapRecord; readings: BatteryReadingRecord[]; fitted: BatteryRecord[] }> {
  const shift = await mustFind(deps, shiftId)
  if (shift.state !== 'open' && shift.state !== 'suspended') {
    throw new ServiceError(409, 'shift_not_open_for_swap')
  }

  // The pack fitted to this bike at that slot right now is the one coming off.
  const fitted = await deps.directory.listBatteriesForVehicle(shift.vehicleId)
  const outgoing = fitted.find((b) => b.slotNo === input.slotNo)
  if (!outgoing) throw new ServiceError(422, 'slot_not_fitted', { slotNo: input.slotNo })

  // The pack going on must be a READY SPARE in the same branch — on the shelf, not on another bike.
  const incoming = await deps.directory.battery(input.inBatteryId)
  if (!incoming || !incoming.active || incoming.branchId !== shift.branchId) {
    throw new ServiceError(404, 'battery_not_found', { batteryId: input.inBatteryId })
  }
  if (incoming.id === outgoing.id) throw new ServiceError(422, 'same_battery')
  if (incoming.vehicleId !== null || incoming.state !== 'ready') {
    throw new ServiceError(422, 'spare_not_available', { batteryId: incoming.id, state: incoming.state })
  }

  const seqNo = (await deps.batterySwaps.listByShift(shift.id)).length + 1
  const swap: BatterySwapRecord = {
    id: deps.ids.uuid(),
    shiftId: shift.id,
    seqNo,
    slotNo: input.slotNo,
    outBatteryId: outgoing.id,
    inBatteryId: incoming.id,
    occurredAtMs: deps.clock.nowMs(),
    createdBy: actor.userId,
  }
  await deps.batterySwaps.create(swap)

  await deps.batteryReadings.upsert(swapReading(shift.id, outgoing.id, 'swap_out', input.slotNo, swap.id, input.outReading))
  await deps.batteryReadings.upsert(swapReading(shift.id, incoming.id, 'swap_in', input.slotNo, swap.id, input.inReading))

  // Re-fit: outgoing to the shelf to charge, then incoming into the freed slot.
  await deps.directory.updateBattery({ ...outgoing, vehicleId: null, slotNo: null, state: 'charging' })
  await deps.directory.updateBattery({ ...incoming, vehicleId: shift.vehicleId, slotNo: input.slotNo, state: 'ready' })

  return {
    swap,
    readings: await deps.batteryReadings.listByShift(shift.id),
    // The bike's fitted set changed. The driver app MUST take this back, or its close screen would
    // still ask for the pack that just came off and reject the reading for the one now on.
    fitted: await deps.directory.listBatteriesForVehicle(shift.vehicleId),
  }
}

function swapReading(
  shiftId: string,
  batteryId: string,
  pkg: 'swap_out' | 'swap_in',
  slotNo: number,
  batterySwapId: string,
  r: BatteryReadingFields,
): BatteryReadingRecord {
  return {
    shiftId,
    batteryId,
    package: pkg,
    slotNo,
    percent: r.percent,
    packMillivolts: r.packMillivolts,
    cycleCount: r.cycleCount,
    remainCapacityDah: r.remainCapacityDah,
    fullCapacityDah: r.fullCapacityDah,
    mosTempDc: r.mosTempDc,
    t1Dc: r.t1Dc,
    t2Dc: r.t2Dc,
    mediaId: null,
    source: r.source,
    ocrRaw: r.ocrRaw ?? null,
    batterySwapId,
  }
}

// ── Orders ────────────────────────────────────────────────────────────────────────────────

export async function addOrder(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: {
    providerOrderNo: string
    payMode: ShiftOrder['payMode']
    fee: Minor
    zone: string | null
    source?: 'manual' | 'ocr' | 'refused'
    feeOcr?: Minor | null
  /** The fee's own pixels, kept as a training sample. Never money; never required. */
  feeStrip?: string | null
    included?: boolean
    walletAmount?: Minor | null
    occurredMinute?: string | null
  },
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
      // A SYNTHETIC package: this call only wants `transition`'s permission branch, so it is
      // deliberately complete. Battery slots are omitted for the same reason.
      mediaSlots: [...REQUIRED_END_SLOTS],
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
    // SRS D-1/D-3: 'ocr' when the driver pulled the fee off «Recent orders»; feeOcr is what it read.
    source: storedSource(input.source),
    feeOcr: input.feeOcr ?? null,
    // What the driver records is always a Yallago delivery — he scans his own «Recent orders» list.
    // A MANUAL job is the branch's, and only a manager may enter one (`addManualOrder`); allowing it
    // here would let a driver write his own share.
    kind: 'yallago',
    driverShare: null,
    companyShare: null,
    notes: null,
    createdBy: actor.userId,
    points: [],
    included: input.included ?? true,
    walletAmount: input.walletAmount ?? null,
    occurredMinute: input.occurredMinute ?? null,
    occurredDate: null,
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
  await keepOcrSample(deps, order.id, input)
  return order
}

/**
 * A manual order added by a higher-level manager (branch manager / GM) to RECONCILE a shift — the
 * fix for the "missing order" BR1 ranks at close. Unlike `addOrder` (the driver, only while open),
 * this is permitted in `open`, `suspended` AND `pending_review`, so a manager can add the order
 * during the C-7 review; it then changes the orders hash, and the staleness guard forces a
 * re-review before approval. `driver_confirmed: true` — the manager vouches for it. The route
 * audits every manual add (who/when), since it moves money into BR1.
 */
export async function addManualOrder(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: {
    providerOrderNo: string
    payMode: ShiftOrder['payMode']
    fee: Minor
    zone: string | null
    kind?: 'yallago' | 'manual'
    driverShare?: Minor | null
    companyShare?: Minor | null
    notes?: string | null
    points?: readonly OrderPointRecord[]
    walletAmount?: Minor | null
    occurredMinute?: string | null
  },
): Promise<ShiftOrderRecord> {
  const shift = await mustFind(deps, shiftId)
  if (shift.state !== 'open' && shift.state !== 'suspended' && shift.state !== 'pending_review') {
    throw new ServiceError(409, 'shift_not_reconcilable')
  }
  const kind = input.kind ?? 'yallago'
  const driverShare = input.driverShare ?? null
  const companyShare = input.companyShare ?? null

  if (kind === 'manual') {
    // The invariant the whole manual-order design rests on. `shareSplit` must close `fee_earned`
    // exactly (driver + company + yallago === feeTotal); a manual order contributes no Yallago cut,
    // so its two shares ARE its fee. Let them disagree by one minor unit and the approval posting
    // throws — at close, in front of a manager, with no way to fix it but editing the database.
    if (driverShare === null || companyShare === null) {
      throw new ServiceError(422, 'manual_order_shares_required')
    }
    if (add(driverShare, companyShare) !== input.fee) {
      throw new ServiceError(422, 'manual_order_shares_mismatch', {
        fee: serializeMoney(input.fee),
        driverShare: serializeMoney(driverShare),
        companyShare: serializeMoney(companyShare),
      })
    }
  } else if (driverShare !== null || companyShare !== null) {
    // A Yallago order's split belongs to the DAY's tier band, computed at approval. Storing one on
    // the order would be quietly overwritten by the true-up that restates earlier shifts.
    throw new ServiceError(422, 'yallago_order_takes_no_shares')
  }

  const order: ShiftOrderRecord = {
    id: deps.ids.uuid(),
    shiftId,
    providerOrderNo: input.providerOrderNo,
    payMode: input.payMode,
    fee: input.fee,
    zone: input.zone,
    driverConfirmed: true,
    // A manager reconciling by hand vouches for the number — always manual, no OCR baseline.
    source: 'manual',
    feeOcr: null,
    kind,
    driverShare,
    companyShare,
    notes: input.notes ?? null,
    createdBy: actor.userId,
    points: input.points ?? [],
    // A manager adding an order by hand is asserting it belongs to this shift; that is the whole
    // point of the act. The measured wallet amount is the payments log's business, not his.
    included: true,
    walletAmount: input.walletAmount ?? null,
    occurredMinute: input.occurredMinute ?? null,
    occurredDate: null,
  }
  try {
    await deps.orders.create(order)
  } catch (err) {
    if ((err as { code?: string }).code === 'DUPLICATE_ORDER_NO') {
      throw new ServiceError(409, 'duplicate_order_no', { providerOrderNo: input.providerOrderNo })
    }
    throw err
  }
  return order
}

// `requestManualOrder` lived here: the driver proposing an order for a manager to enter. A manual
// job is now the branch's own work, priced by a manager with shares he agrees — not something a
// driver proposes — so the request channel and its bell went with it (owner's decision). His own
// Yallago deliveries he still records himself, by scanning them at the end of the shift.

// ── BR1 ───────────────────────────────────────────────────────────────────────────────────

export interface Br1View {
  result: Br1Result
  causes: Br1Cause[]
  minWallet: Minor
  ordersHash: string
}

export async function evaluateShift(deps: Deps, shift: ShiftRecord): Promise<Br1View> {
  const orderRows = await deps.orders.listByShift(shift.id)
  const movementRows = await deps.movements.listByShift(shift.id)
  const orders = toDomainOrders(orderRows)
  const walletAdjustments = toWalletAdjustments(movementRows)
  const result = evaluateBr1({
    floatTotal: sum(shift.floatTranches),
    topupTotal: sum(shift.topupTranches),
    endCashDeclared: shift.endCashDeclared ?? minor(0n),
    endWalletDeclared: shift.endWalletDeclared ?? minor(0n),
    orders,
    walletAdjustments,
  })
  return {
    result,
    causes: diagnoseBr1(
      result,
      orders,
      'floor',
      // A credit still flagged ambiguous is the likeliest single explanation for a difference, and
      // the only one a manager can settle with one tap.
      movementRows.filter((m) => m.ambiguous && m.included).map((m) => m.amount),
    ),
    // The trough the wallet reaches mid-shift still walks the ORDERS only: a movement carries a
    // minute but the orders do not carry a sequence, so interleaving them would be guesswork.
    // It therefore under-reports once adjustments are real — noted rather than faked.
    minWallet: minWalletBalance({
      driverId: shift.driverId,
      floatTranches: shift.floatTranches,
      topupTranches: shift.topupTranches,
      orders,
    }),
    ordersHash: ordersHash(orderRows, movementRows),
  }
}

// ── The CLOSE gate (BR5) ──────────────────────────────────────────────────────────────────

export async function submitEndPackage(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: {
    odometerKm: number
    batteryPercent: number | null
    cashDeclared: Minor
    walletDeclared: Minor
    walletDeclaredOcr?: Minor | null
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
    // SRS D-3: the wallet OCR baseline (readWallet); evidence, not a BR1 input.
    endWalletDeclaredOcr: input.walletDeclaredOcr ?? null,
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
      ...(await batteryContext(deps, staged, 'end')),
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
  await notifyBranch(deps, updated, 'shift_awaiting_close_approval')
  return { shift: updated, br1 }
}

/**
 * The manager corrects a closing figure during the review, WITHOUT approving.
 *
 * The driver's close is increasingly read off screenshots rather than typed, and a reader that
 * misses leaves a figure wrong or missing with nobody able to fix it: the review screen was
 * read-only, so the only ways out were bouncing the shift back to the driver or force-closing it —
 * and force-close bypasses BR1 entirely, which is far too blunt a tool for a mistyped odometer.
 *
 * This changes only what the manager passes, re-evaluates BR1 against it, and LEAVES THE SHIFT IN
 * `pending_review`. The close gate still has to pass on its own afterwards, so correcting a figure
 * can never become a way around the equation — only a way to give it the right numbers. Audited at
 * the route, because it moves BR1.
 */
export async function reviseCloseFigures(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: { odometerKm?: number | null; cashDeclared?: Minor | null; walletDeclared?: Minor | null },
): Promise<{ shift: ShiftRecord; br1: Br1View; before: ShiftRecord }> {
  const shift = await mustFind(deps, shiftId)
  if (shift.state !== 'pending_review') throw new ServiceError(409, 'shift_not_under_review')

  // `can` rather than `transition`: this is not a state change, so there is no edge to walk — but
  // it is still a `shift.approve` act and must be checked as one, on the SHIFT's branch.
  const grants = grantsFromRows(await deps.directory.grants())
  const decision = can(
    actor,
    'shift.approve',
    { driverId: shift.driverId, branchId: shift.branchId, ownerUserId: null },
    grants,
  )
  if (!decision.allowed) throw new ServiceError(403, 'forbidden')

  const staged: ShiftRecord = {
    ...shift,
    ...(input.odometerKm === undefined || input.odometerKm === null ? {} : { odoEnd: input.odometerKm }),
    ...(input.cashDeclared === undefined || input.cashDeclared === null ? {} : { endCashDeclared: input.cashDeclared }),
    ...(input.walletDeclared === undefined || input.walletDeclared === null
      ? {}
      : { endWalletDeclared: input.walletDeclared }),
  }
  const br1 = await evaluateShift(deps, staged)
  const updated: ShiftRecord = {
    ...staged,
    equationDiff: br1.result.scalarDiff,
    cashDiff: br1.result.cashDiff,
    walletDiff: br1.result.walletDiff,
    ordersHash: br1.ordersHash,
  }
  await deps.shifts.update(updated)
  return { shift: updated, br1, before: shift }
}

// ── The operations of a shift (the driver's close, read off his screenshots) ────────────────

export interface OperationsInput {
  orders: readonly {
    providerOrderNo: string
    payMode: ShiftOrder['payMode']
    fee: Minor
    zone?: string | null
    source?: 'manual' | 'ocr' | 'refused'
    feeOcr?: Minor | null
  /** The fee's own pixels, kept as a training sample. Never money; never required. */
  feeStrip?: string | null
    included?: boolean
    walletAmount?: Minor | null
    occurredMinute?: string | null
    occurredDate?: string | null
    pointA?: string | null
    pointB?: string | null
  }[]
  movements: readonly {
    amount: Minor
    occurredMinute: string
    role?: 'yalago_cut' | 'order_credit' | 'unmatched'
    providerOrderNo?: string | null
    ambiguous?: boolean
    included?: boolean
    notes?: string | null
  }[]
}

/**
 * The driver submits his whole operations list.
 *
 * UPSERT, not insert. The list is read off overlapping screenshots and is submitted more than once —
 * he steps back out of the close to add a delivery he forgot, or re-reads a page. Inserting meant
 * every re-read was a 409 on the globally-unique `provider_order_no`, and an already-sent row could
 * never be corrected at all: the only remedy was a manager adding a compensating order.
 *
 * Rows already on the server but ABSENT from the payload are left alone, never deleted. With
 * `included` there is no longer any need to delete an order to undo it — which is exactly why no
 * order DELETE should ever be added. An order is money; it is unchecked, not erased.
 */
/**
 * What `source` a stored order gets. `refused` is not one of them, deliberately.
 *
 * On the money row the honest value is `manual`: a PERSON typed that fee, whatever the reader did
 * beforehand. Widening a CHECK constraint on a money table to carry a research distinction would be
 * the wrong trade. The fact that the reader saw the row and declined is kept where it is actually
 * useful — on the training sample, whose own `source` column allows exactly `ocr` and `refused`.
 */
const storedSource = (s: 'manual' | 'ocr' | 'refused' | undefined): 'manual' | 'ocr' =>
  s === 'ocr' ? 'ocr' : 'manual'

/**
 * Keep the fee's own pixels beside what the reader made of them — one training sample per order.
 *
 * BEST EFFORT, ALWAYS. This is research material: a hundred bikes produce about a megabyte a month
 * of it, and none of it is worth failing a driver's close over. Every error is swallowed.
 *
 * Only rows with a screenshot behind them are samples. A fee typed with no scan is not one — there
 * are no pixels to learn from — which is exactly why `source` carries `refused` as its own value:
 * a row the reader SAW and declined is the most valuable example there is, being a hard glyph at
 * real phone scale with a human's correction about to be attached to it.
 */
async function keepOcrSample(
  deps: Deps,
  orderId: string,
  row: { source?: string | undefined; feeStrip?: string | null | undefined },
): Promise<void> {
  const source = row.source === 'ocr' ? 'ocr' : row.source === 'refused' ? 'refused' : null
  if (source === null || !row.feeStrip) return
  const base64 = row.feeStrip.replace(/^data:image\/png;base64,/, '')
  if (base64 === row.feeStrip) return // not the data URL we produce; ignore rather than store junk
  try {
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length === 0 || bytes.length > 65536) return
    await deps.orders.recordOcrSample(orderId, source, bytes)
  } catch {
    // A lost sample costs a future model one example. A thrown error would cost a driver his shift.
  }
}

export async function submitOperations(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: OperationsInput,
): Promise<{ shift: ShiftRecord; br1: Br1View }> {
  const shift = await mustFind(deps, shiftId)
  if (shift.state !== 'open' && shift.state !== 'suspended') throw new ServiceError(409, 'shift_not_open')

  const grants = grantsFromRows(await deps.directory.grants())
  const decision = can(
    actor,
    'shift.operate',
    { driverId: shift.driverId, branchId: shift.branchId, ownerUserId: null },
    grants,
  )
  if (!decision.allowed) throw new ServiceError(403, 'forbidden')

  const existing = await deps.orders.listByShift(shiftId)
  const byNo = new Map(existing.map((o) => [o.providerOrderNo, o]))

  for (const row of input.orders) {
    const current = byNo.get(row.providerOrderNo)
    if (current) {
      await deps.orders.update({
        ...current,
        payMode: row.payMode,
        fee: row.fee,
        zone: row.zone ?? current.zone,
        source: row.source === undefined ? current.source : storedSource(row.source),
        feeOcr: row.feeOcr ?? current.feeOcr,
        included: row.included ?? current.included,
        walletAmount: row.walletAmount ?? null,
        occurredMinute: row.occurredMinute ?? current.occurredMinute,
        occurredDate: row.occurredDate ?? current.occurredDate,
      })
      // BACKFILL the route, never overwrite it. An order submitted before the reader could read
      // routes has none stored, and re-submitting the shift is the only chance it will ever get
      // one; but a route already on the record may have been corrected by a manager, and a
      // re-read screenshot must not undo that.
      if ((row.pointA || row.pointB) && current.points.length === 0) {
        await deps.orders.replacePoints(current.id, [
          ...(row.pointA ? [{ role: 'start' as const, label: row.pointA, lat: null, lng: null }] : []),
          ...(row.pointB ? [{ role: 'end' as const, label: row.pointB, lat: null, lng: null }] : []),
        ])
      }
      continue
    }
    // The dashboard list scrolls back through PREVIOUS DAYS, so reading further pulls in orders
    // already recorded on an earlier shift. That must say which shift owns it — «هذا الطلب مسجّل في
    // نوبة سابقة» — rather than the blanket "some orders could not be saved" it used to produce.
    const elsewhere = await deps.orders.findByProviderNo(row.providerOrderNo)
    if (elsewhere) {
      const owner = await deps.shifts.findById(elsewhere.shiftId)
      throw new ServiceError(409, 'order_belongs_to_other_shift', {
        providerOrderNo: row.providerOrderNo,
        shiftId: elsewhere.shiftId,
        businessDate: owner?.businessDate ?? null,
      })
    }
    const orderId = deps.ids.uuid()
    await deps.orders.create({
      id: orderId,
      shiftId,
      providerOrderNo: row.providerOrderNo,
      payMode: row.payMode,
      fee: row.fee,
      zone: row.zone ?? null,
      driverConfirmed: true,
      source: storedSource(row.source),
      feeOcr: row.feeOcr ?? null,
      // A driver's own list is always Yallago's work. A manual job is the branch's and only a
      // manager may price one — letting it in here would let a driver write his own share.
      kind: 'yallago',
      driverShare: null,
      companyShare: null,
      notes: null,
      createdBy: actor.userId,
      // «A» the pickup, «B» the dropoff, exactly as the screen wrote them. The route is what makes
      // an order recognisable to a person at the review — it has no order number to go by.
      points: [
        ...(row.pointA ? [{ role: 'start' as const, label: row.pointA, lat: null, lng: null }] : []),
        ...(row.pointB ? [{ role: 'end' as const, label: row.pointB, lat: null, lng: null }] : []),
      ],
      included: row.included ?? true,
      walletAmount: row.walletAmount ?? null,
      occurredMinute: row.occurredMinute ?? null,
      occurredDate: row.occurredDate ?? null,
    })
    await keepOcrSample(deps, orderId, row)
  }

  // Resolve each movement's order AFTER the orders exist, so a page submitted in one go can link
  // its rows to orders created by the same call.
  const saved = new Map((await deps.orders.listByShift(shiftId)).map((o) => [o.providerOrderNo, o.id]))
  await deps.movements.merge(
    shiftId,
    input.movements.map((m) => ({
      amount: m.amount,
      occurredMinute: m.occurredMinute,
      orderId: m.providerOrderNo ? (saved.get(m.providerOrderNo) ?? null) : null,
      role: m.role ?? 'unmatched',
      ambiguous: m.ambiguous ?? false,
      included: m.included ?? true,
      source: 'ocr' as const,
      notes: m.notes ?? null,
      createdBy: actor.userId,
    })),
  )

  const br1 = await evaluateShift(deps, shift)
  return { shift, br1 }
}

/**
 * The manager changes what counts, during the review, WITHOUT approving.
 *
 * Same shape as `reviseCloseFigures` and for the same reason: the driver curates the list at close,
 * but he is reading it off a screenshot at the end of a long day, and the manager must be able to
 * put a row back — or take one out — without bouncing the shift or force-closing it. The state stays
 * `pending_review`, so the close gate still has to pass on its own afterwards.
 */
export async function reviseOperations(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  // `| undefined` spelled out on every optional: `exactOptionalPropertyTypes` is on, and Zod's
  // parsed shape carries the explicit undefined that an omitted key produces.
  input: {
    orders?: readonly {
      providerOrderNo: string
      included?: boolean | undefined
      walletAmount?: Minor | null | undefined
      fee?: Minor | undefined
    }[]
    movements?: readonly {
      id: string
      included?: boolean | undefined
      role?: 'yalago_cut' | 'order_credit' | 'unmatched' | undefined
      providerOrderNo?: string | null | undefined
      ambiguous?: boolean | undefined
    }[]
  },
): Promise<{ shift: ShiftRecord; br1: Br1View; before: ShiftRecord }> {
  const shift = await mustFind(deps, shiftId)
  if (shift.state !== 'pending_review') throw new ServiceError(409, 'shift_not_under_review')

  const grants = grantsFromRows(await deps.directory.grants())
  const decision = can(
    actor,
    'shift.approve',
    { driverId: shift.driverId, branchId: shift.branchId, ownerUserId: null },
    grants,
  )
  if (!decision.allowed) throw new ServiceError(403, 'forbidden')

  const rows = await deps.orders.listByShift(shiftId)
  const byNo = new Map(rows.map((o) => [o.providerOrderNo, o]))
  for (const patch of input.orders ?? []) {
    const current = byNo.get(patch.providerOrderNo)
    if (!current) throw new ServiceError(404, 'order_not_found', { providerOrderNo: patch.providerOrderNo })
    await deps.orders.update({
      ...current,
      included: patch.included ?? current.included,
      // The manager's own correction. He verifies against the cash in his hand, so he is the one
      // placed to say what a fee actually was — and until now his only move against a wrong one was
      // to exclude the whole delivery. The audit trigger attributes the change, and it moves
      // `orders_hash`, so he cannot approve figures he has not re-read.
      fee: patch.fee ?? current.fee,
      // `undefined` leaves it alone; an explicit `null` clears a measurement the manager rejects.
      walletAmount: patch.walletAmount === undefined ? current.walletAmount : patch.walletAmount,
    })
  }

  const known = new Set((await deps.movements.listByShift(shiftId)).map((m) => m.id))
  const orderIds = new Map(rows.map((o) => [o.providerOrderNo, o.id]))
  for (const patch of input.movements ?? []) {
    if (!known.has(patch.id)) throw new ServiceError(404, 'movement_not_found', { id: patch.id })
    await deps.movements.update(patch.id, {
      ...(patch.included === undefined ? {} : { included: patch.included }),
      ...(patch.role === undefined ? {} : { role: patch.role }),
      ...(patch.ambiguous === undefined ? {} : { ambiguous: patch.ambiguous }),
      // Presence decides, because `null` is a real instruction here: «this credit belongs to no
      // order», which is the whole resolution of an ambiguous row.
      ...(patch.providerOrderNo === undefined
        ? {}
        : { orderId: patch.providerOrderNo === null ? null : (orderIds.get(patch.providerOrderNo) ?? null) }),
    })
  }

  const br1 = await evaluateShift(deps, shift)
  const updated: ShiftRecord = {
    ...shift,
    equationDiff: br1.result.scalarDiff,
    cashDiff: br1.result.cashDiff,
    walletDiff: br1.result.walletDiff,
    ordersHash: br1.ordersHash,
  }
  await deps.shifts.update(updated)
  return { shift: updated, br1, before: shift }
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
      ...(await batteryContext(deps, shift, 'end')),
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
  // ONLY Yallago's deliveries choose the band and feed the true-up. A manual job is the branch's
  // own, priced by hand: counting it would lift the driver's percentage on Yallago work he did not
  // do, and totalling its fee here would have the tier try to split money that is already split.
  const dayFees = [...priorOrders, ...todaysOrders].filter((o) => o.kind !== 'manual').map((o) => o.fee)

  // The tier rule that actually governs this shift's pay — resolved by business date and vehicle
  // type (F-3 versioning, F-4 per-type), not a frozen default. `resolveTierRule` falls back to the
  // F-1 table when nothing is published, so a close is never blocked; published/marginal/per-type
  // tables now change real pay instead of being dead config.
  const vehicle = await deps.directory.vehicle(shift.vehicleId)
  const rule = await resolveTierRule(deps, shift.businessDate, vehicle?.vehicleTypeId ?? null)

  // What the day's earlier shifts were already paid — READ from the ledger, never recomputed under
  // this shift's rule. See `postedDayShares`: recomputing mis-pays a driver who changed vehicle type
  // mid-day, or whose tier rule was republished between two approvals.
  const alreadyPosted = await postedDayShares(deps, priorShifts.filter((s) => s.id !== shift.id))

  const settlement = trueUp(dayFees, rule, alreadyPosted)

  // The tier settles Yallago's work; the manual jobs on THIS shift carry the shares a manager typed
  // and validated (driverShare + companyShare === fee). Adding them here is what lets `shareSplit`
  // exhaust `fee_earned` across both kinds — the postings total every order's fee, so the split must
  // account for every order's fee too. Prior shifts' manual orders were settled at their own close.
  const manual = manualShareTotals(orderRows)
  const shiftSplit = {
    driverShare: add(settlement.driverDelta, manual.driverShare),
    companyShare: add(settlement.companyDelta, manual.companyShare),
    yalagoShare: settlement.yalagoDelta,
  }

  const fxDayId = await ensureFxDay(deps, shift.businessDate)
  const postings = postingsForApproval(
    {
      driverId: shift.driverId,
      branchId: shift.branchId,
      floatTranches: shift.floatTranches,
      topupTranches: shift.topupTranches,
      orders: todaysOrders,
      // The SAME list BR1 just balanced against. If these two ever diverged the ledger would
      // return a wallet different from the one the equation approved.
      walletAdjustments: toWalletAdjustments(await deps.movements.listByShift(shiftId)),
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
  await recordDecision(deps, actor, shiftId, 'close', 'approved', null)
  return { shift: updated, postings: written.length }
}

// ── Upper-level override: void / force-close a stuck shift (SRS ops escape hatch) ───────────

/**
 * VOID a shift the driver can't finish (`manager_force_cancel`, shift.approve). The float + top-up
 * were disbursed to the driver at open; here they are returned to the office so the ledger nets to
 * zero, the recorded orders are discarded (their fee/split only ever posts at approve-close, so
 * there's nothing to reverse there), and the shift ends `cancelled` — terminal, bike released,
 * never counted. Audited with a reason at the route. For test/abandoned/erroneous shifts.
 */
export async function voidShift(deps: Deps, actor: Actor, shiftId: string, reason: string): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const result = await guard(deps, shift, 'manager_force_cancel', actor)
  if (!result.ok) fail(result)

  const postings: Posting[] = []
  const floatTotal = sum(shift.floatTranches)
  const topupTotal = sum(shift.topupTranches)
  if (floatTotal > minor(0n)) postings.push(floatReturn(shift.driverId, floatTotal))
  if (topupTotal > minor(0n)) postings.push(walletReturn(shift.driverId, topupTotal))
  if (postings.length > 0) {
    const fxDayId = await ensureFxDay(deps, shift.businessDate)
    await deps.ledger.post(shift.branchId, postings, {
      shiftId: shift.id,
      businessDate: shift.businessDate,
      postingDate: todayFor(deps),
      weekStartDate: shift.weekStartDate,
      fxDayId,
      createdBy: actor.userId,
      reason,
    })
  }

  // The movements go with the orders. A voided shift keeping its wallet rows would leave the
  // branch's books carrying adjustments for a shift that is defined never to have counted.
  await deps.movements.deleteByShift(shiftId)
  for (const o of await deps.orders.listByShift(shiftId)) await deps.orders.delete(o.id)

  const updated: ShiftRecord = { ...shift, state: result.next }
  await deps.shifts.update(updated)
  return updated
}

/** Shared with approveClose: the tier-resolved day-level split delta for this shift. */
async function shiftSplitFor(deps: Deps, shift: ShiftRecord, todaysOrders: ShiftOrder[]): Promise<{ driverShare: Minor; companyShare: Minor; yalagoShare: Minor }> {
  const priorShifts = await deps.shifts.listApprovedForDriverOnDate(shift.driverId, shift.businessDate)
  const priorOrders: ShiftOrder[] = []
  for (const prior of priorShifts) {
    if (prior.id === shift.id) continue
    priorOrders.push(...toDomainOrders(await deps.orders.listByShift(prior.id)))
  }
  // Yallago's deliveries alone choose the band and feed the true-up — see approveClose.
  const dayFees = [...priorOrders, ...todaysOrders].filter((o) => o.kind !== 'manual').map((o) => o.fee)
  const vehicle = await deps.directory.vehicle(shift.vehicleId)
  const rule = await resolveTierRule(deps, shift.businessDate, vehicle?.vehicleTypeId ?? null)
  // Read what was paid, do not recompute it — the same reason as approveClose. A force-close on the
  // second shift of a mixed-vehicle day would otherwise mis-pay exactly as a normal close did.
  const alreadyPosted = await postedDayShares(deps, priorShifts.filter((p) => p.id !== shift.id))
  const s = trueUp(dayFees, rule, alreadyPosted)
  // Plus this shift's manual jobs, whose shares were typed and validated against their fees.
  const manual = manualShareTotals(await deps.orders.listByShift(shift.id))
  return {
    driverShare: add(s.driverDelta, manual.driverShare),
    companyShare: add(s.companyDelta, manual.companyShare),
    yalagoShare: s.yalagoDelta,
  }
}

/**
 * FORCE-CLOSE a shift the driver can't finish (`manager_force_close`, shift.approve). It posts the
 * SAME approval postings as a normal close (order splits + the returns that zero the driver funds),
 * but bypasses the BR5/BR1 gate. The admin may supply the end figures he actually knows; the gap
 * between what the driver returned (declared) and what the equation expected lands in a
 * `shift_variance` cost centre so the books reflect reality — a shortfall the driver owes, or a
 * surplus — instead of the close being blocked. State → `approved`. Audited with a reason.
 */
export async function forceClose(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: { odometerKm?: number | null; cashDeclared?: Minor | null; walletDeclared?: Minor | null; reason: string },
): Promise<{ shift: ShiftRecord; postings: number }> {
  const shift = await mustFind(deps, shiftId)
  const result = await guard(deps, shift, 'manager_force_close', actor)
  if (!result.ok) fail(result)

  const orderRows = await deps.orders.listByShift(shiftId)
  const todaysOrders = toDomainOrders(orderRows)
  const shiftInput = {
    driverId: shift.driverId,
    branchId: shift.branchId,
    floatTranches: shift.floatTranches,
    topupTranches: shift.topupTranches,
    orders: todaysOrders,
    // A force-close still posts the wallet the shift actually had; `closingBalances` below reads
    // the same input, so the variance it computes is against the real expectation, not a partial one.
    walletAdjustments: toWalletAdjustments(await deps.movements.listByShift(shiftId)),
  }

  const shiftSplit = await shiftSplitFor(deps, shift, todaysOrders)
  const postings: Posting[] = postingsForApproval(shiftInput, shiftSplit)

  // Variance: postingsForApproval returned the COMPUTED balances to the office. If the admin says
  // the driver actually handed over a different amount, move the difference to the shift_variance
  // cost centre so office_cash/office_wallet reflect what really came in. `null`/omitted ⇒ assume a
  // full, clean return (no variance).
  const expected = closingBalances(shiftInput)
  const cashDeclared = input.cashDeclared ?? shift.endCashDeclared ?? expected.endCash
  const walletDeclared = input.walletDeclared ?? shift.endWalletDeclared ?? expected.endWallet
  const variance = `shift_variance:${shift.branchId}`
  postings.push(...variancePosting('office_cash', variance, expected.endCash - cashDeclared, `fc-cash-${shift.id}`))
  postings.push(...variancePosting('office_wallet', variance, expected.endWallet - walletDeclared, `fc-wallet-${shift.id}`))

  const fxDayId = await ensureFxDay(deps, shift.businessDate)
  const written = await deps.ledger.post(shift.branchId, postings, {
    shiftId: shift.id,
    businessDate: shift.businessDate,
    postingDate: todayFor(deps),
    weekStartDate: shift.weekStartDate,
    fxDayId,
    createdBy: actor.userId,
    reason: input.reason,
  })

  const br1 = await evaluateShift(deps, { ...shift, endCashDeclared: cashDeclared, endWalletDeclared: walletDeclared })
  const updated: ShiftRecord = {
    ...shift,
    state: result.next,
    approvedBy: actor.userId,
    odoEnd: input.odometerKm ?? shift.odoEnd,
    endCashDeclared: cashDeclared,
    endWalletDeclared: walletDeclared,
    equationDiff: br1.result.scalarDiff,
    cashDiff: br1.result.cashDiff,
    walletDiff: br1.result.walletDiff,
    ordersHash: br1.ordersHash,
  }
  await deps.shifts.update(updated)
  await recordDecision(deps, actor, shiftId, 'close', 'approved', input.reason)
  return { shift: updated, postings: written.length }
}

/**
 * One balancing posting moving `delta` between an office fund and the variance cost centre. `delta`
 * is a signed value (`expected − declared`); positive means the office is short that much (a
 * receivable / loss to variance), negative a surplus. Empty when there's no gap.
 */
function variancePosting(office: 'office_cash' | 'office_wallet', costCenterId: string, delta: bigint, occurrenceKey: string): Posting[] {
  if (delta === 0n) return []
  const amount = minor(delta > 0n ? delta : -delta)
  const varFund = { kind: 'cost_center' as const, costCenterId }
  const officeFund = { kind: office } as const
  const lines =
    delta > 0n
      ? [{ fund: varFund, side: 'D' as const, amount }, { fund: officeFund, side: 'C' as const, amount }]
      : [{ fund: officeFund, side: 'D' as const, amount }, { fund: varFund, side: 'C' as const, amount }]
  return [{ eventType: 'manual', occurrenceKey, lines }]
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
