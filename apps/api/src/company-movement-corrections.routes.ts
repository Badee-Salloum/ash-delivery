import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type {
  CompanyExpenseCorrectionValues, CompanyExpenseRecord, CompanyHistoricalIntakeSession,
  CompanyMovementCorrection, CompanyMovementMetadata, Deps, FinancialTransactionDeps,
} from '@ash/contracts'
import { moneySchema, serializeMoney } from '@ash/contracts'
import {
  type CalendarDate, type CompanyExpenseCentre, type Currency, companyExpense, companyReversal,
  fundRefFromCode, hasVisibleText, isCalendarDate, minor, monthEndFor, weekStartFor,
} from '@ash/domain'
import { ServiceError, assertWeekOpen, ensureFxDay, todayFor } from './shifts.service.ts'
import { assertOriginalCorrectionTarget, effectiveExpenseView, ownerBranchFundingRead } from './company-movement-read.service.ts'
import { effectiveHistoricalSource } from './company-historical-source.service.ts'
import { assertCompanyOperationLinks, refreshCorrectedExpensePayments } from './company-operation-links.service.ts'

const idSchema = z.string().uuid().transform((value) => value.toLowerCase())
const dateSchema = z.string().refine(isCalendarDate).refine((value) => value >= '2000-01-01')
const reasonSchema = z.string().trim().min(1).max(1000).refine(hasVisibleText)
const positiveMoney = moneySchema.refine((value) => value > 0n, 'amount must be positive')
const versionSchema = z.number().int().positive()
const currencySchema = z.enum(['SYP_NEW', 'USD'])
const nullableId = idSchema.nullable()

const valuesSchema = z.object({
  currency: currencySchema.optional(), amount: positiveMoney.optional(),
  paidFrom: z.enum(['pocket', 'reserve', 'owner_outside', 'owner_custody']).optional(),
  categoryId: idSchema.optional(), costCenterKind: z.enum(['general', 'vehicle', 'asset']).optional(),
  vehicleId: nullableId.optional(), assetId: nullableId.optional(), receiptMediaId: nullableId.optional(),
  occurredOn: dateSchema.optional(), description: reasonSchema.optional(), historicalRate: positiveMoney.optional(),
  occurredPrecision: z.enum(['day', 'month']).optional(),
  occurredMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable().optional(),
  rateBasis: z.enum(['documented', 'estimated']).nullable().optional(),
  sourceUnit: z.string().trim().min(1).max(100).nullable().optional(),
  receiptReference: z.string().trim().min(1).max(200).refine(hasVisibleText).nullable().optional(),
}).strict()

function assertReviewer(req: FastifyRequest): void {
  if (req.actor?.roleKey !== 'general_manager' && req.actor?.roleKey !== 'system_admin') {
    throw new ServiceError(403, 'forbidden', { reason: 'company_financial_review_roles_only' })
  }
}

/** Sorted canonical input hash, including actor. Action UUID replay cannot mask a changed request. */
function fingerprint(input: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (typeof value === 'bigint') return value.toString()
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]))
    }
    return value
  }
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
}

function commandValues(command: CompanyExpenseRecord, metadata: CompanyMovementMetadata | null): CompanyExpenseCorrectionValues {
  return {
    currency: command.currency, amount: serializeMoney(command.amount), paidFrom: command.paidFrom,
    categoryId: command.categoryId, costCenterKind: command.costCenterKind, vehicleId: command.vehicleId,
    assetId: command.assetId, receiptMediaId: command.receiptMediaId, occurredOn: command.occurredOn,
    description: command.description, sypMinorPerUsd: command.sypMinorPerUsd?.toString() ?? null,
    occurredPrecision: metadata?.occurredPrecision ?? 'day', occurredMonth: metadata?.occurredMonth ?? null,
    rateBasis: metadata?.rateBasis ?? (command.currency === 'USD' ? 'documented' : null),
    sourceUnit: metadata?.sourceUnit ?? null, receiptReference: metadata?.receiptReference ?? null,
  }
}

