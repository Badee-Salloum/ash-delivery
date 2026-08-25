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
  return (
    input.settlementReady &&
    input.unresolvedOperationCount === 0 &&
    input.managerBatteryReadingCount === 0 &&
    input.pendingTimingDraftCount === 0 &&
    !input.refreshing
  )
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
