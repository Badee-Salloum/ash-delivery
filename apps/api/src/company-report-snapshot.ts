import type { FinancialTransactionDeps } from '@ash/contracts'
import type { CompanyReportSnapshot } from './company-report.service.ts'

/** Shared, transaction-bound evidence for reports and dashboard. Never reads a global pool. */
export async function loadCompanyReportSnapshot(tx: FinancialTransactionDeps, branchId: string, today: string): Promise<CompanyReportSnapshot> {
  const [movements, commands, corrections, metadata, proposals, debts, assets, cutovers, historicalSources, historicalSourceCorrections] = await Promise.all([
    tx.companyLedgerSource.listMovements(branchId, { from: '2000-01-01', to: today }),
    tx.companyLedger.listCommands(branchId), tx.companyMovementReview.listCorrections(branchId),
    tx.companyMovementReview.listMetadata(branchId), tx.companyRestorationReviews.list(branchId),
    tx.companyFinance.listDebts(branchId), tx.companyFinance.listAssets(branchId), tx.companyLedger.listCutovers(),
    tx.companyLedgerSource.listHistoricalImportReceipts(branchId, { from: '2000-01-01', to: today }),
    tx.companyMovementReview.listHistoricalSourceCorrections(branchId),
  ])
  const receiptOccurrences = new Map<number, string>(), receiptSourceEntries = new Map<number, number>()
  for (const link of await tx.companyLedger.listHistoricalBranchLinks(branchId)) {
    receiptOccurrences.set(link.companyEntryId, link.occurredOn)
    receiptSourceEntries.set(link.companyEntryId, link.sourceEntryId)
  }
  for (const asset of assets) receiptOccurrences.set(asset.journalEntryId, asset.purchasedOn)
  for (const debt of debts) {
    if (!receiptOccurrences.has(debt.journalEntryId)) receiptOccurrences.set(debt.journalEntryId, debt.openedOn)
    for (const event of await tx.companyFinance.listDebtEvents(debt.id)) receiptOccurrences.set(event.journalEntryId, event.occurredOn)
  }
  for (const cutover of cutovers.filter(row => row.companyBranchId === branchId)) for (const mirror of await tx.companyLedger.listMirrors(cutover.branchId)) {
    const source = await tx.ledger.findEntryById(mirror.sourceEntryId)
    if (source) {
      receiptOccurrences.set(mirror.mirrorEntryId, source.businessDate)
      receiptSourceEntries.set(mirror.mirrorEntryId, source.id)
    }
  }
  const restorations = await Promise.all(proposals.map(async proposal => ({ proposal,
    revisions: await tx.companyRestorationReviews.listRevisions(proposal.id) })))
  return { movements, commands, corrections, metadata, receiptOccurrences, receiptSourceEntries,
    restorations, historicalSources, historicalSourceCorrections }
}
