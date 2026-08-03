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
export function ordersHash(orders: readonly ShiftOrderRecord[]): string {
  const canonical = [...orders]
    .sort((a, b) => (a.providerOrderNo < b.providerOrderNo ? -1 : 1))
    // The kind and the typed shares are hashed too: they decide the money as much as the fee does,
    // so a manager must not be able to approve against a split he never reviewed.
    .map((o) => `${o.providerOrderNo}|${o.payMode}|${o.fee}|${o.kind}|${o.driverShare ?? ''}|${o.companyShare ?? ''}`)
    .join(';')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

const toDomainOrders = (rows: readonly ShiftOrderRecord[]): ShiftOrder[] =>
  rows.map((o) => ({ orderNo: o.providerOrderNo, payMode: o.payMode, fee: o.fee, kind: o.kind }))

/** What the manual jobs on one shift pay out, as typed and already validated to equal their fees. */
const manualShareTotals = (rows: readonly ShiftOrderRecord[]): { driverShare: Minor; companyShare: Minor } => {
  const manual = rows.filter((o) => o.kind === 'manual')
  return {
    driverShare: sum(manual.map((o) => o.driverShare ?? minor(0n))),
    companyShare: sum(manual.map((o) => o.companyShare ?? minor(0n))),
  }
}

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
    // What the driver records is always a Yallago delivery — he scans his own «Recent orders» list.
    // A MANUAL job is the branch's, and only a manager may enter one (`addManualOrder`); allowing it
    // here would let a driver write his own share.
    kind: 'yallago',
    driverShare: null,
    companyShare: null,
    notes: null,
    createdBy: actor.userId,
    points: [],
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

  // What the day's earlier shifts were already paid, under the SAME rule — so the true-up is correct
  // for whole AND marginal modes and for a mid-day band crossing. `splitDay` handles both modes.
  const priorYallagoFees = priorOrders.filter((o) => o.kind !== 'manual').map((o) => o.fee)
  const alreadyPosted =
    priorYallagoFees.length > 0
      ? splitDay(priorYallagoFees, rule)
      : { driverShare: minor(0n), companyShare: minor(0n), yalagoShare: minor(0n) }

  const settlement = trueUp(dayFees, rule, {
    driver: alreadyPosted.driverShare,
    company: alreadyPosted.companyShare,
    yalago: alreadyPosted.yalagoShare,
  })

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
  const priorYallagoFees = priorOrders.filter((o) => o.kind !== 'manual').map((o) => o.fee)
  const alreadyPosted =
    priorYallagoFees.length > 0
      ? splitDay(priorYallagoFees, rule)
      : { driverShare: minor(0n), companyShare: minor(0n), yalagoShare: minor(0n) }
  const s = trueUp(dayFees, rule, { driver: alreadyPosted.driverShare, company: alreadyPosted.companyShare, yalago: alreadyPosted.yalagoShare })
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
  const shiftInput = { driverId: shift.driverId, floatTranches: shift.floatTranches, topupTranches: shift.topupTranches, orders: todaysOrders }

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
