import { createHash } from 'node:crypto'
import type {
  BatteryReadingFields,
  BatteryReadingRecord,
  BatteryRecord,
  BatterySwapRecord,
  CashDeductionRecord,
  NewShiftSettlementRecord,
  OperationWindowStatus,
  ShiftSettlementRecord,
  OperationBatch,
  Deps,
  OrderPointRecord,
  DocumentRecord,
  ShiftOrderRecord,
  ShiftCloseTransactionDeps,
  ShiftDecisionRecord,
  WalletMovementRecord,
  ShiftRecord,
  VehicleEventKind,
  VehicleEventRecord,
} from '@ash/contracts'
import {
  MAX_SHIFTS_PER_DAY,
  classifyOperationWindow as classifyStoredOperationWindow,
  includedByOperationWindow,
  serializeMoney,
} from '@ash/contracts'
import {
  type Actor,
  type Br1Cause,
  type Br1Result,
  type CalendarDate,
  type DocumentStatus,
  type Minor,
  type Posting,
  type FixedShareSettlementPlan,
  type ShiftAction,
  type BatteryReading,
  type ShiftOrder,
  type TransitionResult,
  WALLET_LOG_FEEDS_BR1,
  add,
  businessDateFor,
  bmsSlot,
  can,
  canOpenShift,
  documentStatusOn,
  diagnoseBr1,
  evaluateBr1,
  floatCarry,
  floatOut,
  floatReturn,
  isDateLocked,
  minWalletBalance,
  minor,
  planFixedShareSettlement,
  postingsForCashSettledApproval,
  postingsForOpen,
  reverse,
  walletReturn,
  walletTopup,
  REQUIRED_END_SLOTS,
  resolveFxDay,
  splitFixedDriverShare,
  sum,
  transition,
  weekStartFor,
} from '@ash/domain'
import { fundCodeOf } from '@ash/adapters/memory'
import { grantsFromRows } from './rbac.ts'
import {
  FIXED_SETTLEMENT_DRIVER_BPS,
  FIXED_SETTLEMENT_POLICY,
  fixedSettlementHash,
  varianceDirection,
} from './fixed-settlement.ts'

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
  deductions: readonly CashDeductionRecord[] = [],
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
        `|${o.included ? 1 : 0}|${o.walletAmount ?? ''}|${o.occurredDate ?? ''}|${o.occurredMinute ?? ''}` +
        `|${o.windowStatus}|${o.decisionReason ?? ''}`,
    )
    .join(';')
  // Archive-only payment-log rows do not belong in a financial review fingerprint. If the policy is
  // ever deliberately restored, hashing them here again makes a changed financial input stale the
  // review instead of silently changing what gets posted.
  const movementPart = WALLET_LOG_FEEDS_BR1
    ? [...movements]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((m) => `${m.occurredMinute}|${m.amount}|${m.seq}|${m.role}|${m.orderId ?? ''}|${m.included ? 1 : 0}`)
        .join(';')
    : ''
  const deductionPart = [...deductions]
    .sort((a, b) => (a.operationKey < b.operationKey ? -1 : 1))
    .map(
      (d) =>
        `${d.operationKey}|${d.amount}|${d.occurredDate ?? ''}|${d.occurredMinute ?? ''}` +
        `|${d.windowStatus}|${d.included ? 1 : 0}|${d.decisionReason ?? ''}`,
    )
    .join(';')
  return createHash('sha256').update(`${orderPart}#${movementPart}#${deductionPart}`).digest('hex').slice(0, 32)
}

/** Overlay only database repositories; clocks, crypto, blobs and notifications stay request-scoped. */
const withCloseTransaction = (deps: Deps, transaction: ShiftCloseTransactionDeps): Deps => ({
  ...deps,
  ...transaction,
})

/** A local minute key that sorts lexicographically, derived in the branch's IANA timezone. */
function localMinuteKey(instant: string | null, timeZone: string | undefined, offsetMinutes: number): string | null {
  if (instant === null) return null
  const epochMs = Date.parse(instant)
  if (!Number.isFinite(epochMs)) return null
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(epochMs)
      const value = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
        parts.find((part) => part.type === type)?.value
      const [year, month, day, hour, minute] = [value('year'), value('month'), value('day'), value('hour'), value('minute')]
      if (year && month && day && hour && minute) return `${year}-${month}-${day} ${hour}:${minute}`
    } catch {
      // Invalid legacy timezone data falls back to the injected offset instead of losing rows.
    }
  }
  const local = new Date(epochMs + offsetMinutes * 60_000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
}

/**
 * Classify one screenshot row against [manager-open, close-submission], inclusive at minute
 * precision. Equality is called out for review but included because the source has no seconds.
 */
export const classifyOperationWindow = classifyStoredOperationWindow

const includedByWindow = includedByOperationWindow

async function operationWindowContext(deps: Deps, shift: ShiftRecord): Promise<{
  openApprovedAt: string | null
  submittedAt: string | null
  timeZone?: string
  offsetMinutes: number
}> {
  const branch = await deps.directory.branch(shift.branchId)
  return {
    openApprovedAt: shift.openApprovedAt,
    submittedAt: shift.submittedAt,
    ...(branch?.timezone ? { timeZone: branch.timezone } : {}),
    offsetMinutes: deps.clock.offsetMinutes(),
  }
}

/**
 * The orders that count.
 *
 * An unchecked row stays with the shift and stays visible to everyone, but it is out of the money
 * entirely — BR1, the tier band and the ledger. Filtering HERE, at the single point where records
 * become domain values, is what keeps `packages/domain` from having to learn what "excluded" means
 * and keeps the rule from drifting across the several places that ask for a shift's orders.
 */
const hasAuditedWindowDecision = (row: {
  decisionReason: string | null
  decidedBy: string | null
  decidedAt: string | null
}): boolean =>
  row.decidedBy !== null && row.decidedAt !== null && Boolean(row.decisionReason?.trim())

/**
 * `included=true` is not enough for an unknown-time legacy row. Older API/database versions wrote
 * that combination automatically, so the money boundary also requires the attributed manager
 * reason that resolves the uncertainty. This keeps BR1 and settlement safe even before the first
 * compatibility reclassification runs.
 */
const operationCounts = (row: {
  included: boolean
  windowStatus: OperationWindowStatus
  decisionReason: string | null
  decidedBy: string | null
  decidedAt: string | null
}): boolean =>
  row.included && (row.windowStatus !== 'unknown' || hasAuditedWindowDecision(row))

/** Preserve an audited manager choice; otherwise derive inclusion only from verified timing. */
const persistedOperationInclusion = (row: {
  included: boolean
  windowStatus: OperationWindowStatus
  decisionReason: string | null
  decidedBy: string | null
  decidedAt: string | null
}): boolean =>
  hasAuditedWindowDecision(row) ? row.included : includedByWindow(row.windowStatus)

export const includedOrders = (rows: readonly ShiftOrderRecord[]): ShiftOrderRecord[] =>
  rows.filter(operationCounts)

const toDomainOrders = (rows: readonly ShiftOrderRecord[]): ShiftOrder[] =>
  includedOrders(rows).map((o) => ({
    orderNo: o.providerOrderNo,
    payMode: o.payMode,
    fee: o.fee,
    kind: o.kind,
    ...(o.driverShare === null ? {} : { driverShare: o.driverShare }),
    ...(o.companyShare === null ? {} : { companyShare: o.companyShare }),
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
  // No `shiftNo`: the wire still carries one for older bundles, and this function never reads it.
  input: { driverId: string; vehicleId: string },
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

  /*
   * THE SHIFT NUMBER IS THE SERVER'S TO GIVE, never the client's to choose.
   *
   * `shifts_no_uq` is UNIQUE (driver_id, business_date, shift_no) and the driver's app hard-coded
   * `shiftNo: 1`. Every gate above passes for a driver whose first shift of the day is `cancelled`
   * or `approved` — `canOpenShift` only asks about LIVE shifts — and then the INSERT hit the
   * constraint and became a bare 500 on the one screen a driver cannot get past. Measured in
   * production 2026-08-12. `input.shiftNo` is still accepted on the wire so older bundles and the
   * test suite keep working, and it is deliberately ignored: a client cannot know what is taken.
   */
  const shiftNo = await deps.shifts.nextShiftNo(driver.id, businessDate)
  if (shiftNo > MAX_SHIFTS_PER_DAY) {
    throw new ServiceError(409, 'too_many_shifts_today', { max: MAX_SHIFTS_PER_DAY })
  }

  // SRS B-3: the manager binds the bike to the driver in advance. Two rules, both enforced here
  // rather than only in the UI:
  //   • if this driver HAS an assignment for the slot, he may only start that bike;
  //   • a bike assigned to somebody else is off limits even to an unassigned driver.
  // Where no assignment exists at all the old free choice stands, so a branch that has not
  // started assigning is not locked out of its own shifts.
  const dayAssignments = await deps.assignments.listByDate(driver.branchId, businessDate)
  const slot = dayAssignments.filter((a) => a.shiftNo === shiftNo)
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
    shiftNo,
    businessDate,
    weekStartDate: weekStartFor(businessDate),
    state: 'draft',
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
  }
  try {
    await deps.shifts.create(shift, actor.userId)
  } catch (err) {
    // Two starts racing on the same driver: `nextShiftNo` handed both the same number. A 409 tells
    // the app to try again; the 500 it used to be told the driver nothing at all.
    if ((err as { code?: string }).code === 'DUPLICATE_SHIFT_NO') {
      throw new ServiceError(409, 'shift_no_taken')
    }
    throw err
  }
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
export async function cancelShift(deps: Deps, shiftId: string, actorId: string | null): Promise<ShiftRecord> {
  return deps.closeUnitOfWork.run(
    { shiftId, actorId },
    async (transaction) => cancelShiftLocked(withCloseTransaction(deps, transaction), shiftId, actorId),
  )
}

async function cancelShiftLocked(deps: Deps, shiftId: string, actorId: string | null): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  if (shift.state !== 'draft' && shift.state !== 'awaiting_open_approval') {
    throw new ServiceError(409, 'shift_already_opened', { state: shift.state })
  }
  await deps.shifts.delete(shift.id, actorId)
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
  const [rows, attached] = await Promise.all([
    deps.batteryReadings.listByShift(shift.id),
    deps.media.listSlots(shift.id),
  ])
  const forPackage = rows.filter((r) => r.package === pkg)
  return {
    batterySlots: fitted.length,
    batteryReadings: fitted.map((battery, i) => {
      const row = forPackage.find((r) => r.batteryId === battery.id)
      const currentMediaId = attached.find(
        (slot) => slot.package === pkg && slot.slot === bmsSlot(battery.slotNo ?? i + 1),
      )?.mediaId ?? null
      // A replacement photo invalidates the old machine reading until the new file has been read.
      // The explicit "app unavailable" path is the exception: it intentionally has no driver image
      // and waits for the manager's reading at the gate.
      const evidenceMatches =
        row?.unavailable === true ||
        (row?.mediaId !== null && row?.mediaId !== undefined && row.mediaId === currentMediaId)
      return {
        slotNo: battery.slotNo ?? i + 1,
        percent: evidenceMatches ? (row?.percent ?? null) : null,
        // The driver's «التطبيق لا يعمل على جهازي». Carried into the gate so it can tell a pack
        // nobody has done yet from one he has told us he CANNOT do — the first is his to close,
        // the second is the manager's.
        unavailable: evidenceMatches && row?.unavailable === true,
      }
    }),
  }
}

// ── The OPEN gate (BR5) ───────────────────────────────────────────────────────────────────

const EVIDENCE_STALE_MS = 30 * 60_000

/** Stale or reused evidence is allowed only after an explicit driver acknowledgement. */
async function unacknowledgedEvidenceWarnings(
  deps: Deps,
  shiftId: string,
  pkg: 'start' | 'end',
): Promise<string[]> {
  const warnings: string[] = []
  for (const slot of (await deps.media.listSlots(shiftId)).filter((s) => s.package === pkg)) {
    if (slot.staleAcknowledgedAtMs !== null) continue
    const media = await deps.media.findById(slot.mediaId)
    const stale = media?.clientTakenAtMs != null && slot.attachedAtMs - media.clientTakenAtMs >= EVIDENCE_STALE_MS
    if (stale || slot.reusedFromShiftId !== null) warnings.push(slot.slot)
  }
  return warnings
}

type SubmitStartPackageInput = {
  odometerKm: number
  batteryPercent: number | null
  odometerKmOcr?: number | null
  batteryPercentOcr?: number | null
  /** The dashboard as the reader saw it — training material, never evidence. */
  odometerStrip?: string | null
}

export async function submitStartPackage(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: SubmitStartPackageInput,
): Promise<ShiftRecord> {
  const updated = await deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) =>
      submitStartPackageLocked(withCloseTransaction(deps, transaction), actor, shiftId, input),
  )
  // Research samples and notifications are deliberately outside the transaction: they are
  // best-effort side effects and must never make a committed state transition look failed.
  await keepShiftOcrSample(deps, updated.id, 'start', 'odometer', input.odometerStrip, input.odometerKmOcr)
  await notifyBranch(deps, updated, 'shift_awaiting_open_approval')
  return updated
}

