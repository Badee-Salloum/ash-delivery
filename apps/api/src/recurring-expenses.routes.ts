import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type {
  Deps,
  ExpenseRecord,
  RecurringExpenseOccurrenceRecord,
  RecurringExpenseTemplateRecord,
} from '@ash/contracts'
import {
  createRecurringExpenseRequest,
  deactivateRecurringExpenseRequest,
  payRecurringExpenseRequest,
  serializeMoney,
  skipRecurringExpenseRequest,
  updateRecurringExpenseRequest,
} from '@ash/contracts'
import {
  type CalendarDate,
  MAX_DUE_RANGE_DAYS,
  addDays,
  countOccurrencesBetween,
  defaultDueWindow,
  defaultPayDate,
  daysBetween,
  dueStatus,
  isCalendarDate,
  occurrencesBetween,
  payDateInRange,
  recurrenceMatches,
  weekStartFor,
} from '@ash/domain'
import { branchSubject, resolveBranchId } from './branch-scope.ts'
import { recordExpenseInTx } from './expenses.routes.ts'
import { MAX_UPLOAD_BYTES, uploadReceipt } from './media.service.ts'
import { ServiceError, assertWeekOpen, ensureFxDay, recordVehicleEvent, todayFor } from './shifts.service.ts'

const paramsSchema = z.object({ id: z.string().uuid() })
const occurrenceParamsSchema = z.object({ id: z.string().uuid(), dueDate: z.string() })

type BranchRecurringTemplate = RecurringExpenseTemplateRecord & {
  templateKind?: 'branch'
  currency?: 'SYP_NEW'
  costCenterKind: 'vehicle' | 'branch' | 'general'
  channel: 'office_cash' | 'office_wallet'
  paidFrom?: null
}

const templateTermsEqual = (
  a: RecurringExpenseTemplateRecord,
  b: Pick<
    RecurringExpenseTemplateRecord,
    | 'branchId' | 'title' | 'categoryId' | 'costCenterKind' | 'vehicleId' | 'channel' | 'amount'
    | 'scheduleKind' | 'weekday' | 'intervalDays' | 'startsOn' | 'endsOn'
  >,
): boolean =>
  a.branchId === b.branchId &&
  a.title === b.title &&
  a.categoryId === b.categoryId &&
  a.costCenterKind === b.costCenterKind &&
  a.vehicleId === b.vehicleId &&
  a.channel === b.channel &&
  a.amount === b.amount &&
  a.scheduleKind === b.scheduleKind &&
  a.weekday === b.weekday &&
  a.intervalDays === b.intervalDays &&
  a.startsOn === b.startsOn &&
  a.endsOn === b.endsOn

const wireTemplate = (row: RecurringExpenseTemplateRecord) => ({
  ...row,
  amount: serializeMoney(row.amount),
})

const wireOccurrence = (row: RecurringExpenseOccurrenceRecord) => ({ ...row })

const scheduleOf = (row: RecurringExpenseTemplateRecord) => ({
  kind: row.scheduleKind,
  startsOn: row.startsOn,
  endsOn:
    row.deactivatedOn === null
      ? row.endsOn
      : row.endsOn === null || addDays(row.deactivatedOn, -1) < row.endsOn
        ? addDays(row.deactivatedOn, -1)
        : row.endsOn,
  weekday: row.weekday,
  intervalDays: row.intervalDays,
})

const assertTemplateScope = (
  row: RecurringExpenseTemplateRecord | null,
  branchId: string,
): BranchRecurringTemplate => {
  if (!row) throw new ServiceError(404, 'recurring_expense_not_found')
  if (
    row.branchId !== branchId || (row.templateKind ?? 'branch') !== 'branch' || row.channel === null ||
    row.costCenterKind === 'asset'
  ) throw new ServiceError(404, 'recurring_expense_not_found')
  return row as BranchRecurringTemplate
}

async function validateTemplateReferences(
  deps: Deps,
  branchId: string,
  body: { categoryId: string; vehicleId: string | null },
): Promise<void> {
  const categories = await deps.expenses.listCategories()
  if (!categories.some((category) => category.id === body.categoryId)) {
    throw new ServiceError(422, 'unknown_expense_category', { categoryId: body.categoryId })
  }
  if (body.vehicleId !== null) {
    const vehicle = await deps.directory.vehicle(body.vehicleId)
    if (!vehicle) throw new ServiceError(404, 'vehicle_not_found')
    if (vehicle.branchId !== branchId) throw new ServiceError(422, 'vehicle_in_another_branch')
  }
}

