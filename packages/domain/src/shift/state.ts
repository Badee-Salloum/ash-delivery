import type { Minor } from '../money/minor.ts'
import type { Actor, GrantTable, PermissionKey } from '../rbac/can.ts'
import { can } from '../rbac/can.ts'

/**
 * The shift lifecycle (SRS C-1) and both gates (BR5), as a pure transition function.
 *
 * BR5 is the rule this encodes:
 *   • a shift may not OPEN  before the start package is complete, the driver confirms, and the
 *     branch manager approves;
 *   • a shift may not CLOSE before the end package is complete, BR1 evaluates to zero, and the
 *     branch manager approves after matching the ground numbers to the system.
 *
 * Every refusal carries a machine-readable reason. The UI resolves `shift.blocked.<reason>` to
 * Arabic — no human-facing strings live in the domain.
 */

export type ShiftState =
  | 'draft'
  | 'awaiting_open_approval'
  | 'open'
  | 'pending_review'
  | 'approved'
  | 'suspended'
  | 'week_locked'
  // An upper-level account voided a stuck shift: the float/top-up were returned to the office and
  // the orders discarded. Terminal, does not occupy the bike, never counts toward tier or the week.
  | 'cancelled'

export type ShiftAction =
  | 'driver_confirm_start'
  | 'manager_approve_open'
  | 'manager_request_rephoto'
  | 'driver_submit_end'
  | 'manager_approve_close'
  | 'manager_reject_close'
  // Refusing a shift at the OPEN gate, sending it back to the driver to redo. Distinct from
  // `manager_request_rephoto` (which asks for a better photo of the same package) in intent and in
  // the decision log: this one says the shift itself was not acceptable, with a reason.
  | 'manager_reject_open'
  | 'suspend'
  | 'resume'
  | 'week_lock'
  // Upper-level overrides for a shift the driver can't finish (SRS ops escape hatch). No BR5/BR1
  // gate — the whole point is to resolve a shift that can't satisfy them — but audited + reasoned.
  | 'manager_force_cancel'
  | 'manager_force_close'

/** Which permission each action requires. Checked server-side; UI hiding is not security. */
export const ACTION_PERMISSION: Readonly<Record<ShiftAction, PermissionKey>> = {
  driver_confirm_start: 'shift.operate',
  manager_approve_open: 'shift.approve',
  manager_request_rephoto: 'shift.approve',
  driver_submit_end: 'shift.operate',
  manager_approve_close: 'shift.approve',
  manager_reject_close: 'shift.approve',
  manager_reject_open: 'shift.approve',
  suspend: 'shift.approve',
  resume: 'shift.operate',
  week_lock: 'week.close',
  manager_force_cancel: 'shift.approve',
  manager_force_close: 'shift.approve',
}

/** Evidence slots each package requires (SRS C-2, C-3). */
export const REQUIRED_START_SLOTS = ['odometer'] as const
/**
 * The wallet is still returned/zeroed daily like the float (decision D-4), but the product owner
 * dropped the separate `wallet_zeroed` proof photo at close — the wallet-balance screenshot is the
 * evidence. So the close package is the dashboard screenshot, the wallet screenshot and the odometer.
 */
export const REQUIRED_END_SLOTS = ['dashboard', 'wallet', 'odometer'] as const

export type StartSlot = (typeof REQUIRED_START_SLOTS)[number]
export type EndSlot = (typeof REQUIRED_END_SLOTS)[number]

/**
 * The absolute hard ceiling on packs per bike — mirrors the `slot_no BETWEEN 1 AND 8` backstop in
 * 0013. It bounds slot enumeration and the upload-validation superset only; the REAL product limit
 * is the configurable per-vehicle-type `battery_slots` (≤ this), enforced app-side, and the actual
 * per-bike count is derived (COUNT of fitted packs). Raised from 2 once bikes carried three packs.
 */
export const MAX_BATTERY_SLOTS = 8

/** The evidence slot for pack `n`'s BMS screenshot: `bms_1`, `bms_2`. */
export const bmsSlot = (slotNo: number): string => `bms_${slotNo}`

/**
 * Required evidence, given how many battery packs are actually fitted to the bike.
 *
 * This used to be a fixed tuple, which silently assumed every bike is the same machine. A bike
 * carrying two packs must produce two BMS screenshots or half its charge state is unevidenced —
 * and the count is not a number anyone typed, it is how many packs the fleet says are fitted.
 */
export function requiredStartSlots(batterySlots: number): readonly string[] {
  return [...REQUIRED_START_SLOTS, ...batterySlotNumbers(batterySlots).map(bmsSlot)]
}

export function requiredEndSlots(batterySlots: number): readonly string[] {
  return [...REQUIRED_END_SLOTS, ...batterySlotNumbers(batterySlots).map(bmsSlot)]
}