async function submitStartPackageLocked(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: SubmitStartPackageInput,
): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const evidenceWarnings = await unacknowledgedEvidenceWarnings(deps, shiftId, 'start')
  if (evidenceWarnings.length > 0) {
    throw new ServiceError(422, 'stale_evidence_confirmation_required', {
      package: 'start',
      slots: evidenceWarnings,
    })
  }
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
  await deps.shifts.update(updated, actor.userId)
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

type ApproveOpenInput = { floatTranches: Minor[]; topupTranches: Minor[]; carriedTranches?: Minor[] }

export async function approveOpen(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: ApproveOpenInput,
): Promise<ShiftRecord> {
  return deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => approveOpenLocked(withCloseTransaction(deps, transaction), actor, shiftId, input),
  )
}

async function approveOpenLocked(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: ApproveOpenInput,
): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)

  const evidenceWarnings = await unacknowledgedEvidenceWarnings(deps, shiftId, 'start')
  if (evidenceWarnings.length > 0) {
    throw new ServiceError(422, 'stale_evidence_confirmation_required', {
      package: 'start',
      slots: evidenceWarnings,
    })
  }

  /*
   * ── «الذمة المرحّلة» — cash he ALREADY has, consumed here (owner decision c) ────────────────
   *
   * «should be handled when he starts a new shift». It may not exceed what he actually owes: the
   * receivable fund is the record, and carrying more than it holds would credit it below zero and
   * hand the driver money the office never gave him. Refused rather than clamped — a manager who
   * typed the wrong figure should be told, not quietly corrected.
   */
  const carried = input.carriedTranches ?? []
  const carriedTotal = sum(carried)
  if (carriedTotal > 0n) {
    const owed = await deps.ledger.fundBalance(shift.branchId, `driver_receivable_cash:${shift.driverId}`)
    if (carriedTotal > owed) {
      throw new ServiceError(422, 'carry_exceeds_receivable', {
        owed: serializeMoney(owed),
        asked: serializeMoney(carriedTotal),
      })
    }
  }

  // The manager records the float + top-up here (the driver no longer types them). They are the
  // branch's money, disbursed by the manager, so they become part of the shift at approval time.
  const withFunds: ShiftRecord = {
    ...shift,
    floatTranches: input.floatTranches,
    topupTranches: input.topupTranches,
    carriedTranches: carried,
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
      // Clears the receivable and raises his cash, WITHOUT the branch box paying again — it paid
      // yesterday, which is exactly what the ذمة recorded.
      carriedTranches: withFunds.carriedTranches,
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

  const openApprovedAt = new Date(deps.clock.nowMs()).toISOString()
  const updated: ShiftRecord = {
    ...withFunds,
    state: result.next,
    openApprovedAt,
    openApprovedBy: actor.userId,
  }
  await deps.shifts.update(updated, actor.userId)
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
  decision: 'approved' | 'rejected' | 'rephoto_requested' | 'force_close_prepared',
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
  const updated = await deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => requestRephotoLocked(withCloseTransaction(deps, transaction), actor, shiftId, notes),
  )
  await notifyDriver(deps, updated, 'shift_rephoto_requested', notes)
  return updated
}

/** Return the force preparation that belongs to this exact submitted close attempt, if any. */
async function activeForcePreparation(
  deps: Deps,
  shift: ShiftRecord,
): Promise<ShiftDecisionRecord | null> {
  if (shift.submittedAt === null) return null
  const submittedAtMs = Date.parse(shift.submittedAt)
  if (!Number.isFinite(submittedAtMs)) return null
  const latest = (await deps.decisions.listByShift(shift.id)).find(
    (decision) => decision.gate === 'close' && decision.decidedAtMs >= submittedAtMs,
  )
  return latest?.decision === 'force_close_prepared' ? latest : null
}

async function requestRephotoLocked(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  notes: string | null,
): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const gate = shift.state === 'pending_review' ? 'close' : 'open'
  const result = await guard(deps, shift, 'manager_request_rephoto', actor)
  if (!result.ok) fail(result)
  const updated: ShiftRecord = {
    ...shift,
    state: result.next,
    ...(gate === 'close' ? { submittedAt: null } : {}),
  }
  await deps.shifts.update(updated, actor.userId)
  await recordDecision(deps, actor, shiftId, gate, 'rephoto_requested', notes)
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
  const updated = await deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => rejectOpenLocked(withCloseTransaction(deps, transaction), actor, shiftId, notes),
  )
  await notifyDriver(deps, updated, 'shift_open_rejected', notes)
  return updated
}

async function rejectOpenLocked(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  notes: string | null,
): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const result = await guard(deps, shift, 'manager_reject_open', actor)
  if (!result.ok) fail(result)
  const updated: ShiftRecord = { ...shift, state: result.next }
  await deps.shifts.update(updated, actor.userId)
  await recordDecision(deps, actor, shiftId, 'open', 'rejected', notes)
  return updated
}

/** The manager rejects a close: the shift returns to `open` so the driver can correct and resubmit. */
export async function rejectClose(deps: Deps, actor: Actor, shiftId: string, notes: string | null): Promise<ShiftRecord> {
  const updated = await deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => rejectCloseLocked(withCloseTransaction(deps, transaction), actor, shiftId, notes),
  )
  await notifyDriver(deps, updated, 'shift_close_rejected', notes)
  return updated
}

async function rejectCloseLocked(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  notes: string | null,
): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const result = await guard(deps, shift, 'manager_reject_close', actor)
  if (!result.ok) fail(result)
  const updated: ShiftRecord = { ...shift, state: result.next, submittedAt: null }
  await deps.shifts.update(updated, actor.userId)
  await recordDecision(deps, actor, shiftId, 'close', 'rejected', notes)
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
  const updated = await deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => suspendShiftLocked(withCloseTransaction(deps, transaction), actor, shiftId),
  )
  await notifyDriver(deps, updated, 'shift_suspended', notes)
  return updated
}

async function suspendShiftLocked(deps: Deps, actor: Actor, shiftId: string): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  // Suspension is a mid-shift incident, never a shortcut from draft/approval/review into `open`.
  if (shift.state !== 'open') throw new ServiceError(409, 'shift_not_operational', { state: shift.state })
  const result = await guard(deps, shift, 'suspend', actor)
  if (!result.ok) fail(result)
  const updated: ShiftRecord = { ...shift, state: result.next }
  await deps.shifts.update(updated, actor.userId)
  return updated
}

/** The driver resumes a suspended shift back to `open` when the incident clears (`shift.operate`). */
export async function resumeShift(deps: Deps, actor: Actor, shiftId: string): Promise<ShiftRecord> {
  return deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => resumeShiftLocked(withCloseTransaction(deps, transaction), actor, shiftId),
  )
}

async function resumeShiftLocked(deps: Deps, actor: Actor, shiftId: string): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const result = await guard(deps, shift, 'resume', actor)
  if (!result.ok) fail(result)
  const updated: ShiftRecord = { ...shift, state: result.next }
  await deps.shifts.update(updated, actor.userId)
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
  return deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => addTrancheLocked(withCloseTransaction(deps, transaction), actor, shiftId, input),
  )
}

async function addTrancheLocked(
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
  await deps.shifts.update(updated, actor.userId)
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
  input: Parameters<typeof swapBatteryLocked>[3],
): Promise<{ swap: BatterySwapRecord; readings: BatteryReadingRecord[]; fitted: BatteryRecord[] }> {
  return deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => swapBatteryLocked(withCloseTransaction(deps, transaction), actor, shiftId, input),
  )
}

async function swapBatteryLocked(
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
    // A swap is done at the branch with the manager present, so the declaration never applies here.
    unavailable: false,
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

type LegacyOrderWriteResult =
  | ShiftOrderRecord
  | (CashDeductionRecord & { providerOrderNo: string })

const legacyDeductionKey = (providerOrderNo: string): string => `legacy:${providerOrderNo}`

const isAutomaticCashDeductionKey = (operationKey: string): boolean =>
  operationKey.startsWith('recent-orders:') || operationKey.startsWith('legacy:')

const providerNoFromLegacyDeductionKey = (operationKey: string): string | null => {
  if (!operationKey.startsWith('legacy:')) return null
  const providerOrderNo = operationKey.slice('legacy:'.length)
  return providerOrderNo.length === 0 ? null : providerOrderNo
}

const hasOperationDecision = (row: { decidedBy: string | null; decidedAt: string | null }): boolean =>
  row.decidedBy !== null || row.decidedAt !== null

const hasAuthoritativeOrderKind = (order: ShiftOrderRecord): boolean =>
  order.kind === 'manual' || hasOperationDecision(order)

/**
 * An order that changes sign stops being an order. Any wallet-log rows previously matched to it
 * cannot keep a dangling financial role; retain them as excluded evidence for manager review.
 */
async function removeOrderForLegacyDeduction(
  deps: Deps,
  order: ShiftOrderRecord,
  actorId: string,
): Promise<void> {
  for (const movement of await deps.movements.listByShift(order.shiftId)) {
    if (movement.orderId !== order.id) continue
    await deps.movements.update(
      movement.id,
      { role: 'unmatched', orderId: null, included: false, ambiguous: true },
      actorId,
    )
  }
  await deps.orders.delete(order.id, actorId)
}

export async function addOrder(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: Parameters<typeof addOrderLocked>[3],
): Promise<LegacyOrderWriteResult> {
  const written = await deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => addOrderLocked(withCloseTransaction(deps, transaction), actor, shiftId, input),
  )
  // The strip is optional training material. Keep image decoding/storage outside the state lock,
  // so a failed sample cannot delay or undo a committed order.
  if (input.fee >= 0n && !('operationKey' in written)) await keepOcrSample(deps, written.id, input)
  return written
}

