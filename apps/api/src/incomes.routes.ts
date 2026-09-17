import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps, IncomeCategoryRecord, IncomeRecord } from '@ash/contracts'
import { createIncomeCategoryRequest, createIncomeRequest, serializeMoney } from '@ash/contracts'
import { type Posting, income as incomePosting, minor, weekStartFor } from '@ash/domain'
import { ServiceError, assertWeekOpen, ensureFxDay, todayFor } from './shifts.service.ts'
import { branchSubject, resolveBranchId } from './branch-scope.ts'

/**
 * «المدخول المباشر» (owner request, 2026-08-28) — money arriving at the branch that is not a
 * delivery fee: a scrap sale, a damage recovery, a sponsor.
 *
 * The exact mirror of `expenses.routes.ts`, and deliberately so: the two are the same shape of fact
 * in opposite directions, and every hard part — client-owned idempotency, replay comparison, the
 * week gate, one transaction for the row and its journal — is already solved there.
 *
 * TWO DIFFERENCES, both on purpose:
 *   1. The operator names a CHANNEL (which box received it), never a fund. `fundRefFromCode`'s
 *      default clause turns an unrecognised code into `cost_center:<code>`, a look-alike account
 *      no profit reader sums and no error is ever raised about.
 *   2. There is no `assertCompleteIncome` guard, because `incomes.journal_entry_id` is NOT NULL —
 *      the expense route needs its runtime check only because that column is nullable there.
 */

const sameIncomeRequest = (existing: IncomeRecord, requested: IncomeRecord, dateWasExplicit: boolean): boolean =>
  existing.branchId === requested.branchId &&
  existing.categoryId === requested.categoryId &&
  // Compared, and it matters: without the channel a replay that flipped cash to wallet would
  // return 200 and quietly leave the ORIGINAL row standing against the wrong box.
  existing.channel === requested.channel &&
  existing.amount === requested.amount &&
  existing.description === requested.description &&
  existing.evidenceMediaId === requested.evidenceMediaId &&
  (!dateWasExplicit || existing.businessDate === requested.businessDate)

export function registerIncomeRoutes(app: FastifyInstance, deps: Deps): void {
  const targetBranch = branchSubject
  const ownBranch = branchSubject
  const resolveBranch = resolveBranchId

  app.get('/income-categories', { config: { permission: 'branch_data.view', subject: ownBranch } }, async () => ({
    categories: await deps.incomes.listCategories(),
  }))

  app.post('/income-categories', { config: { permission: 'settings.write' } }, async (req, reply) => {
    const body = createIncomeCategoryRequest.parse(req.body)
    const category: IncomeCategoryRecord = { id: deps.ids.uuid(), ...body, active: true }
    try {
      await deps.incomes.createCategory(category)
    } catch (err) {
      if ((err as { code?: string }).code === 'DUPLICATE_CODE') {
        throw new ServiceError(409, 'duplicate_category_code', { code: body.code })
      }
      throw err
    }
    return reply.code(201).send(category)
  })

  /**
   * Recording is `expense.write`: the branch manager already holds it at branch scope, and an
   * income is the same act of recording a categorised money movement at the branch. A seventeenth
   * permission would be granted to exactly the same three roles while costing a migration against
   * the live `role_permissions` table — decision 9 records why `DEFAULT_GRANTS` alone is not enough.
   */
  app.post('/incomes', { config: { permission: 'expense.write', subject: targetBranch } }, async (req, reply) => {
    const body = createIncomeRequest.parse(req.body)
    const branchId = resolveBranch(req)
    const businessDate = body.businessDate ?? todayFor(deps)
    const record: IncomeRecord = {
      // The client-generated UUID is the record identity too, giving the business row the same
      // durable retry key as its journal without a second mutable mapping table.
      id: body.idempotencyKey,
      branchId,
      categoryId: body.categoryId,
      channel: body.channel,
      amount: body.amount,
      businessDate,
      description: body.description,
      evidenceMediaId: body.evidenceMediaId,
      journalEntryId: 0, // replaced with the real entry id inside the transaction below
      createdBy: req.actor!.userId,
    }

    // A lost-response replay must not start failing because a category was later disabled or the
    // calendar crossed midnight. The immutable row is the receipt; compare it first.
    const already = await deps.incomes.get(record.id)
    if (already) {
      if (!sameIncomeRequest(already, record, body.businessDate !== undefined)) {
        throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: record.id })
      }
      return reply.code(200).send({ ...already, amount: serializeMoney(already.amount) })
    }

    const categories = await deps.incomes.listCategories()
    if (!categories.some((c) => c.id === body.categoryId)) {
      throw new ServiceError(422, 'unknown_income_category', { categoryId: body.categoryId })
    }

    // BR7, exactly as on the expense path: a back-dated entry is the likeliest way into a sealed
    // week, and this route lets the caller supply the date.
    await assertWeekOpen(deps, branchId, businessDate)

    const posting: Posting = incomePosting(record.channel, record.amount, record.id)
    const fxDayId = await ensureFxDay(deps, businessDate)

    const outcome = await deps.financialUnitOfWork.run(
      { lockKey: `income:${record.id}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const concurrent = await tx.incomes.get(record.id)
        if (concurrent) {
          if (!sameIncomeRequest(concurrent, record, body.businessDate !== undefined)) {
            throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: record.id })
          }
          return { record: concurrent, created: false }
        }

        const [entry] = await tx.ledger.post(branchId, [posting], {
          shiftId: null,
          businessDate,
          postingDate: todayFor(deps),
          weekStartDate: weekStartFor(businessDate),
          fxDayId,
          sypMinorPerUsd: null,
          createdBy: req.actor!.userId,
          reason: record.description,
        })
        // A journal carrying this client UUID but no matching income can only be an incompatible
        // use of the key. Never attach the new row to somebody else's entry.
        if (!entry) throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: record.id })

        const created = { ...record, journalEntryId: entry.id }
        await tx.incomes.create(created)
        return { record: created, created: true }
      },
    )
    const saved = outcome.record

    if (!outcome.created) {
      return reply.code(200).send({ ...saved, amount: serializeMoney(saved.amount) })
    }
    await deps.audit.append({
      tableName: 'incomes',
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

    return reply.code(201).send({ ...saved, amount: serializeMoney(saved.amount) })
  })

  app.get('/incomes', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    const { from, to } = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query)
    const today = todayFor(deps)
    const rows = await deps.incomes.listByBranchAndDate(branchId, from ?? today, to ?? today)
    return {
      from: from ?? today,
      to: to ?? today,
      incomes: rows.map((e) => ({ ...e, amount: serializeMoney(e.amount) })),
      total: serializeMoney(minor(rows.reduce((acc, e) => acc + e.amount, 0n))),
    }
  })
}