/**
 * «سجل المدفوعات» — the wallet's payments log. Evidence, and the only screen that says what actually
 * MOVED in the wallet (each order leaves Yallago's 20% in it at its own minute, which is how a cash
 * order is told from a part-electronic one). Deliberately NOT in `REQUIRED_END_SLOTS`: a driver
 * whose log will not photograph must still be able to close, and the manager reconciles from the
 * balance screenshot instead. Uploadable, never blocking.
 */
export const PAYMENTS_LOG_SLOT = 'payments_log'

/**
 * How many images ONE scrollable screen may be photographed in.
 *
 * Both «الطلبات الحديثة» and «سجل المدفوعات» scroll, and a day rarely fits in one screenful — a
 * single screenshot silently truncates the list, which on the log means truncating the only
 * measurement of how much of each fee reached the wallet. Eight matches `MAX_BATTERY_SLOTS`, and
 * staying single-digit keeps the plain text sort in `listSlots` («ORDER BY slot») in page order:
 * `dashboard_10` would sort before `dashboard_2`.
 */
export const MAX_PAGE_SLOTS = 8

/**
 * Page `n` of a scrollable screen: `dashboard`, `dashboard_2`, `dashboard_3`, …
 *
 * Page 1 keeps the BARE name. That is what makes this change need no data migration and no alias
 * table: every row already written with slot `dashboard`, every `mediaSlotsEnd` array and
 * `REQUIRED_END_SLOTS` itself are all still correct, because the un-numbered name simply *is*
 * page 1 under the new scheme.
 */
export const pageSlot = (base: string, page: number): string => (page <= 1 ? base : `${base}_${page}`)

/** Pages 2…N of a scrollable screen — the optional extras, never required. */
const extraPages = (base: string): string[] =>
  Array.from({ length: MAX_PAGE_SLOTS - 1 }, (_, i) => pageSlot(base, i + 2))

/** The screens that may arrive as several images. */
export const DASHBOARD_SLOT = 'dashboard'

/** Every slot name an upload may legitimately carry — the superset, for validating a POST. */
export const ALL_START_SLOTS: readonly string[] = requiredStartSlots(MAX_BATTERY_SLOTS)
export const ALL_END_SLOTS: readonly string[] = [
  ...requiredEndSlots(MAX_BATTERY_SLOTS),
  PAYMENTS_LOG_SLOT,
  // Extra pages are acceptance vocabulary only. `requiredEndSlots` is untouched, so no extra page
  // can ever become a `missing_photo` — one dashboard image stays the requirement.
  ...extraPages(DASHBOARD_SLOT),
  ...extraPages(PAYMENTS_LOG_SLOT),
]

function batterySlotNumbers(batterySlots: number): number[] {
  const n = Math.max(0, Math.min(MAX_BATTERY_SLOTS, Math.trunc(batterySlots)))
  return Array.from({ length: n }, (_, i) => i + 1)
}

/** One pack's reading, as the gate sees it. The full BMS record lives in the adapters. */
export interface BatteryReading {
  readonly slotNo: number
  readonly percent: number | null
}

export interface StartPackage {
  readonly mediaSlots: readonly string[]
  readonly batteryPercent: number | null
  readonly odometerKm: number | null
  readonly floatTotal: Minor
  readonly topupTotal: Minor
  readonly driverConfirmedAt: string | null
  /** How many packs are fitted to this bike. 0 keeps pre-battery shifts gating exactly as before. */
  readonly batterySlots?: number
  readonly batteryReadings?: readonly BatteryReading[]
}

export interface EndPackage {
  readonly mediaSlots: readonly string[]
  readonly odometerKm: number | null
  readonly batteryPercent: number | null
  readonly cashDeclared: Minor | null
  readonly walletDeclared: Minor | null
  readonly orderCount: number
  readonly allOrdersConfirmed: boolean
  readonly batterySlots?: number
  readonly batteryReadings?: readonly BatteryReading[]
}

export type PackageGap =
  | { readonly kind: 'missing_photo'; readonly slot: string }
  | { readonly kind: 'missing_value'; readonly field: string }
  | { readonly kind: 'missing_battery_reading'; readonly slotNo: number }
  | { readonly kind: 'unconfirmed_orders' }
  | { readonly kind: 'no_orders' }

/**
 * Which packs have no usable charge reading.
 *
 * A row that exists with a null percent counts as missing: the driver uploaded the screenshot and
 * the OCR came back empty, which is exactly the case a gate must catch rather than wave through.
 */
function batteryGaps(pkg: {
  readonly batterySlots?: number
  readonly batteryReadings?: readonly BatteryReading[]
}): PackageGap[] {
  const readings = pkg.batteryReadings ?? []
  return batterySlotNumbers(pkg.batterySlots ?? 0)
    .filter((slotNo) => {
      const reading = readings.find((r) => r.slotNo === slotNo)
      return reading === undefined || reading.percent === null
    })
    .map((slotNo) => ({ kind: 'missing_battery_reading' as const, slotNo }))
}

