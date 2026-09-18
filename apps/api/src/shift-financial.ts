import type { ShiftOrderRecord, ShiftSettlementRecord } from '@ash/contracts'
import { serializeMoney } from '@ash/contracts'
import { add, minor, splitFixedDriverShare, sum } from '@ash/domain'
import { includedOrders } from './shifts.service.ts'

/** Historical close figures shared by completed-shift and vehicle-history reads. */
export function completedShiftFinancial(
  settlement: ShiftSettlementRecord,
  rows: readonly ShiftOrderRecord[],
): Record<string, string> {
  const counted = includedOrders(rows)
  const yallago = splitFixedDriverShare(counted.filter((row) => row.kind !== 'manual').map((row) => row.fee))
  const manualCompanyShare = sum(
    counted.filter((row) => row.kind === 'manual').map((row) => row.companyShare ?? minor(0n)),
  )

  return {
    policyCode: settlement.policyCode,
    deliveryFees: serializeMoney(sum(counted.map((row) => row.fee))),
    companyShare: serializeMoney(add(yallago.companyShare, manualCompanyShare)),
    yalagoShare: serializeMoney(yallago.yalagoShare),
    grossDriverShare: serializeMoney(settlement.grossDriverShare),
    deductions: serializeMoney(settlement.cashDeductionTotal),
    netDriverShare: serializeMoney(settlement.baseDriverShare),
    expectedTotal: serializeMoney(settlement.expectedTotal),
    actualCash: serializeMoney(settlement.actualCash),
    actualWallet: serializeMoney(settlement.actualWallet),
    actualTotal: serializeMoney(settlement.actualTotal),
    variance: serializeMoney(settlement.variance),
    varianceDirection: settlement.varianceDirection,
    finalEmployeeCash: serializeMoney(settlement.finalEmployeeCash),
    cashClaimToOffice: serializeMoney(settlement.cashClaimToOffice),
    walletClaimToOffice: serializeMoney(settlement.walletClaimToOffice),
    cashReceivableDeferred: serializeMoney(settlement.cashReceivableDeferred),
    walletReceivableDeferred: serializeMoney(settlement.walletReceivableDeferred),
    cashShortageReceivable: serializeMoney(settlement.cashShortageReceivable),
    cashToOffice: serializeMoney(settlement.cashToOffice),
    walletToOffice: serializeMoney(settlement.walletToOffice),
    officeReturn: serializeMoney(add(settlement.cashToOffice, settlement.walletToOffice)),
  }
}
