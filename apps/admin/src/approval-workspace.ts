import { add, formatMinor, hasVisibleText, parseMinor } from '@ash/domain'
import type { OperationWindowStatus } from './operation-window.ts'

export type CloseDraftReviewReason =
  | 'missing_money'
  | 'missing_time'
  | 'reader_conflict'
  | 'time_conflict'
  | 'cancelled_conflict'
  | 'human_time_edit'
  | 'human_money_edit'
  | 'evidence_removed'

export interface ReviewOrderSummaryInput {
  fee: string
  source?: 'manual' | 'ocr'
  kind?: 'yallago' | 'manual'
  included?: boolean
  feeOcr?: string | null
  windowStatus?: OperationWindowStatus
  decisionReason?: string | null
  windowBasis?: 'printed_time' | 'screen_position' | 'manager' | null
  closeDraftReviewReasons?: readonly CloseDraftReviewReason[]
}

export interface OrderReviewSummary {
  included: { count: number; total: string }
  excluded: { count: number; total: string }
  unresolved: { count: number; total: string }
}

export interface CloseBatteryReadingInput {
  percent: number | null
  unavailable?: boolean
}

export interface CloseWorkspaceApprovalGateInput {
  settlementReady: boolean
  unresolvedOperationCount: number
  managerBatteryReadingCount: number
  pendingTimingDraftCount: number
  refreshing: boolean
}

export interface PhysicalSettlementConfirmations {
  walletTransferConfirmed: boolean
  cashSettlementConfirmed: boolean
}

export interface PhysicalSettlementConfirmationGuard extends PhysicalSettlementConfirmations {
  allowed: boolean
}

/**
 * A wallet/cash tick certifies a physical action against the currently displayed settlement.
 * Unknown-time money rows mean that statement is not final yet, so neither action may be certified
 * and any ticks belonging to the earlier view must be treated as invalid immediately.
 */
export function guardPhysicalSettlementConfirmations(
  unresolvedOperationCount: number,
  confirmations: PhysicalSettlementConfirmations,
): PhysicalSettlementConfirmationGuard {
  if (unresolvedOperationCount > 0) {
    return {
      allowed: false,
      walletTransferConfirmed: false,
      cashSettlementConfirmed: false,
    }
  }
  return { allowed: true, ...confirmations }
}

/** One local timing draft is enough to keep the financial close button unavailable. */
export function closeWorkspaceApprovalReady(input: CloseWorkspaceApprovalGateInput): boolean {
  return approvalBlockerCodes(input).length === 0
}

export type ApprovalBlockerCode =
  | 'recalculating'
  | 'settlement_unavailable'
  | 'settlement_amounts_pending'
  | 'confirm_before_approval'
  | 'unresolved_operations'
  | 'unsaved_timing_draft'
  | 'manager_battery_required'
  | 'force_reason_required'

export interface ApprovalBlockerInput extends CloseWorkspaceApprovalGateInput {
  /** Split out of `settlementReady` so each half can name itself. */
  settlementLoaded?: boolean
  deferralMatches?: boolean
  confirmationsComplete?: boolean
  forcePrepared?: boolean
  forceReason?: string
}

/**
 * WHY the close button is dead — every reason, by code, in reading order.
 *
 * `closeWorkspaceApprovalReady` is defined AS "this list is empty", so the button and its
 * explanation cannot disagree. That is not tidiness: two of the five gate terms —
 * `deferralMatchesSettlement` and the settlement-hash shape — used to disable the button while
 * contributing nothing to the displayed list, and a manager reading a dead button with no reason
 * concludes the console is broken and goes looking for a way around the gate.
 *
 * The caller resolves each code through `t.close.blocker.*`; the domain emits codes, the UI
 * resolves them.
 */
