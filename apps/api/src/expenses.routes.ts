import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps, ExpenseCategoryRecord, ExpenseRecord } from '@ash/contracts'
import { createExpenseCategoryRequest, createExpenseRequest, serializeMoney } from '@ash/contracts'
import { type Posting, expense as expensePosting, minor, weekStartFor } from '@ash/domain'
import { ServiceError, assertWeekOpen, ensureFxDay, recordVehicleEvent, todayFor } from './shifts.service.ts'
import { branchSubject, resolveBranchId } from './branch-scope.ts'

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

  app.get('/expense-categories', { config: { permission: 'branch_data.view', subject: ownBranch } }, async () => ({
    categories: await deps.expenses.listCategories(),
  }))

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

    const businessDate = body.businessDate ?? todayFor(deps)
    // BR7. The likeliest real path into a sealed week in the whole system: a manager remembering
    // Thursday's charging bill on Monday, and back-dating it because the form lets him.
    await assertWeekOpen(deps, branchId, businessDate)
    const record: ExpenseRecord = {
      id: deps.ids.uuid(),
      branchId,
      categoryId: body.categoryId,
      costCenterKind: body.costCenterKind,
      vehicleId: body.vehicleId,
      amount: body.amount,
      businessDate,
      description: body.description,
      receiptMediaId: body.receiptMediaId,
      journalEntryId: null,
      createdBy: req.actor!.userId,
    }

    // The ledger posting and the expense row belong together: an expense that is not in the
    // ledger is a number nobody's balance sheet knows about.
    const costCenterId = record.vehicleId ?? `${record.costCenterKind}:${branchId}`
    const posting: Posting = expensePosting(costCenterId, record.amount, record.id)
    const fxDayId = await ensureFxDay(deps, businessDate)

    const [entry] = await deps.ledger.post(branchId, [posting], {
      shiftId: null,
      businessDate,
      postingDate: todayFor(deps),
      weekStartDate: weekStartFor(businessDate),
      fxDayId,
      createdBy: req.actor!.userId,
      reason: record.description,
    })
    record.journalEntryId = entry?.id ?? null

    await deps.expenses.create(record)
    await deps.audit.append({
      tableName: 'expenses',
      recordId: record.id,
      action: 'INSERT',
      actorId: req.actor!.userId,
      actorKind: 'user',
      branchId,
      requestId: req.requestId,
      before: null,
      after: { ...record, amount: serializeMoney(record.amount) },
      occurredAtMs: deps.clock.nowMs(),
    })

    // A cost against a vehicle belongs in that vehicle's life log too (س66: «كل الأحداث والكلف»),
    // linked back to this expense. Defaults to a maintenance entry — a charge-specific cost can be
    // reclassified via a manual event. Best-effort: the expense + ledger are the record of truth.
    if (record.vehicleId !== null) {
      try {
        await recordVehicleEvent(deps, {
          vehicleId: record.vehicleId,
          branchId,
          kind: 'maintenance',
          costMinor: record.amount,
          expenseId: record.id,
          notes: record.description,
          businessDate,
          createdBy: req.actor!.userId,
        })
      } catch {
        // The life-log entry is a convenience; never fail a posted expense over it.
      }
    }

    return reply.code(201).send({ ...record, amount: serializeMoney(record.amount) })
  })

  app.get('/expenses', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    const { from, to } = z
      .object({ from: z.string().optional(), to: z.string().optional() })
      .parse(req.query)
    const today = todayFor(deps)
    const rows = await deps.expenses.listByBranchAndDate(branchId, from ?? today, to ?? today)

    return {
      from: from ?? today,
      to: to ?? today,
      expenses: rows.map((e) => ({ ...e, amount: serializeMoney(e.amount) })),
      total: serializeMoney(minor(rows.reduce((acc, e) => acc + e.amount, 0n))),
    }
  })

  /** G-1: per-axis profitability starts with per-axis cost. */
  app.get('/expenses/by-cost-center', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    const { from, to } = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query)
    const today = todayFor(deps)
    const totals = await deps.expenses.totalsByCostCenter(branchId, from ?? today, to ?? today)
    return { totals: totals.map((t) => ({ ...t, total: serializeMoney(t.total) })) }
  })
}

