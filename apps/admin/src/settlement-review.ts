import type { ApproveCloseRequest, ShiftSettlementView } from '@ash/client'
import { abs, formatMinor, parseMinor } from '@ash/domain'

export interface SettlementConfirmationDraft {
  walletTransferConfirmed: boolean
  cashSettlementConfirmed: boolean
  varianceReason: string
}

export interface ForcePreparationDecision {
  gate: string
  decision: string
  decidedAt: string
  notes: string | null
}

/**
 * A preparation belongs only to the current close attempt.
 *
 * Reject/re-photo clears `submittedAt`; a later driver submission creates a new boundary. Keeping
 * an older force marker active would silently turn that ordinary review back into a force-close.
 */
export function activeForcePreparation(
  submittedAt: string | null | undefined,
  decisions: readonly ForcePreparationDecision[],
): ForcePreparationDecision | null {
  if (!submittedAt) return null
  const boundaryMs = Date.parse(submittedAt)
  if (!Number.isFinite(boundaryMs)) return null
  const latest = decisions.find(
    (decision) =>
      decision.gate === 'close' &&
      Number.isFinite(Date.parse(decision.decidedAt)) &&
      Date.parse(decision.decidedAt) >= boundaryMs,
  )
  return latest?.decision === 'force_close_prepared' ? latest : null
}

/** Whether the statement contains a surplus/shortage worth offering an optional manager note for. */
export function settlementHasVariance(settlement: ShiftSettlementView): boolean {
  return settlement.varianceDirection !== 'balanced'
}

/** Direction lives in the explicit label; the adjacent amount is always an easy-to-scan magnitude. */
export function settlementVarianceMagnitude(settlement: ShiftSettlementView): string {
  return formatMinor(abs(parseMinor(settlement.variance)))
}

/**
 * The close button is a physical handover gate, not merely a ledger action.
 *
 * Both confirmations stay mandatory even for a zero action: in that case the manager is attesting
 * that the wallet/cash was checked and genuinely needs no transfer. This keeps a stale screenshot
 * or an unnoticed empty field from turning into an implicit confirmation.
 */
export function settlementApprovalReady(
  settlement: ShiftSettlementView | null,
  draft: SettlementConfirmationDraft,
): boolean {
  if (!settlement || !/^[0-9a-f]{64}$/.test(settlement.settlementHash)) return false
  if (!draft.walletTransferConfirmed || !draft.cashSettlementConfirmed) return false
  return true
}

/** Build the exact snapshot-bound close request after `settlementApprovalReady` succeeds. */
export function closeApprovalRequest(
  reviewedOrdersHash: string,
  settlement: ShiftSettlementView,
  draft: SettlementConfirmationDraft,
): ApproveCloseRequest {
  if (!settlementApprovalReady(settlement, draft)) throw new Error('settlement_confirmation_incomplete')
  const optionalVarianceReason = draft.varianceReason.trim()
  return {
    reviewedOrdersHash,
    reviewedSettlementHash: settlement.settlementHash,
    walletTransferConfirmed: true,
    cashSettlementConfirmed: true,
    cashReceivableDeferred: settlement.cashReceivableDeferred,
    walletReceivableDeferred: settlement.walletReceivableDeferred,
    cashShortageReceivable: settlement.cashShortageReceivable,
    varianceReason:
      settlementHasVariance(settlement) && optionalVarianceReason !== ''
        ? optionalVarianceReason
        : null,
  }
}

/** Every action amount is absolute; this helper keeps action cards honest if a server regresses. */
export function isKnownSettlementAction(settlement: ShiftSettlementView): boolean {
  return (
    ['collect', 'fund', 'none'].includes(settlement.walletAction) &&
    ['collect', 'pay', 'none'].includes(settlement.cashAction) &&
    ['surplus', 'shortage', 'balanced'].includes(settlement.varianceDirection)
  )
}

export function forceCloseFiguresComplete(cashDeclared: string, walletDeclared: string): boolean {
  return forceClosePreparationReady(cashDeclared, walletDeclared)
}

/** Phase one validates figures only; no transfer confirmation exists before the boundary is fixed. */
export function forceClosePreparationReady(cashDeclared: string, walletDeclared: string): boolean {
  const cash = /^\d+(?:\.\d{1,2})?$/
  const wallet = /^-?\d+(?:\.\d{1,2})?$/
  return cash.test(cashDeclared.trim()) && wallet.test(walletDeclared.trim())
}

/** Force-close settles real money too: both actual figures and both handovers are mandatory. */
export function forceCloseConfirmationReady(
  cashDeclared: string,
  walletDeclared: string,
  walletTransferConfirmed: boolean,
  cashSettlementConfirmed: boolean,
): boolean {
  return (
    forceCloseFiguresComplete(cashDeclared, walletDeclared) &&
    walletTransferConfirmed &&
    cashSettlementConfirmed
  )
}

/** A force-close may post only the exact actual-figure preview the manager physically settled. */
export function forceCloseApprovalReady(
  cashDeclared: string,
  walletDeclared: string,
  settlement: ShiftSettlementView | null,
  walletTransferConfirmed: boolean,
  cashSettlementConfirmed: boolean,
): boolean {
  return (
    forceClosePreparationReady(cashDeclared, walletDeclared) &&
    settlement !== null &&
    /^[0-9a-f]{64}$/.test(settlement.settlementHash) &&
    isKnownSettlementAction(settlement) &&
    forceCloseConfirmationReady(
      cashDeclared,
      walletDeclared,
      walletTransferConfirmed,
      cashSettlementConfirmed,
    )
  )
}