export function approvalBlockerCodes(input: ApprovalBlockerInput): ApprovalBlockerCode[] {
  const codes: ApprovalBlockerCode[] = []
  if (input.refreshing) codes.push('recalculating')
  else if (input.settlementLoaded === false) codes.push('settlement_unavailable')

  if (!input.settlementReady && input.settlementLoaded !== false && !input.refreshing) {
    // The statement loaded, so say which half of "ready" is missing rather than one vague line.
    if (input.deferralMatches === false) codes.push('settlement_amounts_pending')
    if (input.confirmationsComplete === false) codes.push('confirm_before_approval')
    if (input.deferralMatches !== false && input.confirmationsComplete !== false) {
      // Neither half explains it: the hash is malformed, which is a server or transport fault the
      // manager cannot fix by typing. Name it as an unavailable statement rather than stay silent.
      codes.push('settlement_unavailable')
    }
  }

  if (input.unresolvedOperationCount > 0) codes.push('unresolved_operations')
  if (input.pendingTimingDraftCount > 0) codes.push('unsaved_timing_draft')
  if (input.managerBatteryReadingCount > 0) codes.push('manager_battery_required')
  /*
   * `hasVisibleText`, not `.trim()`. An exceptional close is the one path where the reason is
   * MANDATORY, and `'‏'.trim()` is truthy — an RTL mark pasted along with Arabic used to pass
   * as an audit trail. The server already refuses it (`normalizedSettlementReason` tests
   * `\p{White_Space}|\p{Cf}`); this makes the button agree with the server instead of letting the
   * manager write something the ledger will not keep.
   */
  if (input.forcePrepared === true && !hasVisibleText(input.forceReason ?? '')) {
    codes.push('force_reason_required')
  }
  return codes
}

export type TimingRevisionDecision = 'preserve' | 'include' | 'duplicate'

/**
 * Persisted money rows collapse a failed AI read to `source: manual` once the driver types the
 * unread value. The durable dashboard-origin markers are therefore the Yallago kind (unless the
 * manager created that reconciliation row) and the automatic Recent Orders deduction key.
 */
export function orderHasDashboardEvidenceOrigin(order: {
  kind?: 'yallago' | 'manual'
  decisionReason?: string | null
}): boolean {
  return order.kind !== 'manual' && order.decisionReason !== 'manager_manual_entry'
}

export function deductionHasDashboardEvidenceOrigin(deduction: {
  source: 'ocr' | 'manual'
  operationKey: string
}): boolean {
  return deduction.source === 'ocr' || deduction.operationKey.startsWith('recent-orders:')
}

/**
 * Time and inclusion move in one audited request. In particular, correcting an excluded duplicate
 * must not let window classification silently re-include it, while a verified post-close OCR row
 * can be corrected and included deliberately in the same transaction.
 */
export function buildOrderTimingRevision(
  currentIncluded: boolean | undefined,
  occurredDate: string | null,
  occurredMinute: string | null,
  decision: TimingRevisionDecision,
): { occurredDate: string | null; occurredMinute: string | null; included: boolean } {
  return {
    occurredDate,
    occurredMinute,
    included: decision === 'include' ? true : decision === 'duplicate' ? false : currentIncluded !== false,
  }
}

/** Marking a duplicate alone must not rewrite a suspect OCR clock with that same suspect value. */
export function buildOrderDuplicateRevision(
  currentDate: string | null,
  currentMinute: string | null,
  draftDate: string | null,
  draftMinute: string | null,
): { included: false; occurredDate?: string | null; occurredMinute?: string | null } {
  if (currentDate === draftDate && currentMinute === draftMinute) return { included: false }
  return { included: false, occurredDate: draftDate, occurredMinute: draftMinute }
}

/**
 * An OCR row is ordinary once its value and time are accepted. Attention is reserved for a real
 * exception or an audited manager decision, so the close workspace does not turn every scanned
 * delivery into noise.
 */