async function addOrderLocked(
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
): Promise<LegacyOrderWriteResult> {
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

  const windowContext = await operationWindowContext(deps, shift)
  const currentLocalMinute = localMinuteKey(
    new Date(deps.clock.nowMs()).toISOString(),
    windowContext.timeZone,
    windowContext.offsetMinutes,
  )!
  const occurredMinute = input.occurredMinute ?? currentLocalMinute.slice(-5)
  const occurredDate = currentLocalMinute.slice(0, 10) as CalendarDate
  const windowStatus = classifyOperationWindow({ occurredDate, occurredMinute, ...windowContext })

  const operationKey = legacyDeductionKey(input.providerOrderNo)
  const [existingOrder, existingDeduction] = await Promise.all([
    deps.orders.listByShift(shiftId).then((rows) => rows.find((row) => row.providerOrderNo === input.providerOrderNo) ?? null),
    deps.cashDeductions.findByOperationKey(shiftId, operationKey),
  ])
  if (
    existingOrder &&
    existingDeduction &&
    hasAuthoritativeOrderKind(existingOrder) &&
    hasOperationDecision(existingDeduction)
  ) {
    throw new ServiceError(409, 'operation_kind_conflict_requires_manager', {
      providerOrderNo: input.providerOrderNo,
    })
  }

  if (input.fee < 0n) {
    // A manager-reviewed order is authoritative over a stale cached negative scan. Clean up only
    // an undecided duplicate deduction; never delete or rewrite the manager's decision.
    if (existingOrder && hasAuthoritativeOrderKind(existingOrder)) {
      if (existingDeduction) await deps.cashDeductions.delete(existingDeduction.id, actor.userId)
      return existingOrder
    }
    if (existingOrder) await removeOrderForLegacyDeduction(deps, existingOrder, actor.userId)

    const current = existingDeduction
    // A cached legacy client cannot undo a manager's attributed amount/window decision.
    if (current && hasOperationDecision(current)) {
      return { ...current, providerOrderNo: input.providerOrderNo }
    }
    const deduction: CashDeductionRecord = {
      id: current?.id ?? deps.ids.uuid(),
      shiftId,
      operationKey,
      amount: minor(-input.fee),
      // The first persisted printed time is evidence. A cached driver retry may enrich amount/OCR
      // fields, but correcting which minute/day the operation belongs to is a manager decision.
      occurredDate: current ? current.occurredDate : existingOrder ? existingOrder.occurredDate : occurredDate,
      occurredMinute: current ? current.occurredMinute : existingOrder ? existingOrder.occurredMinute : occurredMinute,
      source: storedSource(input.source),
      amountOcr: input.feeOcr === null || input.feeOcr === undefined
        ? null
        : minor(input.feeOcr < 0n ? -input.feeOcr : input.feeOcr),
      pointA: null,
      pointB: null,
      included: current
        ? persistedOperationInclusion(current)
        : existingOrder
          ? persistedOperationInclusion(existingOrder)
          : includedByWindow(windowStatus),
      windowStatus: current?.windowStatus ?? existingOrder?.windowStatus ?? windowStatus,
      decisionReason: current?.decisionReason ?? null,
      decidedBy: current?.decidedBy ?? null,
      decidedAt: current?.decidedAt ?? null,
      createdBy: current ? current.createdBy : existingOrder ? existingOrder.createdBy : actor.userId,
    }
    if (current) await deps.cashDeductions.update(deduction, actor.userId)
    else await deps.cashDeductions.create(deduction, actor.userId)
    return { ...deduction, providerOrderNo: input.providerOrderNo }
  }

  // The inverse sign correction is equally exclusive. A reviewed deduction wins over a cached
  // positive row; an undecided deduction is removed in the same shift transaction as the order.
  if (existingDeduction && hasOperationDecision(existingDeduction)) {
    if (existingOrder) await removeOrderForLegacyDeduction(deps, existingOrder, actor.userId)
    return { ...existingDeduction, providerOrderNo: input.providerOrderNo }
  }
  if (existingDeduction) {
    await deps.cashDeductions.delete(existingDeduction.id, actor.userId)
    // Heal an historical double without turning an otherwise idempotent sign correction into a
    // duplicate-order error. Ordinary same-kind duplicate POSTs retain their old 409 behaviour.
    if (existingOrder) return existingOrder
  }

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
    createdBy: existingDeduction ? existingDeduction.createdBy : actor.userId,
    points: [],
    included: existingDeduction
      ? persistedOperationInclusion(existingDeduction)
      : includedByWindow(windowStatus),
    walletAmount: input.walletAmount ?? null,
    occurredMinute: existingDeduction ? existingDeduction.occurredMinute : occurredMinute,
    occurredDate: existingDeduction ? existingDeduction.occurredDate : occurredDate,
    windowStatus: existingDeduction?.windowStatus ?? windowStatus,
    decisionReason: null,
    decidedBy: null,
    decidedAt: null,
  }
  try {
    await deps.orders.create(order, actor.userId)
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
  input: Parameters<typeof addManualOrderLocked>[3],
): Promise<ShiftOrderRecord> {
  return deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => addManualOrderLocked(withCloseTransaction(deps, transaction), actor, shiftId, input),
  )
}

async function addManualOrderLocked(
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
    windowStatus: 'in_window',
    decisionReason: 'manager_manual_entry',
    decidedBy: actor.userId,
    decidedAt: new Date(deps.clock.nowMs()).toISOString(),
  }
  try {
    await deps.orders.create(order, actor.userId)
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
  cashDeductionTotal: Minor
}

export async function evaluateShift(deps: Deps, shift: ShiftRecord): Promise<Br1View> {
  const orderRows = await deps.orders.listByShift(shift.id)
  const movementRows = await deps.movements.listByShift(shift.id)
  const deductionRows = await deps.cashDeductions.listByShift(shift.id)
  const orders = toDomainOrders(orderRows)
  const walletAdjustments = toWalletAdjustments(movementRows)
  const cashDeductions = deductionRows.filter(operationCounts).map((d) => d.amount)
  const result = evaluateBr1({
    // A carried ذمة is cash he was ALREADY holding at open, so it is part of the float for the
    // equation exactly as it is for `closingBalances`. These two sums must never drift — the
    // ledger would otherwise return a different amount from the one BR1 just balanced.
    floatTotal: add(sum(shift.floatTranches), sum(shift.carriedTranches)),
    topupTotal: sum(shift.topupTranches),
    endCashDeclared: shift.endCashDeclared ?? minor(0n),
    endWalletDeclared: shift.endWalletDeclared ?? minor(0n),
    orders,
    walletAdjustments,
    cashDeductions,
  })
  return {
    result,
    causes: diagnoseBr1(
      result,
      orders,
      'floor',
      // A credit still flagged ambiguous is the likeliest single explanation for a difference, and
      // the only one a manager can settle with one tap.
      WALLET_LOG_FEEDS_BR1
        ? movementRows.filter((m) => m.ambiguous && m.included).map((m) => m.amount)
        : [],
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
    ordersHash: ordersHash(orderRows, movementRows, deductionRows),
    cashDeductionTotal: sum(cashDeductions),
  }
}

// ── The CLOSE gate (BR5) ──────────────────────────────────────────────────────────────────

/** Recompute every OCR-derived operation when either edge of the window becomes known. */
async function reclassifyShiftOperations(deps: Deps, shift: ShiftRecord, actorId: string): Promise<void> {
  await deps.operationWindows.reclassify(shift.id, actorId)
}

/**
 * DB-first rollout healing: an old API can submit the close after 0028 has stamped submittedAt but
 * before it knows how to classify operation rows. The first new manager review repairs every
 * deterministic row inside the same locked snapshot. Illegible dates/minutes remain unknown.
 */
export async function prepareShiftReview(deps: Deps, shift: ShiftRecord, actorId: string): Promise<void> {
  if (shift.state !== 'pending_review' || shift.submittedAt === null) return
  await healPendingCashDeductionDuplicates(deps, shift, actorId)
  await reclassifyShiftOperations(deps, shift, actorId)
}

/**
 * Heal duplicate OCR sightings that were already persisted by an older/cached driver bundle.
 *
 * The owner-defined identity is printed date (when known) + minute + untouched OCR amount. Route
 * text is evidence only. We touch only rows created by this shift's driver, never a manual/edit,
 * foreign row or manager decision. Choosing a known-date survivor avoids inventing a window edge;
 * reclassification runs immediately afterwards under the same locked close transaction.
 */
async function healPendingCashDeductionDuplicates(
  deps: Deps,
  shift: ShiftRecord,
  actorId: string,
): Promise<void> {
  const driver = await deps.directory.driver(shift.driverId)
  if (!driver?.userId) return
  const rows = await deps.cashDeductions.listByShift(shift.id)
  const eligible = (row: CashDeductionRecord): boolean =>
    row.createdBy === driver.userId &&
    row.source === 'ocr' &&
    row.amountOcr !== null &&
    row.amount === row.amountOcr &&
    row.decisionReason === null &&
    !hasOperationDecision(row) &&
    isAutomaticCashDeductionKey(row.operationKey)

  const survivors: CashDeductionRecord[] = []
  for (const row of rows) {
    if (!eligible(row)) {
      survivors.push(row)
      continue
    }
    const matchIndex = survivors.findIndex(
      (candidate) => eligible(candidate) && isTimedCashDeductionDuplicate(candidate, row),
    )
    if (matchIndex === -1) {
      survivors.push(row)
      continue
    }

    const candidate = survivors[matchIndex]!
    const candidateHasDate = cleanDeductionEvidence(candidate.occurredDate) !== ''
    const rowHasDate = cleanDeductionEvidence(row.occurredDate) !== ''
    let keep = candidate
    let remove = row
    if (candidateHasDate !== rowHasDate) {
      keep = candidateHasDate ? candidate : row
      remove = candidateHasDate ? row : candidate
    } else {
      const family = cashDeductionKeyBase(candidate.operationKey) === cashDeductionKeyBase(row.operationKey)
      const candidateBase = candidate.operationKey === cashDeductionKeyBase(candidate.operationKey)
      const rowBase = row.operationKey === cashDeductionKeyBase(row.operationKey)
      if (family && candidateBase !== rowBase && rowBase) {
        keep = row
        remove = candidate
      }
    }

    const richer = cashDeductionRouteEvidenceCount(remove) > cashDeductionRouteEvidenceCount(keep)
      ? remove
      : keep
    const merged = richer === keep
      ? keep
      : { ...keep, pointA: richer.pointA, pointB: richer.pointB }
    if (merged !== keep) await deps.cashDeductions.update(merged, actorId)
    await deps.cashDeductions.delete(remove.id, actorId)
    survivors[matchIndex] = merged
  }
}

async function unresolvedWindowRows(deps: Deps, shiftId: string): Promise<{ orders: string[]; deductions: string[] }> {
  const [orders, deductions] = await Promise.all([
    deps.orders.listByShift(shiftId),
    deps.cashDeductions.listByShift(shiftId),
  ])
  return {
    orders: orders
      // A value-only manager correction also versions the row with `decidedBy/decidedAt`, so that
      // a cached driver submission cannot put the old money back. That is NOT a decision about an
      // unreadable timestamp. Only an attributed decision carrying the required reason resolves an
      // unknown operation window.
      .filter(
        (o) =>
          o.kind !== 'manual' &&
          o.windowStatus === 'unknown' &&
          !hasAuditedWindowDecision(o),
      )
      .map((o) => o.providerOrderNo),
    deductions: deductions
      .filter((d) => d.windowStatus === 'unknown' && !hasAuditedWindowDecision(d))
      .map((d) => d.id),
  }
}

interface EndPackageInput {
  odometerKm: number
  batteryPercent: number | null
  cashDeclared: Minor
  walletDeclared: Minor
  odometerKmOcr?: number | null
  odometerAnomalyConfirmed?: boolean
  walletDeclaredOcr?: Minor | null
  odometerStrip?: string | null
  walletStrip?: string | null
}

export async function submitEndPackage(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: EndPackageInput,
): Promise<{ shift: ShiftRecord; br1: Br1View }> {
  const committed = await deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => submitEndPackageLocked(withCloseTransaction(deps, transaction), actor, shiftId, input),
  )

  // Research samples and notifications are deliberately outside the money/state transaction. A
  // slow optional path must not hold the shift row, and both operations are safe to retry.
  await keepShiftOcrSample(deps, committed.shift.id, 'end', 'odometer', input.odometerStrip, input.odometerKmOcr)
  await keepShiftOcrSample(
    deps,
    committed.shift.id,
    'end',
    'wallet',
    input.walletStrip,
    input.walletDeclaredOcr === null || input.walletDeclaredOcr === undefined ? null : String(input.walletDeclaredOcr),
  )
  await notifyBranch(deps, committed.shift, 'shift_awaiting_close_approval')
  return committed
}

