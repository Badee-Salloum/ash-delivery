import { createHash } from 'node:crypto'
import type {
  Deps,
  DocumentRecord,
  ShiftOrderRecord,
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
  type ShiftAction,
  type BatteryReading,
  type ShiftOrder,
  type TransitionResult,
  businessDateFor,
  canOpenShift,
  documentStatusOn,
  diagnoseBr1,
  evaluateBr1,
  floatOut,
  minWalletBalance,
  minor,
  postingsForApproval,
  postingsForOpen,
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
  input: { kind: 'float' | 'topup'; amount: Minor },
): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  // Money the driver is out with: only while he is live. Not before open, not after review.
  if (shift.state !== 'open' && shift.state !== 'suspended') {
    throw new ServiceError(409, 'shift_not_open_for_tranche')
  }
  if (input.amount <= minor(0n)) throw new ServiceError(422, 'tranche_amount_must_be_positive')

  const existing = input.kind === 'float' ? shift.floatTranches : shift.topupTranches
  const trancheNo = existing.length + 1
  const posting =
    input.kind === 'float' ? floatOut(shift.driverId, input.amount, trancheNo) : walletTopup(shift.driverId, input.amount, trancheNo)

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

// ── Orders ────────────────────────────────────────────────────────────────────────────────

export async function addOrder(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: { providerOrderNo: string; payMode: ShiftOrder['payMode']; fee: Minor; zone: string | null; source?: 'manual' | 'ocr'; feeOcr?: Minor | null },
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
    source: input.source ?? 'manual',
    feeOcr: input.feeOcr ?? null,
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
  _actor: Actor,
  shiftId: string,
  input: { providerOrderNo: string; payMode: ShiftOrder['payMode']; fee: Minor; zone: string | null },
): Promise<ShiftOrderRecord> {
  const shift = await mustFind(deps, shiftId)
  if (shift.state !== 'open' && shift.state !== 'suspended' && shift.state !== 'pending_review') {
    throw new ServiceError(409, 'shift_not_reconcilable')
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

/**
 * The driver asks a manager to add an order he can no longer add himself (the shift has left the
 * open window). No new entity: it rings the branch bell with the proposed order, and the manager
 * adds it via `addManualOrder` or declines.
 */
export async function requestManualOrder(
  deps: Deps,
  _actor: Actor,
  shiftId: string,
  input: { providerOrderNo: string; payMode: ShiftOrder['payMode']; fee: Minor; zone: string | null },
): Promise<void> {
  const shift = await mustFind(deps, shiftId)
  try {
    await deps.notifications.push({
      recipientId: `branch:${shift.branchId}`,
      branchId: shift.branchId,
      kind: 'manual_order_requested',
      payload: {
        shiftId,
        driverId: shift.driverId,
        providerOrderNo: input.providerOrderNo,
        payMode: input.payMode,
        fee: serializeMoney(input.fee),
        zone: input.zone,
      },
      dedupeKey: `${shiftId}:manual_order_request:${input.providerOrderNo}`,
      readAtMs: null,
      createdAtMs: deps.clock.nowMs(),
    })
  } catch {
    // The bell is a convenience; a failed push must not error the driver's request.
  }
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
  const dayFees = [...priorOrders, ...todaysOrders].map((o) => o.fee)

  // The tier rule that actually governs this shift's pay — resolved by business date and vehicle
  // type (F-3 versioning, F-4 per-type), not a frozen default. `resolveTierRule` falls back to the
  // F-1 table when nothing is published, so a close is never blocked; published/marginal/per-type
  // tables now change real pay instead of being dead config.
  const vehicle = await deps.directory.vehicle(shift.vehicleId)
  const rule = await resolveTierRule(deps, shift.businessDate, vehicle?.vehicleTypeId ?? null)

  // What the day's earlier shifts were already paid, under the SAME rule — so the true-up is correct
  // for whole AND marginal modes and for a mid-day band crossing. `splitDay` handles both modes.
  const alreadyPosted =
    priorOrders.length > 0
      ? splitDay(priorOrders.map((o) => o.fee), rule)
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
  await recordDecision(deps, actor, shiftId, 'close', 'approved', null)
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
