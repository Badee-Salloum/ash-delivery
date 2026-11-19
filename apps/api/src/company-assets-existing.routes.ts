import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Deps, ExistingAssetEventRecord, ExistingAssetRecord, ExistingAssetRepo, FinancialTransactionDeps, JournalEntryRecord } from '@ash/contracts'
import { moneySchema, serializeMoney } from '@ash/contracts'
import { existingAssetDepreciationSchedule, hasVisibleText, isCalendarDate, minor, monthStartFor, type CalendarDate, type Minor } from '@ash/domain'
import { ServiceError, assertWeekOpen, todayFor } from './shifts.service.ts'
import { registerExistingAssetPaymentRoutes } from './company-existing-asset-payments.routes.ts'
import { activeAssetPayments } from './company-existing-asset-payments.service.ts'

// PostgreSQL UUIDs are canonical lowercase. Normalize before fingerprints and JSON snapshots,
// so uppercase client identities behave identically in memory and in guarded PG projections.
const id = z.string().uuid().transform((value) => value.toLowerCase())
const date = z.string().refine(isCalendarDate).refine((value) => value >= '2000-01-01')
const text = z.string().trim().min(1).max(500).refine(hasVisibleText)
const positive = moneySchema.refine((value) => value > 0n)
const nonnegative = moneySchema.refine((value) => value >= 0n)
const currency = z.enum(['SYP_NEW', 'USD'])
const fields = {
  vehicleId: id,
  name: z.string().trim().min(1).max(160).refine(hasVisibleText),
  currency,
  price: positive.nullable(),
  purchasedOn: date.nullable().default(null),
  useStartedOn: date.nullable().default(null),
  fundingSource: z.enum(['company', 'owner_outside', 'unknown']).default('unknown'),
  description: z.string().trim().max(500).default(''),
}
const register = z.object({ idempotencyKey: id, ...fields }).strict()
const revise = z.object({ idempotencyKey: id, expectedVersion: z.number().int().positive(), reason: text, ...fields }).strict()
const command = { idempotencyKey: id, expectedVersion: z.number().int().positive(), reason: text }

/** Stable, exact fingerprint; a UUID cannot be reused for a different card or command kind. */
function fingerprint(kind: ExistingAssetEventRecord['kind'], assetId: string, actorId: string, body: unknown): string {
  return JSON.stringify({ kind, assetId, actorId, body }, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)
}

function wireCard(card: ExistingAssetRecord, asOf: CalendarDate): Record<string, unknown> {
  const calculatedSchedule = card.depreciation && card.price !== null
    ? (card.depreciationSchedule ?? existingAssetDepreciationSchedule({ cost: card.price, ...card.depreciation }))
      .filter((row) => card.sale?.status !== 'confirmed' || row.periodMonth < monthStartFor(card.sale.occurredOn))
      .map((row) => ({ ...row, amount: serializeMoney(row.amount), status: row.endsOn <= asOf ? 'calculated_not_posted' : 'scheduled' })) : []
  return {
    ...card, registrationMode: 'register_existing', price: card.price === null ? null : serializeMoney(card.price),
    depreciationSchedule: card.depreciationSchedule?.map(row => ({ ...row, amount: serializeMoney(row.amount) })),
    depreciation: card.depreciation === null ? null : { ...card.depreciation, residualValue: serializeMoney(card.depreciation.residualValue) },
    recognition: card.recognition === null ? null : { ...card.recognition, cost: serializeMoney(card.recognition.cost), accumulatedDepreciation: serializeMoney(card.recognition.accumulatedDepreciation) },
    sale: card.sale === null ? null : { ...card.sale, price: serializeMoney(card.sale.price), receivedAmount: serializeMoney(card.sale.receivedAmount), bookValue: card.sale.bookValue === null ? null : serializeMoney(card.sale.bookValue) },
    pendingEdit: card.pendingEdit === undefined || card.pendingEdit === null ? null : {
      ...card.pendingEdit, price: card.pendingEdit.price === null ? null : serializeMoney(card.pendingEdit.price),
    },
    calculatedSchedule,
    depreciationAsOf: asOf,
    bookValue: card.accountingStatus === 'approved' && card.recognition
      ? card.status === 'sold' ? '0.00' : serializeMoney(minor(card.recognition.cost - card.recognition.accumulatedDepreciation)) : null,
    bookValueStatus: card.accountingStatus === 'approved' ? card.status === 'sold' ? 'disposed' : 'approved_baseline_only' : 'unreviewed',
    depreciationExpensePosted: false,
    depreciationStoppedOn: card.sale?.status === 'confirmed' ? card.sale.occurredOn : null,
    paymentStatus: 'not_documented',
    cashEffect: { company: '0.00', branch: '0.00', ownerFunding: '0.00' },
  }
}

