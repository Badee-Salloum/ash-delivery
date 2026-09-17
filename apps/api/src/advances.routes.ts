import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdvanceEventRecord, AdvanceRecord, Deps, ExpenseRecord } from '@ash/contracts'
import {
  convertAdvanceRequest,
  createAdvanceRequest,
  repayAdvanceRequest,
  serializeMoney,
} from '@ash/contracts'
import {
  type Minor,
  type Posting,
  advance as advancePosting,
  advanceFromReceivable as advanceFromReceivablePosting,
  advanceConversion as advanceConversionPosting,
  advanceRepayment as advanceRepaymentPosting,
  fundCode,
  minor,
  normalizePartyName,
  weekStartFor,
} from '@ash/domain'
import { ServiceError, assertWeekOpen, ensureFxDay, todayFor } from './shifts.service.ts'
import { branchSubject, resolveBranchId } from './branch-scope.ts'

/**
 * «السلفة» (owner decision 17) — an expense that was paid but must come back in full.
 *
 * «اضف شي خليط بين الصرفية و الذمة — هوي صرفية دفعت لكنها يجب ان ترد كاملة». It is recorded from
 * the Expenses screen with a category, a description and a receipt, because that is exactly what it
 * becomes if it is never repaid. Its outstanding balance is read from the Treasury screen, because
 * while it is outstanding it is still office capital.
 *
 * Modelled on `incomes.routes.ts`, which already solves every hard part: client-owned idempotency,
 * a replay comparator, reading the immutable receipt before any mutable rule, the BR7 week gate,
 * and one transaction for the row and its journal.
 *
 * THE THINGS THAT ARE DIFFERENT, all of them deliberate:
 *
 *   1. THE ADVANCE IS THE UNIT, NOT THE PARTY. The party is free text by the owner's own choice, so
 *      it has no id; every balance is per advance and a repayment names the advance. `partyKey` is
 *      derived here and never accepted from the wire — a client-supplied key could disagree with
 *      the name it is supposed to normalise, and the grouped view and the list would then disagree
 *      with each other for ever.
 *   2. THE OUTSTANDING AMOUNT IS A LEDGER FACT, read from the advance's own fund inside the lock.
 *      Never `advances.amount_minor`: half of it may already be back.
 *   3. A REPAYMENT RETURNS TO THE BOX THE MONEY LEFT FROM. الترميم plans each box against its own
 *      target, so crossing boxes would raise one leg and lower the other at different moments and
 *      let this advance's own balance go negative in between. If the notes are physically handed
 *      over for a wallet advance, record it to the wallet and move it with `POST /treasury/transfer`.
 *   4. CONVERSION TAKES `journal.manual.write`, not `expense.write`. Paying and collecting move
 *      money about; declaring that it will never come back permanently reduces office capital, and
 *      that is the manual-journal decision a receivable write-off also is.
 */

const sameAdvanceRequest = (
  existing: AdvanceRecord,
  requested: AdvanceRecord,
  dateWasExplicit: boolean,
): boolean =>
  existing.branchId === requested.branchId &&
  existing.partyName === requested.partyName &&
  existing.categoryId === requested.categoryId &&
  existing.costCenterKind === requested.costCenterKind &&
  existing.vehicleId === requested.vehicleId &&
  existing.sourceDriverId === requested.sourceDriverId &&
  // Compared, and it matters: without the channel a replay that flipped cash to wallet would
  // return 200 and quietly leave the ORIGINAL row standing against the wrong box.
  existing.channel === requested.channel &&
  existing.amount === requested.amount &&
  existing.description === requested.description &&
  existing.receiptMediaId === requested.receiptMediaId &&
  (!dateWasExplicit || existing.businessDate === requested.businessDate)

const sameAdvanceEvent = (
  existing: AdvanceEventRecord,
  requested: Pick<AdvanceEventRecord, 'advanceId' | 'branchId' | 'kind' | 'amount' | 'reason'>,
): boolean =>
  existing.advanceId === requested.advanceId &&
  existing.branchId === requested.branchId &&
  existing.kind === requested.kind &&
  existing.amount === requested.amount &&
  existing.reason === requested.reason

