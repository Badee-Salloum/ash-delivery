import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type {
  CompanyExpenseRecord,
  Deps,
  RecurringExpenseOccurrenceRecord,
  RecurringExpenseTemplateRecord,
} from '@ash/contracts'
import { moneySchema, serializeMoney } from '@ash/contracts'
import {
  type CalendarDate,
  type CompanyExpenseCentre,
  type Currency,
  MAX_DUE_RANGE_DAYS,
  addDays,
  companyExpense,
  countOccurrencesBetween,
  defaultDueWindow,
  daysBetween,
  dueStatus,
  isCalendarDate,
  minor,
  occurrencesBetween,
  recurrenceMatches,
  resolveFxDay,
  weekStartFor,
} from '@ash/domain'
import { ServiceError, assertWeekOpen, ensureFxDay, todayFor } from './shifts.service.ts'

const idSchema = z.string().uuid()
const dateSchema = z.string().refine(isCalendarDate, 'expected a real YYYY-MM-DD date')
const positiveMoney = moneySchema.refine((value) => value > 0n, 'amount must be positive')
const reasonSchema = z.string().trim().min(1).max(500)
const currencySchema = z.enum(['SYP_NEW', 'USD'])
const centreSchema = z.enum(['general', 'vehicle', 'asset'])
const paidFromSchema = z.enum(['pocket', 'reserve', 'owner_outside'])

const scheduleFields = z.object({
  title: z.string().trim().min(1).max(200),
  categoryId: idSchema,
  costCenterKind: centreSchema.default('general'),
  vehicleId: idSchema.nullable().default(null),
  assetId: idSchema.nullable().default(null),
  currency: currencySchema,
  paidFrom: paidFromSchema.default('pocket'),
  amount: positiveMoney,
  scheduleKind: z.enum(['weekly', 'monthly_first', 'every_n_days']),
  weekday: z.number().int().min(0).max(6).nullable().default(null),
  intervalDays: z.number().int().min(1).max(366).nullable().default(null),
  startsOn: dateSchema,
  endsOn: dateSchema.nullable().default(null),
}).superRefine((body, context) => {
  if (body.endsOn !== null && body.endsOn < body.startsOn) {
    context.addIssue({ code: 'custom', message: 'endsOn must be on or after startsOn', path: ['endsOn'] })
  }
  const scheduleMatches =
    (body.scheduleKind === 'weekly' && body.weekday !== null && body.intervalDays === null) ||
    (body.scheduleKind === 'monthly_first' && body.weekday === null && body.intervalDays === null) ||
    (body.scheduleKind === 'every_n_days' && body.weekday === null && body.intervalDays !== null)
  if (!scheduleMatches) context.addIssue({ code: 'custom', message: 'schedule fields do not match kind' })
})

const createSchema = z.object({ idempotencyKey: idSchema }).and(scheduleFields)
const paramsSchema = z.object({ id: idSchema })
const occurrenceParamsSchema = z.object({ id: idSchema, dueDate: z.string() })

const scheduleOf = (row: RecurringExpenseTemplateRecord) => ({
  kind: row.scheduleKind,
  startsOn: row.startsOn,
  endsOn: row.deactivatedOn === null
    ? row.endsOn
    : row.endsOn === null || addDays(row.deactivatedOn, -1) < row.endsOn
      ? addDays(row.deactivatedOn, -1)
      : row.endsOn,
  weekday: row.weekday,
  intervalDays: row.intervalDays,
})

const wireTemplate = (row: RecurringExpenseTemplateRecord) => ({ ...row, amount: serializeMoney(row.amount) })
const wireOccurrence = (row: RecurringExpenseOccurrenceRecord) => ({ ...row })

function companyTemplate(row: RecurringExpenseTemplateRecord | null, branchId: string): RecurringExpenseTemplateRecord {
  if (!row || row.branchId !== branchId || row.templateKind !== 'company') {
    throw new ServiceError(404, 'recurring_expense_not_found')
  }
  return row
}