async function auditMutation(
  deps: Deps,
  input: {
    tableName: string
    recordId: string
    branchId: string
    actorId: string
    requestId: string
    action: 'INSERT' | 'UPDATE'
    before: unknown
    after: unknown
  },
): Promise<void> {
  await deps.audit.append({
    ...input,
    actorKind: 'user',
    occurredAtMs: deps.clock.nowMs(),
  })
}

/** Branch recurring expenses: due dates are calculated on read; only these buttons post/skip. */
export function registerRecurringExpenseRoutes(app: FastifyInstance, deps: Deps): void {
  app.get(
    '/recurring-expenses',
    { config: { permission: 'branch_data.view', subject: branchSubject } },
    async (req) => {
      const branchId = resolveBranchId(req)
      const { includeInactive } = z.object({ includeInactive: z.enum(['true', 'false']).optional() }).parse(req.query)
      const templates = await deps.recurringExpenses.listTemplates(branchId, includeInactive === 'true')
      return { templates: templates.map(wireTemplate) }
    },
  )

  app.post(
    '/recurring-expenses',
    { config: { permission: 'expense.write', subject: branchSubject } },
    async (req, reply) => {
      const body = createRecurringExpenseRequest.parse(req.body)
      const branchId = resolveBranchId(req)
      const existing = await deps.recurringExpenses.getTemplate(body.idempotencyKey)
      const terms = { ...body, branchId, id: body.idempotencyKey }
      if (existing) {
        if (!templateTermsEqual(existing, terms)) {
          throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: body.idempotencyKey })
        }
        return reply.code(200).send(wireTemplate(existing))
      }
      await validateTemplateReferences(deps, branchId, body)
      const now = deps.clock.nowMs()
      const record: RecurringExpenseTemplateRecord = {
        id: body.idempotencyKey,
        branchId,
        title: body.title,
        categoryId: body.categoryId,
        costCenterKind: body.costCenterKind,
        vehicleId: body.vehicleId,
        channel: body.channel,
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
      const outcome = await deps.financialUnitOfWork.run(
        { lockKey: `recurring-template:${record.id}`, actorId: req.actor!.userId, requestId: req.requestId },
        async (tx) => {
          const concurrent = await tx.recurringExpenses.getTemplate(record.id)
          if (concurrent) {
            if (!templateTermsEqual(concurrent, record)) {
              throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: record.id })
            }
            return { row: concurrent, created: false }
          }
          await tx.recurringExpenses.createTemplate(record)
          return { row: record, created: true }
        },
      )
      if (outcome.created) {
        await auditMutation(deps, {
          tableName: 'recurring_expense_templates', recordId: record.id, branchId,
          actorId: req.actor!.userId, requestId: req.requestId, action: 'INSERT', before: null,
          after: wireTemplate(outcome.row),
        })
      }
      return reply.code(outcome.created ? 201 : 200).send(wireTemplate(outcome.row))
    },
  )

  app.put(
    '/recurring-expenses/:id',
    { config: { permission: 'expense.write', subject: branchSubject } },
    async (req) => {
      const { id } = paramsSchema.parse(req.params)
      const body = updateRecurringExpenseRequest.parse(req.body)
      const branchId = resolveBranchId(req)
      const current = assertTemplateScope(await deps.recurringExpenses.getTemplate(id), branchId)
      if (!current.active) throw new ServiceError(409, 'recurring_expense_inactive')
      await validateTemplateReferences(deps, branchId, body)
      const updated: RecurringExpenseTemplateRecord = {
        ...current,
        title: body.title,
        categoryId: body.categoryId,
        costCenterKind: body.costCenterKind,
        vehicleId: body.vehicleId,
        channel: body.channel,
        amount: body.amount,
        scheduleKind: body.scheduleKind,
        weekday: body.weekday,
        intervalDays: body.intervalDays,
        startsOn: body.startsOn,
        endsOn: body.endsOn,
        updatedBy: req.actor!.userId,
        updatedAtMs: deps.clock.nowMs(),
      }
      await deps.financialUnitOfWork.run(
        { lockKey: `recurring-template:${id}`, actorId: req.actor!.userId, requestId: req.requestId },
        async (tx) => {
          const locked = assertTemplateScope(await tx.recurringExpenses.getTemplate(id), branchId)
          if (!locked.active) throw new ServiceError(409, 'recurring_expense_inactive')
          await tx.recurringExpenses.updateTemplate({ ...updated, createdAtMs: locked.createdAtMs })
        },
      )
      await auditMutation(deps, {
        tableName: 'recurring_expense_templates', recordId: id, branchId,
        actorId: req.actor!.userId, requestId: req.requestId, action: 'UPDATE',
        before: wireTemplate(current), after: wireTemplate(updated),
      })
      return wireTemplate(updated)
    },
  )

  app.post(
    '/recurring-expenses/:id/deactivate',
    { config: { permission: 'expense.write', subject: branchSubject } },
    async (req) => {
      const { id } = paramsSchema.parse(req.params)
      const body = deactivateRecurringExpenseRequest.parse(req.body)
      const branchId = resolveBranchId(req)
      const current = assertTemplateScope(await deps.recurringExpenses.getTemplate(id), branchId)
      if (!current.active) {
        if (current.deactivationReason !== body.reason) throw new ServiceError(409, 'recurring_expense_inactive')
        return wireTemplate(current)
      }
      const now = deps.clock.nowMs()
      const updated: RecurringExpenseTemplateRecord = {
        ...current,
        active: false,
        deactivatedOn: todayFor(deps),
        deactivatedAtMs: now,
        deactivatedBy: req.actor!.userId,
        deactivationReason: body.reason,
        updatedBy: req.actor!.userId,
        updatedAtMs: now,
      }
      const outcome = await deps.financialUnitOfWork.run(
        { lockKey: `recurring-template:${id}`, actorId: req.actor!.userId, requestId: req.requestId },
        async (tx) => {
          const locked = assertTemplateScope(await tx.recurringExpenses.getTemplate(id), branchId)
          if (!locked.active) {
            if (locked.deactivationReason !== body.reason) throw new ServiceError(409, 'recurring_expense_inactive')
            return { row: locked, changed: false }
          }
          await tx.recurringExpenses.updateTemplate(updated)
          return { row: updated, changed: true }
        },
      )
      if (outcome.changed) {
        await auditMutation(deps, {
          tableName: 'recurring_expense_templates', recordId: id, branchId,
          actorId: req.actor!.userId, requestId: req.requestId, action: 'UPDATE',
          before: wireTemplate(current), after: wireTemplate(outcome.row),
        })
      }
      return wireTemplate(outcome.row)
    },
  )

  app.get(
    '/recurring-expenses/due',
    { config: { permission: 'branch_data.view', subject: branchSubject } },
    async (req) => {
      const branchId = resolveBranchId(req)
      const query = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query)
      const today = todayFor(deps)
      const defaults = defaultDueWindow(today)
      const from = (query.from ?? defaults.from) as CalendarDate
      const to = (query.to ?? defaults.to) as CalendarDate
      if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
        throw new ServiceError(422, 'invalid_date_range')
      }
      if (daysBetween(from, to) + 1 > MAX_DUE_RANGE_DAYS) {
        throw new ServiceError(422, 'range_too_large', { maxDays: MAX_DUE_RANGE_DAYS })
      }
      const [templates, resolved] = await Promise.all([
        deps.recurringExpenses.listTemplates(branchId, true),
        deps.recurringExpenses.listOccurrences(branchId, from, to),
      ])
      const resolvedKeys = new Set(resolved.map((row) => `${row.templateId}|${row.dueDate}`))
      const due: Array<ReturnType<typeof wireTemplate> & { dueDate: CalendarDate; status: string }> = []
      let olderUnresolved = 0
      for (const template of templates) {
        const schedule = scheduleOf(template)
        for (const dueDate of occurrencesBetween(schedule, from, to)) {
          if (resolvedKeys.has(`${template.id}|${dueDate}`)) continue
          due.push({ ...wireTemplate(template), dueDate, status: dueStatus(dueDate, today) })
        }
        const before = addDays(from, -1)
        if (schedule.startsOn <= before && (schedule.endsOn === null || schedule.endsOn >= schedule.startsOn)) {
          const effectiveBefore = schedule.endsOn !== null && schedule.endsOn < before ? schedule.endsOn : before
          const generated = effectiveBefore < schedule.startsOn
            ? 0
            : countOccurrencesBetween(schedule, schedule.startsOn, effectiveBefore)
          const acted = await deps.recurringExpenses.countOccurrencesBefore(template.id, from)
          olderUnresolved += Math.max(0, generated - acted)
        }
      }
      due.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title))
      return { today, from, to, olderUnresolved, due }
    },
  )

  app.post(
    '/recurring-expenses/:id/occurrences/:dueDate/pay',
    { config: { permission: 'expense.write', subject: branchSubject } },
    async (req, reply) => {
      const { id, dueDate: rawDueDate } = occurrenceParamsSchema.parse(req.params)
      if (!isCalendarDate(rawDueDate)) throw new ServiceError(422, 'invalid_due_date')
      const dueDate = rawDueDate as CalendarDate
      const body = payRecurringExpenseRequest.parse(req.body)
      const branchId = resolveBranchId(req)
      const template = assertTemplateScope(await deps.recurringExpenses.getTemplate(id), branchId)

      // A lost-response retry reads the immutable decision before re-running today's creation
      // gates. The week may have closed or the calendar may have rolled since the first request;
      // neither may turn an exact retry into a second spend or a false failure.
      const already = await deps.recurringExpenses.getOccurrence(id, dueDate)
      if (already) {
        if (already.status !== 'paid' || already.expenseId !== body.idempotencyKey || already.reason !== body.reason) {
          throw new ServiceError(409, 'recurring_expense_already_resolved')
        }
        const saved = await deps.expenses.get(body.idempotencyKey)
        if (!saved || saved.amount !== body.amount || saved.receiptMediaId !== body.receiptMediaId ||
            (body.businessDate !== undefined && saved.businessDate !== body.businessDate)) {
          throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: body.idempotencyKey })
        }
        return reply.code(200).send({
          occurrence: wireOccurrence(already),
          expense: { ...saved, amount: serializeMoney(saved.amount) },
          replayed: true,
        })
      }

      const schedule = scheduleOf(template)
      if (!recurrenceMatches(schedule, dueDate)) throw new ServiceError(422, 'recurring_expense_invalid_due_date')
      const today = todayFor(deps)
      if (dueDate > today) throw new ServiceError(409, 'recurring_expense_not_due')
      if (body.amount !== template.amount && body.reason === null) {
        throw new ServiceError(422, 'recurring_expense_adjustment_reason_required')
      }
      const closedStarts = await deps.weekLocks.listClosedStarts(branchId)
      const resolvedBusinessDate = body.businessDate ?? defaultPayDate(
        dueDate,
        today,
        (date) => !closedStarts.includes(weekStartFor(date)),
      )
      if (!payDateInRange(resolvedBusinessDate, dueDate, today)) {
        throw new ServiceError(422, 'recurring_expense_payment_date_invalid')
      }
      await assertWeekOpen(deps, branchId, resolvedBusinessDate)
      if (body.receiptMediaId !== null) {
        const media = await deps.media.findById(body.receiptMediaId)
        if (!media || media.branchId !== branchId) throw new ServiceError(422, 'receipt_media_invalid')
      }
      const ceiling = await deps.settings.receiptRequiredAbove(branchId)
      if (ceiling !== null && body.amount > ceiling && body.receiptMediaId === null) {
        throw new ServiceError(422, 'receipt_required', {
          amount: serializeMoney(body.amount), ceiling: serializeMoney(ceiling),
        })
      }
      const fxDayId = await ensureFxDay(deps, resolvedBusinessDate)
      const expense: ExpenseRecord = {
        id: body.idempotencyKey,
        branchId,
        categoryId: template.categoryId,
        costCenterKind: template.costCenterKind,
        vehicleId: template.vehicleId,
        channel: template.channel,
        amount: body.amount,
        businessDate: resolvedBusinessDate,
        description: template.title,
        receiptMediaId: body.receiptMediaId,
        journalEntryId: null,
        advanceId: null,
        createdBy: req.actor!.userId,
      }
      const now = deps.clock.nowMs()
      const outcome = await deps.financialUnitOfWork.run(
        { lockKey: `recurring:${id}:${dueDate}`, actorId: req.actor!.userId, requestId: req.requestId },
        async (tx) => {
          const existing = await tx.recurringExpenses.getOccurrence(id, dueDate)
          if (existing) {
            if (existing.status !== 'paid' || existing.expenseId !== body.idempotencyKey || existing.reason !== body.reason) {
              throw new ServiceError(409, 'recurring_expense_already_resolved')
            }
            const saved = await tx.expenses.get(body.idempotencyKey)
            if (!saved || saved.amount !== body.amount || saved.receiptMediaId !== body.receiptMediaId ||
                (body.businessDate !== undefined && saved.businessDate !== body.businessDate)) {
              throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: body.idempotencyKey })
            }
            return { occurrence: existing, expense: saved, created: false }
          }
          const saved = await recordExpenseInTx(tx, {
            record: expense,
            businessDateWasExplicit: body.businessDate !== undefined,
            fxDayId,
            postingDate: today,
          })
          const occurrence: RecurringExpenseOccurrenceRecord = {
            id: deps.ids.uuid(), templateId: id, branchId, dueDate, status: 'paid',
            expenseId: saved.record.id, reason: body.reason, actedBy: req.actor!.userId, actedAtMs: now,
          }
          await tx.recurringExpenses.createOccurrence(occurrence)
          return { occurrence, expense: saved.record, created: true }
        },
      )
      if (outcome.created) {
        await auditMutation(deps, {
          tableName: 'recurring_expense_occurrences', recordId: outcome.occurrence.id, branchId,
          actorId: req.actor!.userId, requestId: req.requestId, action: 'INSERT', before: null,
          after: wireOccurrence(outcome.occurrence),
        })
        if (outcome.expense.vehicleId !== null) {
          try {
            await recordVehicleEvent(deps, {
              vehicleId: outcome.expense.vehicleId, branchId, kind: 'maintenance',
              costMinor: outcome.expense.amount, expenseId: outcome.expense.id,
              notes: outcome.expense.description, businessDate: outcome.expense.businessDate,
              createdBy: req.actor!.userId,
            })
          } catch { /* The ledger-backed expense remains the record of truth. */ }
        }
      }
      return reply.code(outcome.created ? 201 : 200).send({
        occurrence: wireOccurrence(outcome.occurrence),
        expense: { ...outcome.expense, amount: serializeMoney(outcome.expense.amount) },
        replayed: !outcome.created,
      })
    },
  )

  app.post(
    '/recurring-expenses/:id/occurrences/:dueDate/skip',
    { config: { permission: 'expense.write', subject: branchSubject } },
    async (req, reply) => {
      const { id, dueDate: rawDueDate } = occurrenceParamsSchema.parse(req.params)
      if (!isCalendarDate(rawDueDate)) throw new ServiceError(422, 'invalid_due_date')
      const dueDate = rawDueDate as CalendarDate
      const body = skipRecurringExpenseRequest.parse(req.body)
      const branchId = resolveBranchId(req)
      const template = assertTemplateScope(await deps.recurringExpenses.getTemplate(id), branchId)
      if (!recurrenceMatches(scheduleOf(template), dueDate)) {
        throw new ServiceError(422, 'recurring_expense_invalid_due_date')
      }
      if (dueDate > todayFor(deps)) throw new ServiceError(409, 'recurring_expense_not_due')
      const occurrence: RecurringExpenseOccurrenceRecord = {
        id: deps.ids.uuid(), templateId: id, branchId, dueDate, status: 'skipped', expenseId: null,
        reason: body.reason, actedBy: req.actor!.userId, actedAtMs: deps.clock.nowMs(),
      }
      const outcome = await deps.financialUnitOfWork.run(
        { lockKey: `recurring:${id}:${dueDate}`, actorId: req.actor!.userId, requestId: req.requestId },
        async (tx) => {
          const existing = await tx.recurringExpenses.getOccurrence(id, dueDate)
          if (existing) {
            if (existing.status === 'skipped' && existing.reason === body.reason) return { row: existing, created: false }
            throw new ServiceError(409, 'recurring_expense_already_resolved')
          }
          await tx.recurringExpenses.createOccurrence(occurrence)
          return { row: occurrence, created: true }
        },
      )
      if (outcome.created) {
        await auditMutation(deps, {
          tableName: 'recurring_expense_occurrences', recordId: outcome.row.id, branchId,
          actorId: req.actor!.userId, requestId: req.requestId, action: 'INSERT', before: null,
          after: wireOccurrence(outcome.row),
        })
      }
      return reply.code(outcome.created ? 201 : 200).send({ ...wireOccurrence(outcome.row), replayed: !outcome.created })
    },
  )

  app.post(
    '/media/receipts',
    { config: { permission: 'expense.write', subject: branchSubject }, bodyLimit: MAX_UPLOAD_BYTES },
    async (req, reply) => {
      const branchId = resolveBranchId(req)
      const taken = req.headers['x-client-taken-at']
      const result = await uploadReceipt(deps, {
        branchId,
        bytes: new Uint8Array(req.body as Buffer),
        clientTakenAtMs: typeof taken === 'string' && /^\d+$/.test(taken) ? Number(taken) : null,
        uploadedBy: req.actor!.userId,
      })
      return reply.code(result.deduped ? 200 : 201).send({
        mediaId: result.media.id,
        sha256: result.media.sha256,
        byteSize: result.media.byteSize,
        deduped: result.deduped,
      })
    },
  )
}
