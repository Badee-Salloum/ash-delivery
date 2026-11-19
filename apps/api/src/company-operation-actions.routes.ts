import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { CompanyCommandRecord, CompanyMovementMetadata, Deps, FinancialTransactionDeps } from '@ash/contracts'
import { moneySchema, reversalTargetKindOf } from '@ash/contracts'
import { companyDeposit, companyWithdrawal, companyIncome, companyFxExchange, companyReversal, exchangeRate,
  fundCode, fundRefFromCode, hasVisibleText, isCalendarDate, isDateLocked, weekStartFor, type Posting } from '@ash/domain'
import { ServiceError, ensureFxDay, todayFor } from './shifts.service.ts'
import { assertCompanyOperationLinks } from './company-operation-links.service.ts'

const id = z.string().uuid().transform(value => value.toLowerCase())
const text = z.string().trim().min(1).max(500).refine(hasVisibleText)
const amount = moneySchema.refine(value => value > 0n)
const changes = z.object({ amount: amount.optional(), currency: z.enum(['SYP_NEW', 'USD']).optional(),
  fromAmount: amount.optional(), toAmount: amount.optional(), fromCurrency: z.enum(['SYP_NEW', 'USD']).optional(),
  toCurrency: z.enum(['SYP_NEW', 'USD']).optional(), description: text.optional(), categoryId: id.optional(),
  occurredOn: z.string().refine(isCalendarDate).refine(value => value >= '2000-01-01').optional(), historicalRate: amount.optional(),
}).strict().refine(value => Object.keys(value).length > 0)
const input = z.object({ idempotencyKey: id, expectedEntryId: z.number().int().positive(), action: z.enum(['edit', 'delete']),
  reason: text, values: changes.optional() }).strict().superRefine((body, ctx) => {
  if ((body.action === 'edit') !== (body.values !== undefined)) ctx.addIssue({ code: 'custom', path: ['values'], message: 'edit requires changes; delete accepts none' })
})
const wire = (value: unknown) => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))
const hash = (value: unknown): string => {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item !== null && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
    : typeof item === 'bigint' ? item.toString() : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

/** Direct commands only. Branch mirrors, custody, debt and asset journals have dedicated commands. */
export function registerCompanyOperationActionRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/company/operations/:id/actions', { config: { permission: 'company_fund.manage' } }, async (req, reply) => {
    if (!['general_manager', 'system_admin'].includes(req.actor!.roleKey)) throw new ServiceError(403, 'forbidden')
    const targetId = z.object({ id }).parse(req.params).id, body = input.parse(req.body)
    const company = await deps.directory.companyBranch()
    if (!company) throw new ServiceError(500, 'company_branch_missing')
    const branchId = company.id, actorId = req.actor!.userId, requestHash = hash({ targetId, body, actorId })
    const day = todayFor(deps)
    // Resolve global calendar repositories before borrowing the transaction connection. A busy
    // financial lock must not retain one connection while waiting to borrow another for FX.
    const fxDayId = await ensureFxDay(deps, day)
    const closedWeeks = await deps.weekLocks.listClosedStarts(branchId)
    const outcome = await deps.financialUnitOfWork.run({ lockKey: `receivables:${branchId}`, actorId, requestId: req.requestId }, async tx => {
      const replay = await tx.companyLedger.findCommand(body.idempotencyKey)
      if (replay) {
        const receipt = await tx.companyMovementReview.findMetadata(replay.id)
        if (replay.branchId !== branchId || receipt?.operationChange?.requestHash !== requestHash) throw new ServiceError(409, 'idempotency_key_conflict')
        return { replayed: true, change: receipt.operationChange }
      }
      if (await tx.companyLedger.findHistoricalBranchLink(body.idempotencyKey) ||
        await tx.companyMovementReview.getCorrectionByAction(body.idempotencyKey) ||
        await tx.companyMovementReview.findHistoricalSourceCorrection(body.idempotencyKey) ||
        await tx.ledger.findStandaloneEntry(branchId, 'company_custody_transfer', `custody:${body.idempotencyKey}`)) throw new ServiceError(409, 'idempotency_key_conflict')
      const original = await tx.companyLedger.findCommand(targetId)
      if (!original || original.branchId !== branchId) throw new ServiceError(404, 'company_command_not_found')
      // Expense revisions already have their own guarded, canonical correction chain.
      if (original.kind === 'reversal' || original.kind === 'expense') throw new ServiceError(422, 'company_operation_dedicated_editor_required')
      if (original.journalEntryId !== body.expectedEntryId || await tx.companyLedger.findReversalOf(original.journalEntryId))
        throw new ServiceError(409, 'company_movement_version_conflict')
      await assertCompanyOperationLinks(tx, original)
      const event = original.kind === 'exchange' ? 'company_fx_exchange' : original.kind === 'deposit' ? 'company_deposit'
        : original.kind === 'withdrawal' ? 'company_withdrawal' : 'company_income'
      const entry = await tx.ledger.findStandaloneEntry(branchId, event, original.id)
      if (!entry || entry.id !== original.journalEntryId) throw new ServiceError(500, 'company_command_integrity_error')
      const now = deps.clock.nowMs()
      if (isDateLocked(day, closedWeeks)) throw new ServiceError(409, 'week_locked', { businessDate: day, weekStart: weekStartFor(day) })
      const reversed = companyReversal({ eventType: entry.eventType, occurrenceKey: entry.occurrenceKey,
        lines: entry.lines.map(line => ({ fund: fundRefFromCode(line.fundCode), side: line.side, amount: line.amount,
          ...(line.role === undefined ? {} : { role: line.role }) })) }, body.idempotencyKey)
      let replacement: Exclude<CompanyCommandRecord, { kind: 'reversal' } | { kind: 'expense' }> | null = null
      let posting: Posting | null = null
      if (body.action === 'edit') {
        const values = body.values!, key = randomUUID(), occurredOn = values.occurredOn ?? original.occurredOn
        if (occurredOn > day) throw new ServiceError(422, 'future_company_event')
        const base = { id: key, branchId, occurredOn, businessDate: day, journalEntryId: 0, createdBy: actorId, createdAtMs: now }
        const narrative = values.description ?? ('description' in original ? original.description : original.reason)
        if (original.kind === 'exchange') {
          if (values.amount !== undefined || values.currency !== undefined || values.categoryId !== undefined || values.historicalRate !== undefined)
            throw new ServiceError(422, 'invalid_company_operation_fields')
          const from = { currency: values.fromCurrency ?? original.fromCurrency, amount: values.fromAmount ?? original.fromAmount }
          const to = { currency: values.toCurrency ?? original.toCurrency, amount: values.toAmount ?? original.toAmount }
          if (from.currency === to.currency) throw new ServiceError(422, 'exchange_currency_must_differ')
          posting = companyFxExchange(from, to, key)
          replacement = { ...base, kind: 'exchange', fromCurrency: values.fromCurrency ?? original.fromCurrency,
            fromAmount: values.fromAmount ?? original.fromAmount, toCurrency: values.toCurrency ?? original.toCurrency,
            toAmount: values.toAmount ?? original.toAmount, sypMinorPerUsd: exchangeRate(from, to), reason: narrative }
        } else {
          if (values.fromAmount !== undefined || values.toAmount !== undefined || values.fromCurrency !== undefined || values.toCurrency !== undefined ||
            original.kind !== 'income' && values.categoryId !== undefined) throw new ServiceError(422, 'invalid_company_operation_fields')
          const currency = values.currency ?? original.currency, total = values.amount ?? original.amount
          const rate = currency === 'USD' ? values.historicalRate ?? (original.currency === 'USD' ? original.sypMinorPerUsd : null) : null
          if (currency === 'USD' && rate === null) throw new ServiceError(422, 'historical_rate_required')
          if (currency !== 'USD' && values.historicalRate !== undefined) throw new ServiceError(422, 'historical_rate_not_applicable')
          if (original.kind === 'income') {
            const categoryId = values.categoryId ?? original.categoryId
            if (!(await tx.incomes.listCategories()).some(row => row.id === categoryId && (row.active || categoryId === original.categoryId))) throw new ServiceError(422, 'unknown_income_category')
            replacement = { ...base, kind: 'income', currency, amount: total, categoryId, description: narrative, sypMinorPerUsd: rate }
            posting = companyIncome(currency, total, key)
          } else {
            replacement = { ...base, kind: original.kind, currency, amount: total, equityAccount: original.equityAccount, reason: narrative, sypMinorPerUsd: rate }
            posting = original.kind === 'deposit' ? companyDeposit(currency, total, original.equityAccount as 'owner_funding' | 'opening', key) : companyWithdrawal(currency, total, key)
          }
        }
        if (hash({ ...wire(original), id: '', businessDate: '', journalEntryId: 0, createdBy: '', createdAtMs: 0 }) ===
          hash({ ...wire(replacement), id: '', businessDate: '', journalEntryId: 0, createdBy: '', createdAtMs: 0 })) throw new ServiceError(422, 'no_movement_changes')
      }
      await assertNetBalances(tx, branchId, [reversed, ...(posting ? [posting] : [])])
      const meta = { shiftId: null, businessDate: day, postingDate: day, weekStartDate: weekStartFor(day), fxDayId, createdBy: actorId, reason: body.reason }
      const [undo] = await tx.ledger.post(branchId, [reversed], { ...meta, sypMinorPerUsd: entry.sypMinorPerUsd })
      if (!undo) throw new ServiceError(409, 'idempotency_key_conflict')
      await tx.companyLedger.createCommand({ id: body.idempotencyKey, branchId, kind: 'reversal', targetKind: reversalTargetKindOf(original)!,
        targetId, targetEntryId: original.journalEntryId, sypMinorPerUsd: entry.sypMinorPerUsd, reason: body.reason,
        occurredOn: day, businessDate: day, journalEntryId: undo.id, createdBy: actorId, createdAtMs: now })
      const oldMetadata = await tx.companyMovementReview.findMetadata(targetId)
      const evidence: CompanyMovementMetadata = { commandId: body.idempotencyKey, branchId, occurredPrecision: 'day', occurredMonth: null,
        rateBasis: null, sourceUnit: oldMetadata?.sourceUnit ?? null, receiptReference: oldMetadata?.receiptReference ?? entry.externalReference, intakeSessionId: null,
        operationChange: { action: body.action, targetId, replacementId: replacement?.id ?? null, requestHash } }
      await tx.companyMovementReview.createMetadata(evidence)
      if (posting && replacement) {
        const [saved] = await tx.ledger.post(branchId, [posting], { ...meta, reason: 'description' in replacement ? replacement.description : replacement.reason, sypMinorPerUsd: replacement.sypMinorPerUsd })
        if (!saved) throw new ServiceError(409, 'idempotency_key_conflict')
        await tx.companyLedger.createCommand({ ...replacement, journalEntryId: saved.id })
        const { operationChange: _change, ...replacementEvidence } = evidence
        await tx.companyMovementReview.createMetadata({ ...replacementEvidence, commandId: replacement.id,
          occurredPrecision: body.values?.occurredOn ? 'day' : oldMetadata?.occurredPrecision ?? 'day',
          occurredMonth: body.values?.occurredOn ? null : oldMetadata?.occurredMonth ?? null,
          rateBasis: replacement.sypMinorPerUsd === null ? null : oldMetadata?.rateBasis ?? 'documented' })
      }
      return { replayed: false, change: evidence.operationChange }
    })
    return reply.code(outcome.replayed ? 200 : 201).send(outcome)
  })
}

async function assertNetBalances(tx: FinancialTransactionDeps, branchId: string, postings: Posting[]) {
  const deltas = new Map<string, bigint>()
  for (const posting of postings) for (const line of posting.lines) {
    const code = fundCode(line.fund)
    if (['company_cash:', 'company_custody:', 'depreciation_reserve:'].some(prefix => code.startsWith(prefix)))
      deltas.set(code, (deltas.get(code) ?? 0n) + (line.side === 'D' ? line.amount : -line.amount))
  }
  for (const [code, delta] of deltas) if (delta < 0n && await tx.ledger.fundBalance(branchId, code) + delta < 0n)
    throw new ServiceError(422, 'insufficient_funds', { fundCode: code })
}