function assertDates(card: Pick<ExistingAssetRecord, 'purchasedOn' | 'useStartedOn'>, today: CalendarDate): void {
  if ((card.purchasedOn !== null && card.purchasedOn > today) ||
    (card.useStartedOn !== null && card.useStartedOn > today) ||
    (card.purchasedOn !== null && card.useStartedOn !== null && card.purchasedOn > card.useStartedOn)) {
    throw new ServiceError(422, 'invalid_existing_asset_dates')
  }
}

function net(entry: JournalEntryRecord, code: string): Minor {
  return minor(entry.lines.filter((line) => line.fundCode === code).reduce((sum, line) => sum + (line.side === 'D' ? line.amount : -line.amount), 0n))
}

export function registerExistingAssetRoutes(app: FastifyInstance, deps: Deps): void {
  registerExistingAssetPaymentRoutes(app, deps)
  const permission = { config: { permission: 'company_fund.manage' as const } }
  function reviewRole(req: FastifyRequest): void {
    if (req.actor?.roleKey !== 'general_manager' && req.actor?.roleKey !== 'system_admin') throw new ServiceError(403, 'forbidden')
  }
  async function companyId(): Promise<string> {
    const branch = await deps.directory.companyBranch()
    if (!branch) throw new ServiceError(500, 'company_branch_missing')
    return branch.id
  }
  async function replay(repo: ExistingAssetRepo, key: string, hash: string): Promise<ExistingAssetRecord | null> {
    const prior = await repo.getEvent(key)
    if (!prior) return null
    if (prior.requestFingerprint !== hash) throw new ServiceError(409, 'idempotency_key_conflict')
    // Return the original revision even if the card has been edited subsequently.
    return prior.snapshot
  }
  async function apply(
    req: FastifyRequest, assetId: string, kind: ExistingAssetEventRecord['kind'],
    body: { idempotencyKey: string; expectedVersion?: number; reason?: string },
    build: (prior: ExistingAssetRecord | null, tx: FinancialTransactionDeps) => Promise<ExistingAssetRecord>,
    after?: (tx: FinancialTransactionDeps, card: ExistingAssetRecord) => Promise<void>,
  ): Promise<{ asset: ExistingAssetRecord; replayed: boolean }> {
    reviewRole(req)
    const branchId = await companyId()
    const hash = fingerprint(kind, assetId, req.actor!.userId, body)
    const old = await replay(deps.existingAssets, body.idempotencyKey, hash)
    if (old) return { asset: old, replayed: true }
    return deps.financialUnitOfWork.run({ lockKey: `receivables:${branchId}`, actorId: req.actor!.userId, requestId: req.requestId }, async (tx) => {
      const again = await replay(tx.existingAssets, body.idempotencyKey, hash)
      if (again) return { asset: again, replayed: true }
      const prior = await tx.existingAssets.get(assetId)
      if (kind === 'register' ? prior !== null : prior === null) throw new ServiceError(kind === 'register' ? 409 : 404, 'asset_not_found_or_duplicate')
      if (prior && prior.branchId !== branchId) throw new ServiceError(404, 'asset_not_found')
      if (prior && prior.version !== body.expectedVersion) throw new ServiceError(409, 'asset_version_conflict', { currentVersion: prior.version })
      const asset = await build(prior, tx)
      const allocations = activeAssetPayments(await tx.existingAssets.paymentEvents(branchId)).filter(row => row.assetId === assetId)
      if (allocations.length && (asset.currency !== prior?.currency || asset.price === null ||
        allocations.reduce((sum, row) => sum + BigInt(row.data.amount!.replace('.', '')), 0n) > asset.price)) {
        throw new ServiceError(422, 'asset_payment_edit_conflict')
      }
      assertDates(asset, todayFor(deps))
      if (!(await tx.directory.vehicle(asset.vehicleId))) throw new ServiceError(404, 'vehicle_not_found')
      const legacy = await tx.companyFinance.getAssetByVehicle(asset.vehicleId)
      const neutral = await tx.existingAssets.getByVehicle(asset.vehicleId)
      if (legacy || (neutral && neutral.id !== asset.id)) throw new ServiceError(409, 'asset_vehicle_already_registered', { assetId: legacy?.id ?? neutral?.id })
      const event: ExistingAssetEventRecord = {
        id: body.idempotencyKey, assetId, branchId, kind,
        expectedVersion: prior?.version ?? 0, version: asset.version, requestFingerprint: hash,
        reason: body.reason ?? 'Register an existing motor without a payment', snapshot: asset,
        createdBy: req.actor!.userId, createdAtMs: deps.clock.nowMs(),
      }
      await tx.existingAssets.apply(event)
      await after?.(tx, asset)
      return { asset, replayed: false }
    })
  }
  function update(prior: ExistingAssetRecord, req: FastifyRequest): ExistingAssetRecord {
    return { ...prior, version: prior.version + 1, updatedBy: req.actor!.userId, updatedAtMs: deps.clock.nowMs() }
  }
  function reviewedEdit(prior: ExistingAssetRecord, effectiveOn: CalendarDate) {
    const patch = prior.pendingEdit
    if (!patch) throw new ServiceError(409, 'asset_edit_proposal_required')
    if (prior.status === 'sold') throw new ServiceError(422, 'asset_sold_financial_edit_not_allowed')
    if (effectiveOn < todayFor(deps)) throw new ServiceError(422, 'asset_edit_past_effect_not_allowed')
    if (patch.price === null || patch.useStartedOn === null) throw new ServiceError(422, 'asset_edit_complete_inputs_required')
    if (patch.currency !== prior.currency) throw new ServiceError(422, 'asset_edit_currency_conversion_required')
    assertDates(patch, todayFor(deps))
    if (prior.depreciation && patch.useStartedOn > prior.depreciation.startsOn) throw new ServiceError(422, 'invalid_asset_depreciation_policy')
    const schedule = prior.depreciation && prior.price !== null
      ? prior.depreciationSchedule ?? existingAssetDepreciationSchedule({ cost: prior.price, ...prior.depreciation }) : []
    // The in-progress month remains frozen too; revise from an untouched period boundary only.
    if (schedule.some(row => row.startsOn < effectiveOn && row.endsOn >= effectiveOn)) throw new ServiceError(422, 'asset_edit_period_boundary_required')
    const frozen = schedule.filter(row => row.endsOn < effectiveOn)
    const future = schedule.filter(row => row.startsOn >= effectiveOn)
    const calculated = frozen.reduce((sum, row) => sum + row.amount, 0n)
    const remaining = patch.price - calculated - (prior.depreciation?.residualValue ?? 0n)
    if (remaining < 0n) throw new ServiceError(422, 'asset_edit_below_calculated_depreciation')
    const base = future.length ? remaining / BigInt(future.length) : 0n
    return { patch, schedule: [...frozen, ...future.map((row, index) => ({ ...row,
      amount: minor(index === future.length - 1 ? remaining - base * BigInt(future.length - 1) : base) }))],
      calculated: serializeMoney(minor(calculated)), frozenPeriods: frozen.length, remainingPeriods: future.length,
      futureMonthly: serializeMoney(minor(base)), cashEffect: 'none' }
  }
  async function receipt(tx: FinancialTransactionDeps, entryId: number, branchId: string): Promise<JournalEntryRecord> {
    const entry = await tx.ledger.findEntryById(entryId)
    if (!entry || entry.branchId !== branchId || entry.shiftId !== null) throw new ServiceError(422, 'asset_journal_link_mismatch')
    if (await tx.companyLedger.findReversalOf(entry.id)) throw new ServiceError(422, 'asset_journal_link_reversed')
    return entry
  }

  app.get('/company/existing-assets/vehicles', permission, async (req) => {
    reviewRole(req)
    const branchId = await companyId()
    const [branches, cards, legacy] = await Promise.all([deps.directory.listBranches(), deps.existingAssets.list(branchId), deps.companyFinance.listAssets(branchId)])
    const byVehicle = new Map([...legacy, ...cards.filter((card) => card.status !== 'sold')].filter((card) => card.vehicleId !== null).map((card) => [card.vehicleId!, card.id]))
    const vehicles = (await Promise.all(branches.map((branch) => deps.directory.listVehicles(branch.id)))).flat()
    return { vehicles: vehicles.map((vehicle) => ({ ...vehicle, assetId: byVehicle.get(vehicle.id) ?? null })) }
  })
  app.get('/company/existing-assets', permission, async (req) => {
    reviewRole(req)
    const branchId = await companyId()
    const [cards, legacy] = await Promise.all([deps.existingAssets.list(branchId), deps.companyFinance.listAssets(branchId)])
    return { assets: cards.map(card => wireCard(card, todayFor(deps))), legacyAssets: legacy.map((asset) => ({ id: asset.id, vehicleId: asset.vehicleId, name: asset.name, currency: asset.currency, price: serializeMoney(asset.price), registrationMode: 'cash_purchase' })) }
  })
  app.get('/company/existing-assets/sale-receipts', permission, async (req) => {
    reviewRole(req)
    const query = z.object({ currency }).strict().parse(req.query)
    const branchId = await companyId()
    const cards = await deps.existingAssets.list(branchId)
    const used = new Set(cards.filter(card => card.sale?.status === 'confirmed').map(card => card.sale!.receiptEntryId))
    const movements = await deps.companyLedgerSource.listMovements(branchId, { from: '2000-01-01', to: todayFor(deps) })
    const receipts = []
    for (const { entry } of movements) {
      const amount = net(entry, `company_cash:${query.currency}`)
      if (entry.shiftId !== null || amount <= 0n || used.has(entry.id) || entry.lines.some(line => line.fundCode.startsWith('fixed_asset:')) || await deps.companyLedger.findReversalOf(entry.id)) continue
      receipts.push({ id: entry.id, occurredOn: entry.businessDate, amount: serializeMoney(amount), currency: query.currency, description: entry.reason ?? '' })
    }
    return { receipts: receipts.reverse(), cashEffect: 'none' }
  })
  app.get('/company/existing-assets/:id', permission, async (req) => {
    reviewRole(req)
    const params = z.object({ id }).parse(req.params)
    const card = await deps.existingAssets.get(params.id)
    if (!card || card.branchId !== await companyId()) throw new ServiceError(404, 'asset_not_found')
    return { asset: wireCard(card, todayFor(deps)), evidence: await deps.existingAssets.listEvidence(card.id), events: (await deps.existingAssets.listEvents(card.id)).map((event) => ({ ...event, snapshot: wireCard(event.snapshot, todayFor(deps)) })) }
  })
  app.post('/company/existing-assets', permission, async (req, reply) => {
    const body = register.parse(req.body)
    const { idempotencyKey, ...cardFields } = body
    const result = await apply(req, idempotencyKey, 'register', body, async () => ({
      id: idempotencyKey, branchId: await companyId(), ...cardFields,
      status: body.price !== null && body.useStartedOn !== null ? 'registered' : 'draft',
      accountingStatus: 'pending_review', version: 1, depreciation: null, recognition: null, sale: null, pendingEdit: null,
      createdBy: req.actor!.userId, createdAtMs: deps.clock.nowMs(), updatedBy: req.actor!.userId, updatedAtMs: deps.clock.nowMs(),
    }))
    return reply.code(result.replayed ? 200 : 201).send({ asset: wireCard(result.asset, todayFor(deps)), replayed: result.replayed })
  })
  app.post('/company/existing-assets/:id/edit', permission, async (req, reply) => {
    const params = z.object({ id }).parse(req.params)
    const body = revise.parse(req.body)
    const result = await apply(req, params.id, 'edit', body, async (previous, tx) => {
      const prior = previous!
      const financialChange = prior.price !== body.price || prior.currency !== body.currency || prior.vehicleId !== body.vehicleId || prior.useStartedOn !== body.useStartedOn || prior.purchasedOn !== body.purchasedOn
      const { idempotencyKey: _key, expectedVersion: _version, reason: _reason, ...patch } = body
      assertDates(patch, todayFor(deps))
      if (patch.vehicleId !== prior.vehicleId) {
        if (!(await tx.directory.vehicle(patch.vehicleId))) throw new ServiceError(404, 'vehicle_not_found')
        const other = await tx.existingAssets.getByVehicle(patch.vehicleId)
        if (await tx.companyFinance.getAssetByVehicle(patch.vehicleId) || (other && other.id !== prior.id)) throw new ServiceError(409, 'asset_vehicle_already_registered')
      }
      if (financialChange && (prior.status === 'sold' || prior.depreciation !== null || prior.recognition !== null)) {
        // Never rewrite approved cost, a used calculation policy or a completed sale implicitly.
        // The user's request is retained, with the effective card and all journals unchanged.
        return { ...update(prior, req), pendingEdit: { ...patch, requestId: body.idempotencyKey,
          sourceVersion: prior.version, reason: body.reason, requestedBy: req.actor!.userId, requestedAtMs: deps.clock.nowMs() } }
      }
      return { ...update(prior, req), ...patch, status: prior.status === 'sold' ? 'sold' : body.price !== null && body.useStartedOn !== null ? 'registered' : 'draft', accountingStatus: financialChange && prior.recognition ? 'needs_correction' : prior.accountingStatus }
    })
    return reply.code(result.replayed ? 200 : 201).send({ asset: wireCard(result.asset, todayFor(deps)), replayed: result.replayed,
      requiresReview: result.asset.pendingEdit?.requestId === body.idempotencyKey })
  })
  app.get('/company/existing-assets/:id/edit-preview', permission, async req => {
    reviewRole(req)
    const params = z.object({ id }).parse(req.params)
    const { effectiveOn } = z.object({ effectiveOn: date }).strict().parse(req.query)
    const prior = await deps.existingAssets.get(params.id)
    if (!prior || prior.branchId !== await companyId()) throw new ServiceError(404, 'asset_not_found')
    const plan = reviewedEdit(prior, effectiveOn)
    return { requestId: plan.patch.requestId, version: prior.version, effectiveOn, before: wireCard(prior, todayFor(deps)),
      afterPrice: serializeMoney(plan.patch.price!), calculated: plan.calculated, frozenPeriods: plan.frozenPeriods,
      remainingPeriods: plan.remainingPeriods, futureMonthly: plan.futureMonthly,
      requiresJournal: prior.recognition !== null && prior.recognition.cost !== plan.patch.price,
      cashEffect: plan.cashEffect, branchCashEffect: 'none' }
  })
  app.post('/company/existing-assets/:id/edit-confirm', permission, async (req, reply) => {
    const params = z.object({ id }).parse(req.params)
    const body = z.object({ ...command, requestId: id, effectiveOn: date,
      journalEntryId: z.number().int().positive().nullable().default(null), acknowledged: z.literal(true) }).strict().parse(req.body)
    const result = await apply(req, params.id, 'edit_confirm', body, async (previous, tx) => {
      const prior = previous!, plan = reviewedEdit(prior, body.effectiveOn)
      if (plan.patch.requestId !== body.requestId) throw new ServiceError(409, 'asset_edit_proposal_changed')
      let recognition = prior.recognition
      if (recognition && recognition.cost !== plan.patch.price) {
        if (body.journalEntryId === null) throw new ServiceError(422, 'asset_edit_accounting_entry_required')
        const entry = await receipt(tx, body.journalEntryId, prior.branchId)
        const code = `fixed_asset:${prior.currency}:${prior.id}`, difference = plan.patch.price! - recognition.cost
        if (entry.businessDate !== body.effectiveOn || net(entry, code) !== difference ||
          await tx.ledger.fundBalance(prior.branchId, code) !== plan.patch.price! - recognition.accumulatedDepreciation ||
          recognition.accumulatedDepreciation > plan.patch.price! ||
          entry.lines.some(line => line.fundCode.startsWith('company_cash:') || line.fundCode.startsWith('company_custody:'))) {
          throw new ServiceError(422, 'asset_edit_accounting_entry_mismatch')
        }
        recognition = { ...recognition, cost: plan.patch.price!, journalEntryId: entry.id, asOf: body.effectiveOn,
          approvedBy: req.actor!.userId, approvedAtMs: deps.clock.nowMs(), reason: body.reason }
      } else if (body.journalEntryId !== null) throw new ServiceError(422, 'asset_edit_journal_not_required')
      const { requestId: _request, sourceVersion: _source, reason: _reason, requestedBy: _by, requestedAtMs: _at, ...patch } = plan.patch
      return { ...update(prior, req), ...patch, recognition, pendingEdit: null,
        ...(prior.depreciation ? { depreciationSchedule: plan.schedule } : {}),
        lastEditReview: { requestId: body.requestId, effectiveOn: body.effectiveOn, reason: body.reason, journalEntryId: body.journalEntryId } }
    })
    return reply.code(result.replayed ? 200 : 201).send({ asset: wireCard(result.asset, todayFor(deps)), replayed: result.replayed, cashEffect: 'none' })
  })
  app.post('/company/existing-assets/:id/edit-reject', permission, async (req, reply) => {
    const params = z.object({ id }).parse(req.params)
    const body = z.object({ ...command, requestId: id }).strict().parse(req.body)
    const result = await apply(req, params.id, 'edit_reject', body, async previous => {
      if (previous!.pendingEdit?.requestId !== body.requestId) throw new ServiceError(409, 'asset_edit_proposal_changed')
      return { ...update(previous!, req), pendingEdit: null }
    })
    return reply.code(result.replayed ? 200 : 201).send({ asset: wireCard(result.asset, todayFor(deps)), replayed: result.replayed })
  })
  app.post('/company/existing-assets/:id/depreciation/activate', permission, async (req, reply) => {
    const params = z.object({ id }).parse(req.params)
    const body = z.object({ ...command, startsOn: date, usefulMonths: z.number().int().min(1).max(600), residualValue: nonnegative }).strict().parse(req.body)
    const result = await apply(req, params.id, 'depreciation_activate', body, async (previous) => {
      const prior = previous!
      if (prior.status !== 'registered' || prior.price === null || prior.useStartedOn === null || prior.accountingStatus === 'needs_correction') throw new ServiceError(422, 'asset_depreciation_requires_reviewed_inputs')
      if (prior.depreciation) throw new ServiceError(422, 'asset_depreciation_already_active')
      if (body.startsOn < prior.useStartedOn || body.residualValue > prior.price) throw new ServiceError(422, 'invalid_asset_depreciation_policy')
      // Older months need a separate accounting-period review, never silent retroactive activation.
      if (body.startsOn < todayFor(deps)) throw new ServiceError(422, 'asset_depreciation_prior_period_review_required')
      return { ...update(prior, req), depreciation: { startsOn: body.startsOn, activatedOn: todayFor(deps), usefulMonths: body.usefulMonths, residualValue: body.residualValue, activatedBy: req.actor!.userId, activatedAtMs: deps.clock.nowMs(), activationReason: body.reason } }
    })
    return reply.code(result.replayed ? 200 : 201).send({ asset: wireCard(result.asset, todayFor(deps)), replayed: result.replayed })
  })
  app.post('/company/existing-assets/:id/evidence', permission, async (req, reply) => {
    const params = z.object({ id }).parse(req.params)
    const body = z.object({ ...command, operationId: id.nullable().default(null), journalEntryId: z.number().int().positive().nullable().default(null), mediaId: id.nullable().default(null), description: text }).strict().parse(req.body)
    if (body.operationId === null && body.journalEntryId === null && body.mediaId === null) throw new ServiceError(422, 'asset_evidence_source_required')
    let journalEntryId = body.journalEntryId
    const result = await apply(req, params.id, 'evidence_link', body, async (previous, tx) => {
      if (body.operationId !== null) {
        const operation = await tx.companyLedger.findCommand(body.operationId)
        if (!operation || operation.branchId !== previous!.branchId) throw new ServiceError(422, 'asset_evidence_operation_mismatch')
        if (journalEntryId !== null && journalEntryId !== operation.journalEntryId) throw new ServiceError(422, 'asset_evidence_operation_mismatch')
        journalEntryId = operation.journalEntryId
      }
      if (journalEntryId !== null) await receipt(tx, journalEntryId, previous!.branchId)
      if (body.mediaId !== null && !(await deps.media.findById(body.mediaId))) throw new ServiceError(404, 'media_not_found')
      return update(previous!, req)
    }, async (tx, card) => tx.existingAssets.addEvidence({ id: body.idempotencyKey, assetId: card.id, operationId: body.operationId, journalEntryId, mediaId: body.mediaId, description: body.description, createdBy: req.actor!.userId, createdAtMs: deps.clock.nowMs() }))
    return reply.code(result.replayed ? 200 : 201).send({ asset: wireCard(result.asset, todayFor(deps)), replayed: result.replayed })
  })
  app.post('/company/existing-assets/:id/recognition', permission, async (req, reply) => {
    const params = z.object({ id }).parse(req.params)
    const body = z.object({ ...command, journalEntryId: z.number().int().positive(), cost: positive, accumulatedDepreciation: nonnegative, asOf: date }).strict().parse(req.body)
    const result = await apply(req, params.id, 'recognition_link', body, async (previous, tx) => {
      const prior = previous!
      if (prior.status !== 'registered' || prior.price !== body.cost || body.accumulatedDepreciation > body.cost || body.asOf > todayFor(deps)) throw new ServiceError(422, 'asset_recognition_review_required')
      const entry = await receipt(tx, body.journalEntryId, prior.branchId)
      const code = `fixed_asset:${prior.currency}:${prior.id}`
      if (net(entry, code) !== body.cost || entry.lines.some((line) => line.fundCode === code && line.currency !== prior.currency)) throw new ServiceError(422, 'asset_recognition_entry_mismatch')
      if (await tx.ledger.fundBalance(prior.branchId, code) !== body.cost - body.accumulatedDepreciation) throw new ServiceError(422, 'asset_recognition_balance_mismatch')
      return { ...update(prior, req), accountingStatus: 'approved', recognition: { journalEntryId: body.journalEntryId, accountAssetId: prior.id, cost: body.cost, accumulatedDepreciation: body.accumulatedDepreciation, asOf: body.asOf, approvedBy: req.actor!.userId, approvedAtMs: deps.clock.nowMs(), reason: body.reason } }
    })
    return reply.code(result.replayed ? 200 : 201).send({ asset: wireCard(result.asset, todayFor(deps)), replayed: result.replayed })
  })
  app.post('/company/existing-assets/:id/sales', permission, async (req, reply) => {
    const params = z.object({ id }).parse(req.params)
    const body = z.object({ ...command, buyer: text, currency, price: positive, occurredOn: date, receivedAmount: nonnegative, receiptDestination: z.enum(['company', 'owner_outside']), receiptEntryId: z.number().int().positive().nullable().default(null), debtId: id.nullable().default(null) }).strict().parse(req.body)
    const result = await apply(req, params.id, 'sale_draft', body, async (previous, tx) => {
      const prior = previous!
      if (prior.status === 'sold') throw new ServiceError(422, 'asset_already_sold')
      if (body.occurredOn > todayFor(deps) || body.receivedAmount > body.price || (prior.useStartedOn !== null && body.occurredOn < prior.useStartedOn)) throw new ServiceError(422, 'invalid_asset_sale')
      if (body.receiptEntryId !== null) {
        const entry = await receipt(tx, body.receiptEntryId, prior.branchId)
        if (body.receiptDestination !== 'company' || body.receivedAmount <= 0n || net(entry, `company_cash:${body.currency}`) !== body.receivedAmount) throw new ServiceError(422, 'asset_sale_receipt_mismatch')
      }
      if (body.debtId !== null) {
        const debt = await tx.companyFinance.getDebt(body.debtId)
        if (!debt || debt.branchId !== prior.branchId || debt.direction !== 'receivable' || debt.currency !== body.currency || debt.principal !== body.price - body.receivedAmount || debt.partyName !== body.buyer) throw new ServiceError(422, 'asset_sale_debt_mismatch')
      }
      return { ...update(prior, req), sale: { id: body.idempotencyKey, buyer: body.buyer, currency: body.currency, price: body.price, occurredOn: body.occurredOn, receivedAmount: body.receivedAmount, receiptDestination: body.receiptDestination, receiptEntryId: body.receiptEntryId, debtId: body.debtId, status: 'draft', disposalEntryId: null, bookValue: null, confirmedBy: null, confirmedAtMs: null, reason: body.reason } }
    })
    return reply.code(result.replayed ? 200 : 201).send({ asset: wireCard(result.asset, todayFor(deps)), replayed: result.replayed })
  })
  app.post('/company/existing-assets/:id/documentary-sale', permission, async (req, reply) => {
    const params = z.object({ id }).parse(req.params)
    const body = z.object({ ...command, buyer: text, currency, price: positive, occurredOn: date,
      receiptEntryId: z.number().int().positive() }).strict().parse(req.body)
    const result = await apply(req, params.id, 'sale_documentary', body, async (previous, tx) => {
      const prior = previous!
      if (prior.status === 'sold') throw new ServiceError(422, 'asset_already_sold')
      if (prior.status !== 'registered' || prior.price === null || prior.useStartedOn === null) throw new ServiceError(422, 'asset_documentary_sale_requires_card')
      // Administrative sale is not an escape hatch around financial recognition or disposal.
      if (prior.recognition !== null || prior.accountingStatus !== 'pending_review') throw new ServiceError(422, 'asset_documentary_sale_recognized_blocked')
      if (prior.pendingEdit) throw new ServiceError(422, 'asset_documentary_sale_pending_edit')
      if (body.occurredOn > todayFor(deps) || body.occurredOn < prior.useStartedOn) throw new ServiceError(422, 'invalid_asset_sale')
      const entry = await receipt(tx, body.receiptEntryId, prior.branchId)
      // For the simple card-only path the full price must already have been received once.
      // Partial sales require a separately approved debt policy, never an invented buyer debt.
      if (net(entry, `company_cash:${body.currency}`) !== body.price || entry.lines.some(line => line.fundCode.startsWith('fixed_asset:')))
        throw new ServiceError(422, 'asset_sale_receipt_mismatch')
      if (await tx.ledger.fundBalance(prior.branchId, `fixed_asset:${prior.currency}:${prior.id}`) !== 0n)
        throw new ServiceError(422, 'asset_documentary_sale_recognized_blocked')
      if ((await tx.existingAssets.list(prior.branchId)).some(card => card.id !== prior.id && card.sale?.status === 'confirmed' && card.sale.receiptEntryId === entry.id))
        throw new ServiceError(409, 'asset_sale_journal_already_linked')
      return { ...update(prior, req), status: 'sold', sale: { id: body.idempotencyKey, kind: 'documentary',
        buyer: body.buyer, currency: body.currency, price: body.price, occurredOn: body.occurredOn,
        receivedAmount: body.price, receiptDestination: 'company', receiptEntryId: entry.id, debtId: null,
        status: 'confirmed', disposalEntryId: null, bookValue: null,
        confirmedBy: req.actor!.userId, confirmedAtMs: deps.clock.nowMs(), reason: body.reason } }
    })
    return reply.code(result.replayed ? 200 : 201).send({ asset: wireCard(result.asset, todayFor(deps)), replayed: result.replayed,
      administrativeOnly: true, cashEffect: 'none', bookGain: null })
  })
  app.post('/company/existing-assets/:id/sales/:saleId/confirm', permission, async (req, reply) => {
    const params = z.object({ id, saleId: id }).parse(req.params)
    const body = z.object({ ...command, disposalEntryId: z.number().int().positive() }).strict().parse(req.body)
    const result = await apply(req, params.id, 'sale_confirm', { ...body, reason: body.reason, saleId: params.saleId } as typeof body, async (previous, tx) => {
      const prior = previous!
      const sale = prior.sale
      if (!sale || sale.id !== params.saleId || sale.status !== 'draft' || prior.status === 'sold') throw new ServiceError(422, 'asset_sale_draft_required')
      if (prior.accountingStatus !== 'approved' || !prior.recognition) throw new ServiceError(422, 'asset_sale_recognition_required')
      if (sale.currency !== prior.currency) throw new ServiceError(422, 'asset_sale_currency_review_required')
      if (sale.receiptDestination === 'owner_outside' && sale.receivedAmount > 0n) throw new ServiceError(422, 'asset_sale_owner_receipt_review_required')
      if (sale.receivedAmount > 0n) {
        if (sale.receiptEntryId === null) throw new ServiceError(422, 'asset_sale_receipt_required')
        const entry = await receipt(tx, sale.receiptEntryId, prior.branchId)
        if (net(entry, `company_cash:${sale.currency}`) !== sale.receivedAmount) throw new ServiceError(422, 'asset_sale_receipt_mismatch')
      }
      if (sale.price > sale.receivedAmount && sale.debtId === null) throw new ServiceError(422, 'asset_sale_receivable_review_required')
      await assertWeekOpen(deps, prior.branchId, sale.occurredOn)
      const disposal = await receipt(tx, body.disposalEntryId, prior.branchId)
      const bookValue = minor(prior.recognition.cost - prior.recognition.accumulatedDepreciation)
      const code = `fixed_asset:${prior.currency}:${prior.recognition.accountAssetId}`
      // No price-minus-manual-cost profit is invented; the actual reviewed disposal journal is required.
      if (net(disposal, code) !== -bookValue || await tx.ledger.fundBalance(prior.branchId, code) !== 0n) throw new ServiceError(422, 'asset_sale_disposal_entry_mismatch')
      if (sale.receivedAmount > 0n && sale.receiptEntryId !== disposal.id) {
        // Until a receivable-clearing policy is approved, a separate cash entry must not borrow
        // an unrelated disposal. The reviewed disposal must itself be the linked receipt.
        throw new ServiceError(422, 'asset_sale_separate_receipt_review_required')
      }
      const linked = (await tx.existingAssets.list(prior.branchId)).some((card) => card.id !== prior.id && card.sale?.status === 'confirmed' &&
        (card.sale.disposalEntryId === disposal.id || (sale.receiptEntryId !== null && card.sale.receiptEntryId === sale.receiptEntryId)))
      if (linked) throw new ServiceError(409, 'asset_sale_journal_already_linked')
      return { ...update(prior, req), status: 'sold', sale: { ...sale, status: 'confirmed', disposalEntryId: body.disposalEntryId, bookValue, confirmedBy: req.actor!.userId, confirmedAtMs: deps.clock.nowMs() } }
    })
    return reply.code(result.replayed ? 200 : 201).send({ asset: wireCard(result.asset, todayFor(deps)), replayed: result.replayed })
  })
}
