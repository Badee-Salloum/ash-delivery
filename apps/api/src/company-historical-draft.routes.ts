import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { CompanyHistoricalDraft, CompanyHistoricalDraftRevision, Deps, HistoricalDraftPayload } from '@ash/contracts'
import { currencySchema, nonblankReasonSchema, positiveMoneySchema, serializeMoney } from '@ash/contracts'
import { exchangeRate, isCalendarDate, minor, money, type Minor } from '@ash/domain'
import { ServiceError, todayFor } from './shifts.service.ts'

const id = z.string().uuid().transform(value => value.toLowerCase())
const date = z.string().refine(isCalendarDate).refine(value => value >= '2000-01-01')
const reference = nonblankReasonSchema.pipe(z.string().max(200))
const input = z.object({
  idempotencyKey: id, expectedVersion: z.number().int().nonnegative().optional(),
  type: z.enum(['deposit', 'withdrawal', 'expense', 'income', 'exchange', 'branch_receipt', 'branch_payment', 'asset_payment', 'refund']),
  occurredOn: date, occurredPrecision: z.enum(['day', 'month']).default('day'),
  occurredMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  description: nonblankReasonSchema,
  currency: currencySchema.optional(), amount: positiveMoneySchema.optional(),
  historicalRate: positiveMoneySchema.optional(), rateBasis: z.enum(['documented', 'estimated']).optional(),
  paidFrom: z.enum(['pocket', 'owner_outside']).optional(), categoryId: id.optional(),
  account: z.enum(['owner_funding', 'opening']).optional(),
  fromCurrency: currencySchema.optional(), fromAmount: positiveMoneySchema.optional(),
  toCurrency: currencySchema.optional(), toAmount: positiveMoneySchema.optional(),
  sourceUnit: nonblankReasonSchema.pipe(z.string().max(100)).optional(),
  receiptReference: reference.optional(), externalReference: reference.optional(),
  branchId: id.optional(), assetId: id.optional(),
}).strict().superRefine((body, context) => {
  const required = (value: unknown, key: string): void => { if (value === undefined) context.addIssue({ code: 'custom', message: `${key} is required`, path: [key] }) }
  const forbidden = (value: unknown, key: string): void => { if (value !== undefined) context.addIssue({ code: 'custom', message: `${key} is not valid for this type`, path: [key] }) }
  if (body.occurredPrecision === 'month') {
    required(body.occurredMonth, 'occurredMonth')
    if (body.occurredOn !== `${body.occurredMonth}-01`) context.addIssue({ code: 'custom', message: 'month precision requires its month-first anchor', path: ['occurredOn'] })
  } else forbidden(body.occurredMonth, 'occurredMonth')
  if (!['expense', 'branch_payment', 'asset_payment'].includes(body.type)) forbidden(body.paidFrom, 'paidFrom')
  if (body.type === 'branch_receipt' || body.type === 'branch_payment') required(body.branchId, 'branchId')
  if (body.type !== 'asset_payment') forbidden(body.assetId, 'assetId')
  if (body.type !== 'expense' && body.type !== 'income') forbidden(body.categoryId, 'categoryId')
  if (body.type !== 'deposit') forbidden(body.account, 'account')
  if (body.receiptReference && body.externalReference && body.receiptReference !== body.externalReference) {
    context.addIssue({ code: 'custom', message: 'receipt aliases must agree', path: ['receiptReference'] })
  }
  if (body.type === 'exchange') {
    for (const key of ['fromCurrency', 'fromAmount', 'toCurrency', 'toAmount'] as const) required(body[key], key)
    if (body.fromCurrency && body.fromCurrency === body.toCurrency) context.addIssue({ code: 'custom', message: 'exchange currencies must differ', path: ['toCurrency'] })
    for (const key of ['currency', 'amount', 'historicalRate', 'rateBasis'] as const) forbidden(body[key], key)
  } else {
    required(body.currency, 'currency'); required(body.amount, 'amount')
    for (const key of ['fromCurrency', 'fromAmount', 'toCurrency', 'toAmount'] as const) forbidden(body[key], key)
    if (body.currency === 'USD') required(body.historicalRate, 'historicalRate')
    else { forbidden(body.historicalRate, 'historicalRate'); forbidden(body.rateBasis, 'rateBasis') }
  }
})