function mergeValues(current: CompanyExpenseCorrectionValues, changes: z.infer<typeof valuesSchema>, today: CalendarDate): CompanyExpenseCorrectionValues {
  const { amount, historicalRate, ...other } = changes
  const values: CompanyExpenseCorrectionValues = { ...current,
    amount: amount === undefined ? current.amount : serializeMoney(amount) }
  Object.assign(values, Object.fromEntries(Object.entries(other).filter(([, value]) => value !== undefined)))
  if (values.occurredOn > today) throw new ServiceError(422, 'future_company_event')
  if (values.currency === 'USD') {
    if (historicalRate !== undefined) values.sypMinorPerUsd = historicalRate.toString()
    else if (current.currency !== 'USD') throw new ServiceError(422, 'historical_rate_required')
    if (values.sypMinorPerUsd === null || BigInt(values.sypMinorPerUsd) <= 0n) throw new ServiceError(422, 'historical_rate_required')
    values.rateBasis = changes.rateBasis ?? (current.currency === 'USD' ? current.rateBasis : 'documented')
    if (values.rateBasis === null) values.rateBasis = 'documented'
  } else {
    if (historicalRate !== undefined || changes.rateBasis != null) throw new ServiceError(422, 'historical_rate_not_applicable')
    values.sypMinorPerUsd = null
    values.rateBasis = null
  }
  if (values.occurredPrecision === 'month') {
    if (values.occurredMonth === null || values.occurredOn !== `${values.occurredMonth}-01`) {
      throw new ServiceError(422, 'historical_month_precision_invalid')
    }
  } else {
    if (changes.occurredMonth != null) throw new ServiceError(422, 'historical_month_precision_invalid')
    values.occurredMonth = null
  }
  if ((values.costCenterKind === 'general' && (values.vehicleId !== null || values.assetId !== null)) ||
    (values.costCenterKind === 'vehicle' && (values.vehicleId === null || values.assetId !== null)) ||
    (values.costCenterKind === 'asset' && (values.assetId === null || values.vehicleId !== null))) {
    throw new ServiceError(422, 'company_cost_center_mismatch')
  }
  return values
}

function financiallyDifferent(before: CompanyExpenseCorrectionValues, after: CompanyExpenseCorrectionValues): boolean {
  return before.currency !== after.currency || before.amount !== after.amount || before.paidFrom !== after.paidFrom ||
    before.sypMinorPerUsd !== after.sypMinorPerUsd || before.costCenterKind !== after.costCenterKind ||
    before.vehicleId !== after.vehicleId || before.assetId !== after.assetId
}

function wireCommand(command: CompanyExpenseRecord, values?: CompanyExpenseCorrectionValues): Record<string, unknown> {
  return { ...command, ...values, amount: values?.amount ?? serializeMoney(command.amount),
    sypMinorPerUsd: values === undefined ? command.sypMinorPerUsd?.toString() ?? null : values.sypMinorPerUsd }
}

function impact(before: CompanyExpenseCorrectionValues, after: CompanyExpenseCorrectionValues) {
  const pockets = { SYP_NEW: 0n, USD: 0n }
  const reserves = { SYP_NEW: 0n, USD: 0n }
  const custody = { SYP_NEW: 0n, USD: 0n }
  const ownerPayments = { SYP_NEW: 0n, USD: 0n }
  for (const [values, side] of [[before, 1n], [after, -1n]] as const) {
    const amount = moneySchema.parse(values.amount) * side
    if (values.paidFrom === 'pocket') pockets[values.currency] += amount
    else if (values.paidFrom === 'reserve') reserves[values.currency] += amount
    else if (values.paidFrom === 'owner_custody') custody[values.currency] += amount
    else ownerPayments[values.currency] -= amount
  }
  const wire = (totals: Record<Currency, bigint>) => ({
    SYP_NEW: serializeMoney(minor(totals.SYP_NEW)), USD: serializeMoney(minor(totals.USD)),
  })
  return { pockets: wire(pockets), reserves: wire(reserves), custody: wire(custody), ownerPayments: wire(ownerPayments), branchEffect: 'none' }
}

type ReviewDeps = Pick<FinancialTransactionDeps, 'companyLedger' | 'companyMovementReview' | 'existingAssets' | 'companyFinance'>

async function reviewState(repo: ReviewDeps, branchId: string, targetId: string) {
  const original = await repo.companyLedger.findCommand(targetId)
  if (!original || original.branchId !== branchId) throw new ServiceError(404, 'company_command_not_found')
  if (original.kind !== 'expense') throw new ServiceError(422, 'company_correction_expense_required')
  const allCorrections = await repo.companyMovementReview.listCorrections(branchId)
  assertOriginalCorrectionTarget(targetId, allCorrections)
  const corrections = allCorrections.filter((row) => row.targetId === targetId)
  const confirmed = corrections.filter((row) => row.status === 'confirmed').sort((a, b) => a.targetVersion - b.targetVersion)
  let effective = original
  let metadata = await repo.companyMovementReview.findMetadata(original.id)
  let values = commandValues(effective, metadata)
  for (const correction of confirmed) {
    if (correction.financial) {
      const replacement = await repo.companyLedger.findCommand(correction.replacementId)
      if (!replacement || replacement.kind !== 'expense') throw new ServiceError(500, 'company_correction_integrity_error')
      effective = replacement
    }
    values = correction.values
    metadata = { commandId: effective.id, branchId, occurredPrecision: values.occurredPrecision,
      occurredMonth: values.occurredMonth, rateBasis: values.rateBasis, sourceUnit: values.sourceUnit,
      receiptReference: values.receiptReference, intakeSessionId: metadata?.intakeSessionId ?? null }
  }
  return { original, effective, metadata, values, version: confirmed.length + 1, corrections }
}