async function submitEndPackageLocked(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: EndPackageInput,
): Promise<{ shift: ShiftRecord; br1: Br1View }> {
  const shift = await mustFind(deps, shiftId)
  const orderRows = await deps.orders.listByShift(shiftId)

  const evidenceWarnings = await unacknowledgedEvidenceWarnings(deps, shiftId, 'end')
  if (evidenceWarnings.length > 0) {
    throw new ServiceError(422, 'stale_evidence_confirmation_required', {
      package: 'end',
      slots: evidenceWarnings,
    })
  }

  if (shift.odoStart !== null && input.odometerKm < shift.odoStart && !input.odometerAnomalyConfirmed) {
    throw new ServiceError(422, 'odometer_anomaly_confirmation_required', {
      start: shift.odoStart,
      end: input.odometerKm,
    })
  }

  const submittedAt = new Date(deps.clock.nowMs()).toISOString()

  const staged: ShiftRecord = {
    ...shift,
    odoEnd: input.odometerKm,
    odoEndOcr: input.odometerKmOcr ?? null,
    odoEndAnomalyConfirmedAt:
      shift.odoStart !== null && input.odometerKm < shift.odoStart && input.odometerAnomalyConfirmed
        ? submittedAt
        : null,
    odoEndAnomalyConfirmedBy:
      shift.odoStart !== null && input.odometerKm < shift.odoStart && input.odometerAnomalyConfirmed
        ? actor.userId
        : null,
    batteryEnd: input.batteryPercent,
    endCashDeclared: input.cashDeclared,
    endWalletDeclared: input.walletDeclared,
    // SRS D-3: the wallet OCR baseline (readWallet); evidence, not a BR1 input.
    endWalletDeclaredOcr: input.walletDeclaredOcr ?? null,
    submittedAt,
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

  // Claim the close boundary BEFORE reading/classifying operations. PgOperationBatchRepo locks the
  // same shift row and accepts only open/suspended rows with no submittedAt, so concurrent paths
  // serialize: a batch that wins is visible below; a batch that loses is rejected as too late.
  const claimed: ShiftRecord = { ...staged, state: result.next }
  await deps.shifts.update(claimed, actor.userId)
  await reclassifyShiftOperations(deps, claimed, actor.userId)
  const br1 = await evaluateShift(deps, claimed)
  const updated: ShiftRecord = {
    ...claimed,
    equationDiff: br1.result.scalarDiff,
    cashDiff: br1.result.cashDiff,
    walletDiff: br1.result.walletDiff,
    ordersHash: br1.ordersHash,
  }
  await deps.shifts.update(updated, actor.userId)
  // Both closing readers, with what each made of the picture it was handed. The driver's confirmed
  // figures become the ground truth at export — joined from the shift, never copied here.
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
  input: Parameters<typeof reviseCloseFiguresLocked>[3],
): Promise<{ shift: ShiftRecord; br1: Br1View; before: ShiftRecord }> {
  return deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => reviseCloseFiguresLocked(withCloseTransaction(deps, transaction), actor, shiftId, input),
  )
}