function centreOf(row: Pick<RecurringExpenseTemplateRecord, 'costCenterKind' | 'vehicleId' | 'assetId'>): CompanyExpenseCentre {
  if (row.costCenterKind === 'general') return 'general'
  if (row.costCenterKind === 'vehicle' && row.vehicleId !== null) return `vehicle:${row.vehicleId}`
  if (row.costCenterKind === 'asset' && row.assetId != null) return `asset:${row.assetId}`
  throw new ServiceError(422, 'company_cost_center_mismatch')
}

function termsMatch(existing: RecurringExpenseTemplateRecord, requested: RecurringExpenseTemplateRecord): boolean {
  return existing.branchId === requested.branchId && existing.templateKind === 'company' &&
    existing.title === requested.title && existing.categoryId === requested.categoryId &&
    existing.costCenterKind === requested.costCenterKind && existing.vehicleId === requested.vehicleId &&
    existing.assetId === requested.assetId && existing.currency === requested.currency &&
    existing.paidFrom === requested.paidFrom && existing.amount === requested.amount &&
    existing.scheduleKind === requested.scheduleKind && existing.weekday === requested.weekday &&
    existing.intervalDays === requested.intervalDays && existing.startsOn === requested.startsOn &&
    existing.endsOn === requested.endsOn
}