function normalize(body: z.infer<typeof input>): HistoricalDraftPayload {
  let frozen = body.historicalRate ?? null
  if (body.type === 'exchange') {
    try {
      const rate = exchangeRate(money(body.fromCurrency!, body.fromAmount!), money(body.toCurrency!, body.toAmount!))
      if (rate > 9_223_372_036_854_775_807n) throw new Error('rate overflow')
      frozen = minor(rate)
    } catch { throw new ServiceError(422, 'invalid_exchange_rate') }
  }
  const wire = (value: Minor | null | undefined): string | null => value == null ? null : serializeMoney(value)
  return {
    type: body.type, occurredOn: body.occurredOn, occurredPrecision: body.occurredPrecision, occurredMonth: body.occurredMonth ?? null,
    description: body.description, currency: body.currency ?? null, amount: wire(body.amount), paidFrom: body.paidFrom ?? 'pocket',
    categoryId: body.categoryId ?? null, account: body.type === 'deposit' ? body.account ?? null : null,
    historicalRate: body.type === 'exchange' ? null : wire(body.historicalRate), sypMinorPerUsd: frozen?.toString() ?? null,
    rateBasis: body.currency === 'USD' ? body.rateBasis ?? 'documented' : null,
    fromCurrency: body.fromCurrency ?? null, fromAmount: wire(body.fromAmount), toCurrency: body.toCurrency ?? null, toAmount: wire(body.toAmount),
    sourceUnit: body.sourceUnit ?? null, receiptReference: body.receiptReference ?? body.externalReference ?? null,
    branchId: body.branchId ?? null, assetId: body.assetId ?? null,
  }
}

function assertRole(req: FastifyRequest): void {
  if (req.actor?.roleKey !== 'general_manager' && req.actor?.roleKey !== 'system_admin') throw new ServiceError(403, 'forbidden', { reason: 'historical_roles_only' })
}

/** An original UUID replay returns the originally saved version, even after subsequent edits. */
function atRevision(draft: CompanyHistoricalDraft, revision: CompanyHistoricalDraftRevision): CompanyHistoricalDraft {
  return { ...draft, version: revision.version, updatedBy: revision.actorId, updatedAtMs: revision.createdAtMs,
    payload: revision.payload, revisions: draft.revisions.filter(row => row.version <= revision.version) }
}