export function orderNeedsAttention(order: ReviewOrderSummaryInput): boolean {
  return (
    order.included === false ||
    order.kind === 'manual' ||
    order.windowStatus === 'unknown' ||
    order.windowStatus === 'pre_open' ||
    order.windowStatus === 'post_close' ||
    Boolean(order.decisionReason) ||
    order.windowBasis === 'screen_position' ||
    (order.closeDraftReviewReasons?.length ?? 0) > 0 ||
    (order.feeOcr != null && order.feeOcr !== order.fee)
  )
}

/** Human-facing copy for the durable reader reasons that must be resolved before approval. */
export function closeDraftReviewReasonLabel(
  reason: CloseDraftReviewReason,
  lang: 'ar' | 'en',
): string {
  const labels: Record<CloseDraftReviewReason, { ar: string; en: string }> = {
    missing_money: { ar: 'الأجرة غير موثقة', en: 'Fee is not verified' },
    missing_time: { ar: 'الوقت غير موثق', en: 'Time is not verified' },
    reader_conflict: { ar: 'اختلفت قراءات الذكاء الاصطناعي', en: 'AI readings disagree' },
    time_conflict: { ar: 'تعارض وقت الطلب', en: 'Order time conflicts' },
    cancelled_conflict: { ar: 'تعارض حول إلغاء الطلب', en: 'Cancellation status conflicts' },
    human_time_edit: { ar: 'وقت أدخله السائق ويحتاج اعتماداً', en: 'Driver-entered time needs approval' },
    human_money_edit: { ar: 'مبلغ أدخله السائق ويحتاج اعتماداً', en: 'Driver-entered amount needs approval' },
    evidence_removed: { ar: 'فقد الصف آخر صورة داعمة', en: 'The row lost its last supporting image' },
  }
  return labels[reason][lang]
}

/**
 * Positional evidence is an interval, not a fabricated clock. Keep the bounds readable in the
 * manager audit without ever presenting either edge as the operation's actual minute.
 */
export function positionEvidenceLabel(
  evidence: { lowerInstant?: string | null; upperInstant?: string | null } | null | undefined,
  separator = ' → ',
): string | null {
  if (!evidence) return null
  const lower = evidence.lowerInstant?.trim() || null
  const upper = evidence.upperInstant?.trim() || null
  if (!lower && !upper) return null
  return `${lower ?? '…'}${separator}${upper ?? '…'}`
}

/** Counts and totals remain visible even while ordinary rows are folded away. */
export function summarizeOrders(orders: readonly ReviewOrderSummaryInput[]): OrderReviewSummary {
  const summarize = (predicate: (order: ReviewOrderSummaryInput) => boolean): { count: number; total: string } => {
    const rows = orders.filter(predicate)
    return {
      count: rows.length,
      total: formatMinor(rows.reduce((sum, row) => add(sum, parseMinor(row.fee || '0')), parseMinor('0'))),
    }
  }

  // An unknown clock needs a manager decision, not necessarily a guessed clock. Once the manager
  // records an audited reason, the row belongs in the financial bucket selected by `included`.
  // Keeping it in «unknown» after that would make the included total disagree with settlement.
  const needsDecision = (order: ReviewOrderSummaryInput): boolean =>
    (order.closeDraftReviewReasons?.length ?? 0) > 0 ||
    (order.windowStatus === 'unknown' && !hasVisibleText(order.decisionReason))

  return {
    included: summarize((order) => !needsDecision(order) && order.included !== false),
    excluded: summarize((order) => !needsDecision(order) && order.included === false),
    unresolved: summarize(needsDecision),
  }
}

/**
 * The manager-approval domain gate evaluates the END package. A driver who declared that the BMS
 * app cannot run has moved this one reading to the manager; it remains a hard close blocker until
 * the manager records a real percentage.
 */
export function countAwaitingCloseBatteryReadings(
  endReadings: readonly CloseBatteryReadingInput[],
): number {
  return endReadings.filter((reading) => reading.unavailable === true && reading.percent === null).length
}