export function registerCompanyRecurringRoutes(app: FastifyInstance, deps: Deps): void {
  const permission = { config: { permission: 'company_fund.manage' as const } }

  const companyBranch = async () => {
    const branch = await deps.directory.companyBranch()
    if (!branch) throw new ServiceError(500, 'company_branch_missing')
    return branch
  }

  const validateReferences = async (body: z.infer<typeof scheduleFields>): Promise<void> => {
    if (!(await deps.expenses.listCategories()).some((row) => row.id === body.categoryId && row.active)) {
      throw new ServiceError(422, 'unknown_expense_category')
    }
    if ((body.costCenterKind === 'vehicle') !== (body.vehicleId !== null)) {
      throw new ServiceError(422, 'company_cost_center_mismatch')
    }
    if ((body.costCenterKind === 'asset') !== (body.assetId !== null)) {
      throw new ServiceError(422, 'company_cost_center_mismatch')
    }
    if (body.vehicleId !== null && !(await deps.directory.vehicle(body.vehicleId))) {
      throw new ServiceError(404, 'vehicle_not_found')
    }
    if (body.assetId !== null && !(await deps.companyFinance.getAsset(body.assetId))) {
      throw new ServiceError(404, 'asset_not_found')
    }
  }

  app.get('/company/recurring-expenses', permission, async (req) => {
    const { includeInactive } = z.object({ includeInactive: z.enum(['true', 'false']).optional() }).parse(req.query)
    const company = await companyBranch()
    const rows = await deps.recurringExpenses.listTemplates(company.id, includeInactive === 'true')
    return { templates: rows.filter((row) => row.templateKind === 'company').map(wireTemplate) }
  })

  app.post('/company/recurring-expenses', permission, async (req, reply) => {
    const body = createSchema.parse(req.body)
    await validateReferences(body)
    const company = await companyBranch()
    const now = deps.clock.nowMs()
    const record: RecurringExpenseTemplateRecord = {
      id: body.idempotencyKey,
      branchId: company.id,
      templateKind: 'company',
      currency: body.currency,
      title: body.title,
      categoryId: body.categoryId,
      costCenterKind: body.costCenterKind,
      vehicleId: body.vehicleId,
      assetId: body.assetId,
      channel: null,
      paidFrom: body.paidFrom,
      amount: body.amount,
      scheduleKind: body.scheduleKind,
      weekday: body.weekday,
      intervalDays: body.intervalDays,
      startsOn: body.startsOn,
      endsOn: body.endsOn,
      active: true,
      deactivatedOn: null,
      deactivatedAtMs: null,
      deactivatedBy: null,
      deactivationReason: null,
      createdBy: req.actor!.userId,
      createdAtMs: now,
      updatedBy: req.actor!.userId,
      updatedAtMs: now,
    }
    const prior = await deps.recurringExpenses.getTemplate(record.id)
    if (prior) {
      if (!termsMatch(prior, record) || prior.createdBy !== record.createdBy) {
        throw new ServiceError(409, 'idempotency_key_conflict')
      }
      return reply.code(200).send(wireTemplate(prior))
    }
    const result = await deps.financialUnitOfWork.run(
      { lockKey: `recurring-template:${record.id}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const concurrent = await tx.recurringExpenses.getTemplate(record.id)
        if (concurrent) {
          if (!termsMatch(concurrent, record) || concurrent.createdBy !== record.createdBy) {
            throw new ServiceError(409, 'idempotency_key_conflict')
          }
          return { row: concurrent, created: false }
        }
        await tx.recurringExpenses.createTemplate(record)
        return { row: record, created: true }
      },
    )
    return reply.code(result.created ? 201 : 200).send(wireTemplate(result.row))
  })

  app.put('/company/recurring-expenses/:id', permission, async (req) => {
    const { id } = paramsSchema.parse(req.params)
    const body = scheduleFields.parse(req.body)
    await validateReferences(body)
    const company = await companyBranch()
    const current = companyTemplate(await deps.recurringExpenses.getTemplate(id), company.id)
    if (!current.active) throw new ServiceError(409, 'recurring_expense_inactive')
    const updated: RecurringExpenseTemplateRecord = {
      ...current,
      ...body,
      assetId: body.assetId,
      channel: null,
      templateKind: 'company',
      updatedBy: req.actor!.userId,
      updatedAtMs: deps.clock.nowMs(),
    }
    await deps.financialUnitOfWork.run(
      { lockKey: `recurring-template:${id}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const locked = companyTemplate(await tx.recurringExpenses.getTemplate(id), company.id)
        if (!locked.active) throw new ServiceError(409, 'recurring_expense_inactive')
        await tx.recurringExpenses.updateTemplate({ ...updated, createdAtMs: locked.createdAtMs })
      },
    )
    return wireTemplate(updated)
  })

  app.post('/company/recurring-expenses/:id/deactivate', permission, async (req) => {
    const { id } = paramsSchema.parse(req.params)
    const { reason } = z.object({ reason: reasonSchema }).parse(req.body)
    const company = await companyBranch()
    const current = companyTemplate(await deps.recurringExpenses.getTemplate(id), company.id)
    if (!current.active) {
      if (current.deactivationReason !== reason) throw new ServiceError(409, 'recurring_expense_inactive')
      return wireTemplate(current)
    }
    const now = deps.clock.nowMs()
    const updated: RecurringExpenseTemplateRecord = {
      ...current,
      active: false,
      deactivatedOn: todayFor(deps),
      deactivatedAtMs: now,
      deactivatedBy: req.actor!.userId,
      deactivationReason: reason,
      updatedBy: req.actor!.userId,
      updatedAtMs: now,
    }
    await deps.financialUnitOfWork.run(
      { lockKey: `recurring-template:${id}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const locked = companyTemplate(await tx.recurringExpenses.getTemplate(id), company.id)
        if (!locked.active) {
          if (locked.deactivationReason !== reason) throw new ServiceError(409, 'recurring_expense_inactive')
          return
        }
        await tx.recurringExpenses.updateTemplate(updated)
      },
    )
    return wireTemplate(updated)
  })

  app.get('/company/recurring-expenses/due', permission, async (req) => {
    const query = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query)
    const today = todayFor(deps)
    const defaults = defaultDueWindow(today)
    const from = (query.from ?? defaults.from) as CalendarDate
    const to = (query.to ?? defaults.to) as CalendarDate
    if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) throw new ServiceError(422, 'invalid_date_range')
    if (daysBetween(from, to) + 1 > MAX_DUE_RANGE_DAYS) throw new ServiceError(422, 'range_too_large', { maxDays: MAX_DUE_RANGE_DAYS })
    const company = await companyBranch()
    const [allTemplates, resolved] = await Promise.all([
      deps.recurringExpenses.listTemplates(company.id, true),
      deps.recurringExpenses.listOccurrences(company.id, from, to),
    ])
    const templates = allTemplates.filter((row) => row.templateKind === 'company')
    const resolvedKeys = new Set(resolved.map((row) => `${row.templateId}|${row.dueDate}`))
    const due: Array<ReturnType<typeof wireTemplate> & { dueDate: CalendarDate; status: string }> = []
    let olderUnresolved = 0
    for (const template of templates) {
      const schedule = scheduleOf(template)
      for (const dueDate of occurrencesBetween(schedule, from, to)) {
        if (!resolvedKeys.has(`${template.id}|${dueDate}`)) {
          due.push({ ...wireTemplate(template), dueDate, status: dueStatus(dueDate, today) })
        }
      }
      const before = addDays(from, -1)
      if (schedule.startsOn <= before && (schedule.endsOn === null || schedule.endsOn >= schedule.startsOn)) {
        const effectiveBefore = schedule.endsOn !== null && schedule.endsOn < before ? schedule.endsOn : before
        const generated = effectiveBefore < schedule.startsOn ? 0 : countOccurrencesBetween(schedule, schedule.startsOn, effectiveBefore)
        const acted = await deps.recurringExpenses.countOccurrencesBefore(template.id, from)
        olderUnresolved += Math.max(0, generated - acted)
      }
    }
    due.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title))
    return { today, from, to, olderUnresolved, due }
  })

  const paySchema = z.object({
    idempotencyKey: idSchema,
    amount: positiveMoney,
    occurredOn: dateSchema.optional(),
    receiptMediaId: idSchema.nullable().default(null),
    reason: z.string().trim().min(1).max(500).nullable().default(null),
  })

  app.post('/company/recurring-expenses/:id/occurrences/:dueDate/pay', permission, async (req, reply) => {
    const { id, dueDate: rawDueDate } = occurrenceParamsSchema.parse(req.params)
    if (!isCalendarDate(rawDueDate)) throw new ServiceError(422, 'invalid_due_date')
    const dueDate = rawDueDate as CalendarDate
    const body = paySchema.parse(req.body)
    const company = await companyBranch()
    const template = companyTemplate(await deps.recurringExpenses.getTemplate(id), company.id)
    const existing = await deps.recurringExpenses.getOccurrence(id, dueDate)
    if (existing) {
      if (existing.status !== 'paid' || existing.companyExpenseId !== body.idempotencyKey || existing.reason !== body.reason) {
        throw new ServiceError(409, 'recurring_expense_already_resolved')
      }
      return reply.code(200).send({ occurrence: wireOccurrence(existing), replayed: true })
    }
    if (!recurrenceMatches(scheduleOf(template), dueDate)) throw new ServiceError(422, 'recurring_expense_invalid_due_date')
    const businessDate = todayFor(deps)
    if (dueDate > businessDate) throw new ServiceError(409, 'recurring_expense_not_due')
    if (body.amount !== template.amount && body.reason === null) {
      throw new ServiceError(422, 'recurring_expense_adjustment_reason_required')
    }
    await assertWeekOpen(deps, company.id, businessDate)
    if (body.receiptMediaId !== null && !(await deps.media.findById(body.receiptMediaId))) {
      throw new ServiceError(422, 'receipt_media_invalid')
    }
    const currency = template.currency as Currency
    const rate = currency === 'USD' ? resolveFxDay(await deps.fx.list(), businessDate).sypMinorPerUsd : null
    const fxDayId = await ensureFxDay(deps, businessDate)
    const occurredOn = body.occurredOn ?? dueDate
    if (occurredOn > businessDate) throw new ServiceError(422, 'future_company_event')
    const paidFrom = template.paidFrom as 'pocket' | 'reserve' | 'owner_outside'
    const centre = centreOf(template)
    const draft: CompanyExpenseRecord = {
      id: body.idempotencyKey,
      branchId: company.id,
      kind: 'expense',
      currency,
      amount: body.amount,
      sypMinorPerUsd: rate,
      categoryId: template.categoryId,
      costCenterKind: template.costCenterKind as 'general' | 'vehicle' | 'asset',
      vehicleId: template.vehicleId,
      assetId: template.assetId ?? null,
      paidFrom,
      receiptMediaId: body.receiptMediaId,
      description: template.title,
      occurredOn,
      businessDate,
      journalEntryId: 0,
      createdBy: req.actor!.userId,
      createdAtMs: deps.clock.nowMs(),
    }
    const posting = companyExpense(currency, body.amount, centre, paidFrom, body.idempotencyKey)
    const result = await deps.financialUnitOfWork.run(
      { lockKey: `recurring:${id}:${dueDate}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const concurrent = await tx.recurringExpenses.getOccurrence(id, dueDate)
        if (concurrent) {
          if (concurrent.status !== 'paid' || concurrent.companyExpenseId !== body.idempotencyKey || concurrent.reason !== body.reason) {
            throw new ServiceError(409, 'recurring_expense_already_resolved')
          }
          return { occurrence: concurrent, created: false }
        }
        const sourceCode = paidFrom === 'pocket' ? `company_cash:${currency}`
          : paidFrom === 'reserve' ? `depreciation_reserve:${currency}` : null
        if (sourceCode !== null) {
          const held = await tx.ledger.fundBalance(company.id, sourceCode)
          if (held < body.amount) throw new ServiceError(422, 'insufficient_funds', { fundCode: sourceCode, held: serializeMoney(held) })
        }
        const priorCommand = await tx.companyLedger.findCommand(draft.id)
        if (priorCommand) throw new ServiceError(409, 'idempotency_key_conflict')
        const [entry] = await tx.ledger.post(company.id, [posting], {
          shiftId: null,
          businessDate,
          postingDate: businessDate,
          weekStartDate: weekStartFor(businessDate),
          fxDayId,
          sypMinorPerUsd: rate,
          createdBy: req.actor!.userId,
          reason: template.title,
        })
        if (!entry) throw new ServiceError(409, 'idempotency_key_conflict')
        await tx.companyLedger.createCommand({ ...draft, journalEntryId: entry.id })
        const occurrence: RecurringExpenseOccurrenceRecord = {
          id: deps.ids.uuid(),
          templateId: id,
          branchId: company.id,
          dueDate,
          status: 'paid',
          expenseId: null,
          companyExpenseId: draft.id,
          reason: body.reason,
          actedBy: req.actor!.userId,
          actedAtMs: deps.clock.nowMs(),
        }
        await tx.recurringExpenses.createOccurrence(occurrence)
        return { occurrence, created: true }
      },
    )
    return reply.code(result.created ? 201 : 200).send({ occurrence: wireOccurrence(result.occurrence), replayed: !result.created })
  })

  app.post('/company/recurring-expenses/:id/occurrences/:dueDate/skip', permission, async (req, reply) => {
    const { id, dueDate: rawDueDate } = occurrenceParamsSchema.parse(req.params)
    if (!isCalendarDate(rawDueDate)) throw new ServiceError(422, 'invalid_due_date')
    const dueDate = rawDueDate as CalendarDate
    const { reason } = z.object({ reason: reasonSchema }).parse(req.body)
    const company = await companyBranch()
    const template = companyTemplate(await deps.recurringExpenses.getTemplate(id), company.id)
    if (!recurrenceMatches(scheduleOf(template), dueDate)) throw new ServiceError(422, 'recurring_expense_invalid_due_date')
    if (dueDate > todayFor(deps)) throw new ServiceError(409, 'recurring_expense_not_due')
    const occurrence: RecurringExpenseOccurrenceRecord = {
      id: deps.ids.uuid(), templateId: id, branchId: company.id, dueDate, status: 'skipped',
      expenseId: null, companyExpenseId: null, reason, actedBy: req.actor!.userId, actedAtMs: deps.clock.nowMs(),
    }
    const result = await deps.financialUnitOfWork.run(
      { lockKey: `recurring:${id}:${dueDate}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const existing = await tx.recurringExpenses.getOccurrence(id, dueDate)
        if (existing) {
          if (existing.status === 'skipped' && existing.reason === reason) return { row: existing, created: false }
          throw new ServiceError(409, 'recurring_expense_already_resolved')
        }
        await tx.recurringExpenses.createOccurrence(occurrence)
        return { row: occurrence, created: true }
      },
    )
    return reply.code(result.created ? 201 : 200).send({ ...wireOccurrence(result.row), replayed: !result.created })
  })
}
