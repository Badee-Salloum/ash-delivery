import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps, ExpenseCategoryRecord, ExpenseRecord, ExpenseReadFilter, FinancialTransactionDeps } from '@ash/contracts'
import { createExpenseCategoryRequest, createExpenseRequest, nonnegativeMoneySchema, realCalendarDateSchema, serializeMoney } from '@ash/contracts'
import { type Posting, expense as expensePosting, minor, weekStartFor } from '@ash/domain'
import { ServiceError, assertWeekOpen, ensureFxDay, recordVehicleEvent, todayFor } from './shifts.service.ts'
import { branchSubject, resolveBranchId } from './branch-scope.ts'

/** Do not silently ignore a filter the UI claims to apply. branchId is part of the read contract. */
const expenseReadQuery = z.object({
  branchId: z.string().min(1).max(64).optional(),
  from: realCalendarDateSchema.optional(),
  to: realCalendarDateSchema.optional(),
  all: z.enum(['true']).optional(),
  categoryId: z.string().min(1).max(64).optional(),
  costCenterKind: z.enum(['general', 'branch', 'vehicle', 'operating']).optional(),
  vehicleId: z.string().min(1).max(64).optional(),
  channel: z.enum(['office_cash', 'office_wallet']).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  receipt: z.enum(['with', 'without']).optional(),
  minAmount: nonnegativeMoneySchema.optional(),
  maxAmount: nonnegativeMoneySchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict().superRefine((query, ctx) => {
  if (query.from && query.to && query.from > query.to) ctx.addIssue({ code: 'custom', path: ['from'], message: 'from must not be after to' })
  if (query.all && query.from) ctx.addIssue({ code: 'custom', path: ['all'], message: 'all and from are mutually exclusive' })
  if (query.minAmount !== undefined && query.maxAmount !== undefined && query.minAmount > query.maxAmount) ctx.addIssue({ code: 'custom', path: ['minAmount'], message: 'minimum must not exceed maximum' })
  if (query.vehicleId && query.costCenterKind && query.costCenterKind !== 'vehicle') ctx.addIssue({ code: 'custom', path: ['vehicleId'], message: 'a vehicle filter needs the vehicle cost centre' })
})

async function readExpenseFilter(deps: Deps, branchId: string, raw: unknown): Promise<{ filter: ExpenseReadFilter; limit: number; offset: number }> {
  const query = expenseReadQuery.parse(raw)
  const today = todayFor(deps)
  const from = query.all ? undefined : query.from ?? today
  const to = query.to ?? today
  if (from !== undefined && from > to) throw new ServiceError(400, 'expense_filter_range_invalid')
  if (query.categoryId && !(await deps.expenses.listCategories(true)).some((category) => category.id === query.categoryId)) {
    throw new ServiceError(422, 'unknown_expense_category')
  }
  if (query.vehicleId) {
    const vehicle = await deps.directory.vehicle(query.vehicleId)
    if (!vehicle) throw new ServiceError(404, 'vehicle_not_found')
    if (vehicle.branchId !== branchId) throw new ServiceError(422, 'vehicle_in_another_branch')
  }
  return {
    filter: {
      ...(from === undefined ? {} : { from }), to,
      ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
      ...(query.costCenterKind === undefined ? {} : { costCenterKind: query.costCenterKind }),
      ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
      ...(query.channel === undefined ? {} : { channel: query.channel }),
      ...(query.q === undefined ? {} : { query: query.q }),
      ...(query.receipt === undefined ? {} : { receipt: query.receipt }),
      ...(query.minAmount === undefined ? {} : { minAmount: query.minAmount }),
      ...(query.maxAmount === undefined ? {} : { maxAmount: query.maxAmount }),
    }, limit: query.limit, offset: query.offset,
  }
}

const sameExpenseRequest = (
  existing: ExpenseRecord,
  requested: ExpenseRecord,
  businessDateWasExplicit: boolean,
): boolean =>
  existing.id === requested.id &&
  existing.branchId === requested.branchId &&
  existing.categoryId === requested.categoryId &&
  existing.costCenterKind === requested.costCenterKind &&
  existing.vehicleId === requested.vehicleId &&
  // Compared, and it matters for the reason the income route records: without it a replay that
  // flipped cash to wallet would return 200 and leave the ORIGINAL row against the wrong box.
  existing.channel === requested.channel &&
  existing.amount === requested.amount &&
  (!businessDateWasExplicit || existing.businessDate === requested.businessDate) &&
  existing.description === requested.description &&
  existing.receiptMediaId === requested.receiptMediaId &&
  existing.advanceId === requested.advanceId &&
  existing.createdBy === requested.createdBy

const assertCompleteExpense = (record: ExpenseRecord): void => {
  if (record.journalEntryId === null) {
    throw new ServiceError(500, 'expense_integrity_error', { expenseId: record.id })
  }
}

/**
 * Write one ordinary expense and its journal while the caller owns the financial transaction.
 *
 * Recurring-expense payment deliberately reuses this exact path: a fixed expense is not a second
 * kind of accounting fact. It is this ordinary expense plus the occurrence decision that points
 * to it, committed in the same unit of work.
 */
export async function recordExpenseInTx(
  tx: FinancialTransactionDeps,
  input: {
    record: ExpenseRecord
    businessDateWasExplicit: boolean
    fxDayId: number
    postingDate: ExpenseRecord['businessDate']
  },
): Promise<{ record: ExpenseRecord; created: boolean }> {
  const { record } = input
  const concurrent = await tx.expenses.get(record.id)
  if (concurrent) {
    if (!sameExpenseRequest(concurrent, record, input.businessDateWasExplicit)) {
      throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: record.id })
    }
    assertCompleteExpense(concurrent)
    return { record: concurrent, created: false }
  }

  const costCenterId = record.vehicleId ?? `${record.costCenterKind}:${record.branchId}`
  const posting: Posting = expensePosting(record.channel, costCenterId, record.amount, record.id)
  const [entry] = await tx.ledger.post(record.branchId, [posting], {
    shiftId: null,
    businessDate: record.businessDate,
    postingDate: input.postingDate,
    weekStartDate: weekStartFor(record.businessDate),
    fxDayId: input.fxDayId,
    sypMinorPerUsd: null,
    createdBy: record.createdBy,
    reason: record.description,
  })
  if (!entry) {
    throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: record.id })
  }
  const created = { ...record, journalEntryId: entry.id }
  await tx.expenses.create(created)
  return { record: created, created: true }
}

