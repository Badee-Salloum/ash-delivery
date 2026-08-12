import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { CashCountLine, CashCountRecord, Deps } from '@ash/contracts'
import { createCashCountRequest, manualEntryRequest, moneySchema, serializeMoney } from '@ash/contracts'
import {
  type Minor,
  type Posting,
  type RestorationPlan,
  assertBalanced,
  fundRefFromCode,
  isDateLocked,
  minor,
  planRestoration,
  postingsForRestoration,
  reverse,
  sweepToCompany,
  weekStartFor,
} from '@ash/domain'
import { ServiceError, assertWeekOpen, ensureFxDay, todayFor } from './shifts.service.ts'
import { branchSubject, resolveBranchId } from './branch-scope.ts'

/**
 * Treasury: the daily cash count (E-5 / س51) and disciplined manual entries (E-3 / س50).
 *
 * Both are branch manager + GM per the §3 matrix and decision D-5 — explicitly NOT the system
 * admin, who owns rules and periods rather than money.
 */
export function registerTreasuryRoutes(app: FastifyInstance, deps: Deps): void {
  // The branch a request targets, from `?branchId=` or the body, else the actor's own session.
  // Shared so a read and a write resolve it identically — see branch-scope.ts for why a GET must
  // have a channel at all.
  const targetBranch = branchSubject
  const ownBranch = branchSubject
  const resolveBranch = resolveBranchId

  /** The funds a physical count covers. Driver funds are counted through the shift close. */
  const COUNTABLE_FUNDS = ['office_cash', 'office_wallet'] as const

  // ── The daily count (E-5) ───────────────────────────────────────────────────────────────

  /** What the system believes each fund holds right now — the sheet a manager counts against. */
  app.get('/cash-counts/sheet', { config: { permission: 'cash_count.perform', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    const businessDate = todayFor(deps)
    const existing = await deps.cashCounts.find(branchId, businessDate)

    const funds = await Promise.all(
      COUNTABLE_FUNDS.map(async (fundCode) => ({
        fundCode,
        computed: serializeMoney(await deps.ledger.fundBalance(branchId, fundCode)),
      })),
    )
    return { businessDate, alreadyCounted: existing !== null, funds }
  })

  app.post('/cash-counts', { config: { permission: 'cash_count.perform', subject: targetBranch } }, async (req, reply) => {
    const body = createCashCountRequest.parse(req.body)
    const branchId = resolveBranch(req)
    const businessDate = body.businessDate ?? todayFor(deps)
    // Not a ledger entry, but a sealed day's count is part of what the seal certified (E-5 is a
    // close blocker). Back-dating one into a closed week rewrites evidence for a settled period.
    await assertWeekOpen(deps, branchId, businessDate)

    const lines: CashCountLine[] = []
    for (const line of body.lines) {
      if (!(COUNTABLE_FUNDS as readonly string[]).includes(line.fundCode)) {
        throw new ServiceError(422, 'fund_not_countable', { fundCode: line.fundCode })
      }
      // The computed side is FROZEN here, not recomputed at read time. Otherwise a later
      // posting silently rewrites history and the variance the manager signed off disappears.
      const computed = await deps.ledger.fundBalance(branchId, line.fundCode)
      lines.push({
        fundCode: line.fundCode,
        counted: line.counted,
        computed,
        variance: minor(line.counted - computed),
        resolution: line.resolution,
      })
    }

    const record: CashCountRecord = {
      id: deps.ids.uuid(),
      branchId,
      businessDate,
      countedBy: req.actor!.userId,
      countedAtMs: deps.clock.nowMs(),
      lines,
      proofSha256: null,
      sealedAtMs: null,
      notes: body.notes,
    }
    // «إثبات الجرد» — a sha256 over the frozen lines, so the count cannot be quietly restated.
    record.proofSha256 = sealProof(record)
    record.sealedAtMs = record.countedAtMs

    try {
      await deps.cashCounts.create(record)
    } catch (err) {
      if ((err as { code?: string }).code === 'DUPLICATE_COUNT') {
        throw new ServiceError(409, 'already_counted_today', { businessDate })
      }
      throw err
    }

    await deps.audit.append({
      tableName: 'cash_counts',
      recordId: record.id,
      action: 'INSERT',
      actorId: req.actor!.userId,
      actorKind: 'user',
      branchId,
      requestId: req.requestId,
      before: null,
      after: serializeCount(record),
      occurredAtMs: deps.clock.nowMs(),
    })

    return reply.code(201).send(serializeCount(record))
  })

  app.get('/cash-counts/:date', { config: { permission: 'cash_count.perform', subject: ownBranch } }, async (req) => {
    const { date } = z.object({ date: z.string() }).parse(req.params)
    const branchId = resolveBranch(req)
    const found = await deps.cashCounts.find(branchId, date)
    if (!found) throw new ServiceError(404, 'cash_count_not_found')
    return serializeCount(found)
  })

  // ── Manual entries and corrections (E-3 / س50) ──────────────────────────────────────────

  app.post('/journal/manual', { config: { permission: 'journal.manual.write', subject: targetBranch } }, async (req, reply) => {
    const body = manualEntryRequest.parse(req.body)
    const branchId = resolveBranch(req)

    // A manual entry without a stated reason is not auditable. The schema requires it and the
    // database CHECK requires it too — this is the third layer, and the one with a clear error.
    if (body.reason.trim().length === 0) throw new ServiceError(422, 'reason_required')

    const ceiling = await deps.settings.receiptRequiredAbove(branchId)
    const total = body.lines
      .filter((l) => l.side === 'D')
      .reduce((acc, l) => acc + l.amount, 0n)
    if (ceiling !== null && total > ceiling && body.evidenceMediaId === null) {
      throw new ServiceError(422, 'evidence_required', {
        amount: serializeMoney(minor(total)),
        ceiling: serializeMoney(ceiling),
      })
    }

    const posting: Posting = assertBalanced({
      eventType: 'manual',
      occurrenceKey: deps.ids.uuid(),
      // fundRefFromCode, NOT a blanket cost-centre wrap: naming `office_cash` must move the
      // office cash fund, not a look-alike called `cost_center:office_cash`.
      lines: body.lines.map((l) => ({
        fund: fundRefFromCode(l.fundCode),
        side: l.side,
        amount: l.amount,
      })),
    })

    const businessDate = body.businessDate ?? todayFor(deps)
    // BR7. `businessDate` is client-supplied here, so this is the route a manual entry would use to
    // walk straight into a week the sysadmin already sealed.
    await assertWeekOpen(deps, branchId, businessDate)
    const fxDayId = await ensureFxDay(deps, businessDate)
    const [entry] = await deps.ledger.post(branchId, [posting], {
      shiftId: null,
      businessDate,
      postingDate: todayFor(deps),
      weekStartDate: weekStartFor(businessDate),
      fxDayId,
      createdBy: req.actor!.userId,
      reason: body.reason,
    })

    return reply.code(201).send({ entryId: entry?.id ?? null, businessDate, reason: body.reason })
  })

  /**
   * Correct a posted entry (BR7).
   *
   * A locked week is NEVER edited — the database refuses it twice over. A correction is a
   * visible, dated reversal plus whatever replaces it, which is exactly what SRS E-6 means by
   * «أي تصحيح لاحق بقيد ظاهر مؤرَّخ».
   */
  app.post(
    '/journal/:entryId/reverse',
    { config: { permission: 'journal.manual.write', subject: ownBranch } },
    async (req, reply) => {
      const { entryId } = z.object({ entryId: z.coerce.number().int() }).parse(req.params)
      const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body)
      const branchId = resolveBranch(req)

      const original = await findEntry(deps, branchId, entryId)
      if (!original) throw new ServiceError(404, 'entry_not_found')

      const posting = reverse(
        {
          eventType: original.eventType,
          occurrenceKey: original.occurrenceKey,
          lines: original.lines.map((l) => ({
            fund: fundRefFromCode(l.fundCode),
            side: l.side,
            amount: l.amount,
          })),
        },
        `reversal-of-${entryId}`,
      )

      // The correction posts on TODAY's date while keeping the original business date, so the
      // day it belongs to and the day it was fixed are both visible.
      //
      // UNLESS the original's week has been sealed. The comment above this route asserts «a locked
      // week is NEVER edited — the database refuses it twice over», and until migration 0018 that
      // was simply not true of an INSERT: both of 0006's guards key off `week_lock_id`, which is
      // NULL on a new row. Copying `original.businessDate` here would have put the correction back
      // inside the sealed week, moving totals the owner already has a printed report for.
      //
      // So a correction against a sealed week is re-homed into the current open week, whole: both
      // dates and the FX day move together, because BR6 applies one rate to a whole day and a
      // correction booked today is today's transaction. That IS SRS E-6's «قيد ظاهر مؤرَّخ» — a
      // visible, dated correction entry — and it is ordinary prior-period accounting: you do not
      // un-earn revenue inside a closed period, you book the correction in the open one. The link
      // back is not lost: `reversal-of-<id>` is the occurrence key, and the reason is required.
      const postingDate = todayFor(deps)
      const closed = await deps.weekLocks.listClosedStarts(branchId)
      const sealed = isDateLocked(original.businessDate, closed)
      // Re-homing needs somewhere open to land. In production today's week always is — the close
      // route only ever seals the week BEFORE the closing Sunday — but nothing in `checkWeekClose`
      // actually forbids sealing a week that has not ended, so this is checked rather than assumed.
      // Silently posting into a sealed week is the one outcome that must not happen.
      if (sealed) await assertWeekOpen(deps, branchId, postingDate)
      const businessDate = sealed ? postingDate : original.businessDate
      const weekStartDate = sealed ? weekStartFor(postingDate) : original.weekStartDate
      const fxDayId = await ensureFxDay(deps, businessDate)
      const [entry] = await deps.ledger.post(branchId, [posting], {
        shiftId: null,
        businessDate,
        postingDate,
        weekStartDate,
        fxDayId,
        createdBy: req.actor!.userId,
        reason,
      })

      return reply
        .code(201)
        .send({ reversalEntryId: entry?.id ?? null, reversalOf: entryId, postingDate, businessDate, rehomed: sealed })
    },
  )

  // ── Branch treasury: the cash box + wallet, and funding them (SRS E-1 / decision D-5) ──────
  //
  // Each branch has an office cash box (`office_cash`) and an office wallet (`office_wallet`) — the
  // money a manager disburses to drivers as float and top-up. They start empty; the owner/GM tops
  // them up here. A driver's float debits the box down, so `balance = deposits − floats + returns`;
  // funding the box is what stops it from silently going negative. Balances are the live ledger sum.

  app.get('/treasury/balances', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    return {
      cash: serializeMoney(await deps.ledger.fundBalance(branchId, 'office_cash')),
      wallet: serializeMoney(await deps.ledger.fundBalance(branchId, 'office_wallet')),
    }
  })

  const depositRequest = z.object({
    target: z.enum(['cash', 'wallet']),
    amount: moneySchema,
    note: z.string().max(200).optional(),
  })

  app.post('/treasury/deposit', { config: { permission: 'journal.manual.write', subject: targetBranch } }, async (req, reply) => {
    const body = depositRequest.parse(req.body)
    const branchId = resolveBranch(req)
    if (body.amount <= 0n) throw new ServiceError(422, 'amount_must_be_positive')
    const officeCode = body.target === 'cash' ? 'office_cash' : 'office_wallet'
    // BR7, and it was MISSING here while every other posting route had it. The date is always
    // today so it rarely bit — but on the Sunday a week is sealed, a deposit would have gone
    // straight through the application and been refused by the database trigger instead, surfacing
    // as a raw 25006 rather than «الأسبوع مقفل».
    await assertWeekOpen(deps, branchId, todayFor(deps))

    // A deposit increases the office box/wallet (DEBIT) against an owner-funding contra account
    // (CREDIT), so the ledger stays balanced and the source of the money is recorded. `owner_funding`
    // is an unrecognised code, which fundRefFromCode maps to a contra cost centre by design.
    const posting = assertBalanced({
      eventType: 'manual',
      occurrenceKey: deps.ids.uuid(),
      lines: [
        { fund: fundRefFromCode(officeCode), side: 'D', amount: body.amount },
        { fund: fundRefFromCode('owner_funding'), side: 'C', amount: body.amount },
      ],
    })

    const businessDate = todayFor(deps)
    const fxDayId = await ensureFxDay(deps, businessDate)
    const reason = body.note?.trim() || (body.target === 'cash' ? 'deposit to cash box' : 'top up branch wallet')
    await deps.ledger.post(branchId, [posting], {
      shiftId: null,
      businessDate,
      postingDate: businessDate,
      weekStartDate: weekStartFor(businessDate),
      fxDayId,
      createdBy: req.actor!.userId,
      reason,
    })

    return reply.code(201).send({
      target: body.target,
      balance: serializeMoney(await deps.ledger.fundBalance(branchId, officeCode)),
    })
  })

  // ── «صندوق الشركة» and taking money back OUT of the branch box (owner decisions 10 and (h)) ──
  //
  // Until now money could only go INTO the branch treasury. The owner's own book has it going both
  // ways every day: «كييش» withdraws the day's profit to صندوق الشركة, and «شحن من الصندوق» puts
  // capital back. الترميم automates that decision later; these are the manual controls underneath
  // it, and the ones he asked for directly — «امكانية السحب و الايداع بشكل مباشر».

  /** Aggregated across branches: with one branch this simply IS صندوق الشركة. */
  // No `subject`: صندوق الشركة is company-wide by definition, so there is no branch to scope it to.
  // `profit.view_total` is the gate — GM and, since decision 9, the system admin.
  app.get('/company-fund', { config: { permission: 'profit.view_total' } }, async () => {
    const branches = await deps.directory.listBranches()
    const perBranch = await Promise.all(
      branches.map(async (b) => ({
        branchId: b.id,
        code: b.code,
        nameAr: b.nameAr,
        balance: serializeMoney(await deps.ledger.fundBalance(b.id, 'company_box')),
      })),
    )
    const total = perBranch.reduce((sum, b) => sum + BigInt(b.balance.replace('.', '')), 0n)
    return { total: serializeMoney(minor(total)), branches: perBranch }
  })

  /**
   * «الذمم» — what each driver still owes, oldest first.
   *
   * Read straight from the ledger rather than from a table of its own: the receivable fund IS the
   * record, and a second list would be one more thing to keep in step with it. The open-approval
   * screen pre-fills from this, which is what makes «handled when he starts a new shift» automatic
   * rather than something a manager has to remember.
   */
  app.get('/receivables', { config: { permission: 'branch_data.view', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    const drivers = await deps.directory.listDrivers(branchId)
    const rows = await Promise.all(
      drivers.map(async (d) => ({
        driverId: d.id,
        code: d.code,
        nameAr: d.fullNameAr,
        cash: serializeMoney(await deps.ledger.fundBalance(branchId, `driver_receivable_cash:${d.id}`)),
        wallet: serializeMoney(await deps.ledger.fundBalance(branchId, `driver_receivable_wallet:${d.id}`)),
      })),
    )
    // Only the drivers who actually owe something. A list of zeroes is noise on a screen a manager
    // reads at the counter with a driver waiting.
    const owing = rows.filter((r) => r.cash !== '0.00' || r.wallet !== '0.00')
    const total = owing.reduce((sum, r) => sum + BigInt(r.cash.replace('.', '')), 0n)
    return { total: serializeMoney(minor(total)), drivers: owing }
  })

  const companyMoveRequest = z.object({
    amount: moneySchema,
    reason: z.string().min(1).max(500),
  })

  /**
   * Put the owner's own money into صندوق الشركة. Its counterpart is `owner_funding`, the same
   * contra account a branch deposit uses — so «where did this come from» has one answer, not two.
   */
  app.post('/company-fund/deposit', { config: { permission: 'journal.manual.write', subject: targetBranch } }, async (req, reply) => {
    const body = companyMoveRequest.parse(req.body)
    const branchId = resolveBranch(req)
    if (body.amount <= 0n) throw new ServiceError(422, 'amount_must_be_positive')
    const businessDate = todayFor(deps)
    await assertWeekOpen(deps, branchId, businessDate)

    const posting = assertBalanced({
      eventType: 'manual',
      occurrenceKey: deps.ids.uuid(),
      lines: [
        { fund: { kind: 'company_box' }, side: 'D', amount: body.amount },
        { fund: fundRefFromCode('owner_funding'), side: 'C', amount: body.amount },
      ],
    })
    await postOne(branchId, businessDate, posting, req.actor!.userId, body.reason)
    return reply.code(201).send({ balance: serializeMoney(await deps.ledger.fundBalance(branchId, 'company_box')) })
  })

  /** Take money out of صندوق الشركة — the owner's drawings. Refused below zero. */
  app.post('/company-fund/withdraw', { config: { permission: 'journal.manual.write', subject: targetBranch } }, async (req, reply) => {
    const body = companyMoveRequest.parse(req.body)
    const branchId = resolveBranch(req)
    if (body.amount <= 0n) throw new ServiceError(422, 'amount_must_be_positive')
    const businessDate = todayFor(deps)
    await assertWeekOpen(deps, branchId, businessDate)

    // You cannot hand over money the fund does not hold. The ledger would happily carry a negative
    // balance — arithmetic has no opinion about it — but a company fund that owes itself money is
    // a data-entry mistake every time, and it is cheapest to refuse at the moment it is made.
    const held = await deps.ledger.fundBalance(branchId, 'company_box')
    if (body.amount > held) {
      throw new ServiceError(422, 'insufficient_funds', { held: serializeMoney(held) })
    }

    const posting = assertBalanced({
      eventType: 'manual',
      occurrenceKey: deps.ids.uuid(),
      lines: [
        { fund: fundRefFromCode('owner_drawings'), side: 'D', amount: body.amount },
        { fund: { kind: 'company_box' }, side: 'C', amount: body.amount },
      ],
    })
    await postOne(branchId, businessDate, posting, req.actor!.userId, body.reason)
    return reply.code(201).send({ balance: serializeMoney(await deps.ledger.fundBalance(branchId, 'company_box')) })
  })

  const withdrawRequest = z.object({
    target: z.enum(['cash', 'wallet']),
    amount: moneySchema,
    /** Where it goes. `company_box` is «كييش»; anything else is a named contra account. */
    to: z.string().min(1).max(64).default('company_box'),
    reason: z.string().min(1).max(500),
  })

  /**
   * Take money OUT of خزينة الفرع — the manual half of «كييش».
   *
   * Uses the same `sweepToCompany` recipe الترميم will use, so a hand-made sweep and an automatic
   * one are the same event type and the same shape in the ledger. A dashboard that sums «كييش» must
   * not have to know which of the two produced a row.
   */
  app.post('/treasury/withdraw', { config: { permission: 'journal.manual.write', subject: targetBranch } }, async (req, reply) => {
    const body = withdrawRequest.parse(req.body)
    const branchId = resolveBranch(req)
    if (body.amount <= 0n) throw new ServiceError(422, 'amount_must_be_positive')
    const office = body.target === 'cash' ? 'office_cash' : 'office_wallet'
    const businessDate = todayFor(deps)
    await assertWeekOpen(deps, branchId, businessDate)

    const held = await deps.ledger.fundBalance(branchId, office)
    if (body.amount > held) {
      throw new ServiceError(422, 'insufficient_funds', { held: serializeMoney(held) })
    }

    const posting =
      body.to === 'company_box'
        ? sweepToCompany(office, body.amount, deps.ids.uuid())
        : assertBalanced({
            eventType: 'manual',
            occurrenceKey: deps.ids.uuid(),
            lines: [
              { fund: fundRefFromCode(body.to), side: 'D', amount: body.amount },
              { fund: fundRefFromCode(office), side: 'C', amount: body.amount },
            ],
          })
    await postOne(branchId, businessDate, posting, req.actor!.userId, body.reason)
    return reply.code(201).send({
      target: body.target,
      balance: serializeMoney(await deps.ledger.fundBalance(branchId, office)),
    })
  })

  // ── «الترميم» — the daily restoration (owner decision 10) ──────────────────────────────────

  /**
   * Build the positions from the SEALED COUNT, never from the request body.
   *
   * Owner decision (j): «count first, then ترميم». The whole point is that it settles against money
   * somebody physically counted — computing it from the ledger instead would make it a tautology
   * that can never find anything.
   */
  async function positionsFor(branchId: string, businessDate: string) {
    const count = await deps.cashCounts.find(branchId, businessDate)
    const targets = await deps.capitalTargets.resolve(branchId, businessDate)
    const receivables = await deps.ledger.balancesByPrefix(branchId, 'driver_receivable_')
    const sumFor = (suffix: string): Minor =>
      minor(
        Object.entries(receivables)
          .filter(([code]) => code.startsWith(`driver_receivable_${suffix}:`))
          .reduce((acc, [, v]) => acc + v, 0n),
      )

    return {
      count,
      positions: (['office_cash', 'office_wallet'] as const).map((fundCode) => ({
        fundCode,
        counted: count?.lines.find((l) => l.fundCode === fundCode)?.counted ?? minor(0n),
        receivables: sumFor(fundCode === 'office_cash' ? 'cash' : 'wallet'),
        capitalTarget: targets[fundCode] ?? null,
      })),
    }
  }

  const serializeLeg = (l: RestorationPlan['legs'][number]) => ({
    fundCode: l.fundCode,
    position: serializeMoney(l.position),
    capitalTarget: serializeMoney(l.capitalTarget),
    delta: serializeMoney(l.delta),
    direction: l.direction,
    amount: serializeMoney(l.amount),
    feasible: l.feasible,
    refusals: l.refusals,
  })

  /** What tonight's ترميم WOULD do. Reads the sealed count; posts nothing. */
  app.get('/treasury/restoration/preview', { config: { permission: 'cash_count.perform', subject: ownBranch } }, async (req) => {
    const branchId = resolveBranch(req)
    const businessDate = todayFor(deps)
    const { count, positions } = await positionsFor(branchId, businessDate)
    const plan = planRestoration(positions)
    return {
      businessDate,
      counted: count !== null,
      legs: plan.legs.map(serializeLeg),
      netToCompany: serializeMoney(plan.netToCompany),
      feasible: plan.feasible,
      refusals: plan.refusals,
    }
  })

  app.post('/treasury/restoration', { config: { permission: 'journal.manual.write', subject: targetBranch } }, async (req, reply) => {
    const body = z.object({ reason: z.string().min(1).max(500) }).parse(req.body)
    const branchId = resolveBranch(req)
    const businessDate = todayFor(deps)
    await assertWeekOpen(deps, branchId, businessDate)

    // BEFORE anything posts. The ledger's idempotency index would refuse the replay too, but as a
    // constraint violation mid-transaction — the operator would see a 500 where the truth is a
    // plain "already done today". Order matters here, not just the guard.
    if ((await deps.restorations.find(branchId, businessDate)) !== null) {
      throw new ServiceError(409, 'already_restored_today')
    }

    const { count, positions } = await positionsFor(branchId, businessDate)
    // Decision (j). Without the count this would settle against what the system BELIEVES is in the
    // drawer, which is the one number a reconciliation must not take on trust.
    if (count === null) throw new ServiceError(422, 'cash_count_required')

    const plan = planRestoration(positions)
    if (!plan.feasible) throw new ServiceError(422, 'restoration_infeasible', { refusals: plan.refusals })

    const postings = postingsForRestoration(plan, businessDate)
    if (postings.length > 0) {
      const fxDayId = await ensureFxDay(deps, businessDate)
      await deps.ledger.post(branchId, postings, {
        shiftId: null,
        businessDate,
        postingDate: businessDate,
        weekStartDate: weekStartFor(businessDate),
        fxDayId,
        createdBy: req.actor!.userId,
        reason: body.reason,
      })
    }

    // Once per branch per working day — the unique index refuses a replay rather than posting the
    // sweep a second time. Recorded even when nothing moved: «we restored and it was already level»
    // is a different fact from «nobody looked».
    try {
      await deps.restorations.create({
        branchId,
        businessDate,
        cashCountId: count.id,
        plan: { legs: plan.legs.map(serializeLeg) },
        netToCompany: plan.netToCompany,
        reason: body.reason,
        performedBy: req.actor!.userId,
      })
    } catch (err) {
      if ((err as { code?: string }).code === 'DUPLICATE_RESTORATION') {
        throw new ServiceError(409, 'already_restored_today')
      }
      throw err
    }

    return reply.code(201).send({
      businessDate,
      legs: plan.legs.map(serializeLeg),
      netToCompany: serializeMoney(plan.netToCompany),
      postings: postings.length,
    })
  })

  /** The four routes above post one balanced entry on today's date; only the lines differ. */
  async function postOne(
    branchId: string,
    businessDate: string,
    posting: Posting,
    createdBy: string,
    reason: string,
  ): Promise<void> {
    const fxDayId = await ensureFxDay(deps, businessDate)
    await deps.ledger.post(branchId, [posting], {
      shiftId: null,
      businessDate,
      postingDate: businessDate,
      weekStartDate: weekStartFor(businessDate),
      fxDayId,
      createdBy,
      reason,
    })
  }
}

