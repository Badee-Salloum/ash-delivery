import { createHash } from 'node:crypto'
import type { Deps, ExistingAssetPaymentEvent, ExistingAssetRecord, FinancialTransactionDeps } from '@ash/contracts'
import { serializeMoney } from '@ash/contracts'
import { addDays, addMonths, minor, parseMinor, type CalendarDate, type Currency } from '@ash/domain'
import { effectiveExpenseView } from './company-movement-read.service.ts'
import { effectiveHistoricalSource } from './company-historical-source.service.ts'
import { ServiceError, todayFor } from './shifts.service.ts'

export type AssetPaymentSource = { key: string; amount: string; currency: Currency; occurredOn: CalendarDate; paidFrom: string; description: string; hash: string }
export const assetPaymentHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function activeAssetPayments(events: readonly ExistingAssetPaymentEvent[]): ExistingAssetPaymentEvent[] {
  const removed = new Set(events.filter(row => row.kind === 'unlink').map(row => row.data.paymentId))
  return events.filter(row => row.kind === 'link' && !removed.has(row.id))
}
export async function assetPaymentSources(deps: Deps, tx: FinancialTransactionDeps, branchId: string): Promise<AssetPaymentSource[]> {
  const commands = await tx.companyLedger.listCommands(branchId), byId = new Map(commands.map(row => [row.id, row]))
  const corrections = await tx.companyMovementReview.listCorrections(branchId)
  const replacements = new Set(corrections.filter(row => row.status === 'confirmed' && row.financial).map(row => row.replacementId))
  const sources: AssetPaymentSource[] = []
  for (const command of commands) {
    if (command.kind !== 'expense' || replacements.has(command.id)) continue
    const current = effectiveExpenseView(command, byId, corrections, null)
    if (await tx.companyLedger.findReversalOf(current.effective.journalEntryId)) continue
    const values = current.wire
    const key = `command:${command.id}`
    sources.push({ key, amount: values.amount, currency: values.currency, occurredOn: values.occurredOn,
      paidFrom: values.paidFrom, description: values.description,
      hash: assetPaymentHash([key, values.amount, values.currency, values.occurredOn, values.paidFrom]) })
  }
  // Owner-funded historical purchases are administrative evidence, not fabricated HQ expenses.
  const receipts = await tx.companyLedgerSource.listHistoricalImportReceipts(branchId, { from: '2000-01-01', to: todayFor(deps) })
  const revisions = await tx.companyMovementReview.listHistoricalSourceCorrections(branchId)
  for (const receipt of receipts) {
    if (receipt.journalEntryId !== null) continue // cash-backed imported expenses already have their canonical command
    const current = effectiveHistoricalSource(receipt, revisions)
    if (current.excluded || current.paidFrom !== 'owner_outside' || !['expense', 'asset_payment'].includes(current.movementType) ||
      current.currency === null || current.amount === null || current.amount <= 0n) continue
    const key = `historical:${current.sourceReference}`, amount = serializeMoney(current.amount)
    sources.push({ key, amount, currency: current.currency, occurredOn: current.occurredOn, paidFrom: current.paidFrom,
      description: current.description, hash: assetPaymentHash([key, amount, current.currency, current.occurredOn, current.paidFrom]) })
  }
  return sources
}
export function paymentSummary(card: ExistingAssetRecord, events: readonly ExistingAssetPaymentEvent[], sources: readonly AssetPaymentSource[], today: CalendarDate) {
  const sourceMap = new Map(sources.map(source => [source.key, source]))
  const own = events.filter(row => row.assetId === card.id), active = activeAssetPayments(events).filter(row => row.assetId === card.id)
  const payments = active.map(row => {
    const source = sourceMap.get(row.data.sourceKey!)
    return { ...row, data: { ...row.data, ...(source ? { description: source.description } : {}) },
      needsReview: source?.hash !== row.data.sourceHash || row.data.currency !== card.currency }
  })
  const paid = payments.filter(row => !row.needsReview).reduce((sum, row) => sum + parseMinor(row.data.amount!), 0n)
  const remaining = card.price === null ? null : card.price - paid
  const latestPlan = own.filter(row => row.kind === 'schedule' || row.kind === 'cancel_schedule').at(-1)
  const plan = latestPlan?.kind === 'schedule' ? latestPlan : null
  const invalidPlan = !!plan && (plan.data.priceSnapshot !== card.price?.toString() || payments.some(row => row.needsReview) ||
    paid < parseMinor(plan.data.baselinePaid ?? '0.00') || own.some(row => row.kind === 'unlink' && row.version > plan.version &&
      own.some(payment => payment.id === row.data.paymentId && payment.version <= plan.version)))
  // Exact allocations paid after the schedule was created settle its oldest rows, not new expenses.
  let available = plan ? payments.filter(row => !row.needsReview && row.version > plan.version).reduce((sum, row) => sum + parseMinor(row.data.amount!), 0n) : 0n
  const installments = plan?.data.installments?.map(row => {
    const amount = parseMinor(row.amount), settled = available > amount ? amount : available
    available -= settled
    return { ...row, paid: serializeMoney(minor(settled)), remaining: serializeMoney(minor(amount - settled)),
      status: invalidPlan ? 'needs_review' : settled === amount ? 'paid' : row.dueOn < today ? 'overdue' : row.dueOn === today ? 'due' : 'scheduled',
      remind: !invalidPlan && settled < amount && row.dueOn <= addDays(today, plan.data.reminderDays ?? 0) }
  }) ?? []
  return { version: own.length, totalPaid: serializeMoney(minor(paid)), remaining: remaining === null ? null : serializeMoney(minor(remaining)),
    status: payments.some(row => row.needsReview) || remaining !== null && remaining < 0n ? 'needs_review' : payments.length ? 'documented' : 'not_documented',
    payments, history: own, plan, installments, reminderCount: installments.filter(row => row.remind).length,
    administrativeOnly: true, cashEffect: 'none', createsDebt: false }
}
export async function validateAssetPayment(deps: Deps, tx: FinancialTransactionDeps, branchId: string, assetId: string,
  source: AssetPaymentSource, amount: string, expectedVersion: number) {
  const card = await tx.existingAssets.get(assetId)
  if (!card || card.branchId !== branchId) throw new ServiceError(404, 'asset_not_found')
  if (card.price === null || card.status === 'sold' || card.pendingEdit) throw new ServiceError(422, 'asset_payment_card_not_ready')
  if (card.version !== expectedVersion) throw new ServiceError(409, 'asset_version_conflict')
  if (source.currency !== card.currency) throw new ServiceError(422, 'asset_payment_currency_mismatch')
  const allocated = parseMinor(amount)
  if (allocated <= 0n) throw new ServiceError(422, 'asset_payment_invalid_amount')
  const events = await tx.existingAssets.paymentEvents(branchId), active = activeAssetPayments(events)
  if (active.filter(row => row.data.sourceKey === source.key).reduce((sum, row) => sum + parseMinor(row.data.amount!), 0n) + allocated > parseMinor(source.amount)) {
    throw new ServiceError(409, 'asset_payment_source_overallocated')
  }
  // Reserve even stale allocations until explicitly unlinked; never silently spend one receipt twice.
  if (active.filter(row => row.assetId === card.id).reduce((sum, row) => sum + parseMinor(row.data.amount!), 0n) + allocated > card.price) {
    throw new ServiceError(422, 'asset_payment_exceeds_price')
  }
  return { card, events }
}
export async function saveAssetPayment(deps: Deps, tx: FinancialTransactionDeps, input: {
  id: string; branchId: string; assetId: string; expectedVersion: number; source: AssetPaymentSource; amount: string;
  actorId: string; reason: string; requestHash: string; newExpense: boolean
}) {
  const { events } = await validateAssetPayment(deps, tx, input.branchId, input.assetId, input.source, input.amount, input.expectedVersion)
  const row: ExistingAssetPaymentEvent = { id: input.id, assetId: input.assetId, branchId: input.branchId,
    version: events.filter(row => row.assetId === input.assetId).length + 1, kind: 'link', requestHash: input.requestHash, reason: input.reason,
    data: { sourceKey: input.source.key, sourceHash: input.source.hash, amount: input.amount, currency: input.source.currency,
      occurredOn: input.source.occurredOn, paidFrom: input.source.paidFrom, description: input.source.description, newExpense: input.newExpense },
    createdBy: input.actorId, createdAtMs: deps.clock.nowMs() }
  await tx.existingAssets.addPaymentEvent(row)
  return row
}
export function buildAssetInstallments(amount: bigint, remaining: bigint, firstDueOn: CalendarDate, recurrence: 'monthly' | 'weekly' | 'every_n_days', intervalDays: number) {
  if (amount <= 0n || remaining <= 0n || (remaining + amount - 1n) / amount > 600n) throw new ServiceError(422, 'asset_payment_invalid_schedule')
  const rows: Array<{ dueOn: CalendarDate; amount: string }> = []
  for (let index = 0; remaining > 0n; index++) {
    const dueOn = recurrence === 'monthly' ? addMonths(firstDueOn, index) : addDays(firstDueOn, index * (recurrence === 'weekly' ? 7 : intervalDays))
    const installment = remaining > amount ? amount : remaining
    rows.push({ dueOn, amount: serializeMoney(minor(installment)) }); remaining -= installment
  }
  return rows
}