async function reviseCloseFiguresLocked(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: {
    odometerKm?: number | null
    odometerAnomalyConfirmed?: boolean
    cashDeclared?: Minor | null
    walletDeclared?: Minor | null
  },
): Promise<{ shift: ShiftRecord; br1: Br1View; before: ShiftRecord }> {
  const shift = await mustFind(deps, shiftId)
  if (shift.state !== 'pending_review') throw new ServiceError(409, 'shift_not_under_review')
  if (await activeForcePreparation(deps, shift)) {
    throw new ServiceError(409, 'force_close_figures_locked')
  }

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

  const changesOdometer = input.odometerKm !== undefined && input.odometerKm !== null
  const anomalousOdometer = changesOdometer && shift.odoStart !== null && input.odometerKm! < shift.odoStart
  if (anomalousOdometer && !input.odometerAnomalyConfirmed) {
    throw new ServiceError(422, 'odometer_anomaly_confirmation_required', {
      start: shift.odoStart,
      end: input.odometerKm,
    })
  }
  const anomalyConfirmedAt = new Date(deps.clock.nowMs()).toISOString()

  const staged: ShiftRecord = {
    ...shift,
    ...(input.odometerKm === undefined || input.odometerKm === null ? {} : { odoEnd: input.odometerKm }),
    ...(changesOdometer
      ? {
          odoEndAnomalyConfirmedAt: anomalousOdometer ? anomalyConfirmedAt : null,
          odoEndAnomalyConfirmedBy: anomalousOdometer ? actor.userId : null,
        }
      : {}),
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
  await deps.shifts.update(updated, actor.userId)
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
  cashDeductions?: readonly {
    operationKey: string
    amount: Minor
    occurredMinute?: string | null
    occurredDate?: string | null
    source?: 'manual' | 'ocr' | 'refused'
    amountOcr?: Minor | null
    amountStrip?: string | null
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

type SubmittedCashDeduction = NonNullable<OperationsInput['cashDeductions']>[number]

const cleanDeductionEvidence = (value: string | null | undefined): string =>
  (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

const cashDeductionKeyBase = (operationKey: string): string => operationKey.replace(/~\d+$/, '')

type CashDeductionMatchEvidence = {
  operationKey: string
  amount: Minor
  amountOcr?: Minor | null
  occurredMinute?: string | null
  occurredDate?: string | null
  pointA?: string | null
  pointB?: string | null
}

const cashDeductionRouteEvidenceCount = (
  row: Pick<CashDeductionMatchEvidence, 'pointA' | 'pointB'>,
): number => [row.pointA, row.pointB].filter((part) => cleanDeductionEvidence(part) !== '').length

/**
 * Recent Orders OCR identifies a deduction by its OCR magnitude and printed minute. Route OCR is
 * review evidence only and can disagree completely between overlapping screenshots. Two known,
 * different dates remain distinct; a missing date can be healed from the other sighting.
 */
const hasSameCashDeductionOcrTiming = (
  left: CashDeductionMatchEvidence,
  right: CashDeductionMatchEvidence,
): boolean => {
  if (
    left.amount !== right.amount ||
    left.amountOcr === null || left.amountOcr === undefined ||
    right.amountOcr === null || right.amountOcr === undefined ||
    left.amountOcr !== right.amountOcr ||
    typeof left.occurredMinute !== 'string' ||
    left.occurredMinute.trim() === '' ||
    typeof right.occurredMinute !== 'string' ||
    right.occurredMinute.trim() === '' ||
    cleanDeductionEvidence(left.occurredMinute) !== cleanDeductionEvidence(right.occurredMinute)
  ) return false

  const leftDate = cleanDeductionEvidence(left.occurredDate)
  const rightDate = cleanDeductionEvidence(right.occurredDate)
  return leftDate === '' || rightDate === '' || leftDate === rightDate
}

const isTimedCashDeductionDuplicate = (
  left: CashDeductionMatchEvidence,
  right: CashDeductionMatchEvidence,
): boolean =>
  left.operationKey !== right.operationKey &&
  isAutomaticCashDeductionKey(left.operationKey) &&
  isAutomaticCashDeductionKey(right.operationKey) &&
  hasSameCashDeductionOcrTiming(left, right)

const untouchedSubmittedDriverOcrDeduction = (
  row: SubmittedCashDeduction,
  actor: Actor,
  shift: ShiftRecord,
): boolean =>
  actor.driverId === shift.driverId &&
  storedSource(row.source) === 'ocr' &&
  row.amountOcr !== null &&
  row.amountOcr !== undefined &&
  row.amount === row.amountOcr

const untouchedExistingDriverOcrDeduction = (
  row: CashDeductionRecord,
  actor: Actor,
  shift: ShiftRecord,
): boolean =>
  actor.driverId === shift.driverId &&
  row.createdBy === actor.userId &&
  row.source === 'ocr' &&
  row.amountOcr !== null &&
  row.amount === row.amountOcr &&
  row.decisionReason === null &&
  !hasOperationDecision(row)

const preferredSubmittedDeductionIdentity = (
  candidate: SubmittedCashDeduction,
  row: SubmittedCashDeduction,
  eligibleExistingKeys: ReadonlySet<string>,
): SubmittedCashDeduction => {
  const candidateExists = eligibleExistingKeys.has(candidate.operationKey)
  const rowExists = eligibleExistingKeys.has(row.operationKey)
  if (candidateExists !== rowExists) return candidateExists ? candidate : row

  const sameKeyFamily = cashDeductionKeyBase(candidate.operationKey) === cashDeductionKeyBase(row.operationKey)
  if (sameKeyFamily) {
    const candidateIsBase = candidate.operationKey === cashDeductionKeyBase(candidate.operationKey)
    const rowIsBase = row.operationKey === cashDeductionKeyBase(row.operationKey)
    if (candidateIsBase !== rowIsBase) return candidateIsBase ? candidate : row
  }
  // Different legacy key families have no meaningful ordering. Preserve the first sighting.
  return candidate
}

const mergeSubmittedDeductionEvidence = (
  identity: SubmittedCashDeduction,
  candidate: SubmittedCashDeduction,
  row: SubmittedCashDeduction,
): SubmittedCashDeduction => {
  const other = identity === candidate ? row : candidate
  const candidateRoutes = cashDeductionRouteEvidenceCount(candidate)
  const rowRoutes = cashDeductionRouteEvidenceCount(row)
  const routeSource = candidateRoutes === rowRoutes
    ? identity
    : candidateRoutes > rowRoutes
      ? candidate
      : row
  const identityDate = cleanDeductionEvidence(identity.occurredDate)
  return {
    ...identity,
    occurredDate: identityDate === '' ? (other.occurredDate ?? null) : (identity.occurredDate ?? null),
    occurredMinute: identity.occurredMinute ?? other.occurredMinute ?? null,
    pointA: routeSource.pointA ?? null,
    pointB: routeSource.pointB ?? null,
    amountStrip: identity.amountStrip ?? routeSource.amountStrip ?? other.amountStrip ?? null,
  }
}

/** Prevent a same-timestamp OCR duplicate from reaching the database in its first batch. */
const reconcileSubmittedCashDeductions = (
  rows: readonly SubmittedCashDeduction[],
  actor: Actor,
  shift: ShiftRecord,
  existingRows: readonly CashDeductionRecord[],
): SubmittedCashDeduction[] => {
  const existingByKey = new Map(existingRows.map((row) => [row.operationKey, row]))
  const eligibleExistingKeys = new Set(
    existingRows
      .filter((row) => untouchedExistingDriverOcrDeduction(row, actor, shift))
      .map((row) => row.operationKey),
  )
  const canReconcile = (row: SubmittedCashDeduction): boolean => {
    if (!untouchedSubmittedDriverOcrDeduction(row, actor, shift)) return false
    const existing = existingByKey.get(row.operationKey)
    return existing === undefined || eligibleExistingKeys.has(row.operationKey)
  }
  const survivors: SubmittedCashDeduction[] = []
  for (const row of rows) {
    if (!canReconcile(row)) {
      survivors.push(row)
      continue
    }
    const matchIndex = survivors.findIndex((candidate) =>
      canReconcile(candidate) && isTimedCashDeductionDuplicate(candidate, row),
    )
    if (matchIndex === -1) {
      survivors.push(row)
      continue
    }
    const candidate = survivors[matchIndex]!
    const identity = preferredSubmittedDeductionIdentity(candidate, row, eligibleExistingKeys)
    survivors[matchIndex] = mergeSubmittedDeductionEvidence(identity, candidate, row)
  }
  return survivors
}

const untouchedDriverOcrDeduction = (
  row: CashDeductionRecord,
  submitted: SubmittedCashDeduction | undefined,
  actor: Actor,
  shift: ShiftRecord,
): boolean =>
  actor.driverId === shift.driverId &&
  row.createdBy === actor.userId &&
  row.source === 'ocr' &&
  row.amountOcr !== null &&
  row.amount === row.amountOcr &&
  row.decisionReason === null &&
  !hasOperationDecision(row) &&
  (
    submitted === undefined ||
    (
      storedSource(submitted.source) === 'ocr' &&
      submitted.amount === row.amount &&
      submitted.amountOcr === row.amountOcr
    )
  )

/**
 * Locate historical OCR duplicates without granting the operations endpoint a general delete.
 *
 * The stable persisted identity survives and may receive the richer sighting's evidence in the
 * same batch. The repository rechecks the complete deleted row under the shift lock, so a racing
 * correction or manager decision makes the whole submission stale instead of erasing newer data.
 */
const persistedCashDeductionHealing = (
  rows: readonly CashDeductionRecord[],
  submittedRows: readonly SubmittedCashDeduction[],
  actor: Actor,
  shift: ShiftRecord,
): { deletes: CashDeductionRecord[]; ignoredOperationKeys: ReadonlySet<string> } => {
  const submittedByKey = new Map(submittedRows.map((row) => [row.operationKey, row]))
  const survivors: CashDeductionRecord[] = []
  const deletes: CashDeductionRecord[] = []

  for (const row of rows) {
    const submitted = submittedByKey.get(row.operationKey)
    // Omission is never deletion. Healing is authorized only when this full-list PUT carries both
    // sightings and therefore proves which richer evidence the canonical row will retain.
    if (submitted === undefined || !untouchedDriverOcrDeduction(row, submitted, actor, shift)) {
      survivors.push(row)
      continue
    }
    const matchIndex = survivors.findIndex((candidate) =>
      submittedByKey.get(candidate.operationKey) !== undefined &&
      untouchedDriverOcrDeduction(candidate, submittedByKey.get(candidate.operationKey), actor, shift) &&
      isTimedCashDeductionDuplicate(candidate, row),
    )
    if (matchIndex === -1) {
      survivors.push(row)
      continue
    }

    const candidate = survivors[matchIndex]!
    const sameKeyFamily = cashDeductionKeyBase(candidate.operationKey) === cashDeductionKeyBase(row.operationKey)
    if (!sameKeyFamily) {
      // Both are existing identities from an older key scheme. Keep the first stable record.
      deletes.push(row)
    } else if (candidate.operationKey === cashDeductionKeyBase(candidate.operationKey)) {
      deletes.push(row)
    } else if (row.operationKey === cashDeductionKeyBase(row.operationKey)) {
      deletes.push(candidate)
      survivors[matchIndex] = row
    } else if (candidate.operationKey.localeCompare(row.operationKey) <= 0) {
      deletes.push(row)
    } else {
      deletes.push(candidate)
      survivors[matchIndex] = row
    }
  }

  return {
    deletes,
    ignoredOperationKeys: new Set(deletes.map((row) => row.operationKey)),
  }
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

/**
 * The same, for the readings that belong to a SHIFT rather than an order.
 *
 * `source` is derived rather than declared: the reader either produced a number or it did not, and
 * the caller already knows which. A refusal is the more valuable of the two — the image it could not
 * read, beside the figure the driver then typed, is exactly the case it is getting wrong.
 *
 * Best-effort, exactly like the fee one: a lost sample costs a future model one example; a thrown
 * error costs a driver his shift.
 */
async function keepShiftOcrSample(
  deps: Deps,
  shiftId: string,
  pkg: 'start' | 'end',
  kind: 'wallet' | 'odometer',
  strip: string | null | undefined,
  read: number | string | null | undefined,
): Promise<void> {
  if (!strip) return
  // PNG for the narrow glyph strips, JPEG for a whole prepared screen — a photograph coded
  // losslessly ran to megabytes and blew the wire's ceiling, which stopped a shift instead of a
  // sample. Anything that is not one of the two data URLs the app produces is ignored, not stored.
  const base64 = strip.replace(/^data:image\/(png|jpeg);base64,/, '')
  if (base64 === strip) return
  try {
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length === 0 || bytes.length > 262144) return
    await deps.orders.recordShiftOcrSample({
      shiftId,
      package: pkg,
      kind,
      source: read === null || read === undefined ? 'refused' : 'ocr',
      stripPng: bytes,
    })
  } catch {
    // Deliberately swallowed — see above.
  }
}

export async function submitOperations(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: OperationsInput,
): Promise<{ shift: ShiftRecord; br1: Br1View; cashDeductions: CashDeductionRecord[] }> {
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
  const windowContext = await operationWindowContext(deps, shift)

  // Old cached PWAs sent a negative Recent-Orders row as an order fee. Preserve that client, but
  // never let the signed fee reach the orders table or the tier/Yallago arithmetic.
  const legacyDeductions = input.orders
    .filter((row) => row.fee < 0n)
    .map((row) => ({
      operationKey: legacyDeductionKey(row.providerOrderNo),
      amount: minor(-row.fee),
      occurredMinute: row.occurredMinute ?? null,
      occurredDate: row.occurredDate ?? null,
      ...(row.source === undefined ? {} : { source: row.source }),
      amountOcr: row.feeOcr === null || row.feeOcr === undefined
        ? null
        : minor(row.feeOcr < 0n ? -row.feeOcr : row.feeOcr),
      amountStrip: row.feeStrip ?? null,
      pointA: row.pointA ?? null,
      pointB: row.pointB ?? null,
    }))
  const rawSubmittedDeductions = [...(input.cashDeductions ?? []), ...legacyDeductions]
  const submittedOrders = input.orders.filter((row) => row.fee >= 0n)

  const [existing, existingDeductionRows] = await Promise.all([
    deps.orders.listByShift(shiftId),
    deps.cashDeductions.listByShift(shiftId),
  ])
  const deductionHealing = persistedCashDeductionHealing(
    existingDeductionRows,
    rawSubmittedDeductions,
    actor,
    shift,
  )
  const deductionDeleteIds = new Set(deductionHealing.deletes.map((row) => row.id))
  const activeExistingDeductionRows = existingDeductionRows.filter((row) => !deductionDeleteIds.has(row.id))
  const submittedDeductionsBeforeHealing = reconcileSubmittedCashDeductions(
    rawSubmittedDeductions,
    actor,
    shift,
    activeExistingDeductionRows,
  )
  const submittedDeductions = submittedDeductionsBeforeHealing.filter(
    (row) => !deductionHealing.ignoredOperationKeys.has(row.operationKey),
  )
  const byNo = new Map(existing.map((o) => [o.providerOrderNo, o]))
  const deductionsByKey = new Map(activeExistingDeductionRows.map((row) => [row.operationKey, row]))

  const seenOrderNos = new Set<string>()
  for (const row of submittedOrders) {
    if (seenOrderNos.has(row.providerOrderNo)) {
      throw new ServiceError(422, 'duplicate_order_in_submission', { providerOrderNo: row.providerOrderNo })
    }
    seenOrderNos.add(row.providerOrderNo)
  }
  const seenDeductionKeys = new Set<string>()
  for (const row of submittedDeductions) {
    if (row.amount <= 0n) throw new ServiceError(422, 'cash_deduction_must_be_positive')
    if (seenDeductionKeys.has(row.operationKey)) {
      throw new ServiceError(422, 'duplicate_cash_deduction_in_submission', { operationKey: row.operationKey })
    }
    const legacyProviderOrderNo = providerNoFromLegacyDeductionKey(row.operationKey)
    if (legacyProviderOrderNo !== null && seenOrderNos.has(legacyProviderOrderNo)) {
      throw new ServiceError(422, 'duplicate_operation_kind_in_submission', {
        providerOrderNo: legacyProviderOrderNo,
      })
    }
    seenDeductionKeys.add(row.operationKey)
  }

  // Validate every cross-shift identity before the first mutation, so one bad row cannot leave the
  // earlier rows from the same payload committed.
  for (const row of submittedOrders) {
    if (byNo.has(row.providerOrderNo)) continue
    const elsewhere = await deps.orders.findByProviderNo(row.providerOrderNo)
    if (!elsewhere) continue
    const owner = await deps.shifts.findById(elsewhere.shiftId)
    throw new ServiceError(409, 'order_belongs_to_other_shift', {
      providerOrderNo: row.providerOrderNo,
      shiftId: elsewhere.shiftId,
      businessDate: owner?.businessDate ?? null,
    })
  }
  const orderCreates: ShiftOrderRecord[] = []
  const orderUpdates: Array<OperationBatch['orderUpdates'][number]> = []
  const orderPointReplacements: Array<OperationBatch['orderPointReplacements'][number]> = []
  const cashDeductionCreates: CashDeductionRecord[] = []
  const cashDeductionUpdates: Array<OperationBatch['cashDeductionUpdates'][number]> = []
  const legacyKindTransitions: Array<NonNullable<OperationBatch['legacyKindTransitions']>[number]> = []
  const transitionTargets = new Map<string, 'order' | 'cash_deduction'>()
  const scheduleLegacyKind = (
    providerOrderNo: string,
    targetKind: 'order' | 'cash_deduction',
    opposite: Pick<ShiftOrderRecord | CashDeductionRecord, 'id' | 'decidedAt'> | null | undefined,
  ): void => {
    const prior = transitionTargets.get(providerOrderNo)
    if (prior !== undefined && prior !== targetKind) {
      throw new ServiceError(422, 'duplicate_operation_kind_in_submission', { providerOrderNo })
    }
    if (prior === undefined) {
      transitionTargets.set(providerOrderNo, targetKind)
      legacyKindTransitions.push({
        providerOrderNo,
        targetKind,
        expectedOppositeId: opposite?.id ?? null,
        expectedOppositeDecidedAt: opposite?.decidedAt ?? null,
      })
    }
  }
  const ocrSamples: Array<{ orderId: string; row: OperationsInput['orders'][number] }> = []
  const saved = new Map(existing.map((order) => [order.providerOrderNo, order.id]))

  for (const row of submittedOrders) {
    const windowStatus = classifyOperationWindow({
      occurredDate: row.occurredDate ?? null,
      occurredMinute: row.occurredMinute ?? null,
      ...windowContext,
    })
    const current = byNo.get(row.providerOrderNo)
    const opposite = deductionsByKey.get(legacyDeductionKey(row.providerOrderNo))
    if (opposite && hasOperationDecision(opposite)) {
      if (current && hasAuthoritativeOrderKind(current)) {
        throw new ServiceError(409, 'operation_kind_conflict_requires_manager', {
          providerOrderNo: row.providerOrderNo,
        })
      }
      // The cached row changed sign after a manager reviewed the deduction. Preserve that decision
      // and let the transition remove only an undecided duplicate order, if one exists.
      scheduleLegacyKind(row.providerOrderNo, 'cash_deduction', current)
      saved.delete(row.providerOrderNo)
      continue
    }
    scheduleLegacyKind(row.providerOrderNo, 'order', opposite)
    if (current) {
      const managerDecided = hasOperationDecision(current)
      const record: ShiftOrderRecord = {
        ...current,
        // Once a manager has reviewed a row, the cached driver copy is no longer authoritative for
        // any of its accounting/evidence fields. Rephoto and reject deliberately reopen the shift,
        // so an older PWA will send the whole page again; accepting even one of these values would
        // silently undo the manager's audited correction while retaining the manager's name.
        payMode: managerDecided ? current.payMode : row.payMode,
        fee: managerDecided ? current.fee : row.fee,
        zone: managerDecided ? current.zone : (row.zone ?? current.zone),
        source: managerDecided
          ? current.source
          : row.source === undefined
            ? current.source
            : storedSource(row.source),
        feeOcr: managerDecided ? current.feeOcr : (row.feeOcr ?? current.feeOcr),
        // Persisted time and classification are evidence, not fields a cached driver retry can
        // revise. The deterministic close/review classifier may refresh the status; only a manager
        // with a reason may correct the printed date/minute or resulting inclusion.
        included: persistedOperationInclusion(current),
        walletAmount: managerDecided ? current.walletAmount : (row.walletAmount ?? null),
        occurredMinute: current.occurredMinute,
        occurredDate: current.occurredDate,
        windowStatus: current.windowStatus,
      }
      orderUpdates.push({ record, expectedDecidedAt: current.decidedAt })
      // BACKFILL the route, never overwrite it. An order submitted before the reader could read
      // routes has none stored, and re-submitting the shift is the only chance it will ever get
      // one; but a route already on the record may have been corrected by a manager, and a
      // re-read screenshot must not undo that.
      if (!managerDecided && (row.pointA || row.pointB) && current.points.length === 0) {
        orderPointReplacements.push({
          orderId: current.id,
          points: [
            ...(row.pointA ? [{ role: 'start' as const, label: row.pointA, lat: null, lng: null }] : []),
            ...(row.pointB ? [{ role: 'end' as const, label: row.pointB, lat: null, lng: null }] : []),
          ],
        })
      }
      continue
    }
    // The dashboard list scrolls back through PREVIOUS DAYS, so reading further pulls in orders
    // already recorded on an earlier shift. That must say which shift owns it — «هذا الطلب مسجّل في
    // نوبة سابقة» — rather than the blanket "some orders could not be saved" it used to produce.
    const orderId = deps.ids.uuid()
    const record: ShiftOrderRecord = {
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
      createdBy: opposite ? opposite.createdBy : actor.userId,
      // «A» the pickup, «B» the dropoff, exactly as the screen wrote them. The route is what makes
      // an order recognisable to a person at the review — it has no order number to go by.
      points: [
        ...(row.pointA ? [{ role: 'start' as const, label: row.pointA, lat: null, lng: null }] : []),
        ...(row.pointB ? [{ role: 'end' as const, label: row.pointB, lat: null, lng: null }] : []),
      ],
      included: opposite ? persistedOperationInclusion(opposite) : includedByWindow(windowStatus),
      walletAmount: row.walletAmount ?? null,
      occurredMinute: opposite ? opposite.occurredMinute : (row.occurredMinute ?? null),
      occurredDate: opposite ? opposite.occurredDate : (row.occurredDate ?? null),
      windowStatus: opposite?.windowStatus ?? windowStatus,
      decisionReason: null,
      decidedBy: null,
      decidedAt: null,
    }
    orderCreates.push(record)
    saved.set(row.providerOrderNo, orderId)
    ocrSamples.push({ orderId, row })
  }

  for (const row of submittedDeductions) {
    const current = deductionsByKey.get(row.operationKey)
    const legacyProviderOrderNo = providerNoFromLegacyDeductionKey(row.operationKey)
    const opposite = legacyProviderOrderNo === null ? undefined : byNo.get(legacyProviderOrderNo)
    if (legacyProviderOrderNo !== null) {
      if (opposite && hasAuthoritativeOrderKind(opposite)) {
        if (current && hasOperationDecision(current)) {
          throw new ServiceError(409, 'operation_kind_conflict_requires_manager', {
            providerOrderNo: legacyProviderOrderNo,
          })
        }
        // A reviewed order wins over a stale negative retry. The repository still receives the
        // target so it can atomically remove an undecided duplicate deduction that appeared earlier.
        scheduleLegacyKind(legacyProviderOrderNo, 'order', current)
        continue
      }
      scheduleLegacyKind(legacyProviderOrderNo, 'cash_deduction', opposite)
      saved.delete(legacyProviderOrderNo)
    }
    // A manager's reviewed classification is authoritative. A cached driver PWA may re-send the
    // same OCR page after a re-photo request; it must not overwrite that decision or misattribute
    // the write to the manager stored on the row.
    if (current && hasOperationDecision(current)) continue
    // An untouched OCR payload must not turn a protected identity into future cleanup scope. This
    // covers a cached key colliding with a manual row, evidence owned by another actor, or a value
    // that was already corrected away from its OCR amount. Explicit manual edits use `manual` and
    // continue through the normal update path.
    if (
      current &&
      untouchedSubmittedDriverOcrDeduction(row, actor, shift) &&
      !untouchedExistingDriverOcrDeduction(current, actor, shift)
    ) continue
    const canHealCurrentOcrDate = current !== undefined &&
      untouchedExistingDriverOcrDeduction(current, actor, shift) &&
      untouchedSubmittedDriverOcrDeduction(row, actor, shift) &&
      hasSameCashDeductionOcrTiming(current, row) &&
      cleanDeductionEvidence(current.occurredDate) === '' &&
      cleanDeductionEvidence(row.occurredDate) !== ''
    const occurredDate = current
      ? canHealCurrentOcrDate
        ? (row.occurredDate ?? null)
        : current.occurredDate
      : opposite
        ? opposite.occurredDate
        : (row.occurredDate ?? null)
    const occurredMinute = current
      ? current.occurredMinute
      : opposite
        ? opposite.occurredMinute
        : (row.occurredMinute ?? null)
    const classifiedWindowStatus = classifyOperationWindow({ occurredDate, occurredMinute, ...windowContext })
    const windowStatus = canHealCurrentOcrDate
      ? classifiedWindowStatus
      : (current?.windowStatus ?? opposite?.windowStatus ?? classifiedWindowStatus)
    const submittedRoute = { pointA: row.pointA ?? null, pointB: row.pointB ?? null }
    const preserveRicherCurrentRoute = current !== undefined &&
      current.source === 'ocr' &&
      storedSource(row.source) === 'ocr' &&
      current.amount === row.amount &&
      current.amountOcr !== null &&
      current.amountOcr === row.amountOcr &&
      cashDeductionRouteEvidenceCount(current) > cashDeductionRouteEvidenceCount(submittedRoute) &&
      hasSameCashDeductionOcrTiming(current, row)
    const record: CashDeductionRecord = {
      id: current?.id ?? deps.ids.uuid(),
      shiftId,
      operationKey: row.operationKey,
      amount: row.amount,
      occurredDate,
      occurredMinute,
      source: storedSource(row.source),
      amountOcr: row.amountOcr ?? null,
      pointA: preserveRicherCurrentRoute ? current.pointA : submittedRoute.pointA,
      pointB: preserveRicherCurrentRoute ? current.pointB : submittedRoute.pointB,
      included: canHealCurrentOcrDate
        ? includedByWindow(windowStatus)
        : current
          ? persistedOperationInclusion(current)
          : opposite
            ? persistedOperationInclusion(opposite)
            : includedByWindow(windowStatus),
      windowStatus,
      decisionReason: current?.decisionReason ?? null,
      decidedBy: current?.decidedBy ?? null,
      decidedAt: current?.decidedAt ?? null,
      createdBy: current ? current.createdBy : opposite ? opposite.createdBy : actor.userId,
    }
    if (current) cashDeductionUpdates.push({ record, expectedDecidedAt: current.decidedAt })
    else cashDeductionCreates.push(record)
  }

  // Orders, deductions and wallet rows are one accounting claim by the driver. Committing a row at
  // a time left a half-imported page when a later natural key conflicted; the aggregate repository
  // locks the shift and rolls the entire page back on any conflict or racing manager decision.
  const batch: OperationBatch = {
    orderCreates,
    orderUpdates,
    orderPointReplacements,
    cashDeductionCreates,
    cashDeductionUpdates,
    cashDeductionDeletes: deductionHealing.deletes.map((expected) => ({ expected })),
    legacyKindTransitions,
    movements: input.movements.map((m) => {
      const orderId = m.providerOrderNo ? (saved.get(m.providerOrderNo) ?? null) : null
      const providerBecameDeduction =
        m.providerOrderNo !== null &&
        m.providerOrderNo !== undefined &&
        transitionTargets.get(m.providerOrderNo) === 'cash_deduction'
      return {
        amount: m.amount,
        occurredMinute: m.occurredMinute,
        orderId: providerBecameDeduction ? null : orderId,
        // A wallet row formerly matched to a provider order is retained as evidence when that row
        // proves to be a cash deduction, but cannot silently become another BR1 adjustment.
        role: providerBecameDeduction ? ('unmatched' as const) : (m.role ?? 'unmatched'),
        ambiguous: providerBecameDeduction ? true : (m.ambiguous ?? false),
        included: providerBecameDeduction ? false : (m.included ?? true),
        source: 'ocr' as const,
        notes: m.notes ?? null,
        createdBy: actor.userId,
      }
    }),
  }
  try {
    await deps.operationBatches.apply(shiftId, batch, actor.userId)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'DUPLICATE_ORDER_NO') {
      for (const row of submittedOrders) {
        const ownerOrder = await deps.orders.findByProviderNo(row.providerOrderNo)
        if (!ownerOrder) continue
        if (ownerOrder.shiftId === shiftId) throw new ServiceError(409, 'operations_changed_concurrently')
        const ownerShift = await deps.shifts.findById(ownerOrder.shiftId)
        throw new ServiceError(409, 'order_belongs_to_other_shift', {
          providerOrderNo: row.providerOrderNo,
          shiftId: ownerOrder.shiftId,
          businessDate: ownerShift?.businessDate ?? null,
        })
      }
    }
    if (
      code === 'DUPLICATE_CASH_DEDUCTION' ||
      code === 'STALE_OPERATION_BATCH' ||
      code === 'OPERATION_BATCH_KIND_CONFLICT'
    ) {
      throw new ServiceError(409, 'operations_changed_concurrently')
    }
    if (code === 'OPERATION_BATCH_SHIFT_CLOSED') throw new ServiceError(409, 'shift_not_open')
    if (code === 'OPERATION_BATCH_SHIFT_NOT_FOUND') throw new ServiceError(404, 'shift_not_found')
    if (code === 'OPERATION_BATCH_SHIFT_MISMATCH') throw new ServiceError(409, 'operations_batch_shift_mismatch')
    throw error
  }

  // Training samples deliberately live outside the money transaction: losing one must never roll
  // back a valid page, and a failed accounting batch must never leave a sample for a nonexistent row.
  for (const sample of ocrSamples) await keepOcrSample(deps, sample.orderId, sample.row)

  const [br1, cashDeductions] = await Promise.all([
    evaluateShift(deps, shift),
    deps.cashDeductions.listByShift(shiftId),
  ])
  return { shift, br1, cashDeductions }
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
  input: Parameters<typeof reviseOperationsLocked>[3],
): Promise<{ shift: ShiftRecord; br1: Br1View; before: ShiftRecord }> {
  return deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => reviseOperationsLocked(withCloseTransaction(deps, transaction), actor, shiftId, input),
  )
}

/** Every authoritative revision gets a fresh optimistic/audit version, even under a frozen clock. */
function nextOperationDecisionAt(nowMs: number, previous: string | null): string {
  const previousMs = previous === null ? Number.NEGATIVE_INFINITY : Date.parse(previous)
  return new Date(Math.max(nowMs, Number.isFinite(previousMs) ? previousMs + 1 : nowMs)).toISOString()
}

async function reviseOperationsLocked(
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
      occurredMinute?: string | null | undefined
      occurredDate?: string | null | undefined
      reason?: string | undefined
    }[]
    cashDeductions?: readonly {
      id: string
      included?: boolean | undefined
      occurredMinute?: string | null | undefined
      occurredDate?: string | null | undefined
      reason: string
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
  const windowContext = await operationWindowContext(deps, shift)

  const rows = await deps.orders.listByShift(shiftId)
  const byNo = new Map(rows.map((o) => [o.providerOrderNo, o]))
  for (const patch of input.orders ?? []) {
    const current = byNo.get(patch.providerOrderNo)
    if (!current) throw new ServiceError(404, 'order_not_found', { providerOrderNo: patch.providerOrderNo })
    const changesWindow =
      patch.included !== undefined || patch.occurredMinute !== undefined || patch.occurredDate !== undefined
    const authoritativeChange = changesWindow || patch.fee !== undefined || patch.walletAmount !== undefined
    if (changesWindow && !patch.reason?.trim()) {
      throw new ServiceError(422, 'operation_decision_reason_required')
    }
    const occurredMinute = patch.occurredMinute === undefined ? current.occurredMinute : patch.occurredMinute
    const occurredDate = patch.occurredDate === undefined ? current.occurredDate : patch.occurredDate
    const windowStatus = changesWindow
      ? classifyOperationWindow({
          occurredDate,
          occurredMinute,
          ...windowContext,
        })
      : current.windowStatus
    await deps.orders.update({
      ...current,
      included: patch.included ?? (changesWindow ? includedByWindow(windowStatus) : current.included),
      // The manager's own correction. He verifies against the cash in his hand, so he is the one
      // placed to say what a fee actually was — and until now his only move against a wrong one was
      // to exclude the whole delivery. The audit trigger attributes the change, and it moves
      // `orders_hash`, so he cannot approve figures he has not re-read.
      fee: patch.fee ?? current.fee,
      // `undefined` leaves it alone; an explicit `null` clears a measurement the manager rejects.
      walletAmount: patch.walletAmount === undefined ? current.walletAmount : patch.walletAmount,
      occurredMinute,
      occurredDate,
      windowStatus,
      ...(authoritativeChange
        ? {
            // Window/include decisions require a human reason. Value-only corrections retain an
            // optional reason for old managers, while still advancing decidedAt as the optimistic
            // version so a late driver sync cannot overwrite the corrected money.
            // On an UNKNOWN row, however, a fee note must not masquerade as the reasoned include /
            // exclude decision approval requires. Keep the existing window reason (normally null)
            // until the manager explicitly changes inclusion or timing.
            decisionReason: changesWindow
              ? patch.reason!.trim()
              : current.windowStatus === 'unknown'
                ? current.decisionReason
                : (patch.reason?.trim() || current.decisionReason),
            decidedBy: actor.userId,
            decidedAt: nextOperationDecisionAt(deps.clock.nowMs(), current.decidedAt),
          }
        : {}),
    }, actor.userId)
  }

  const deductionRows = await deps.cashDeductions.listByShift(shiftId)
  const deductionsById = new Map(deductionRows.map((d) => [d.id, d]))
  for (const patch of input.cashDeductions ?? []) {
    const current = deductionsById.get(patch.id)
    if (!current) throw new ServiceError(404, 'cash_deduction_not_found', { id: patch.id })
    const occurredMinute = patch.occurredMinute === undefined ? current.occurredMinute : patch.occurredMinute
    const occurredDate = patch.occurredDate === undefined ? current.occurredDate : patch.occurredDate
    const windowStatus = classifyOperationWindow({
      occurredDate,
      occurredMinute,
      ...windowContext,
    })
    await deps.cashDeductions.update({
      ...current,
      occurredMinute,
      occurredDate,
      windowStatus,
      included: patch.included ?? includedByWindow(windowStatus),
      decisionReason: patch.reason.trim(),
      decidedBy: actor.userId,
      decidedAt: nextOperationDecisionAt(deps.clock.nowMs(), current.decidedAt),
    }, actor.userId)
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
    }, actor.userId)
  }

  const br1 = await evaluateShift(deps, shift)
  const updated: ShiftRecord = {
    ...shift,
    equationDiff: br1.result.scalarDiff,
    cashDiff: br1.result.cashDiff,
    walletDiff: br1.result.walletDiff,
    ordersHash: br1.ordersHash,
  }
  await deps.shifts.update(updated, actor.userId)
  return { shift: updated, br1, before: shift }
}