/**
 * Expenses (SRS §G) — «كل ليرة تخرج: مصنَّفة وموثَّقة ومنسوبة لمركز كلفتها».
 *
 * Every expense is categorised, attributed to a cost centre (vehicle / branch / general), and
 * posted to the ledger in the same transaction as it is recorded. An expense row without a
 * matching journal entry would be a number in a table that no balance sheet knows about.
 *
 * Per the §3 matrix (and product-owner decision D-5), this is branch manager + GM — NOT the
 * system admin.
 */
export function registerExpenseRoutes(app: FastifyInstance, deps: Deps): void {
  // The branch a request targets, from `?branchId=` or the body, else the actor's own session.
  // Shared so a read and a write resolve it identically — see branch-scope.ts for why a GET must
  // have a channel at all.
  const targetBranch = branchSubject
  const ownBranch = branchSubject
  const resolveBranch = resolveBranchId

  // ── Categories (G-1) ────────────────────────────────────────────────────────────────────

  app.get('/expense-categories', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const query = z.object({ branchId: z.string().optional(), includeInactive: z.enum(['true', 'false']).optional() }).strict().parse(req.query)
    return { categories: await deps.expenses.listCategories(query.includeInactive === 'true') }
  })

  app.post(
    '/expense-categories',
    { config: { permission: 'settings.write' } },
    async (req, reply) => {
      const body = createExpenseCategoryRequest.parse(req.body)
      const category: ExpenseCategoryRecord = { id: deps.ids.uuid(), ...body, active: true }
      try {
        await deps.expenses.createCategory(category)
      } catch (err) {
        if ((err as { code?: string }).code === 'DUPLICATE_CODE') {
          throw new ServiceError(409, 'duplicate_category_code', { code: body.code })
        }
        throw err
      }
      return reply.code(201).send(category)
    },
  )

  // ── Expenses ────────────────────────────────────────────────────────────────────────────

  app.post('/expenses', { config: { permission: 'expense.write', subject: targetBranch } }, async (req, reply) => {
    const body = createExpenseRequest.parse(req.body)
    const branchId = resolveBranch(req)
    const businessDate = body.businessDate ?? todayFor(deps)
    const record: ExpenseRecord = {
      // The client-generated UUID is deliberately the record identity too. It gives the business
      // row the same durable retry key as its journal without a second mutable mapping table.
      id: body.idempotencyKey,
      branchId,
      categoryId: body.categoryId,
      costCenterKind: body.costCenterKind,
      vehicleId: body.vehicleId,
      channel: body.channel,
      amount: body.amount,
      businessDate,
      description: body.description,
      receiptMediaId: body.receiptMediaId,
      journalEntryId: null,
      // Always null here. A conversion expense — a «سلفة» finally recognised as spent — is written
      // by the advances route, which is the only place that may set it.
      advanceId: null,
      createdBy: req.actor!.userId,
    }

    // A lost-response replay must not start failing because a category was later disabled or the
    // calendar crossed midnight. The immutable row is the receipt; compare it before revalidating
    // today's creation rules. An explicitly supplied business date remains part of exactness.
    const already = await deps.expenses.get(record.id)
    if (already) {
      if (!sameExpenseRequest(already, record, body.businessDate !== undefined)) {
        throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: record.id })
      }
      assertCompleteExpense(already)
      return reply.code(200).send({ ...already, amount: serializeMoney(already.amount) })
    }

    const categories = await deps.expenses.listCategories()
    if (!categories.some((c) => c.id === body.categoryId)) {
      throw new ServiceError(422, 'unknown_expense_category', { categoryId: body.categoryId })
    }

    // A vehicle cost centre needs a vehicle, and no other kind may carry one — the same rule
    // the CHECK constraint enforces, surfaced as a clear 422 rather than a database error.
    const vehicleOk = (body.costCenterKind === 'vehicle') === (body.vehicleId !== null)
    if (!vehicleOk) throw new ServiceError(422, 'cost_center_vehicle_mismatch')

    if (body.vehicleId !== null) {
      const vehicle = await deps.directory.vehicle(body.vehicleId)
      if (!vehicle) throw new ServiceError(404, 'vehicle_not_found')
      if (vehicle.branchId !== branchId) throw new ServiceError(422, 'vehicle_in_another_branch')
    }

    // Approval ceiling (A-4 / س52, G-3): above it, a photographed receipt is mandatory. The
    // ceiling is a setting rather than a constant so the client can raise it without a deploy.
    const ceiling = await deps.settings.receiptRequiredAbove(branchId)
    if (ceiling !== null && body.amount > ceiling && body.receiptMediaId === null) {
      throw new ServiceError(422, 'receipt_required', {
        amount: serializeMoney(body.amount),
        ceiling: serializeMoney(ceiling),
      })
    }
    if (body.receiptMediaId !== null) {
      const receipt = await deps.media.findById(body.receiptMediaId)
      if (!receipt || receipt.branchId !== branchId) throw new ServiceError(422, 'receipt_media_invalid')
    }

    // BR7. The likeliest real path into a sealed week in the whole system: a manager remembering
    // Thursday's charging bill on Monday, and back-dating it because the form lets him.
    await assertWeekOpen(deps, branchId, businessDate)
    // The ledger posting and the expense row belong together: an expense that is not in the
    // ledger is a number nobody's balance sheet knows about.
    const fxDayId = await ensureFxDay(deps, businessDate)

    const outcome = await deps.financialUnitOfWork.run(
      {
        lockKey: `expense:${record.id}`,
        actorId: req.actor!.userId,
        requestId: req.requestId,
      },
      (tx) => recordExpenseInTx(tx, {
        record,
        businessDateWasExplicit: body.businessDate !== undefined,
        fxDayId,
        postingDate: todayFor(deps),
      }),
    )
    const saved = outcome.record

    if (!outcome.created) {
      return reply.code(200).send({ ...saved, amount: serializeMoney(saved.amount) })
    }
    await deps.audit.append({
      tableName: 'expenses',
      recordId: saved.id,
      action: 'INSERT',
      actorId: req.actor!.userId,
      actorKind: 'user',
      branchId,
      requestId: req.requestId,
      before: null,
      after: { ...saved, amount: serializeMoney(saved.amount) },
      occurredAtMs: deps.clock.nowMs(),
    })

    // A cost against a vehicle belongs in that vehicle's life log too (س66: «كل الأحداث والكلف»),
    // linked back to this expense. Defaults to a maintenance entry — a charge-specific cost can be
    // reclassified via a manual event. Best-effort: the expense + ledger are the record of truth.
    if (saved.vehicleId !== null) {
      try {
        await recordVehicleEvent(deps, {
          vehicleId: saved.vehicleId,
          branchId,
          kind: 'maintenance',
          costMinor: saved.amount,
          expenseId: saved.id,
          notes: saved.description,
          businessDate,
          createdBy: req.actor!.userId,
        })
      } catch {
        // The life-log entry is a convenience; never fail a posted expense over it.
      }
    }

    return reply.code(201).send({ ...saved, amount: serializeMoney(saved.amount) })
  })

  const expenseRead = async (branchId: string, raw: unknown, complete: boolean) => {
    const { filter, limit, offset } = await readExpenseFilter(deps, branchId, raw)
    const result = await deps.expenses.search(branchId, filter, complete ? undefined : { limit, offset })
    const categories = new Map((await deps.expenses.listCategories(true)).map((category) => [category.id, category.nameAr]))
    const vehicles = new Map<string, string>()
    await Promise.all([...new Set(result.expenses.flatMap((expense) => expense.vehicleId ? [expense.vehicleId] : []))].map(async (vehicleId) => {
      const vehicle = await deps.directory.vehicle(vehicleId)
      if (vehicle) vehicles.set(vehicleId, vehicle.code)
    }))
    return {
      branchId, from: filter.from ?? (result.earliestBusinessDate && result.earliestBusinessDate < filter.to ? result.earliestBusinessDate : filter.to), to: filter.to,
      earliestBusinessDate: result.earliestBusinessDate,
      currency: 'SYP_NEW' as const,
      // This is not a promise that subsequent journal reversals were backdated into these rows.
      totalBasis: 'recorded_expense_rows' as const,
      expenses: result.expenses.map((expense) => ({ ...expense, amount: serializeMoney(expense.amount),
        categoryNameAr: categories.get(expense.categoryId) ?? expense.categoryId,
        vehicleCode: expense.vehicleId ? vehicles.get(expense.vehicleId) ?? expense.vehicleId : null,
      })),
      total: serializeMoney(result.total), count: result.count,
      limit: complete ? null : limit, offset: complete ? 0 : offset,
      generatedAt: new Date(deps.clock.nowMs()).toISOString(),
    }
  }
  app.get('/expenses', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) =>
    expenseRead(resolveBranch(req), req.query, false))
  // No POST, audit mutation or journal creation: exports share the same scoped, validated filter.
  app.get('/expenses/export', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) =>
    expenseRead(resolveBranch(req), req.query, true))

  /** G-1: per-axis profitability starts with per-axis cost. */
  app.get('/expenses/by-cost-center', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    const { filter } = await readExpenseFilter(deps, branchId, req.query)
    const result = await deps.expenses.search(branchId, filter)
    const totals = new Map<string, { costCenterKind: string; vehicleId: string | null; total: bigint }>()
    for (const expense of result.expenses) {
      const key = `${expense.costCenterKind}:${expense.vehicleId ?? ''}`
      const total = totals.get(key) ?? { costCenterKind: expense.costCenterKind, vehicleId: expense.vehicleId, total: 0n }
      total.total += expense.amount
      totals.set(key, total)
    }
    return { totals: [...totals.values()].map((total) => ({ ...total, total: serializeMoney(minor(total.total)) })) }
  })
}
