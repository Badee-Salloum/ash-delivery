import { randomUUID } from 'node:crypto'
import type { CompanyCommandRecord, CompanyExpenseCorrectionValues, FinancialTransactionDeps } from '@ash/contracts'
import { parseMinor } from '@ash/domain'
import { activeAssetPayments, assetPaymentHash } from './company-existing-asset-payments.service.ts'
import { ServiceError } from './shifts.service.ts'

/** No mutation may leave an approved asset/sale or linked debt pointing at cancelled money. */
export async function assertCompanyOperationLinks(tx: FinancialTransactionDeps, command: CompanyCommandRecord): Promise<void> {
  const cards = await tx.existingAssets.linkedToOperation(command.id, command.journalEntryId)
  const corrections = await tx.companyMovementReview.listCorrections(command.branchId)
  const root = corrections.find(row => row.status === 'confirmed' && row.replacementId === command.id)?.targetId ?? command.id
  const links = activeAssetPayments(await tx.existingAssets.paymentEvents(command.branchId)).filter(row =>
    row.data.sourceKey === `command:${command.id}` || row.data.sourceKey === `command:${root}`)
  for (const assetId of new Set(links.map(row => row.assetId))) {
    const card = await tx.existingAssets.get(assetId)
    if (card && !cards.some(row => row.id === assetId)) cards.push(card)
  }
  if (cards.some(card => card.sale?.status === 'confirmed' && card.sale.receiptEntryId === command.journalEntryId))
    throw new ServiceError(409, 'asset_sale_receipt_correction_required')
  if (cards.some(card => card.accountingStatus === 'approved' || card.recognition !== null || card.depreciation !== null || card.sale !== null))
    throw new ServiceError(422, 'company_correction_linked_review_required', { blockingReasons: ['linked_asset_review_required'] })
  const debts = await tx.companyFinance.listDebts(command.branchId)
  if (debts.some(debt => debt.journalEntryId === command.journalEntryId))
    throw new ServiceError(422, 'company_correction_linked_review_required', { blockingReasons: ['linked_debt_review_required'] })
}

/** Explicit allocations keep their amounts. Never guess how to split a reduced receipt. */
export async function refreshCorrectedExpensePayments(tx: FinancialTransactionDeps, branchId: string, rootId: string,
  values: Pick<CompanyExpenseCorrectionValues, 'amount' | 'currency' | 'occurredOn' | 'paidFrom' | 'description'>,
  actorId: string, nowMs: number, reason: string, sourceKey = `command:${rootId}`): Promise<void> {
  const events = await tx.existingAssets.paymentEvents(branchId)
  const links = activeAssetPayments(events).filter(row => row.data.sourceKey === sourceKey)
  if (!links.length) return
  if (links.some(row => row.data.currency !== values.currency) ||
    links.reduce((sum, row) => sum + parseMinor(row.data.amount!), 0n) > parseMinor(values.amount))
    throw new ServiceError(422, 'company_operation_payment_reallocation_required')
  const sourceHash = assetPaymentHash([sourceKey, values.amount, values.currency, values.occurredOn, values.paidFrom])
  const changed = links.filter(row => row.data.sourceHash !== sourceHash)
  for (const link of changed) {
    const card = await tx.existingAssets.get(link.assetId)
    if (!card || card.status === 'sold' || card.pendingEdit || card.currency !== values.currency)
      throw new ServiceError(422, 'company_operation_payment_reallocation_required')
    let version = Math.max(0, ...events.filter(row => row.assetId === link.assetId).map(row => row.version))
    const unlink = { id: randomUUID(), assetId: link.assetId, branchId, version: ++version, kind: 'unlink' as const,
      requestHash: assetPaymentHash(['correct-source-unlink', link.id, sourceHash]), reason: reason.slice(0, 500),
      data: { paymentId: link.id }, createdBy: actorId, createdAtMs: nowMs }
    await tx.existingAssets.addPaymentEvent(unlink); events.push(unlink)
    const replacement = { ...link, id: randomUUID(), version: ++version,
      requestHash: assetPaymentHash(['correct-source-link', link.id, sourceHash]), reason: reason.slice(0, 500),
      data: { ...link.data, sourceHash, currency: values.currency, occurredOn: values.occurredOn,
        paidFrom: values.paidFrom, description: values.description, newExpense: false }, createdBy: actorId, createdAtMs: nowMs }
    await tx.existingAssets.addPaymentEvent(replacement); events.push(replacement)
  }
  for (const assetId of new Set(changed.map(row => row.assetId))) {
    const plan = events.filter(row => row.assetId === assetId && (row.kind === 'schedule' || row.kind === 'cancel_schedule')).at(-1)
    if (plan?.kind === 'schedule') {
      const row = { id: randomUUID(), assetId, branchId,
        version: Math.max(0, ...events.filter(row => row.assetId === assetId).map(row => row.version)) + 1, kind: 'cancel_schedule' as const,
        requestHash: assetPaymentHash(['corrected-source-plan', sourceHash, assetId]), reason: reason.slice(0, 500), data: {}, createdBy: actorId, createdAtMs: nowMs }
      await tx.existingAssets.addPaymentEvent(row); events.push(row)
    }
  }
}

/** Cancel documentary allocations in the SAME transaction as deletion; never posts money. */
export async function unlinkDeletedExpensePayments(tx: FinancialTransactionDeps, branchId: string,
  commandIds: readonly string[], actorId: string, nowMs: number, reason: string, sourceKeys: readonly string[] = []): Promise<void> {
  const events = await tx.existingAssets.paymentEvents(branchId)
  const keys = new Set([...commandIds.map(id => `command:${id}`), ...sourceKeys])
  const links = activeAssetPayments(events).filter(row => keys.has(row.data.sourceKey ?? ''))
  for (const assetId of new Set(links.map(row => row.assetId))) {
    const card = await tx.existingAssets.get(assetId)
    if (card && (card.status === 'sold' || card.accountingStatus === 'approved' || card.recognition !== null || card.depreciation !== null))
      throw new ServiceError(422, 'company_correction_linked_review_required', { blockingReasons: ['linked_asset_review_required'] })
  }
  const versions = new Map<string, number>()
  const append = async (row: (typeof events)[number]) => {
    await tx.existingAssets.addPaymentEvent(row); events.push(row); versions.set(row.assetId, row.version)
  }
  const next = (id: string) => (versions.get(id) ?? Math.max(0, ...events.filter(row => row.assetId === id).map(row => row.version))) + 1
  for (const link of links) await append({ id: randomUUID(), assetId: link.assetId, branchId, version: next(link.assetId),
    kind: 'unlink', requestHash: assetPaymentHash(['delete', commandIds, link.id, actorId]), reason: reason.slice(0, 500),
    data: { paymentId: link.id }, createdBy: actorId, createdAtMs: nowMs })
  // A plan assumed a payment that no longer exists. Do not invent new dates or silently keep
  // stale reminders: cancel it explicitly with an audit event, leaving the price unpaid.
  for (const assetId of new Set(links.map(row => row.assetId))) {
    const plan = events.filter(row => row.assetId === assetId && (row.kind === 'schedule' || row.kind === 'cancel_schedule')).at(-1)
    if (plan?.kind === 'schedule') await append({ id: randomUUID(), assetId, branchId, version: next(assetId), kind: 'cancel_schedule',
      requestHash: assetPaymentHash(['deleted-source-plan', commandIds, assetId]), reason: reason.slice(0, 500), data: {}, createdBy: actorId, createdAtMs: nowMs })
  }
}