interface CashDeductionAllocation {
  postings: Array<{ amount: Minor; sharePortion: Minor; occurrenceKey: string }>
  total: Minor
  fromShare: Minor
  receivable: Minor
}

/** Consume only this shift's positive share, then name the overflow as a cash receivable. */
function allocateCashDeductions(
  rows: readonly CashDeductionRecord[],
  grossDriverShare: Minor,
): CashDeductionAllocation {
  let shareAvailable = grossDriverShare > 0n ? grossDriverShare : minor(0n)
  let total = minor(0n)
  let fromShare = minor(0n)
  const postings = [...rows]
    .filter(operationCounts)
    .sort((a, b) => a.operationKey.localeCompare(b.operationKey))
    .map((row) => {
      const sharePortion = row.amount < shareAvailable ? row.amount : shareAvailable
      shareAvailable = minor(shareAvailable - sharePortion)
      total = add(total, row.amount)
      fromShare = add(fromShare, sharePortion)
      return {
        amount: row.amount,
        sharePortion,
        occurrenceKey: `cash-deduction:${row.id}`,
      }
    })
  return { postings, total, fromShare, receivable: minor(total - fromShare) }
}

export interface CloseSettlementConfirmation {
  reviewedSettlementHash?: string
  walletTransferConfirmed?: boolean
  cashSettlementConfirmed?: boolean
  varianceReason?: string | null
  /** Legacy fields are accepted by the wire only so the service can name the obsolete policy. */
  keepAsReceivable?: Minor
  payShareNow?: boolean
}