/**
 * What is still missing from the start package. Returned as data so the driver's PWA can show a
 * checklist rather than a single unhelpful "incomplete".
 */
export function startPackageGaps(pkg: StartPackage): PackageGap[] {
  const gaps: PackageGap[] = []
  for (const slot of requiredStartSlots(pkg.batterySlots ?? 0)) {
    if (!pkg.mediaSlots.includes(slot)) gaps.push({ kind: 'missing_photo', slot })
  }
  gaps.push(...batteryGaps(pkg))
  if (pkg.odometerKm === null) gaps.push({ kind: 'missing_value', field: 'odometerKm' })
  // No bike-level battery check: charge is tracked PER PACK now (batteryGaps above), so a fitted
  // pack with no reading is what blocks the gate, not a separate whole-bike percentage.
  // A float of zero is legitimate — a driver may start with nothing but a wallet top-up — so
  // the check is "was an amount recorded", not "is it greater than zero".
  if (pkg.floatTotal < 0n) gaps.push({ kind: 'missing_value', field: 'floatTotal' })
  if (pkg.topupTotal < 0n) gaps.push({ kind: 'missing_value', field: 'topupTotal' })
  return gaps
}

export function endPackageGaps(pkg: EndPackage): PackageGap[] {
  const gaps: PackageGap[] = []
  for (const slot of requiredEndSlots(pkg.batterySlots ?? 0)) {
    if (!pkg.mediaSlots.includes(slot)) gaps.push({ kind: 'missing_photo', slot })
  }
  gaps.push(...batteryGaps(pkg))
  if (pkg.odometerKm === null) gaps.push({ kind: 'missing_value', field: 'odometerKm' })
  // Closing charge is tracked per pack (batteryGaps above), not as a whole-bike percentage.
  if (pkg.cashDeclared === null) gaps.push({ kind: 'missing_value', field: 'cashDeclared' })
  if (pkg.walletDeclared === null) gaps.push({ kind: 'missing_value', field: 'walletDeclared' })
  if (pkg.orderCount === 0) gaps.push({ kind: 'no_orders' })
  else if (!pkg.allOrdersConfirmed) gaps.push({ kind: 'unconfirmed_orders' })
  return gaps
}

export type BlockReason =
  | 'illegal_transition'
  | 'forbidden'
  | 'start_package_incomplete'
  | 'driver_not_confirmed'
  | 'end_package_incomplete'
  | 'br1_not_zero'
  | 'br1_split_mismatch'
  | 'orders_changed_since_review'
  | 'week_already_locked'

export interface TransitionContext {
  readonly actor: Actor
  /** The shift's owning driver and branch, for `own`/`branch` scoping. */
  readonly driverId: string
  readonly branchId: string
  readonly startPackage?: StartPackage
  readonly endPackage?: EndPackage
  /** BR1 results, from `evaluateBr1`. */
  readonly br1?: { readonly balanced: boolean; readonly splitBalanced: boolean }
  /**
   * `advisory` warns on a component mismatch; `strict` blocks. The pilot runs advisory while
   * BR1 is calibrated against Yallago's real arithmetic, then switches. See RUNBOOK §1.
   */
  readonly splitGate?: 'advisory' | 'strict'
  /**
   * The orders hash the manager reviewed. If the driver edited an order in the meantime this
   * will not match, and approving would post against numbers nobody actually reviewed.
   */
  readonly reviewedOrdersHash?: string
  readonly currentOrdersHash?: string
  readonly grants?: GrantTable
}

export type TransitionResult =
  | { readonly ok: true; readonly next: ShiftState }
  | { readonly ok: false; readonly reason: BlockReason; readonly gaps?: readonly PackageGap[] }

/** The legal edges, before any guard runs. */
const EDGES: Readonly<Record<ShiftState, Partial<Record<ShiftAction, ShiftState>>>> = {
  draft: { driver_confirm_start: 'awaiting_open_approval', suspend: 'suspended' },
  awaiting_open_approval: {
    manager_approve_open: 'open',
    manager_request_rephoto: 'draft',
    // Refused, and sent back for the driver to redo. Nothing has posted at this state, so there is
    // nothing to reverse — the shift simply returns to his hands with a recorded reason.
    manager_reject_open: 'draft',
    // Refused outright. The bike is released and the shift is closed as cancelled rather than
    // hard-deleted, so the refusal keeps its reason, its decision-log entry and its audit row.
    manager_force_cancel: 'cancelled',
    suspend: 'suspended',
  },
  open: { driver_submit_end: 'pending_review', suspend: 'suspended', manager_force_cancel: 'cancelled', manager_force_close: 'approved' },
  pending_review: {
    manager_approve_close: 'approved',
    manager_reject_close: 'open',
    manager_request_rephoto: 'open',
    suspend: 'suspended',
    manager_force_cancel: 'cancelled',
    manager_force_close: 'approved',
  },
  // «معلقة» (س29): an incident mid-shift. Data is completed later and the shift closes under
  // exactly the same equation — a suspended shift is never a way around BR1.
  suspended: { resume: 'open', driver_submit_end: 'pending_review', manager_force_cancel: 'cancelled', manager_force_close: 'approved' },
  approved: { week_lock: 'week_locked' },
  week_locked: {},
  cancelled: {},
}