/** The advance's own ledger fund — suffixed by the ADVANCE, never by the free-text party. */
const advanceFundCode = (a: Pick<AdvanceRecord, 'id' | 'channel'>): string =>
  fundCode(
    a.channel === 'office_cash'
      ? { kind: 'advance_receivable_cash', advanceId: a.id }
      : { kind: 'advance_receivable_wallet', advanceId: a.id },
  )

/**
 * Where the cost lands if this advance is ever converted.
 *
 * Derived exactly as an ordinary expense derives it (`expenses.routes.ts`), and never from the
 * category: the category is a column on `expenses` and has never been an account, so debiting
 * `cost_center:<categoryId>` would mint a look-alike no profitability reader sums.
 */
const costCenterIdFor = (a: AdvanceRecord): string =>
  a.vehicleId ?? `${a.costCenterKind}:${a.branchId}`

const wireAdvance = (a: AdvanceRecord): Record<string, unknown> => ({
  ...a,
  amount: serializeMoney(a.amount),
})

export function registerAdvanceRoutes(app: FastifyInstance, deps: Deps): void {
  const targetBranch = branchSubject
  const ownBranch = branchSubject
  const resolveBranch = resolveBranchId

  /** What the advance's own fund says is still owed, read wherever a fresh figure is needed. */
  const outstandingOf = async (
    ledger: Pick<Deps['ledger'], 'fundBalance'>,
    a: AdvanceRecord,
  ): Promise<Minor> => minor(await ledger.fundBalance(a.branchId, advanceFundCode(a)))

  // ── Paying one out ──────────────────────────────────────────────────────────────────────

  app.post('/advances', { config: { permission: 'expense.write', subject: targetBranch } }, async (req, reply) => {
    const body = createAdvanceRequest.parse(req.body)
    const branchId = resolveBranch(req)
    const businessDate = body.businessDate ?? todayFor(deps)
    const record: AdvanceRecord = {
      id: body.idempotencyKey,
      branchId,
      partyName: body.partyName,
      // DERIVED, never accepted. See the header.
      partyKey: normalizePartyName(body.partyName),
      categoryId: body.categoryId,
      costCenterKind: body.costCenterKind,
      vehicleId: body.vehicleId,
      sourceDriverId: body.sourceDriverId,
      channel: body.channel,
      amount: body.amount,
      businessDate,
      description: body.description,
      receiptMediaId: body.receiptMediaId,
      journalEntryId: 0, // replaced with the real entry id inside the transaction below
      createdBy: req.actor!.userId,
    }

    // A lost-response replay must not start failing because a category was later disabled or the
    // calendar crossed midnight. The immutable row is the receipt; compare it first.
    const already = await deps.advances.get(record.id)
    if (already) {
      if (!sameAdvanceRequest(already, record, body.businessDate !== undefined)) {
        throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: record.id })
      }
      return reply.code(200).send(wireAdvance(already))
    }

    const categories = await deps.expenses.listCategories()
    if (!categories.some((c) => c.id === body.categoryId)) {
      throw new ServiceError(422, 'unknown_expense_category', { categoryId: body.categoryId })
    }
    // A vehicle cost centre needs a vehicle and no other kind may carry one — the same rule and the
    // same error code the expense route uses, because a converted advance lands in the same place.
    if ((record.costCenterKind === 'vehicle') !== (record.vehicleId !== null)) {
      throw new ServiceError(422, 'cost_center_vehicle_mismatch')
    }
    if (record.vehicleId !== null) {
      const vehicle = await deps.directory.vehicle(record.vehicleId)
      if (!vehicle) throw new ServiceError(404, 'vehicle_not_found')
      if (vehicle.branchId !== branchId) throw new ServiceError(422, 'vehicle_in_another_branch')
    }

    if (record.sourceDriverId !== null) {
      const driver = await deps.directory.driver(record.sourceDriverId)
      if (!driver) throw new ServiceError(404, 'driver_not_found')
      if (driver.branchId !== branchId) throw new ServiceError(422, 'driver_in_another_branch')
    }

    // BR7: a back-dated entry is the likeliest way into a sealed week, and this route lets the
    // caller supply the date.
    await assertWeekOpen(deps, branchId, businessDate)

    /*
     * WHERE THE VALUE COMES FROM.
     *
     * A box, or a «ذمة» being reclassified — and in the second case NOTHING PHYSICAL HAPPENS. One
     * counted asset falls, another rises, no box is touched, office capital is unchanged. Composing
     * the two existing routes instead (collect, then pay) would reach the same balances while
     * writing a COLLECTION into the driver's history for money that never came back.
     */
    const posting: Posting =
      record.sourceDriverId === null
        ? advancePosting(record.channel, record.id, record.amount, record.id)
        : advanceFromReceivablePosting(
            record.channel,
            record.id,
            record.sourceDriverId,
            record.amount,
            record.id,
          )
    const fxDayId = await ensureFxDay(deps, businessDate)

    const outcome = await deps.financialUnitOfWork.run(
      { lockKey: `advance:${record.id}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const concurrent = await tx.advances.get(record.id)
        if (concurrent) {
          if (!sameAdvanceRequest(concurrent, record, body.businessDate !== undefined)) {
            throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: record.id })
          }
          return { record: concurrent, created: false }
        }

        /*
         * You cannot hand over money the box is not holding.
         *
         * Re-read inside the lock, because the interesting case is two advances racing against one
         * balance. The ledger itself would carry a negative office balance without complaint —
         * arithmetic has no opinion — and this is the cheapest place to catch an extra zero, which
         * is the mistake this form invites.
         */
        if (record.sourceDriverId === null) {
          const held = await tx.ledger.fundBalance(branchId, record.channel)
          if (record.amount > held) {
            throw new ServiceError(422, 'insufficient_funds', {
              from: record.channel,
              held: serializeMoney(minor(held)),
              requested: serializeMoney(record.amount),
            })
          }
        } else {
          /*
           * A reclassification is bounded by the DEBT, not by the box: no box is being drawn on.
           * Converting more than he owes would invent office capital out of nothing and leave his
           * «ذمة» negative — which every reader in this system treats as corruption. Re-read inside
           * the lock, because the interesting case is a collection racing a conversion.
           */
          const channel = record.channel === 'office_cash' ? 'cash' : 'wallet'
          const owed = await tx.ledger.fundBalance(
            branchId,
            `driver_receivable_${channel}:${record.sourceDriverId}`,
          )
          if (record.amount > owed) {
            throw new ServiceError(422, 'receivable_too_small', {
              driverId: record.sourceDriverId,
              owed: serializeMoney(minor(owed)),
              requested: serializeMoney(record.amount),
            })
          }
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
        // A journal carrying this client UUID but no matching advance can only be an incompatible
        // use of the key. Never attach the new row to somebody else's entry.
        if (!entry) throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: record.id })

        const created = { ...record, journalEntryId: entry.id }
        await tx.advances.create(created)
        return { record: created, created: true }
      },
    )
    const saved = outcome.record

    if (!outcome.created) return reply.code(200).send(wireAdvance(saved))
    await deps.audit.append({
      tableName: 'advances',
      recordId: saved.id,
      action: 'INSERT',
      actorId: req.actor!.userId,
      actorKind: 'user',
      branchId,
      requestId: req.requestId,
      before: null,
      after: wireAdvance(saved),
      occurredAtMs: deps.clock.nowMs(),
    })
    return reply.code(201).send(wireAdvance(saved))
  })

  // ── Money coming back ───────────────────────────────────────────────────────────────────

  app.post(
    '/advances/:id/repayments',
    { config: { permission: 'expense.write', subject: targetBranch } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
      const body = repayAdvanceRequest.parse(req.body)
      const branchId = resolveBranch(req)
      const businessDate = body.businessDate ?? todayFor(deps)

      const already = await deps.advances.getEvent(body.idempotencyKey)
      if (already) {
        if (
          !sameAdvanceEvent(already, {
            advanceId: id,
            branchId,
            kind: 'repayment',
            amount: body.amount,
            reason: body.reason,
          })
        ) {
          throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: body.idempotencyKey })
        }
        return reply.code(200).send({ ...already, amount: serializeMoney(already.amount) })
      }

      const advanceRow = await deps.advances.get(id)
      if (!advanceRow || advanceRow.branchId !== branchId) throw new ServiceError(404, 'advance_not_found')
      await assertWeekOpen(deps, branchId, businessDate)

      const fxDayId = await ensureFxDay(deps, businessDate)
      const outcome = await deps.financialUnitOfWork.run(
        { lockKey: `advance:${id}`, actorId: req.actor!.userId, requestId: req.requestId },
        async (tx) => {
          const concurrent = await tx.advances.getEvent(body.idempotencyKey)
          if (concurrent) {
            if (
              !sameAdvanceEvent(concurrent, {
                advanceId: id,
                branchId,
                kind: 'repayment',
                amount: body.amount,
                reason: body.reason,
              })
            ) {
              throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: body.idempotencyKey })
            }
            return { record: concurrent, created: false }
          }

          // The fresh figure, inside the lock. Two repayments racing must not each see enough.
          const outstanding = await outstandingOf(tx.ledger, advanceRow)
          if (body.amount > outstanding) {
            throw new ServiceError(422, 'advance_overrepayment', {
              outstanding: serializeMoney(outstanding),
              requested: serializeMoney(body.amount),
            })
          }

          const [entry] = await tx.ledger.post(
            branchId,
            [advanceRepaymentPosting(advanceRow.channel, id, body.amount, body.idempotencyKey)],
            {
              shiftId: null,
              businessDate,
              postingDate: todayFor(deps),
              weekStartDate: weekStartFor(businessDate),
              fxDayId,
              sypMinorPerUsd: null,
              createdBy: req.actor!.userId,
              reason: body.reason,
            },
          )
          if (!entry) {
            throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: body.idempotencyKey })
          }

          const created: AdvanceEventRecord = {
            id: body.idempotencyKey,
            advanceId: id,
            branchId,
            kind: 'repayment',
            amount: body.amount,
            businessDate,
            reason: body.reason,
            expenseId: null,
            journalEntryId: entry.id,
            createdBy: req.actor!.userId,
          }
          await tx.advances.createEvent(created)
          return { record: created, created: true }
        },
      )
      const saved = outcome.record
      if (!outcome.created) return reply.code(200).send({ ...saved, amount: serializeMoney(saved.amount) })

      await deps.audit.append({
        tableName: 'advance_events',
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
    },
  )

  // ── Giving up on it ─────────────────────────────────────────────────────────────────────

  app.post(
    '/advances/:id/conversion',
    { config: { permission: 'journal.manual.write', subject: targetBranch } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
      const body = convertAdvanceRequest.parse(req.body)
      const branchId = resolveBranch(req)
      const businessDate = body.businessDate ?? todayFor(deps)

      const already = await deps.advances.getEvent(body.idempotencyKey)
      if (already) {
        if (already.advanceId !== id || already.kind !== 'conversion' || already.reason !== body.reason) {
          throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: body.idempotencyKey })
        }
        return reply.code(200).send({ ...already, amount: serializeMoney(already.amount) })
      }

      const advanceRow = await deps.advances.get(id)
      if (!advanceRow || advanceRow.branchId !== branchId) throw new ServiceError(404, 'advance_not_found')
      await assertWeekOpen(deps, branchId, businessDate)

      const fxDayId = await ensureFxDay(deps, businessDate)
      const outcome = await deps.financialUnitOfWork.run(
        { lockKey: `advance:${id}`, actorId: req.actor!.userId, requestId: req.requestId },
        async (tx) => {
          const concurrent = await tx.advances.getEvent(body.idempotencyKey)
          if (concurrent) return { record: concurrent, created: false, expense: null }

          /*
           * THE WHOLE REMAINDER, read inside the lock — never `advances.amount_minor`.
           *
           * Half may already be back, and converting the original amount would credit an asset that
           * no longer holds it and drive the fund negative. Zero means there is nothing left to
           * convert, which is also what a second conversion attempt looks like.
           */
          const outstanding = await outstandingOf(tx.ledger, advanceRow)
          if (outstanding <= 0n) throw new ServiceError(422, 'advance_already_settled')

          const costCenterId = costCenterIdFor(advanceRow)
          const [entry] = await tx.ledger.post(
            branchId,
            [advanceConversionPosting(advanceRow.channel, id, costCenterId, outstanding, body.idempotencyKey)],
            {
              shiftId: null,
              businessDate,
              postingDate: todayFor(deps),
              weekStartDate: weekStartFor(businessDate),
              fxDayId,
              sypMinorPerUsd: null,
              createdBy: req.actor!.userId,
              reason: body.reason,
            },
          )
          if (!entry) {
            throw new ServiceError(409, 'idempotency_key_conflict', { idempotencyKey: body.idempotencyKey })
          }

          /*
           * An ordinary `expenses` row, so SRS G's «كل ليرة تخرج: مصنَّفة وموثَّقة ومنسوبة لمركز
           * كلفتها» is honoured at the moment the lira is finally recognised as spent, and every
           * existing expense report picks it up for free.
           *
           * It inherits the advance's own classification and receipt: those were captured when the
           * money left, and asking for them again months later would get a worse answer.
           */
          const expense: ExpenseRecord = {
            id: deps.ids.uuid(),
            branchId,
            categoryId: advanceRow.categoryId,
            costCenterKind: advanceRow.costCenterKind,
            vehicleId: advanceRow.vehicleId,
            // The box the money originally left. No box moves now — it left weeks ago — but the
            // cost belongs to whichever one paid.
            channel: advanceRow.channel,
            amount: outstanding,
            businessDate,
            description: `${advanceRow.description} — ${body.reason}`,
            receiptMediaId: advanceRow.receiptMediaId,
            journalEntryId: entry.id,
            advanceId: id,
            createdBy: req.actor!.userId,
          }
          await tx.expenses.create(expense)

          const created: AdvanceEventRecord = {
            id: body.idempotencyKey,
            advanceId: id,
            branchId,
            kind: 'conversion',
            amount: outstanding,
            businessDate,
            reason: body.reason,
            expenseId: expense.id,
            journalEntryId: entry.id,
            createdBy: req.actor!.userId,
          }
          await tx.advances.createEvent(created)
          return { record: created, created: true, expense }
        },
      )
      const saved = outcome.record
      if (!outcome.created) return reply.code(200).send({ ...saved, amount: serializeMoney(saved.amount) })

      await deps.audit.append({
        tableName: 'advance_events',
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
    },
  )

  // ── Reading ─────────────────────────────────────────────────────────────────────────────

  app.get('/advances', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    const { from, to } = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query)
    const today = todayFor(deps)
    const [recorded, outstanding, parties] = await Promise.all([
      deps.advances.listByBranchAndDate(branchId, from ?? today, to ?? today),
      deps.advances.listOutstanding(branchId),
      deps.advances.listParties(branchId),
    ])
    return {
      from: from ?? today,
      to: to ?? today,
      advances: recorded.map(wireAdvance),
      total: serializeMoney(minor(recorded.reduce((acc, a) => acc + a.amount, 0n))),
      outstanding: outstanding.map((row) => ({
        ...wireAdvance(row.advance),
        outstanding: serializeMoney(row.outstanding),
        repaid: serializeMoney(row.repaid),
        converted: serializeMoney(row.converted),
      })),
      // Split by box, because الترميم restores each against its own capital target.
      outstandingCash: serializeMoney(
        minor(outstanding.filter((r) => r.advance.channel === 'office_cash').reduce((a, r) => a + r.outstanding, 0n)),
      ),
      outstandingWallet: serializeMoney(
        minor(outstanding.filter((r) => r.advance.channel === 'office_wallet').reduce((a, r) => a + r.outstanding, 0n)),
      ),
      parties,
    }
  })

  app.get('/advances/:id/events', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const branchId = resolveBranch(req)
    const advanceRow = await deps.advances.get(id)
    if (!advanceRow || advanceRow.branchId !== branchId) throw new ServiceError(404, 'advance_not_found')
    const events = await deps.advances.listEvents(id)
    return {
      advance: wireAdvance(advanceRow),
      outstanding: serializeMoney(await outstandingOf(deps.ledger, advanceRow)),
      events: events.map((e) => ({ ...e, amount: serializeMoney(e.amount) })),
    }
  })
}
