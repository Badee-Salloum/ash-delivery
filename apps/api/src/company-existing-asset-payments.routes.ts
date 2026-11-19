import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Deps, ExistingAssetPaymentEvent } from '@ash/contracts'
import { moneySchema, serializeMoney } from '@ash/contracts'
import { hasVisibleText, isCalendarDate, minor, parseMinor } from '@ash/domain'
import { ServiceError, todayFor } from './shifts.service.ts'
import { z } from 'zod'
import { activeAssetPayments, assetPaymentHash, assetPaymentSources, buildAssetInstallments, paymentSummary, saveAssetPayment } from './company-existing-asset-payments.service.ts'

const id = z.string().uuid().transform(value => value.toLowerCase())
const reason = z.string().trim().min(1).max(500).refine(hasVisibleText)
const date = z.string().refine(isCalendarDate).refine(value => value >= '2000-01-01' && value <= '9999-12-31')
const command = { idempotencyKey: id, expectedVersion: z.number().int().positive(), expectedPaymentVersion: z.number().int().nonnegative(), reason }
export function registerExistingAssetPaymentRoutes(app: FastifyInstance, deps: Deps): void {
  const permission = { config: { permission: 'company_fund.manage' as const } }
  async function company(req: FastifyRequest): Promise<string> {
    if (!['general_manager', 'system_admin'].includes(req.actor?.roleKey ?? '')) throw new ServiceError(403, 'forbidden')
    const branch = await deps.directory.companyBranch()
    if (!branch) throw new ServiceError(500, 'company_branch_missing')
    return branch.id
  }
  app.get('/company/existing-assets/payment-summaries', permission, async req => {
    const branchId = await company(req)
    return deps.financialUnitOfWork.run({ mode: 'read_snapshot', lockKey: `receivables:${branchId}`, actorId: req.actor!.userId }, async tx => {
      const events = await tx.existingAssets.paymentEvents(branchId), sources = await assetPaymentSources(deps, tx, branchId)
      const summaries = (await tx.existingAssets.list(branchId)).map(card => ({ assetId: card.id, name: card.name, currency: card.currency,
        ...paymentSummary(card, events, sources, todayFor(deps)) }))
      return { summaries, reminders: summaries.flatMap(card => card.installments.filter(row => row.remind)
        .map(row => ({ assetId: card.assetId, name: card.name, currency: card.currency, ...row }))), reminderChannel: 'in_app' }
    })
  })
  app.get('/company/existing-assets/:id/payments', permission, async req => {
    const branchId = await company(req), params = z.object({ id }).parse(req.params)
    return deps.financialUnitOfWork.run({ mode: 'read_snapshot', lockKey: `receivables:${branchId}`, actorId: req.actor!.userId }, async tx => {
      const card = await tx.existingAssets.get(params.id)
      if (!card || card.branchId !== branchId) throw new ServiceError(404, 'asset_not_found')
      const events = await tx.existingAssets.paymentEvents(branchId), sources = await assetPaymentSources(deps, tx, branchId)
      const active = activeAssetPayments(events)
      return { ...paymentSummary(card, events, sources, todayFor(deps)), sources: sources.filter(row => row.currency === card.currency)
        .map(row => ({ ...row, available: serializeMoney(minor(parseMinor(row.amount) - active.filter(payment => payment.data.sourceKey === row.key)
          .reduce((sum, payment) => sum + parseMinor(payment.data.amount!), 0n))) }))
        .filter(row => parseMinor(row.available) > 0n) }
    })
  })
  const link = z.object({ ...command, sourceKey: z.string().min(1).max(200), sourceHash: z.string().length(64), amount: moneySchema.refine(value => value > 0n) }).strict()
  const schedule = z.object({ ...command, supplier: z.string().trim().min(1).max(160).refine(hasVisibleText), installmentAmount: moneySchema.refine(value => value > 0n),
    firstDueOn: date, recurrence: z.enum(['monthly', 'weekly', 'every_n_days']), intervalDays: z.number().int().min(1).max(366).default(30),
    reminderDays: z.number().int().min(0).max(30).default(3) }).strict()
  const unlink = z.object({ ...command, paymentId: id }).strict()
  for (const action of ['link', 'schedule', 'unlink', 'cancel_schedule'] as const) {
    app.post(`/company/existing-assets/:id/payments/${action}`, permission, async (req, reply) => {
      const branchId = await company(req), params = z.object({ id }).parse(req.params)
      const body = action === 'link' ? link.parse(req.body) : action === 'schedule' ? schedule.parse(req.body) : action === 'unlink' ? unlink.parse(req.body) : z.object(command).strict().parse(req.body)
      const requestHash = assetPaymentHash([params.id, action, req.actor!.userId, JSON.stringify(body, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)])
      const result = await deps.financialUnitOfWork.run({ lockKey: `receivables:${branchId}`, actorId: req.actor!.userId }, async tx => {
        const events = await tx.existingAssets.paymentEvents(branchId), prior = events.find(row => row.id === body.idempotencyKey)
        if (prior) {
          if (prior.requestHash !== requestHash) throw new ServiceError(409, 'idempotency_key_conflict')
          return { event: prior, replayed: true }
        }
        const card = await tx.existingAssets.get(params.id)
        if (!card || card.branchId !== branchId) throw new ServiceError(404, 'asset_not_found')
        if (card.version !== body.expectedVersion || events.filter(row => row.assetId === card.id).length !== body.expectedPaymentVersion) throw new ServiceError(409, 'asset_version_conflict')
        const sources = await assetPaymentSources(deps, tx, branchId)
        let data: ExistingAssetPaymentEvent['data'] = {}
        if (action === 'link') {
          const values = link.parse(req.body), source = sources.find(row => row.key === values.sourceKey)
          if (!source || source.hash !== values.sourceHash) throw new ServiceError(409, 'asset_payment_source_changed')
          return { event: await saveAssetPayment(deps, tx, { id: values.idempotencyKey, branchId, assetId: card.id,
            expectedVersion: card.version, source, amount: serializeMoney(values.amount), actorId: req.actor!.userId,
            reason: values.reason, requestHash, newExpense: false }), replayed: false }
        }
        if (action === 'schedule') {
          const values = schedule.parse(req.body), summary = paymentSummary(card, events, sources, todayFor(deps))
          if (card.price === null || card.status === 'sold' || card.pendingEdit || summary.status === 'needs_review' || summary.remaining === null) throw new ServiceError(422, 'asset_payment_card_not_ready')
          data = { supplier: values.supplier, reminderDays: values.reminderDays, priceSnapshot: card.price.toString(), baselinePaid: summary.totalPaid,
            installments: buildAssetInstallments(values.installmentAmount, parseMinor(summary.remaining), values.firstDueOn, values.recurrence, values.intervalDays) }
        } else if (action === 'unlink') {
          const values = unlink.parse(req.body)
          if (!activeAssetPayments(events).some(row => row.assetId === card.id && row.id === values.paymentId)) throw new ServiceError(409, 'asset_payment_link_missing')
          data = { paymentId: values.paymentId }
        } else if (!paymentSummary(card, events, sources, todayFor(deps)).plan) throw new ServiceError(409, 'asset_payment_schedule_missing')
        const event: ExistingAssetPaymentEvent = { id: body.idempotencyKey, assetId: card.id, branchId,
          version: body.expectedPaymentVersion + 1, kind: action, requestHash, reason: body.reason, data,
          createdBy: req.actor!.userId, createdAtMs: deps.clock.nowMs() }
        await tx.existingAssets.addPaymentEvent(event)
        return { event, replayed: false }
      })
      return reply.code(result.replayed ? 200 : 201).send({ ...result, cashEffect: 'none', administrativeOnly: true })
    })
  }
}