interface FixedShiftShare {
  split: { driverShare: Minor; companyShare: Minor; yalagoShare: Minor }
  deliveryFeeTotal: Minor
  fixedDriverShare: Minor
  manualDriverShare: Minor
}

/** Fixed 40% applies independently to this shift's included Yallago fees; no day-tier true-up. */
function fixedShiftShare(rows: readonly ShiftOrderRecord[]): FixedShiftShare {
  const included = includedOrders(rows)
  const yallagoFees = included.filter((row) => row.kind !== 'manual').map((row) => row.fee)
  const fixed = splitFixedDriverShare(yallagoFees)
  const manual = manualShareTotals(included)
  return {
    split: {
      driverShare: add(fixed.driverShare, manual.driverShare),
      companyShare: add(fixed.companyShare, manual.companyShare),
      yalagoShare: fixed.yalagoShare,
    },
    deliveryFeeTotal: sum(yallagoFees),
    fixedDriverShare: fixed.driverShare,
    manualDriverShare: manual.driverShare,
  }
}

export type SettlementView = FixedShareSettlementPlan & {
  policyCode: typeof FIXED_SETTLEMENT_POLICY
  driverRateBps: typeof FIXED_SETTLEMENT_DRIVER_BPS
  varianceDirection: 'surplus' | 'shortage' | 'balanced'
  settlementHash: string
  reviewedOrdersHash: string
  deductionPostings: CashDeductionAllocation['postings']
  split: FixedShiftShare['split']
}

/** Compute the exact immutable preview approval will recompute under the same close transaction. */
export async function settlementFor(deps: Deps, shift: ShiftRecord): Promise<SettlementView> {
  if (shift.endCashDeclared === null || shift.endWalletDeclared === null) {
    throw new ServiceError(422, 'settlement_figures_missing')
  }
  const br1 = await evaluateShift(deps, shift)
  const rows = await deps.orders.listByShift(shift.id)
  const share = fixedShiftShare(rows)
  const deductions = allocateCashDeductions(await deps.cashDeductions.listByShift(shift.id), share.split.driverShare)
  const plan = planFixedShareSettlement({
    deliveryFeeTotal: share.deliveryFeeTotal,
    fixedDriverShare: share.fixedDriverShare,
    manualDriverShare: share.manualDriverShare,
    cashDeductionTotal: deductions.total,
    expectedCash: br1.result.expectedCash,
    expectedWallet: br1.result.expectedWallet,
    actualCash: shift.endCashDeclared,
    actualWallet: shift.endWalletDeclared,
  })
  const settlementHash = fixedSettlementHash(
    {
      shiftId: shift.id,
      branchId: shift.branchId,
      driverId: shift.driverId,
      businessDate: shift.businessDate,
      reviewedOrdersHash: br1.ordersHash,
    },
    plan,
  )
  return {
    ...plan,
    policyCode: FIXED_SETTLEMENT_POLICY,
    driverRateBps: FIXED_SETTLEMENT_DRIVER_BPS,
    varianceDirection: varianceDirection(plan.variance),
    settlementHash,
    reviewedOrdersHash: br1.ordersHash,
    deductionPostings: deductions.postings,
    split: share.split,
  }
}

function requireSettlementConfirmation(
  plan: SettlementView,
  input: CloseSettlementConfirmation,
): { varianceReason: string | null } {
  if ((input.keepAsReceivable ?? minor(0n)) !== 0n || input.payShareNow === false) {
    throw new ServiceError(422, 'fixed_cash_settlement_required')
  }
  const missing: string[] = []
  if (!input.walletTransferConfirmed) missing.push('walletTransferConfirmed')
  if (!input.cashSettlementConfirmed) missing.push('cashSettlementConfirmed')
  if (!input.reviewedSettlementHash) missing.push('reviewedSettlementHash')
  if (missing.length > 0) throw new ServiceError(422, 'settlement_confirmation_required', { missing })
  if (input.reviewedSettlementHash !== plan.settlementHash) {
    throw new ServiceError(409, 'settlement_changed_since_review', {
      reviewed: input.reviewedSettlementHash,
      current: plan.settlementHash,
    })
  }
  const reason = input.varianceReason?.trim() || null
  if (plan.variance !== 0n && reason === null) throw new ServiceError(422, 'variance_reason_required')
  return { varianceReason: reason }
}

/** Exact retry after a committed response was lost: return success without posting a second time. */
function requireSettlementReplay(
  stored: ShiftSettlementRecord,
  confirmation: CloseSettlementConfirmation,
  reviewedOrdersHash: string | null,
): void {
  if ((confirmation.keepAsReceivable ?? minor(0n)) !== 0n || confirmation.payShareNow === false) {
    throw new ServiceError(422, 'fixed_cash_settlement_required')
  }
  if (!confirmation.walletTransferConfirmed || !confirmation.cashSettlementConfirmed) {
    throw new ServiceError(422, 'settlement_confirmation_required')
  }
  if (
    confirmation.reviewedSettlementHash !== stored.settlementHash ||
    (reviewedOrdersHash !== null && reviewedOrdersHash !== stored.reviewedOrdersHash)
  ) {
    throw new ServiceError(409, 'settlement_changed_since_review', {
      reviewed: confirmation.reviewedSettlementHash ?? null,
      current: stored.settlementHash,
    })
  }
  const reason = confirmation.varianceReason?.trim() || null
  if (stored.variance !== 0n && reason === null) throw new ServiceError(422, 'variance_reason_required')
  if (reason !== stored.varianceReason) {
    throw new ServiceError(409, 'settlement_changed_since_review', {
      reasonChanged: true,
    })
  }
}

function settlementRecord(
  shift: ShiftRecord,
  plan: SettlementView,
  actor: Actor,
  confirmedAtMs: number,
  varianceReason: string | null,
): NewShiftSettlementRecord {
  return {
    shiftId: shift.id,
    branchId: shift.branchId,
    driverId: shift.driverId,
    businessDate: shift.businessDate,
    policyCode: plan.policyCode,
    driverRateBps: plan.driverRateBps,
    deliveryFeeTotal: plan.deliveryFeeTotal,
    fixedDriverShare: plan.fixedDriverShare,
    manualDriverShare: plan.manualDriverShare,
    grossDriverShare: plan.grossDriverShare,
    cashDeductionTotal: plan.cashDeductionTotal,
    baseDriverShare: plan.baseDriverShare,
    expectedTotal: plan.expectedTotal,
    actualCash: plan.actualCash,
    actualWallet: plan.actualWallet,
    actualTotal: plan.actualTotal,
    variance: plan.variance,
    varianceDirection: plan.varianceDirection,
    finalEmployeeCash: plan.finalEmployeeCash,
    walletToOffice: plan.walletToOffice,
    cashToOffice: plan.cashToOffice,
    walletAction: plan.wallet.action,
    walletAmount: plan.wallet.amount,
    cashAction: plan.cash.action,
    cashAmount: plan.cash.amount,
    reviewedOrdersHash: plan.reviewedOrdersHash,
    settlementHash: plan.settlementHash,
    walletTransferConfirmed: true,
    cashSettlementConfirmed: true,
    confirmedBy: actor.userId,
    confirmedAtMs,
    varianceReason,
  }
}

export async function approveClose(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  reviewedOrdersHash: string,
  splitGate: 'advisory' | 'strict' = 'advisory',
  confirmation: CloseSettlementConfirmation = {},
): Promise<{ shift: ShiftRecord; postings: number }> {
  return deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) =>
      approveCloseLocked(
        withCloseTransaction(deps, transaction),
        actor,
        shiftId,
        reviewedOrdersHash,
        splitGate,
        confirmation,
      ),
  )
}

async function approveCloseLocked(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  reviewedOrdersHash: string,
  splitGate: 'advisory' | 'strict',
  confirmation: CloseSettlementConfirmation,
): Promise<{ shift: ShiftRecord; postings: number }> {
  const shift = await mustFind(deps, shiftId)
  const storedSettlement = await deps.settlements.findByShift(shiftId)
  if (shift.state === 'approved' || shift.state === 'week_locked') {
    if (!storedSettlement) throw new ServiceError(409, 'legacy_settlement_read_only')
    requireSettlementReplay(storedSettlement, confirmation, reviewedOrdersHash)
    return { shift, postings: 0 }
  }
  if (await activeForcePreparation(deps, shift)) {
    throw new ServiceError(409, 'force_close_commit_required')
  }
  await prepareShiftReview(deps, shift, actor.userId)
  const orderRows = await deps.orders.listByShift(shiftId)
  const br1 = await evaluateShift(deps, shift)
  const settlement = await settlementFor(deps, shift)
  const evidenceWarnings = await unacknowledgedEvidenceWarnings(deps, shiftId, 'end')
  if (evidenceWarnings.length > 0) {
    throw new ServiceError(422, 'stale_evidence_confirmation_required', {
      package: 'end',
      slots: evidenceWarnings,
    })
  }
  const unresolved = await unresolvedWindowRows(deps, shiftId)
  if (unresolved.orders.length > 0 || unresolved.deductions.length > 0) {
    throw new ServiceError(422, 'operation_window_unresolved', unresolved)
  }
  const { varianceReason } = requireSettlementConfirmation(settlement, confirmation)

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
    settlementConfirmed: true,
    splitGate,
    reviewedOrdersHash,
    currentOrdersHash: br1.ordersHash,
  })
  if (!result.ok) fail(result)

  const todaysOrders = toDomainOrders(orderRows)
  const fxDayId = await ensureFxDay(deps, shift.businessDate)
  const postings = postingsForCashSettledApproval(
    {
      driverId: shift.driverId,
      branchId: shift.branchId,
      floatTranches: shift.floatTranches,
      carriedTranches: shift.carriedTranches,
      topupTranches: shift.topupTranches,
      orders: todaysOrders,
      walletAdjustments: toWalletAdjustments(await deps.movements.listByShift(shiftId)),
      cashDeductions: settlement.deductionPostings,
    },
    settlement.split,
    settlement,
  )

  const written = await deps.ledger.post(shift.branchId, postings, {
    shiftId: shift.id,
    businessDate: shift.businessDate,
    postingDate: todayFor(deps),
    weekStartDate: shift.weekStartDate,
    fxDayId,
    createdBy: actor.userId,
    ...(varianceReason === null ? {} : { reason: varianceReason }),
  })

  const confirmedAtMs = deps.clock.nowMs()
  await deps.settlements.create(settlementRecord(shift, settlement, actor, confirmedAtMs, varianceReason))

  const updated: ShiftRecord = {
    ...shift,
    state: result.next,
    approvedBy: actor.userId,
    keptAsReceivable: minor(0n),
    driverSharePaid: settlement.finalEmployeeCash > 0n ? settlement.finalEmployeeCash : minor(0n),
    equationDiff: br1.result.scalarDiff,
    cashDiff: br1.result.cashDiff,
    walletDiff: br1.result.walletDiff,
    ordersHash: br1.ordersHash,
  }
  await deps.shifts.update(updated, actor.userId)
  await recordDecision(deps, actor, shiftId, 'close', 'approved', varianceReason)
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
  return deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => voidShiftLocked(withCloseTransaction(deps, transaction), actor, shiftId, reason),
  )
}