async function findEntry(deps: Deps, branchId: string, entryId: number) {
  // Entries are addressed by week; scanning the shift index would miss standalone entries.
  const starts = await deps.weekLocks.listClosedStarts(branchId)
  const candidates = new Set<string>([...starts, weekStartFor(todayFor(deps))])
  for (const start of candidates) {
    const entries = await deps.ledger.listByWeek(branchId, start)
    const found = entries.find((e) => e.id === entryId)
    if (found) return found
  }
  return null
}

function sealProof(record: CashCountRecord): string {
  const canonical = record.lines
    .map((l) => `${l.fundCode}|${l.counted}|${l.computed}|${l.variance}`)
    .sort()
    .join(';')
  return createHash('sha256')
    .update(`${record.branchId}|${record.businessDate}|${record.countedBy}|${canonical}`)
    .digest('hex')
}

function serializeCount(record: CashCountRecord) {
  return {
    id: record.id,
    businessDate: record.businessDate,
    countedBy: record.countedBy,
    countedAt: new Date(record.countedAtMs).toISOString(),
    proofSha256: record.proofSha256,
    notes: record.notes,
    lines: record.lines.map((l) => ({
      fundCode: l.fundCode,
      counted: serializeMoney(l.counted),
      computed: serializeMoney(l.computed),
      variance: serializeMoney(l.variance),
      resolution: l.resolution,
    })),
    /** Any non-zero variance is what the manager must explain before the Sunday close. */
    balanced: record.lines.every((l) => l.variance === 0n),
  }
}