export function transition(
  state: ShiftState,
  action: ShiftAction,
  ctx: TransitionContext,
): TransitionResult {
  const next = EDGES[state][action]
  if (next === undefined) {
    return { ok: false, reason: state === 'week_locked' ? 'week_already_locked' : 'illegal_transition' }
  }

  const decision = can(
    ctx.actor,
    ACTION_PERMISSION[action],
    { driverId: ctx.driverId, branchId: ctx.branchId, ownerUserId: null },
    ctx.grants,
  )
  if (!decision.allowed) return { ok: false, reason: 'forbidden' }

  // ── The OPEN gate (BR5) ────────────────────────────────────────────────────────────────
  if (action === 'driver_confirm_start') {
    const gaps = ctx.startPackage ? startPackageGaps(ctx.startPackage) : [{ kind: 'missing_value' as const, field: 'startPackage' }]
    if (gaps.length > 0) return { ok: false, reason: 'start_package_incomplete', gaps }
  }

  if (action === 'manager_approve_open') {
    const pkg = ctx.startPackage
    const gaps = pkg ? startPackageGaps(pkg) : [{ kind: 'missing_value' as const, field: 'startPackage' }]
    if (gaps.length > 0) return { ok: false, reason: 'start_package_incomplete', gaps }
    // The manager's approval is the SECOND signature, never the first — BR5 requires the
    // driver's own confirmation before it, so nobody can open a shift on a driver's behalf.
    if (!pkg || pkg.driverConfirmedAt === null) return { ok: false, reason: 'driver_not_confirmed' }
  }

  // ── The CLOSE gate (BR5) ───────────────────────────────────────────────────────────────
  if (action === 'driver_submit_end') {
    const gaps = ctx.endPackage ? endPackageGaps(ctx.endPackage) : [{ kind: 'missing_value' as const, field: 'endPackage' }]
    if (gaps.length > 0) return { ok: false, reason: 'end_package_incomplete', gaps }
  }

  if (action === 'manager_approve_close') {
    const gaps = ctx.endPackage ? endPackageGaps(ctx.endPackage) : [{ kind: 'missing_value' as const, field: 'endPackage' }]
    if (gaps.length > 0) return { ok: false, reason: 'end_package_incomplete', gaps }

    if (!ctx.br1?.balanced) return { ok: false, reason: 'br1_not_zero' }
    if ((ctx.splitGate ?? 'advisory') === 'strict' && !ctx.br1.splitBalanced) {
      return { ok: false, reason: 'br1_split_mismatch' }
    }

    // Approving against numbers nobody reviewed is how a driver edits an order while the
    // manager has the screen open. Re-checked inside the approval transaction, not before it.
    if (
      ctx.reviewedOrdersHash !== undefined &&
      ctx.currentOrdersHash !== undefined &&
      ctx.reviewedOrdersHash !== ctx.currentOrdersHash
    ) {
      return { ok: false, reason: 'orders_changed_since_review' }
    }
  }

  return { ok: true, next }
}

/** States in which a shift still occupies its driver and vehicle. */
export const LIVE_STATES: readonly ShiftState[] = [
  'draft',
  'awaiting_open_approval',
  'open',
  'pending_review',
  'suspended',
]

export const isLive = (state: ShiftState): boolean => LIVE_STATES.includes(state)

/**
 * States in which a shift is waiting for a branch manager to decide something.
 *
 * These are not a question about a DATE, which is why they are their own list. The approval queue
 * read the branch's shifts for today and filtered client-side, so a close submitted on Saturday and
 * not approved before midnight left the queue on its own — the shift stayed `pending_review`, its
 * money stayed unposted, and the only screen whose job is to show it stopped doing so. Nothing
 * expires an approval: a shift waiting yesterday is still waiting today, and the older it is the
 * more it needs to be at the top of the list.
 */
export const AWAITING_DECISION_STATES: readonly ShiftState[] = ['awaiting_open_approval', 'pending_review']

export const isAwaitingDecision = (state: ShiftState): boolean => AWAITING_DECISION_STATES.includes(state)