async function voidShiftLocked(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  reason: string,
): Promise<ShiftRecord> {
  const shift = await mustFind(deps, shiftId)
  const result = await guard(deps, shift, 'manager_force_cancel', actor)
  if (!result.ok) fail(result)

  const postings: Posting[] = []
  const floatTotal = sum(shift.floatTranches)
  const topupTotal = sum(shift.topupTranches)
  const carriedTotal = sum(shift.carriedTranches)
  if (floatTotal > minor(0n)) postings.push(floatReturn(shift.driverId, floatTotal))
  /*
   * A CARRIED ذمة GOES BACK TO BEING A ذمة, not to the branch box.
   *
   * `postingsForOpen` cleared the receivable and raised his cash; voiding must undo exactly that.
   * Returning it through `floatReturn` instead would credit `office_cash` with money the box never
   * paid out for this shift — the office would show a gain, the receivable would stay cleared, and
   * the driver would still be holding the cash with nothing on the books saying so.
   */
  if (carriedTotal > minor(0n)) postings.push(reverse(floatCarry(shift.driverId, carriedTotal), `void-carry-${shift.id}`))
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
  await deps.movements.deleteByShift(shiftId, actor.userId)
  for (const deduction of await deps.cashDeductions.listByShift(shiftId)) {
    await deps.cashDeductions.delete(deduction.id, actor.userId)
  }
  for (const o of await deps.orders.listByShift(shiftId)) await deps.orders.delete(o.id, actor.userId)

  const updated: ShiftRecord = { ...shift, state: result.next }
  await deps.shifts.update(updated, actor.userId)
  return updated
}

/** Force-close uses the exact same fixed settlement as ordinary approval, but bypasses evidence gates. */
export async function forceClose(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: Parameters<typeof forceCloseLocked>[3],
): Promise<
  | { shift: ShiftRecord; postings: 0; prepared: true; replayed: false }
  | { shift: ShiftRecord; postings: number; prepared: false; replayed: boolean }
> {
  return deps.closeUnitOfWork.run(
    { shiftId, actorId: actor.userId },
    async (transaction) => forceCloseLocked(withCloseTransaction(deps, transaction), actor, shiftId, input),
  )
}

async function forceCloseLocked(
  deps: Deps,
  actor: Actor,
  shiftId: string,
  input: {
    odometerKm?: number | null
    odometerAnomalyConfirmed?: boolean
    cashDeclared?: Minor | null
    walletDeclared?: Minor | null
    prepareOnly?: boolean | undefined
    reviewedSettlementHash?: string
    walletTransferConfirmed?: boolean
    cashSettlementConfirmed?: boolean
    reason: string
  },
): Promise<
  | { shift: ShiftRecord; postings: 0; prepared: true; replayed: false }
  | { shift: ShiftRecord; postings: number; prepared: false; replayed: boolean }
> {
  let shift = await mustFind(deps, shiftId)
  const storedSettlement = await deps.settlements.findByShift(shiftId)
  if (shift.state === 'approved' || shift.state === 'week_locked') {
    if (input.prepareOnly) throw new ServiceError(409, 'illegal_transition')
    if (!storedSettlement) throw new ServiceError(409, 'legacy_settlement_read_only')
    if (
      (input.cashDeclared !== undefined && input.cashDeclared !== null && input.cashDeclared !== storedSettlement.actualCash) ||
      (input.walletDeclared !== undefined && input.walletDeclared !== null && input.walletDeclared !== storedSettlement.actualWallet) ||
      (input.odometerKm !== undefined && input.odometerKm !== null && input.odometerKm !== shift.odoEnd)
    ) {
      throw new ServiceError(409, 'settlement_changed_since_review', { replayFiguresChanged: true })
    }
    requireSettlementReplay(storedSettlement, {
      ...(input.reviewedSettlementHash === undefined ? {} : { reviewedSettlementHash: input.reviewedSettlementHash }),
      ...(input.walletTransferConfirmed === undefined ? {} : { walletTransferConfirmed: input.walletTransferConfirmed }),
      ...(input.cashSettlementConfirmed === undefined ? {} : { cashSettlementConfirmed: input.cashSettlementConfirmed }),
      varianceReason: input.reason,
    }, null)
    return { shift, postings: 0, prepared: false, replayed: true }
  }
  const result = await guard(deps, shift, 'manager_force_close', actor)
  if (!result.ok) fail(result)
  const forcePreparation = await activeForcePreparation(deps, shift)

  const finalOdometer = input.odometerKm ?? shift.odoEnd
  const anomalousOdometer =
    finalOdometer !== null && shift.odoStart !== null && finalOdometer < shift.odoStart
  const existingAnomalyConfirmed =
    finalOdometer === shift.odoEnd &&
    shift.odoEndAnomalyConfirmedAt !== null &&
    shift.odoEndAnomalyConfirmedBy !== null
  if (anomalousOdometer && !existingAnomalyConfirmed && !input.odometerAnomalyConfirmed) {
    throw new ServiceError(422, 'odometer_anomaly_confirmation_required', {
      start: shift.odoStart,
      end: finalOdometer,
    })
  }
  const cashDeclared = input.cashDeclared ?? shift.endCashDeclared
  const walletDeclared = input.walletDeclared ?? shift.endWalletDeclared
  if (cashDeclared === null || walletDeclared === null) {
    throw new ServiceError(422, 'settlement_figures_missing', {
      missing: [
        ...(cashDeclared === null ? ['cashDeclared'] : []),
        ...(walletDeclared === null ? ['walletDeclared'] : []),
      ],
    })
  }
  // A force-close is still a close boundary. Claim it first so no late PWA batch can slip in, then
  // classify every OCR operation against that exact minute. Unknown rows remain a human decision:
  // the force override bypasses BR1, not the requirement to say which operations belong here.
  if (shift.submittedAt === null) {
    if (!input.prepareOnly) throw new ServiceError(409, 'force_close_preparation_required')
    const anomalyConfirmedAt = anomalousOdometer
      ? (existingAnomalyConfirmed
          ? shift.odoEndAnomalyConfirmedAt
          : new Date(deps.clock.nowMs()).toISOString())
      : null
    const anomalyConfirmedBy = anomalousOdometer
      ? (existingAnomalyConfirmed ? shift.odoEndAnomalyConfirmedBy : actor.userId)
      : null
    shift = {
      ...shift,
      state: 'pending_review',
      submittedAt: new Date(deps.clock.nowMs()).toISOString(),
      endCashDeclared: cashDeclared,
      endWalletDeclared: walletDeclared,
      odoEnd: finalOdometer,
      odoEndAnomalyConfirmedAt: anomalyConfirmedAt,
      odoEndAnomalyConfirmedBy: anomalyConfirmedBy,
    }
    await deps.shifts.update(shift, actor.userId)
    await prepareShiftReview(deps, shift, actor.userId)
    await recordDecision(deps, actor, shiftId, 'close', 'force_close_prepared', input.reason)
    return { shift, postings: 0, prepared: true, replayed: false }
  }
  if (input.prepareOnly) {
    if (!forcePreparation) throw new ServiceError(409, 'force_close_preparation_required')
    const samePreparedFigures =
      shift.endCashDeclared === cashDeclared &&
      shift.endWalletDeclared === walletDeclared &&
      shift.odoEnd === finalOdometer
    if (!samePreparedFigures) throw new ServiceError(409, 'settlement_changed_since_review')
    return { shift, postings: 0, prepared: true, replayed: false }
  }

  if (!forcePreparation) throw new ServiceError(409, 'force_close_preparation_required')
  if (
    shift.endCashDeclared !== cashDeclared ||
    shift.endWalletDeclared !== walletDeclared ||
    shift.odoEnd !== finalOdometer
  ) {
    throw new ServiceError(409, 'settlement_changed_since_review', { preparedFiguresChanged: true })
  }

  const missingConfirmations = [
    ...(!input.reviewedSettlementHash ? ['reviewedSettlementHash'] : []),
    ...(!input.walletTransferConfirmed ? ['walletTransferConfirmed'] : []),
    ...(!input.cashSettlementConfirmed ? ['cashSettlementConfirmed'] : []),
  ]
  if (missingConfirmations.length > 0) {
    throw new ServiceError(422, 'settlement_confirmation_required', { missing: missingConfirmations })
  }
  await prepareShiftReview(deps, shift, actor.userId)
  const unresolved = await unresolvedWindowRows(deps, shiftId)
  if (unresolved.orders.length > 0 || unresolved.deductions.length > 0) {
    throw new ServiceError(422, 'operation_window_unresolved', unresolved)
  }

  const orderRows = await deps.orders.listByShift(shiftId)
  const todaysOrders = toDomainOrders(orderRows)
  const stagedShift: ShiftRecord = {
    ...shift,
    endCashDeclared: cashDeclared,
    endWalletDeclared: walletDeclared,
  }
  const settlement = await settlementFor(deps, stagedShift)
  requireSettlementConfirmation(settlement, {
    ...(input.reviewedSettlementHash === undefined ? {} : { reviewedSettlementHash: input.reviewedSettlementHash }),
    ...(input.walletTransferConfirmed === undefined ? {} : { walletTransferConfirmed: input.walletTransferConfirmed }),
    ...(input.cashSettlementConfirmed === undefined ? {} : { cashSettlementConfirmed: input.cashSettlementConfirmed }),
    varianceReason: input.reason,
  })
  const shiftInput = {
    driverId: shift.driverId,
    branchId: shift.branchId,
    floatTranches: shift.floatTranches,
    carriedTranches: shift.carriedTranches,
    topupTranches: shift.topupTranches,
    orders: todaysOrders,
    walletAdjustments: toWalletAdjustments(await deps.movements.listByShift(shiftId)),
    cashDeductions: settlement.deductionPostings,
  }
  const postings = postingsForCashSettledApproval(shiftInput, settlement.split, settlement)

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

  const confirmedAtMs = deps.clock.nowMs()
  await deps.settlements.create(settlementRecord(stagedShift, settlement, actor, confirmedAtMs, input.reason))
  const br1 = await evaluateShift(deps, stagedShift)
  const updated: ShiftRecord = {
    ...stagedShift,
    state: result.next,
    approvedBy: actor.userId,
    keptAsReceivable: minor(0n),
    driverSharePaid: settlement.finalEmployeeCash > 0n ? settlement.finalEmployeeCash : minor(0n),
    odoEnd: finalOdometer,
    odoEndAnomalyConfirmedAt: anomalousOdometer
      ? (existingAnomalyConfirmed
          ? shift.odoEndAnomalyConfirmedAt
          : new Date(deps.clock.nowMs()).toISOString())
      : null,
    odoEndAnomalyConfirmedBy: anomalousOdometer
      ? (existingAnomalyConfirmed ? shift.odoEndAnomalyConfirmedBy : actor.userId)
      : null,
    equationDiff: br1.result.scalarDiff,
    cashDiff: br1.result.cashDiff,
    walletDiff: br1.result.walletDiff,
    ordersHash: br1.ordersHash,
  }
  await deps.shifts.update(updated, actor.userId)
  await recordDecision(deps, actor, shiftId, 'close', 'approved', input.reason)
  return { shift: updated, postings: written.length, prepared: false, replayed: false }
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