async function blockingReasons(repo: ReviewDeps, original: CompanyExpenseRecord, effective: CompanyExpenseRecord,
  proposed: CompanyExpenseCorrectionValues, financial: boolean): Promise<string[]> {
  if (!financial) return []
  const reasons = new Set<string>()
  if (original.assetId !== null || effective.assetId !== null || proposed.assetId !== null ||
    original.costCenterKind === 'asset' || effective.costCenterKind === 'asset' || proposed.costCenterKind === 'asset') {
    reasons.add('linked_asset_review_required')
  }
  const linked = [
    ...await repo.existingAssets.linkedToOperation(original.id, original.journalEntryId),
    ...await repo.existingAssets.linkedToOperation(effective.id, effective.journalEntryId),
  ]
  if (linked.some((asset) => asset.accountingStatus === 'approved' || asset.recognition !== null ||
    asset.depreciation !== null || asset.sale !== null)) reasons.add('linked_asset_review_required')
  const debts = await repo.companyFinance.listDebts(original.branchId)
  if (debts.some((debt) => debt.journalEntryId === original.journalEntryId || debt.journalEntryId === effective.journalEntryId)) {
    reasons.add('linked_debt_review_required')
  }
  return [...reasons]
}

export function registerCompanyMovementReviewRoutes(app: FastifyInstance, deps: Deps): void {
  const permission = { config: { permission: 'company_fund.manage' as const } }
  async function companyId(): Promise<string> {
    const branch = await deps.directory.companyBranch()
    if (!branch) throw new ServiceError(500, 'company_branch_missing')
    return branch.id
  }
  const paramsSchema = z.object({ id: idSchema })
  const correctionQuerySchema = z.object({ targetId: idSchema.optional() })

  app.get('/company/historical-intake-sessions', permission, async (req) => {
    assertReviewer(req)
    return { sessions: await deps.companyMovementReview.listIntakeSessions(await companyId()) }
  })
  const intakeSchema = z.object({ idempotencyKey: idSchema, from: dateSchema, to: dateSchema, reason: reasonSchema,
    reconciliationNote: reasonSchema, reviewedSourceUnits: z.literal(true), reviewedExistingEntries: z.literal(true) }).strict()
  app.post('/company/historical-intake-sessions', permission, async (req, reply) => {
    assertReviewer(req)
    const body = intakeSchema.parse(req.body)
    const branchId = await companyId()
    const today = todayFor(deps)
    if (body.from > body.to || body.to > today) throw new ServiceError(422, 'invalid_date_range')
    const outcome = await deps.financialUnitOfWork.run({ lockKey: `receivables:${branchId}`, actorId: req.actor!.userId, requestId: req.requestId }, async (tx) => {
      const existing = await tx.companyMovementReview.getIntakeSession(body.idempotencyKey)
      if (existing) {
        if (existing.branchId !== branchId || existing.from !== body.from || existing.to !== body.to ||
          existing.reason !== body.reason || existing.reconciliationNote !== body.reconciliationNote || existing.createdBy !== req.actor!.userId) {
          throw new ServiceError(409, 'idempotency_key_conflict')
        }
        return { session: existing, replayed: true }
      }
      await assertWeekOpen(deps, branchId, today)
      const [syp, usd, baselineEntryId] = await Promise.all([
        tx.ledger.fundBalance(branchId, 'company_cash:SYP_NEW'), tx.ledger.fundBalance(branchId, 'company_cash:USD'),
        tx.companyLedger.latestEntryId(),
      ])
      const session: CompanyHistoricalIntakeSession = { id: body.idempotencyKey, branchId, from: body.from, to: body.to,
        reason: body.reason, reconciliationNote: body.reconciliationNote, baselineEntryId,
        baselinePockets: { SYP_NEW: serializeMoney(syp), USD: serializeMoney(usd) },
        reviewedSourceUnits: true, reviewedExistingEntries: true, createdBy: req.actor!.userId, createdAtMs: deps.clock.nowMs(),
        closedBy: null, closedAtMs: null, closureReason: null }
      await tx.companyMovementReview.createIntakeSession(session)
      return { session, replayed: false }
    })
    return reply.code(outcome.replayed ? 200 : 201).send(outcome)
  })
  app.put('/company/historical-intake-sessions/:id/close', permission, async (req) => {
    assertReviewer(req)
    const { id } = paramsSchema.parse(req.params)
    const { reason } = z.object({ reason: reasonSchema }).strict().parse(req.body)
    const branchId = await companyId()
    return deps.financialUnitOfWork.run({ lockKey: `receivables:${branchId}`, actorId: req.actor!.userId, requestId: req.requestId }, async (tx) => {
      const session = await tx.companyMovementReview.getIntakeSession(id)
      if (!session || session.branchId !== branchId) throw new ServiceError(404, 'historical_intake_session_not_found')
      if (session.closedAtMs !== null) {
        if (session.closureReason !== reason || session.closedBy !== req.actor!.userId) throw new ServiceError(409, 'historical_intake_session_closed')
        return { session, replayed: true }
      }
      const closed = { ...session, closedBy: req.actor!.userId, closedAtMs: deps.clock.nowMs(), closureReason: reason }
      await tx.companyMovementReview.closeIntakeSession(closed)
      return { session: closed, replayed: false }
    })
  })

  app.get('/company/movements/:id/review', permission, async (req) => {
    const { id } = paramsSchema.parse(req.params)
    const state = await reviewState(deps, await companyId(), id)
    return { original: wireCommand(state.original), effective: wireCommand(state.effective, state.values),
      version: state.version, metadata: state.metadata, corrections: state.corrections }
  })
  app.get('/company/movement-corrections', permission, async (req) => {
    const q = correctionQuerySchema.parse(req.query)
    return { corrections: await deps.companyMovementReview.listCorrections(await companyId(), q.targetId) }
  })
  app.get('/company/movement-corrections/:id/history', permission, async (req) => {
    const { id } = paramsSchema.parse(req.params)
    const row = await deps.companyMovementReview.getCorrection(id)
    if (!row || row.branchId !== await companyId()) throw new ServiceError(404, 'company_correction_not_found')
    return { history: await deps.companyMovementReview.listCorrectionHistory(id) }
  })
  const createSchema = z.object({ idempotencyKey: idSchema, targetId: idSchema, expectedVersion: versionSchema,
    reason: reasonSchema, values: valuesSchema }).strict()
  app.post('/company/movement-corrections', permission, async (req, reply) => {
    const body = createSchema.parse(req.body)
    const branchId = await companyId()
    const actionFingerprint = fingerprint({ action: 'create', body, actorId: req.actor!.userId })
    const outcome = await deps.financialUnitOfWork.run({ lockKey: `receivables:${branchId}`, actorId: req.actor!.userId, requestId: req.requestId }, async (tx) => {
      const prior = await tx.companyMovementReview.getCorrectionByAction(body.idempotencyKey)
      if (prior) {
        if (prior.actionFingerprint !== actionFingerprint || prior.branchId !== branchId) throw new ServiceError(409, 'idempotency_key_conflict')
        return { correction: prior, replayed: true }
      }
      const state = await reviewState(tx, branchId, body.targetId)
      if (state.version !== body.expectedVersion) throw new ServiceError(409, 'company_movement_version_conflict', { currentVersion: state.version })
      const values = mergeValues(state.values, body.values, todayFor(deps))
      const financial = financiallyDifferent(state.values, values)
      const row: CompanyMovementCorrection = { id: body.idempotencyKey, branchId, targetId: body.targetId,
        targetVersion: state.version, effectiveCommandId: state.effective.id, version: 1, status: 'draft', reason: body.reason,
        values, financial, blockingReasons: await blockingReasons(tx, state.original, state.effective, values, financial),
        reversalId: randomUUID(), replacementId: randomUUID(), reversalEntryId: null, replacementEntryId: null,
        actionId: body.idempotencyKey, actionFingerprint, createdBy: req.actor!.userId, createdAtMs: deps.clock.nowMs(),
        actedBy: req.actor!.userId, actedAtMs: deps.clock.nowMs(), confirmedBy: null, confirmedAtMs: null }
      await tx.companyMovementReview.saveCorrection(row, 0)
      return { correction: row, impact: impact(state.values, values), replayed: false }
    })
    return reply.code(outcome.replayed ? 200 : 201).send(outcome)
  })
  const updateSchema = z.object({ idempotencyKey: idSchema, expectedVersion: versionSchema,
    reason: reasonSchema.optional(), values: valuesSchema.optional() }).strict()
  app.patch('/company/movement-corrections/:id', permission, async (req) => {
    const { id } = paramsSchema.parse(req.params)
    const body = updateSchema.parse(req.body)
    const branchId = await companyId()
    const actionFingerprint = fingerprint({ action: 'edit', id, body, actorId: req.actor!.userId })
    return deps.financialUnitOfWork.run({ lockKey: `receivables:${branchId}`, actorId: req.actor!.userId, requestId: req.requestId }, async (tx) => {
      const replay = await tx.companyMovementReview.getCorrectionByAction(body.idempotencyKey)
      if (replay) {
        if (replay.actionFingerprint !== actionFingerprint || replay.branchId !== branchId) throw new ServiceError(409, 'idempotency_key_conflict')
        return { correction: replay, replayed: true }
      }
      const prior = await tx.companyMovementReview.getCorrection(id)
      if (!prior || prior.branchId !== branchId) throw new ServiceError(404, 'company_correction_not_found')
      if (prior.status !== 'draft') throw new ServiceError(409, 'company_correction_already_confirmed')
      if (prior.version !== body.expectedVersion) throw new ServiceError(409, 'company_correction_version_conflict', { currentVersion: prior.version })
      const state = await reviewState(tx, branchId, prior.targetId)
      if (state.version !== prior.targetVersion) throw new ServiceError(409, 'company_movement_version_conflict', { currentVersion: state.version })
      const values = mergeValues(prior.values, body.values ?? {}, todayFor(deps))
      const financial = financiallyDifferent(state.values, values)
      const row: CompanyMovementCorrection = { ...prior, values, reason: body.reason ?? prior.reason, financial,
        blockingReasons: await blockingReasons(tx, state.original, state.effective, values, financial),
        version: prior.version + 1, actionId: body.idempotencyKey, actionFingerprint, actedBy: req.actor!.userId, actedAtMs: deps.clock.nowMs() }
      await tx.companyMovementReview.saveCorrection(row, prior.version)
      return { correction: row, impact: impact(state.values, values), replayed: false }
    })
  })
  const confirmSchema = z.object({ idempotencyKey: idSchema, expectedVersion: versionSchema,
    acknowledgeCashEffect: z.literal(true) }).strict()
  app.post('/company/movement-corrections/:id/confirm', permission, async (req) => {
    assertReviewer(req)
    const { id } = paramsSchema.parse(req.params)
    const body = confirmSchema.parse(req.body)
    const branchId = await companyId()
    const actionFingerprint = fingerprint({ action: 'confirm', id, body, actorId: req.actor!.userId })
    return deps.financialUnitOfWork.run({ lockKey: `receivables:${branchId}`, actorId: req.actor!.userId, requestId: req.requestId }, async (tx) => {
      const replay = await tx.companyMovementReview.getCorrectionByAction(body.idempotencyKey)
      if (replay) {
        if (replay.actionFingerprint !== actionFingerprint || replay.branchId !== branchId) throw new ServiceError(409, 'idempotency_key_conflict')
        return { correction: replay, replayed: true }
      }
      const prior = await tx.companyMovementReview.getCorrection(id)
      if (!prior || prior.branchId !== branchId) throw new ServiceError(404, 'company_correction_not_found')
      if (prior.status !== 'draft') throw new ServiceError(409, 'company_correction_already_confirmed')
      if (prior.version !== body.expectedVersion) throw new ServiceError(409, 'company_correction_version_conflict', { currentVersion: prior.version })
      const state = await reviewState(tx, branchId, prior.targetId)
      if (state.version !== prior.targetVersion || state.effective.id !== prior.effectiveCommandId) {
        throw new ServiceError(409, 'company_movement_version_conflict', { currentVersion: state.version })
      }
      const values = mergeValues(prior.values, {}, todayFor(deps))
      if (await tx.companyLedger.findReversalOf(state.effective.journalEntryId)) throw new ServiceError(409, 'company_command_already_reversed')
      const financial = financiallyDifferent(state.values, values)
      await assertCompanyOperationLinks(tx, state.effective)
      const blocked = await blockingReasons(tx, state.original, state.effective, values, financial)
      if (blocked.length > 0) throw new ServiceError(422, 'company_correction_linked_review_required', { blockingReasons: blocked })
      const category = (await tx.expenses.listCategories()).find((row) => row.id === values.categoryId && row.active)
      if (!category) throw new ServiceError(422, 'unknown_expense_category')
      if (values.vehicleId !== null && !(await deps.directory.vehicle(values.vehicleId))) throw new ServiceError(404, 'vehicle_not_found')
      if (values.receiptMediaId !== null && !(await deps.media.findById(values.receiptMediaId))) throw new ServiceError(422, 'receipt_media_invalid')
      const deltas = impact(state.values, values)
      for (const currency of ['SYP_NEW', 'USD'] as const) {
        const custodyDelta = moneySchema.parse(deltas.custody[currency])
        if (custodyDelta < 0n && await tx.ledger.fundBalance(branchId, `company_custody:${currency}`) + custodyDelta < 0n) {
          throw new ServiceError(422, 'company_custody_insufficient')
        }
        const reserveDelta = moneySchema.parse(deltas.reserves[currency])
        if (reserveDelta < 0n && await tx.ledger.fundBalance(branchId, `depreciation_reserve:${currency}`) + reserveDelta < 0n) {
          throw new ServiceError(422, 'insufficient_funds', { fundCode: `depreciation_reserve:${currency}` })
        }
      }
      const day = todayFor(deps)
      // New corrections book today; neither the original journal date nor any closed week is altered.
      await assertWeekOpen(deps, branchId, day)
      let reversalEntryId: number | null = null
      let replacementEntryId: number | null = null
      if (financial) {
        const alreadyReversed = await tx.companyLedger.findReversalOf(state.effective.journalEntryId)
        if (alreadyReversed) throw new ServiceError(409, 'company_command_already_reversed', { reversalId: alreadyReversed.id })
        const entry = await tx.ledger.findStandaloneEntry(branchId, 'company_expense', state.effective.id)
        if (!entry || entry.id !== state.effective.journalEntryId) throw new ServiceError(500, 'company_command_integrity_error')
        const fxDayId = await ensureFxDay(deps, day)
        const meta = { shiftId: null, businessDate: day, postingDate: day, weekStartDate: weekStartFor(day),
          fxDayId, createdBy: req.actor!.userId, reason: prior.reason }
        const [reversalEntry] = await tx.ledger.post(branchId, [companyReversal({ eventType: entry.eventType,
          occurrenceKey: entry.occurrenceKey, lines: entry.lines.map((line) => ({ fund: fundRefFromCode(line.fundCode),
            side: line.side, amount: line.amount, ...(line.role === undefined ? {} : { role: line.role }) })) }, prior.reversalId)],
        { ...meta, sypMinorPerUsd: entry.sypMinorPerUsd })
        if (!reversalEntry) throw new ServiceError(409, 'idempotency_key_conflict')
        reversalEntryId = reversalEntry.id
        await tx.companyLedger.createCommand({ id: prior.reversalId, branchId, kind: 'reversal', targetKind: 'expense',
          targetId: state.effective.id, targetEntryId: state.effective.journalEntryId, sypMinorPerUsd: entry.sypMinorPerUsd,
          reason: prior.reason, occurredOn: day, businessDate: day, journalEntryId: reversalEntry.id,
          createdBy: req.actor!.userId, createdAtMs: deps.clock.nowMs() })
        const centre: CompanyExpenseCentre = values.costCenterKind === 'general' ? 'general'
          : values.costCenterKind === 'vehicle' ? `vehicle:${values.vehicleId!}` : `asset:${values.assetId!}`
        const amount = moneySchema.parse(values.amount)
        const rate = values.sypMinorPerUsd === null ? null : BigInt(values.sypMinorPerUsd)
        const [replacementEntry] = await tx.ledger.post(branchId,
          [companyExpense(values.currency, amount, centre, values.paidFrom, prior.replacementId)],
          { ...meta, reason: values.description, sypMinorPerUsd: rate })
        if (!replacementEntry) throw new ServiceError(409, 'idempotency_key_conflict')
        replacementEntryId = replacementEntry.id
        await tx.companyLedger.createCommand({ id: prior.replacementId, branchId, kind: 'expense', currency: values.currency,
          amount, sypMinorPerUsd: rate, categoryId: values.categoryId, costCenterKind: values.costCenterKind,
          vehicleId: values.vehicleId, assetId: values.assetId, receiptMediaId: values.receiptMediaId, paidFrom: values.paidFrom,
          description: values.description, occurredOn: values.occurredOn, businessDate: day, journalEntryId: replacementEntry.id,
          createdBy: req.actor!.userId, createdAtMs: deps.clock.nowMs() })
        await tx.companyMovementReview.createMetadata({ commandId: prior.replacementId, branchId,
          occurredPrecision: values.occurredPrecision, occurredMonth: values.occurredMonth, rateBasis: values.rateBasis,
          sourceUnit: values.sourceUnit, receiptReference: values.receiptReference, intakeSessionId: state.metadata?.intakeSessionId ?? null })
      }
      const row: CompanyMovementCorrection = { ...prior, values, financial, blockingReasons: [], status: 'confirmed',
        version: prior.version + 1, reversalEntryId, replacementEntryId, actionId: body.idempotencyKey, actionFingerprint,
        actedBy: req.actor!.userId, actedAtMs: deps.clock.nowMs(), confirmedBy: req.actor!.userId, confirmedAtMs: deps.clock.nowMs() }
      await tx.companyMovementReview.saveCorrection(row, prior.version)
      await refreshCorrectedExpensePayments(tx, branchId, state.original.id, values, req.actor!.userId, deps.clock.nowMs(), prior.reason)
      const pockets = { SYP_NEW: serializeMoney(await tx.ledger.fundBalance(branchId, 'company_cash:SYP_NEW')),
        USD: serializeMoney(await tx.ledger.fundBalance(branchId, 'company_cash:USD')) }
      return { correction: row, impact: impact(state.values, values), pockets, replayed: false }
    })
  })

  app.get('/company/owner-payments', permission, async (req) => {
    const q = z.object({ from: dateSchema.optional(), to: dateSchema.optional() }).parse(req.query)
    const branchId = await companyId()
    const from = q.from ?? '2000-01-01'
    const to = q.to ?? todayFor(deps)
    if (from > to || to > todayFor(deps)) throw new ServiceError(422, 'invalid_date_range')
    const result = await deps.financialUnitOfWork.run({ mode: 'read_snapshot', lockKey: `receivables:${branchId}`, actorId: req.actor!.userId, requestId: req.requestId }, async (tx) => {
    const [commands, corrections, metadata, assets, debts, sourceReceipts, sourceCorrections] = await Promise.all([
      tx.companyLedger.listCommands(branchId), tx.companyMovementReview.listCorrections(branchId),
      tx.companyMovementReview.listMetadata(branchId), tx.companyFinance.listAssets(branchId), tx.companyFinance.listDebts(branchId),
      tx.companyLedgerSource.listHistoricalImportReceipts(branchId, { from: '2000-01-01', to: todayFor(deps) }),
      tx.companyMovementReview.listHistoricalSourceCorrections(branchId),
    ])
    const historicalReceipts = sourceReceipts.map(row=>effectiveHistoricalSource(row,sourceCorrections))
      .filter(row=>!row.excluded && row.occurredOn>=from && row.occurredOn<=to)
    const byId = new Map(commands.map((command) => [command.id, command]))
    const byMetadata = new Map(metadata.map((row) => [row.commandId, row]))
    const reversed = new Set(commands.filter((row) => row.kind === 'reversal').map((row) => row.targetEntryId))
    const replacements = new Set(corrections.filter((row) => row.status === 'confirmed' && row.financial).map((row) => row.replacementId))
    const totalsByKind = { expense: { SYP_NEW: 0n, USD: 0n }, asset_payment: { SYP_NEW: 0n, USD: 0n },
      debt_payment: { SYP_NEW: 0n, USD: 0n } }
    const payments: Record<string, unknown>[] = []
    for (const command of commands) {
      if (command.kind !== 'expense' || replacements.has(command.id)) continue
      const state = effectiveExpenseView(command, byId, corrections, byMetadata.get(command.id) ?? null)
      // A plain reversal is a real exclusion, not a new current expense. Correction reversals
      // are resolved by state above, keeping only the effective replacement in this projection.
      if (reversed.has(state.effective.journalEntryId)) continue
      const occurredOn = String(state.wire.occurredOn)
      const occurredEnd = state.metadata?.occurredPrecision === 'month' ? monthEndFor(occurredOn) : occurredOn
      if (state.wire.paidFrom !== 'owner_outside' || occurredEnd < from || occurredOn > to) continue
      totalsByKind.expense[state.effective.currency] += moneySchema.parse(state.wire.amount)
      payments.push({ ...state.wire, originalId: command.id, version: state.version, metadata: state.metadata,
        correction: state.correction, correctionIds: state.confirmed.map(row=>row.id),
        reviewStatus: state.confirmed.length > 0 ? 'corrected' : 'original' })
    }
    // Neutral registrations and unpaid prices are deliberately not payment evidence. Only the
    // actual paid-now leg of a legacy purchase can represent owner funding here.
    for (const asset of assets) {
      if (asset.paidFrom !== 'owner_outside' || asset.paidNow <= 0n || reversed.has(asset.journalEntryId) ||
        asset.purchasedOn < from || asset.purchasedOn > to) continue
      totalsByKind.asset_payment[asset.currency] += asset.paidNow
      payments.push({ id: asset.id, originalId: asset.id, branchId, kind: 'asset_payment', assetId: asset.id,
        vehicleId: asset.vehicleId, currency: asset.currency, amount: serializeMoney(asset.paidNow), paidFrom: 'owner_outside',
        occurredOn: asset.purchasedOn, businessDate: asset.businessDate, journalEntryId: asset.journalEntryId,
        sypMinorPerUsd: asset.sypMinorPerUsd?.toString() ?? null, description: asset.description,
        createdBy: asset.createdBy, createdAtMs: asset.createdAtMs, version: 1, metadata: null })
    }
    const payable = debts.filter((debt) => debt.direction === 'payable')
    const debtEvents = await Promise.all(payable.map(async (debt) => ({ debt, events: await tx.companyFinance.listDebtEvents(debt.id) })))
    for (const { debt, events } of debtEvents) for (const event of events) {
      if (event.kind !== 'payment' || event.source !== 'owner_outside' || event.amount <= 0n || reversed.has(event.journalEntryId) ||
        event.occurredOn < from || event.occurredOn > to) continue
      totalsByKind.debt_payment[debt.currency] += event.amount
      payments.push({ id: event.id, originalId: event.id, branchId, kind: 'debt_payment', debtId: debt.id,
        assetId: debt.assetId, currency: debt.currency, amount: serializeMoney(event.amount), paidFrom: 'owner_outside',
        occurredOn: event.occurredOn, businessDate: event.businessDate, journalEntryId: event.journalEntryId,
        sypMinorPerUsd: event.sypMinorPerUsd?.toString() ?? null, description: event.reason,
        partyName: debt.partyName, createdBy: event.createdBy, createdAtMs: event.createdAtMs, version: 1, metadata: null })
    }
    // The reviewed legacy owner payments are final evidence, but intentionally not company P&L
    // or HQ cash commands. Keep them in the owner card, never turn them into company expenses.
    for (const receipt of historicalReceipts) {
      if (receipt.paidFrom !== 'owner_outside' || receipt.amount === null || receipt.currency === null ||
        (receipt.movementType !== 'expense' && receipt.movementType !== 'asset_payment')) continue
      const kind = receipt.movementType
      totalsByKind[kind][receipt.currency] += receipt.amount
      payments.push({ id: receipt.sourceReference, originalId: receipt.sourceReference, branchId,
        kind, currency: receipt.currency, amount: serializeMoney(receipt.amount), paidFrom: 'owner_outside',
        occurredOn: receipt.occurredOn, businessDate: receipt.occurredOn, journalEntryId: null,
        sypMinorPerUsd: receipt.sypMinorPerUsd?.toString() ?? null, description: receipt.description,
        externalReference: receipt.sourceReference, companyCashEffect: '0.00', companyPnlEffect: '0.00',
        version: receipt.version, correctionIds: receipt.correctionIds, categoryId: null,
        reviewStatus: receipt.version > 1 ? 'corrected' : 'original',
        metadata: { occurredPrecision: 'day', occurredMonth: null, rateBasis: receipt.rateBasis } })
    }
    const wireTotals = (totals: Record<Currency, bigint>) => ({ SYP_NEW: serializeMoney(minor(totals.SYP_NEW)), USD: serializeMoney(minor(totals.USD)) })
    const capitalAndDebt = { SYP_NEW: totalsByKind.asset_payment.SYP_NEW + totalsByKind.debt_payment.SYP_NEW,
      USD: totalsByKind.asset_payment.USD + totalsByKind.debt_payment.USD }
    return { from, to, totals: wireTotals({ SYP_NEW: totalsByKind.expense.SYP_NEW + capitalAndDebt.SYP_NEW,
      USD: totalsByKind.expense.USD + capitalAndDebt.USD }), expenseTotals: wireTotals(totalsByKind.expense),
      capitalAndDebtTotals: wireTotals(capitalAndDebt), totalsByKind: { expense: wireTotals(totalsByKind.expense),
        asset_payment: wireTotals(totalsByKind.asset_payment), debt_payment: wireTotals(totalsByKind.debt_payment) },
      payments: payments.sort((a, b) => String(a.occurredOn).localeCompare(String(b.occurredOn)) || Number(a.journalEntryId) - Number(b.journalEntryId)),
      historicalOwnerPaymentsOutsideCompanyPnl: true,
      sourceOwnerBranchSnapshot: sourceReceipts.map(row=>effectiveHistoricalSource(row,sourceCorrections)).filter(row=>!row.excluded) }
    })
    // Branch receipt paging must not hold the HQ financial lock while traversing older evidence.
    // Each immutable branch chain is read through descending ID cursors; no money is posted here.
    const branches = await deps.directory.listBranches()
    const branchFunding = await ownerBranchFundingRead(deps, branches, '2000-01-01', todayFor(deps), todayFor(deps))
    // Reuse the same reviewed source snapshot as direct payments: a concurrent source correction
    // must not make the displayed combined total mix two administrative versions.
    const { sourceOwnerBranchSnapshot: sourceOwnerBranch, ...wireResult } = result
    const linkedByEntry = new Map(sourceOwnerBranch.filter(row => row.movementType === 'branch_payment' &&
      row.paidFrom === 'owner_outside' && row.branchJournalEntryId !== null)
      .map(row => [row.branchJournalEntryId, row]))
    const branchNames = new Map(branches.map(row => [row.id, row.nameAr]))
    const selectedFunding = branchFunding.payments.map(payment => {
      const linked = linkedByEntry.get(Number(payment.journalEntryId))
      return linked ? { ...payment, occurredOn: linked.occurredOn, description: linked.description,
        externalReference: linked.sourceReference, sourceBusinessDate: payment.businessDate } : payment
    }).filter(payment => String(payment.occurredOn) >= from && String(payment.occurredOn) <= to)
    for (const receipt of sourceOwnerBranch) {
      if (receipt.movementType !== 'branch_payment' || receipt.paidFrom !== 'owner_outside' ||
        receipt.branchJournalEntryId !== null || receipt.amount === null || receipt.currency === null ||
        receipt.occurredOn < from || receipt.occurredOn > to) continue
      selectedFunding.push({ id: receipt.sourceReference, kind: 'branch_funding', branchId: receipt.sourceBranchId,
        branchNameAr: branchNames.get(receipt.sourceBranchId ?? '') ?? receipt.sourceBranchId,
        channel: 'historical', currency: receipt.currency, amount: serializeMoney(receipt.amount),
        occurredOn: receipt.occurredOn, businessDate: receipt.occurredOn,
        description: receipt.description, journalEntryId: null, paidFrom: 'owner_outside',
        externalReference: receipt.sourceReference, companyCashEffect: '0.00', expenseEffect: '0.00' })
    }
    const fundingTotals = { SYP_NEW: 0n, USD: 0n }
    for (const payment of selectedFunding) {
      const currency = payment.currency as Currency
      fundingTotals[currency] += moneySchema.parse(String(payment.amount))
    }
    const combinedTotals = { SYP_NEW: serializeMoney(minor(moneySchema.parse(result.totals.SYP_NEW)+fundingTotals.SYP_NEW)),
      USD: serializeMoney(minor(moneySchema.parse(result.totals.USD)+fundingTotals.USD)) }
    return { ...wireResult, combinedTotals, paymentCount: result.payments.length + selectedFunding.length,
      branchFundingBasis: sourceOwnerBranch.some(row => row.movementType === 'branch_payment' &&
      row.paidFrom === 'owner_outside') ? 'source_occurrence_reconciled_with_verified_receipts' : 'current_verified_receipts_by_business_date',
      branchFundingTotals: { SYP_NEW: serializeMoney(minor(fundingTotals.SYP_NEW)),
        USD: serializeMoney(minor(fundingTotals.USD)) },
      branchFundingPayments: selectedFunding.sort((a, b) => String(a.occurredOn).localeCompare(String(b.occurredOn))) }
  })
}
