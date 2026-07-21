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

export type ShiftAction =
  | 'driver_confirm_start'
  | 'manager_approve_open'
  | 'manager_request_rephoto'
  | 'driver_submit_end'
  | 'manager_approve_close'
  | 'manager_reject_close'
  | 'suspend'
  | 'resume'
  | 'week_lock'

/** Which permission each action requires. Checked server-side; UI hiding is not security. */
export const ACTION_PERMISSION: Readonly<Record<ShiftAction, PermissionKey>> = {
  driver_confirm_start: 'shift.operate',
  manager_approve_open: 'shift.approve',
  manager_request_rephoto: 'shift.approve',
  driver_submit_end: 'shift.operate',
  manager_approve_close: 'shift.approve',
  manager_reject_close: 'shift.approve',
  suspend: 'shift.approve',
  resume: 'shift.operate',
  week_lock: 'week.close',
}

/** Evidence slots each package requires (SRS C-2, C-3). */
export const REQUIRED_START_SLOTS = ['odometer'] as const
/** `wallet_zeroed` exists because the wallet is returned daily like the float (decision D-4). */
export const REQUIRED_END_SLOTS = ['dashboard', 'wallet', 'odometer', 'wallet_zeroed'] as const

export type StartSlot = (typeof REQUIRED_START_SLOTS)[number]
export type EndSlot = (typeof REQUIRED_END_SLOTS)[number]

export interface StartPackage {
  readonly mediaSlots: readonly string[]
  readonly batteryPercent: number | null
  readonly odometerKm: number | null
  readonly floatTotal: Minor
  readonly topupTotal: Minor
  readonly driverConfirmedAt: string | null
}

export interface EndPackage {
  readonly mediaSlots: readonly string[]
  readonly odometerKm: number | null
  readonly batteryPercent: number | null
  readonly cashDeclared: Minor | null
  readonly walletDeclared: Minor | null
  readonly orderCount: number
  readonly allOrdersConfirmed: boolean
}

export type PackageGap =
  | { readonly kind: 'missing_photo'; readonly slot: string }
  | { readonly kind: 'missing_value'; readonly field: string }
  | { readonly kind: 'unconfirmed_orders' }
  | { readonly kind: 'no_orders' }

/**
 * What is still missing from the start package. Returned as data so the driver's PWA can show a
 * checklist rather than a single unhelpful "incomplete".
 */
export function startPackageGaps(pkg: StartPackage): PackageGap[] {
  const gaps: PackageGap[] = []
  for (const slot of REQUIRED_START_SLOTS) {
    if (!pkg.mediaSlots.includes(slot)) gaps.push({ kind: 'missing_photo', slot })
  }
  if (pkg.odometerKm === null) gaps.push({ kind: 'missing_value', field: 'odometerKm' })
  if (pkg.batteryPercent === null) gaps.push({ kind: 'missing_value', field: 'batteryPercent' })
  // A float of zero is legitimate — a driver may start with nothing but a wallet top-up — so
  // the check is "was an amount recorded", not "is it greater than zero".
  if (pkg.floatTotal < 0n) gaps.push({ kind: 'missing_value', field: 'floatTotal' })
  if (pkg.topupTotal < 0n) gaps.push({ kind: 'missing_value', field: 'topupTotal' })
  return gaps
}

export function endPackageGaps(pkg: EndPackage): PackageGap[] {
  const gaps: PackageGap[] = []
  for (const slot of REQUIRED_END_SLOTS) {
    if (!pkg.mediaSlots.includes(slot)) gaps.push({ kind: 'missing_photo', slot })
  }
  if (pkg.odometerKm === null) gaps.push({ kind: 'missing_value', field: 'odometerKm' })
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
    suspend: 'suspended',
  },
  open: { driver_submit_end: 'pending_review', suspend: 'suspended' },
  pending_review: {
    manager_approve_close: 'approved',
    manager_reject_close: 'open',
    manager_request_rephoto: 'open',
    suspend: 'suspended',
  },
  // «معلقة» (س29): an incident mid-shift. Data is completed later and the shift closes under
  // exactly the same equation — a suspended shift is never a way around BR1.
  suspended: { resume: 'open', driver_submit_end: 'pending_review' },
  approved: { week_lock: 'week_locked' },
  week_locked: {},
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