/** Administrative evidence is intentionally independent of posting gates and sealed periods. */
export function registerCompanyHistoricalDraftRoutes(app: FastifyInstance, deps: Deps, creationEnabled = false): void {
  const permission = { config: { permission: 'company_fund.manage' as const } }
  const companyId = async (): Promise<string> => {
    const company = await deps.directory.companyBranch()
    if (!company) throw new ServiceError(500, 'company_branch_missing')
    return company.id
  }
  app.get('/company/historical-drafts', permission, async req => {
    assertRole(req)
    return { drafts: await deps.companyHistoricalDrafts.list(await companyId()) }
  })
  app.get('/company/historical-drafts/:id', permission, async req => {
    assertRole(req)
    const params = z.object({ id }).parse(req.params)
    const draft = await deps.companyHistoricalDrafts.get(params.id)
    if (!draft || draft.companyBranchId !== await companyId()) throw new ServiceError(404, 'historical_draft_not_found')
    return { draft }
  })

  for (const method of ['POST', 'PATCH'] as const) app.route({
    method, url: method === 'POST' ? '/company/historical-drafts' : '/company/historical-drafts/:id', ...permission,
    handler: async (req, reply) => {
      assertRole(req)
      if (method === 'POST' && !creationEnabled) throw new ServiceError(409, 'historical_creation_retired')
      const body = input.parse(req.body), companyBranchId = await companyId()
      if ((method === 'POST' && body.expectedVersion !== undefined) || (method === 'PATCH' && body.expectedVersion === undefined)) throw new ServiceError(400, 'invalid_request')
      const draftId = method === 'POST' ? body.idempotencyKey : z.object({ id }).parse(req.params).id
      const expectedVersion = body.expectedVersion ?? 0, payload = normalize(body), actorId = req.actor!.userId
      const requestHash = createHash('sha256').update(JSON.stringify({ method, draftId, companyBranchId, expectedVersion, actorId, payload })).digest('hex')
      const result = await deps.financialUnitOfWork.run({ lockKey: `receivables:${companyBranchId}`, actorId, requestId: req.requestId }, async tx => {
        const prior = await tx.companyHistoricalDrafts.getByRequest(body.idempotencyKey)
        if (prior) {
          const draft = await tx.companyHistoricalDrafts.get(prior.draftId)
          if (prior.requestHash !== requestHash || !draft || draft.companyBranchId !== companyBranchId) throw new ServiceError(409, 'idempotency_key_conflict')
          return { draft: atRevision(draft, prior), replayed: true }
        }
        if (body.occurredOn > todayFor(deps)) throw new ServiceError(422, 'invalid_occurrence_date')
        if (body.branchId) {
          const branch = await deps.directory.branch(body.branchId)
          if (!branch || branch.kind !== 'branch') throw new ServiceError(422, 'historical_draft_branch_not_found')
        }
        if (body.assetId) {
          const asset = await tx.existingAssets.get(body.assetId) ?? await tx.companyFinance.getAsset(body.assetId)
          if (!asset || asset.branchId !== companyBranchId) throw new ServiceError(422, 'historical_draft_asset_not_found')
        }
        if (body.categoryId) {
          const categories = body.type === 'expense' ? await tx.expenses.listCategories() : await tx.incomes.listCategories()
          if (!categories.some(category => category.id === body.categoryId)) throw new ServiceError(422, body.type === 'expense' ? 'expense_category_not_found' : 'income_category_not_found')
        }
        const existing = await tx.companyHistoricalDrafts.get(draftId)
        if (method === 'PATCH' && (!existing || existing.companyBranchId !== companyBranchId)) throw new ServiceError(404, 'historical_draft_not_found')
        if ((existing?.version ?? 0) !== expectedVersion) throw new ServiceError(409, 'historical_draft_version_conflict')
        const revision: CompanyHistoricalDraftRevision = { draftId, version: expectedVersion + 1, expectedVersion,
          requestId: body.idempotencyKey, requestHash, actorId, createdAtMs: deps.clock.nowMs(), payload }
        try {
          if (method === 'POST') await tx.companyHistoricalDrafts.create({ id: draftId, companyBranchId, createdBy: actorId, createdAtMs: revision.createdAtMs, status: 'draft' }, revision)
          else await tx.companyHistoricalDrafts.append(revision, expectedVersion)
        } catch (error) {
          const failure = error as { code?: string; constraint?: string }
          if (failure.code === 'HISTORICAL_DRAFT_VERSION_CONFLICT' || failure.constraint === 'company_historical_draft_version_guard') throw new ServiceError(409, 'historical_draft_version_conflict')
          if (failure.code === '23505' || failure.code === 'HISTORICAL_DRAFT_REQUEST_CONFLICT' || failure.code === 'HISTORICAL_DRAFT_ID_CONFLICT') throw new ServiceError(409, 'idempotency_key_conflict')
          throw error
        }
        const draft = await tx.companyHistoricalDrafts.get(draftId)
        if (!draft) throw new ServiceError(500, 'historical_draft_not_found')
        return { draft, replayed: false }
      })
      return reply.code(result.replayed ? 200 : method === 'POST' ? 201 : 200).send(result)
    },
  })
}
