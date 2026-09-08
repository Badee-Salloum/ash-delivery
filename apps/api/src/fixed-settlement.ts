import { createHash } from 'node:crypto'
import type {
  CalendarDate,
  FixedShareSettlementPlan,
  Minor,
} from '@ash/domain'

export const FIXED_SETTLEMENT_POLICY = 'fixed_40_cash_close_v2_receivable' as const
export const FIXED_SETTLEMENT_DRIVER_BPS = 4_000 as const

export type SettlementVarianceDirection = 'surplus' | 'shortage' | 'balanced'

export function varianceDirection(variance: Minor): SettlementVarianceDirection {
  return variance > 0n ? 'surplus' : variance < 0n ? 'shortage' : 'balanced'
}

export interface SettlementHashContext {
  shiftId: string
  branchId: string
  driverId: string
  businessDate: CalendarDate
  reviewedOrdersHash: string
  /**
   * The exact durable close submission the manager reviewed. Legacy shifts have no draft and use
   * the explicit null sentinel; a re-photo always creates a new revision/hash even when its money
   * happens to be identical.
   */
  closeDraftRevision: number | null
  closeDraftHash: string | null
  closeDraftSubmittedAt: string | null
}

/**
 * Fingerprint every fact that can change the manager's two physical handover instructions.
 *
 * Bigints are encoded as canonical base-10 text. JSON numbers would lose precision and hashing only
 * a subset (for example the orders hash) would let a revised close figure retain stale ticks.
 */
export function fixedSettlementHash(
  context: SettlementHashContext,
  plan: FixedShareSettlementPlan,
): string {
  const canonical = {
    /*
     * 5: «الحسم». Adding a field changes the fingerprint of every shift, including those carrying
     * no charge — which is correct and is what the version is for. An approved shift keeps the hash
     * stored beside its snapshot and is never re-fingerprinted; a shift still under review simply
     * has to be re-read before it can be approved, which is the staleness guard doing its job.
     */
    version: 5,
    policyCode: FIXED_SETTLEMENT_POLICY,
    driverRateBps: FIXED_SETTLEMENT_DRIVER_BPS,
    ...context,
    deliveryFeeTotal: String(plan.deliveryFeeTotal),
    fixedDriverShare: String(plan.fixedDriverShare),
    manualDriverShare: String(plan.manualDriverShare),
    grossDriverShare: String(plan.grossDriverShare),
    cashDeductionTotal: String(plan.cashDeductionTotal),
    baseDriverShare: String(plan.baseDriverShare),
    managerChargeTotal: String(plan.managerChargeTotal),
    expectedCash: String(plan.expectedCash),
    expectedWallet: String(plan.expectedWallet),
    expectedTotal: String(plan.expectedTotal),
    actualCash: String(plan.actualCash),
    actualWallet: String(plan.actualWallet),
    actualTotal: String(plan.actualTotal),
    variance: String(plan.variance),
    finalEmployeeCash: String(plan.finalEmployeeCash),
    officeEntitlement: String(plan.officeEntitlement),
    cashClaimToOffice: String(plan.cashClaimToOffice),
    walletClaimToOffice: String(plan.walletClaimToOffice),
    cashReceivableDeferred: String(plan.cashReceivableDeferred),
    walletReceivableDeferred: String(plan.walletReceivableDeferred),
    maximumCashShortageReceivable: String(plan.maximumCashShortageReceivable),
    cashShortageReceivable: String(plan.cashShortageReceivable),
    walletToOffice: String(plan.walletToOffice),
    cashToOffice: String(plan.cashToOffice),
    walletAction: plan.wallet.action,
    walletAmount: String(plan.wallet.amount),
    cashAction: plan.cash.action,
    cashAmount: String(plan.cash.amount),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
