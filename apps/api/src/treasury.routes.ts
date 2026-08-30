import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type {
  CashCountLine,
  CashCountRecord,
  Deps,
  FinancialTransactionDeps,
  ReceivableEventRecord,
} from '@ash/contracts'
import {
  cancelCashCountRequest,
  createCashCountRequest,
  correctReceivableRequest,
  createReceivableEventRequest,
  manualEntryRequest,
  moneySchema,
  serializeMoney,
  writeoffReceivableRequest,
} from '@ash/contracts'
import {
  type Minor,
  type Posting,
  type RestorationPlan,
  assertBalanced,
  fundRefFromCode,
  isDateLocked,
  minor,
  parseMinor,
  planRestoration,
  postingsForCashCountReconciliation,
  postingsForRestoration,
  receivableAdjustment,
  receivableWriteoff,
  reverse,
  manualKaish,
  weekStartFor,
} from '@ash/domain'
import { ServiceError, assertWeekOpen, ensureFxDay, todayFor } from './shifts.service.ts'
import { branchSubject, resolveBranchId } from './branch-scope.ts'

/** Exact storage range of PostgreSQL bigint-backed money columns and journal lines. */
const PG_MINOR_MAX = 9_223_372_036_854_775_807n
const PG_MINOR_MIN = -9_223_372_036_854_775_808n

function assertPersistableTreasuryMinor(field: string, value: bigint): void {
  if (value >= PG_MINOR_MIN && value <= PG_MINOR_MAX) return
  throw new ServiceError(422, 'money_total_out_of_range', {
    field,
    value: value.toString(),
    min: PG_MINOR_MIN.toString(),
    max: PG_MINOR_MAX.toString(),
  })
}

/** Guard both the immutable JSON snapshot and its bigint `net_to_company_minor` projection. */
function assertPersistableRestorationPlan(plan: RestorationPlan): void {
  for (const leg of plan.legs) {
    const scope = `restoration.legs.${leg.fundCode}`
    assertPersistableTreasuryMinor(`${scope}.counted`, leg.counted)
    assertPersistableTreasuryMinor(`${scope}.receivables`, leg.receivables)
    assertPersistableTreasuryMinor(`${scope}.position`, leg.position)
    assertPersistableTreasuryMinor(`${scope}.capitalTarget`, leg.capitalTarget)
    assertPersistableTreasuryMinor(`${scope}.delta`, leg.delta)
    assertPersistableTreasuryMinor(`${scope}.amount`, leg.amount)
  }
  assertPersistableTreasuryMinor('restoration.netToCompany', plan.netToCompany)
}

/** No derived restoration or reconciliation line may reach a PostgreSQL bigint cast unchecked. */
function assertPersistableTreasuryPostings(postings: readonly Posting[]): void {
  for (const posting of postings) {
    posting.lines.forEach((line, index) => {
      assertPersistableTreasuryMinor(
        `restoration.journal.${posting.eventType}.${posting.occurrenceKey}.lines[${index}]`,
        line.amount,
      )
    })
  }
}

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
      // Physical cash cannot be negative. The wallet remains signed because the provider may
      // legitimately report a negative balance/liability, but accepting a negative drawer count
      // would make restoration manufacture an extra draw from the company box.
      if (line.fundCode === 'office_cash' && line.counted < 0n) {
        throw new ServiceError(422, 'cash_count_negative', { fundCode: line.fundCode })
      }
      // The computed side is FROZEN here, not recomputed at read time. Otherwise a later
      // posting silently rewrites history and the variance the manager signed off disappears.
      const computed = await deps.ledger.fundBalance(branchId, line.fundCode)
      const variance = minor(line.counted - computed)
      const resolution = line.resolution?.trim() || null
      // A signed count is audit evidence. A non-zero line without its own explanation would leave
      // the manager (and the week close) with no record of which physical box was investigated.
      // This check must happen after the server freezes `computed`: the client cannot know or
      // authoritatively assert the variance it is explaining.
      if (variance !== 0n && resolution === null) {
        throw new ServiceError(422, 'cash_count_resolution_required', {
          fundCode: line.fundCode,
          variance: serializeMoney(variance),
        })
      }
      lines.push({
        fundCode: line.fundCode,
        counted: line.counted,
        computed,
        variance,
        resolution,
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
      status: 'active',
      supersededById: null,
      closedAtMs: null,
      closedBy: null,
      closedReason: null,
      notes: body.notes,
    }
    // «إثبات الجرد» — a sha256 over the frozen lines, so the count cannot be quietly restated.
    record.proofSha256 = sealProof(record)
    record.sealedAtMs = record.countedAtMs

    /*
     * A RECOUNT supersedes the day's active count instead of colliding with it.
     *
     * Until this existed the day could deadlock: a posting after a sealed count made the
     * restoration refuse with `cash_count_stale` telling the manager to "recount instead", while
     * this route refused that with `already_counted_today`. Recounting is deliberate and audited —
     * `recountReason` is required, so nobody replaces a signed count by accident.
     */
    let stored: CashCountRecord
    const prior = await deps.cashCounts.find(branchId, businessDate)
    if (prior !== null && body.recountReason !== undefined) {
      try {
        stored = await deps.cashCounts.supersede({
          priorId: prior.id,
          replacement: record,
          closedBy: req.actor!.userId,
          closedAtMs: deps.clock.nowMs(),
          reason: body.recountReason,
        })
      } catch (err) {
        // Somebody else recounted or withdrew it between our read and our write.
        if ((err as { code?: string }).code === 'COUNT_NOT_ACTIVE') {
          throw new ServiceError(409, 'cash_count_changed', { businessDate })
        }
        throw err
      }
    } else {
      try {
        stored = await deps.cashCounts.create(record)
      } catch (err) {
        if ((err as { code?: string }).code === 'DUPLICATE_COUNT') {
          // Names the way out, which the old error did not: send `recountReason` to replace it.
          throw new ServiceError(409, 'already_counted_today', {
            businessDate,
            hint: 'send recountReason to supersede the existing count',
          })
        }
        throw err
      }
    }

    await deps.audit.append({
      tableName: 'cash_counts',
      recordId: stored.id,
      action: 'INSERT',
      actorId: req.actor!.userId,
      actorKind: 'user',
      branchId,
      requestId: req.requestId,
      before: null,
      after: serializeCount(stored),
      occurredAtMs: deps.clock.nowMs(),
    })

    return reply.code(201).send(serializeCount(stored))
  })

  app.get('/cash-counts/:date', { config: { permission: 'cash_count.perform', subject: ownBranch } }, async (req) => {
    const { date } = z.object({ date: z.string() }).parse(req.params)
    const branchId = resolveBranch(req)
    const found = await deps.cashCounts.find(branchId, date)
    if (!found) throw new ServiceError(404, 'cash_count_not_found')
    return serializeCount(found)
  })

  /**
   * «إلغاء الجرد» — withdraw the day's count until the underlying error is fixed.
   *
   * The third answer a variance deserves, beside proceeding and recounting: sometimes the right
   * move is to stop, fix what is wrong, and count again later. The withdrawn count keeps its rows,
   * its resolutions and its proof — only its standing changes — and the day goes back to uncounted,
   * so the restoration refuses with `cash_count_required` rather than settling against figures
   * nobody stands behind.
   */
  app.post(
    '/cash-counts/:date/cancel',
    { config: { permission: 'cash_count.perform', subject: targetBranch } },
    async (req) => {
      const { date } = z.object({ date: z.string() }).parse(req.params)
      const body = cancelCashCountRequest.parse(req.body)
      const branchId = resolveBranch(req)
      await assertWeekOpen(deps, branchId, date)

      const active = await deps.cashCounts.find(branchId, date)
      if (!active) throw new ServiceError(404, 'cash_count_not_found')

      // A restored day's count is the evidence that restoration settled against. Withdrawing it
      // afterwards would leave a posted restoration explained by nothing.
      const restored = await deps.restorations.find(branchId, date)
      if (restored !== null) throw new ServiceError(409, 'already_restored_today', { businessDate: date })

      const cancelled = await deps.cashCounts.cancel({
        id: active.id,
        closedBy: req.actor!.userId,
        closedAtMs: deps.clock.nowMs(),
        reason: body.reason,
      })
      if (!cancelled) throw new ServiceError(409, 'cash_count_changed', { businessDate: date })

      await deps.audit.append({
        tableName: 'cash_counts',
        recordId: cancelled.id,
        action: 'UPDATE',
        actorId: req.actor!.userId,
        actorKind: 'user',
        branchId,
        requestId: req.requestId,
        before: serializeCount(active),
        after: serializeCount(cancelled),
        occurredAtMs: deps.clock.nowMs(),
      })
      return serializeCount(cancelled)
    },
  )

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
            ...(l.role === undefined ? {} : { role: l.role }),
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
  const listReceivables = async (req: FastifyRequest) => {
    const branchId = resolveBranch(req)
    const [drivers, ordinaryBalances, shiftFundingBalances] = await Promise.all([
      deps.directory.listDrivers(branchId),
      deps.ledger.balancesByPrefix(branchId, 'driver_receivable_'),
      deps.ledger.balancesByPrefix(branchId, 'driver_shift_funding_'),
    ])
    const rows = drivers.map((d) => {
      const ordinaryCash = minor(ordinaryBalances[`driver_receivable_cash:${d.id}`] ?? 0n)
      const ordinaryWallet = minor(ordinaryBalances[`driver_receivable_wallet:${d.id}`] ?? 0n)
      const shiftFundingCash = minor(shiftFundingBalances[`driver_shift_funding_cash:${d.id}`] ?? 0n)
      const shiftFundingWallet = minor(shiftFundingBalances[`driver_shift_funding_wallet:${d.id}`] ?? 0n)
      const amounts = [ordinaryCash, ordinaryWallet, shiftFundingCash, shiftFundingWallet]
      if (amounts.some((amount) => amount < 0n)) {
        throw new ServiceError(500, 'receivable_balance_integrity_error', { driverId: d.id })
      }
      return {
        driverId: d.id,
        code: d.code,
        nameAr: d.fullNameAr,
        ordinaryCash,
        ordinaryWallet,
        shiftFundingCash,
        shiftFundingWallet,
        cash: minor(ordinaryCash + shiftFundingCash),
        wallet: minor(ordinaryWallet + shiftFundingWallet),
      }
    })
    // Only the drivers who actually owe something. A list of zeroes is noise on a screen a manager
    // reads at the counter with a driver waiting.
    const owing = rows.filter((r) => r.cash !== 0n || r.wallet !== 0n)
    const cashTotal = minor(owing.reduce((sum, r) => sum + r.cash, 0n))
    const walletTotal = minor(owing.reduce((sum, r) => sum + r.wallet, 0n))
    const grandTotal = minor(cashTotal + walletTotal)
    const ordinaryCashTotal = minor(owing.reduce((sum, r) => sum + r.ordinaryCash, 0n))
    const ordinaryWalletTotal = minor(owing.reduce((sum, r) => sum + r.ordinaryWallet, 0n))
    const shiftFundingCashTotal = minor(owing.reduce((sum, r) => sum + r.shiftFundingCash, 0n))
    const shiftFundingWalletTotal = minor(owing.reduce((sum, r) => sum + r.shiftFundingWallet, 0n))
    return {
      // Backwards compatibility for cached/admin clients: `total` historically meant cash only.
      total: serializeMoney(cashTotal),
      cashTotal: serializeMoney(cashTotal),
      walletTotal: serializeMoney(walletTotal),
      grandTotal: serializeMoney(grandTotal),
      ordinaryCashTotal: serializeMoney(ordinaryCashTotal),
      ordinaryWalletTotal: serializeMoney(ordinaryWalletTotal),
      shiftFundingCashTotal: serializeMoney(shiftFundingCashTotal),
      shiftFundingWalletTotal: serializeMoney(shiftFundingWalletTotal),
      drivers: owing.map((row) => ({
        ...row,
        ordinaryCash: serializeMoney(row.ordinaryCash),
        ordinaryWallet: serializeMoney(row.ordinaryWallet),
        shiftFundingCash: serializeMoney(row.shiftFundingCash),
        shiftFundingWallet: serializeMoney(row.shiftFundingWallet),
        cash: serializeMoney(row.cash),
        wallet: serializeMoney(row.wallet),
        total: serializeMoney(minor(row.cash + row.wallet)),
      })),
    }
  }
  const receivableReadOptions = { config: { permission: 'branch_data.view' as const, subject: ownBranch } }
  app.get('/receivables', receivableReadOptions, listReceivables)
  app.get('/treasury/receivables', receivableReadOptions, listReceivables)

  /** Immutable history, newest first, for explaining debts, collections, corrections, and losses. */
  const listReceivableEvents = async (req: FastifyRequest) => {
    const query = z.object({ driverId: z.string().min(1).optional() }).parse(req.query)
    const branchId = resolveBranch(req)
    const [events, drivers] = await Promise.all([
      deps.receivableEvents.listByBranchAndDriver(branchId, query.driverId),
      deps.directory.listDrivers(branchId),
    ])
    const driverById = new Map(drivers.map((driver) => [driver.id, driver]))
    return {
      events: events.map((event) => {
        const driver = driverById.get(event.driverId)
        return {
          id: event.id,
          driverId: event.driverId,
          driverCode: driver?.code ?? null,
          driverNameAr: driver?.fullNameAr ?? null,
          receivableKind: event.receivableKind,
          channel: event.channel,
          direction: event.direction,
          amount: serializeMoney(event.amount),
          businessDate: event.businessDate,
          reason: event.reason,
          // The history has to say which this was. A correction rendered as a collection tells the
          // driver his debt was paid when nothing was paid.
          intent: event.intent,
          priorBalance: event.priorBalance === null ? null : serializeMoney(event.priorBalance),
          targetBalance: event.targetBalance === null ? null : serializeMoney(event.targetBalance),
          journalEntryId: event.journalEntryId,
          createdBy: event.createdBy,
          createdAtMs: event.createdAtMs,
        }
      }),
    }
  }
  app.get('/receivables/events', receivableReadOptions, listReceivableEvents)
  app.get('/treasury/receivables/events', receivableReadOptions, listReceivableEvents)

  const sameReceivableCommand = (
    prior: ReceivableEventRecord,
    input: {
      driverId: string
      receivableKind: 'ordinary' | 'shift_funding'
      channel: 'cash' | 'wallet'
      direction: 'create' | 'collect'
      amount: Minor
      reason: string
    },
  ): boolean =>
    prior.intent === 'command' &&
    prior.driverId === input.driverId &&
    prior.receivableKind === input.receivableKind &&
    prior.channel === input.channel &&
    prior.direction === input.direction &&
    prior.amount === input.amount &&
    prior.reason === input.reason

  const sendReceivableEvent = (
    reply: FastifyReply,
    event: ReceivableEventRecord,
    replayed: boolean,
  ) => reply.code(replayed ? 200 : 201).send({
    id: event.id,
    driverId: event.driverId,
    receivableKind: event.receivableKind,
    channel: event.channel,
    direction: event.direction,
    amount: serializeMoney(event.amount),
    businessDate: event.businessDate,
    reason: event.reason,
    intent: event.intent,
    priorBalance: event.priorBalance === null ? null : serializeMoney(event.priorBalance),
    targetBalance: event.targetBalance === null ? null : serializeMoney(event.targetBalance),
    journalEntryId: event.journalEntryId,
    replayed,
  })

  /**
   * Create or collect a driver receivable without associating it with a shift.
   *
   * `ordinary` remains until a later collection. `shift_funding` is consumed automatically when
   * this driver's next shift is approved open. Both are office assets and both retain the cash vs
   * wallet channel so restoration adds them to the correct capital target.
  */
  const writeReceivableEvent = async (req: FastifyRequest, reply: FastifyReply) => {
      const body = createReceivableEventRequest.parse(req.body)
      const branchId = resolveBranch(req)

      // A lost-response retry is a read of the immutable receipt, not a new business operation.
      // Resolve it before mutable driver/week/FX rules so deactivating a debtor or closing the week
      // cannot turn an already-committed command into a false failure. Branch authorisation and the
      // complete command fingerprint still apply; a changed reuse of the key remains a conflict.
      const committed = await deps.receivableEvents.findByIdempotencyKey(branchId, body.idempotencyKey)
      if (committed) {
        if (!sameReceivableCommand(committed, body)) {
          throw new ServiceError(409, 'idempotency_key_conflict')
        }
        return sendReceivableEvent(reply, committed, true)
      }

      const driver = await deps.directory.driver(body.driverId)
      if (!driver) throw new ServiceError(404, 'driver_not_found')
      if (driver.branchId !== branchId) throw new ServiceError(422, 'driver_in_another_branch')
      // An inactive driver may still owe office money. Keep that debt collectible, but never hand
      // them a new ordinary advance or next-shift funding while they are disabled.
      if (body.direction === 'create' && !driver.active) {
        throw new ServiceError(404, 'driver_not_found')
      }

      const businessDate = todayFor(deps)
      await assertWeekOpen(deps, branchId, businessDate)
      const fxDayId = await ensureFxDay(deps, businessDate)
      const result = await deps.financialUnitOfWork.run(
        {
          lockKey: `receivables:${branchId}`,
          actorId: req.actor!.userId,
          requestId: req.requestId,
        },
        async (transaction) => {
          const prior = await transaction.receivableEvents.findByIdempotencyKey(
            branchId,
            body.idempotencyKey,
          )
          if (prior) {
            if (!sameReceivableCommand(prior, body)) {
              throw new ServiceError(409, 'idempotency_key_conflict')
            }
            return { event: prior, replayed: true }
          }

          const receivablePrefix = body.receivableKind === 'shift_funding'
            ? 'driver_shift_funding'
            : 'driver_receivable'
          const receivableCode = `${receivablePrefix}_${body.channel}:${body.driverId}`
          const officeCode = body.channel === 'cash' ? 'office_cash' : 'office_wallet'
          const available = await transaction.ledger.fundBalance(
            branchId,
            body.direction === 'create' ? officeCode : receivableCode,
          )
          if (available < body.amount) {
            throw new ServiceError(422, body.direction === 'create' ? 'insufficient_funds' : 'receivable_overcollection', {
              available: serializeMoney(available),
            })
          }

          const posting = receivableAdjustment(
            body.driverId,
            body.receivableKind,
            body.channel,
            body.direction,
            body.amount,
            body.idempotencyKey,
          )
          const [journal] = await transaction.ledger.post(branchId, [posting], {
            shiftId: null,
            businessDate,
            postingDate: businessDate,
            weekStartDate: weekStartFor(businessDate),
            fxDayId,
            createdBy: req.actor!.userId,
            reason: body.reason,
          })
          if (!journal) throw new ServiceError(409, 'idempotency_key_conflict')

          const event: ReceivableEventRecord = {
            id: deps.ids.uuid(),
            branchId,
            driverId: body.driverId,
            receivableKind: body.receivableKind,
            channel: body.channel,
            direction: body.direction,
            amount: body.amount,
            businessDate,
            reason: body.reason,
            // A direct command, not a restatement: money genuinely moves between the office box and
            // the driver's account, so the balances a correction records do not apply.
            intent: 'command',
            priorBalance: null,
            targetBalance: null,
            idempotencyKey: body.idempotencyKey,
            journalEntryId: journal.id,
            createdBy: req.actor!.userId,
            createdAtMs: deps.clock.nowMs(),
          }
          await transaction.receivableEvents.create(event)
          return { event, replayed: false }
        },
      )

      return sendReceivableEvent(reply, result.event, result.replayed)
  }
  const receivableWriteOptions = { config: { permission: 'journal.manual.write' as const, subject: targetBranch } }
  app.post('/receivables/events', receivableWriteOptions, writeReceivableEvent)
  app.post('/treasury/receivables/events', receivableWriteOptions, writeReceivableEvent)

  /**
   * «تعديل الذمم المسجلة» — restate a receivable balance that was recorded wrongly.
   *
   * The operator names the BALANCE, not a movement. That is the only form that can work: a driver's
   * receivable balance is a LEDGER FUND BALANCE fed from seven places — this route, the shift
   * close's deferral, the shift-funding carry consumed at the next open, the cash-deduction
   * overflow, and more — and only ONE of them writes a `receivable_events` row. A correction that
   * pointed at an event could not touch the commonest wrong number of all, a `shift_funding` carry,
   * because there is no event to point at.
   *
   * So: read the balance, refuse if it is not what the operator was looking at, and post the
   * difference through the UNCHANGED `receivableAdjustment` recipe. One way of moving a receivable,
   * no second arithmetic to keep in step, and every guard 0037 installed applies untouched — the
   * actor check against the live RBAC matrix, the journal-identity check, the two-line recipe
   * check, the over-collection row lock. A correction IS one of those postings; it is only
   * LABELLED differently, so the driver's history does not claim money came back when none did.
   */
  const correctReceivable = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = correctReceivableRequest.parse(req.body)
    const branchId = resolveBranch(req)

    const replayMatches = (prior: ReceivableEventRecord): boolean =>
      prior.intent === 'correction' &&
      prior.driverId === body.driverId &&
      prior.receivableKind === body.receivableKind &&
      prior.channel === body.channel &&
      prior.priorBalance === body.expectedCurrentBalance &&
      prior.targetBalance === body.targetBalance &&
      prior.reason === body.reason

    // A lost-response retry reads the immutable receipt rather than restating the balance a second
    // time — which, on a correction, would move it twice as far.
    const committed = await deps.receivableEvents.findByIdempotencyKey(branchId, body.idempotencyKey)
    if (committed) {
      if (!replayMatches(committed)) throw new ServiceError(409, 'idempotency_key_conflict')
      return sendReceivableEvent(reply, committed, true)
    }

    const driver = await deps.directory.driver(body.driverId)
    if (!driver) throw new ServiceError(404, 'driver_not_found')
    if (driver.branchId !== branchId) throw new ServiceError(422, 'driver_in_another_branch')

    const raising = body.targetBalance > body.expectedCurrentBalance
    if (raising && !driver.active) {
      // 0037's database guard refuses `create` for an inactive driver and is not relaxed here — see
      // the note in migration 0050. Name it, so the operator reads "reactivate him first" instead
      // of a constraint violation.
      throw new ServiceError(422, 'receivable_correction_needs_active_driver', { driverId: body.driverId })
    }

    const businessDate = todayFor(deps)
    await assertWeekOpen(deps, branchId, businessDate)
    const fxDayId = await ensureFxDay(deps, businessDate)

    const result = await deps.financialUnitOfWork.run(
      { lockKey: `receivables:${branchId}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (transaction) => {
        const prior = await transaction.receivableEvents.findByIdempotencyKey(branchId, body.idempotencyKey)
        if (prior) {
          if (!replayMatches(prior)) throw new ServiceError(409, 'idempotency_key_conflict')
          return { event: prior, replayed: true }
        }

        const receivablePrefix = body.receivableKind === 'shift_funding' ? 'driver_shift_funding' : 'driver_receivable'
        const receivableCode = receivablePrefix + '_' + body.channel + ':' + body.driverId
        const officeCode = body.channel === 'cash' ? 'office_cash' : 'office_wallet'

        /*
         * Read INSIDE the lock and compare with what the operator saw.
         *
         * "Set it to 500" is a statement about a number he was looking at. If a shift closed or a
         * collection landed between his reading and his pressing, applying it anyway would silently
         * discard that movement — and a correction that erases a real event is worse than the wrong
         * balance it was meant to fix. So: refuse, and hand back what it actually reads.
         */
        const current = await transaction.ledger.fundBalance(branchId, receivableCode)
        if (current !== body.expectedCurrentBalance) {
          throw new ServiceError(409, 'receivable_balance_changed', {
            expected: serializeMoney(body.expectedCurrentBalance),
            actual: serializeMoney(current),
          })
        }

        const delta = body.targetBalance - current
        if (delta === 0n) {
          // Nothing to restate. The recipe refuses a zero amount anyway; saying so plainly beats a
          // RangeError, and a correction that changes nothing is a mistake worth naming.
          throw new ServiceError(422, 'receivable_already_at_target', { balance: serializeMoney(current) })
        }

        const direction = delta > 0n ? ('create' as const) : ('collect' as const)
        const amount = minor(delta > 0n ? delta : -delta)

        // Raising a receivable takes value out of the office box, exactly as an ordinary advance
        // does; the office must actually hold it. Lowering one is bounded by the balance itself,
        // which `targetBalance >= 0` already guarantees.
        if (direction === 'create') {
          const available = await transaction.ledger.fundBalance(branchId, officeCode)
          if (available < amount) {
            throw new ServiceError(422, 'insufficient_funds', { available: serializeMoney(available) })
          }
        }

        const posting = receivableAdjustment(
          body.driverId,
          body.receivableKind,
          body.channel,
          direction,
          amount,
          body.idempotencyKey,
        )
        const [journal] = await transaction.ledger.post(branchId, [posting], {
          shiftId: null,
          businessDate,
          postingDate: businessDate,
          weekStartDate: weekStartFor(businessDate),
          fxDayId,
          createdBy: req.actor!.userId,
          reason: body.reason,
        })
        if (!journal) throw new ServiceError(409, 'idempotency_key_conflict')

        const event: ReceivableEventRecord = {
          id: deps.ids.uuid(),
          branchId,
          driverId: body.driverId,
          receivableKind: body.receivableKind,
          channel: body.channel,
          direction,
          amount,
          businessDate,
          reason: body.reason,
          intent: 'correction',
          priorBalance: current,
          targetBalance: body.targetBalance,
          idempotencyKey: body.idempotencyKey,
          journalEntryId: journal.id,
          createdBy: req.actor!.userId,
          createdAtMs: deps.clock.nowMs(),
        }
        await transaction.receivableEvents.create(event)
        return { event, replayed: false }
      },
    )

    return sendReceivableEvent(reply, result.event, result.replayed)
  }
  app.post('/receivables/adjustments', receivableWriteOptions, correctReceivable)
  app.post('/treasury/receivables/adjustments', receivableWriteOptions, correctReceivable)

  /**
   * Recognise an ordinary receivable as a loss without recording a fictitious collection.
   *
   * The receivable is credited and the dedicated loss cost centre is debited. Neither office box
   * participates: the office gave up the money when the debt was first created, and a write-off
   * must not remove it a second time (nor pretend that it came back).
   */
  const writeoffReceivable = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = writeoffReceivableRequest.parse(req.body)
    const branchId = resolveBranch(req)

    const replayMatches = (prior: ReceivableEventRecord): boolean =>
      prior.intent === 'writeoff' &&
      prior.driverId === body.driverId &&
      prior.receivableKind === 'ordinary' &&
      prior.channel === body.channel &&
      prior.direction === 'collect' &&
      prior.amount === body.amount &&
      prior.reason === body.reason

    // Replay the immutable receipt before mutable week/driver checks. A successful write-off does
    // not become un-retryable because the debtor was later disabled or the week was locked.
    const committed = await deps.receivableEvents.findByIdempotencyKey(branchId, body.idempotencyKey)
    if (committed) {
      if (!replayMatches(committed)) throw new ServiceError(409, 'idempotency_key_conflict')
      return sendReceivableEvent(reply, committed, true)
    }

    const driver = await deps.directory.driver(body.driverId)
    if (!driver) throw new ServiceError(404, 'driver_not_found')
    if (driver.branchId !== branchId) throw new ServiceError(422, 'driver_in_another_branch')
    // Inactive drivers can still have bad debt. Unlike creating a receivable, recognising its loss
    // does not hand them any new value, so activity is deliberately not required.

    const businessDate = todayFor(deps)
    await assertWeekOpen(deps, branchId, businessDate)
    const fxDayId = await ensureFxDay(deps, businessDate)

    const result = await deps.financialUnitOfWork.run(
      { lockKey: `receivables:${branchId}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (transaction) => {
        const prior = await transaction.receivableEvents.findByIdempotencyKey(
          branchId,
          body.idempotencyKey,
        )
        if (prior) {
          if (!replayMatches(prior)) throw new ServiceError(409, 'idempotency_key_conflict')
          return { event: prior, replayed: true }
        }

        const receivableCode = `driver_receivable_${body.channel}:${body.driverId}`
        const current = await transaction.ledger.fundBalance(branchId, receivableCode)
        if (current < body.amount) {
          throw new ServiceError(422, 'receivable_writeoff_exceeds_balance', {
            available: serializeMoney(current),
          })
        }

        const posting = receivableWriteoff(
          body.driverId,
          body.channel,
          body.amount,
          body.idempotencyKey,
        )
        const [journal] = await transaction.ledger.post(branchId, [posting], {
          shiftId: null,
          businessDate,
          postingDate: businessDate,
          weekStartDate: weekStartFor(businessDate),
          fxDayId,
          createdBy: req.actor!.userId,
          reason: body.reason,
        })
        if (!journal) throw new ServiceError(409, 'idempotency_key_conflict')

        const event: ReceivableEventRecord = {
          id: deps.ids.uuid(),
          branchId,
          driverId: body.driverId,
          receivableKind: 'ordinary',
          channel: body.channel,
          direction: 'collect',
          amount: body.amount,
          businessDate,
          reason: body.reason,
          intent: 'writeoff',
          priorBalance: current,
          targetBalance: minor(current - body.amount),
          idempotencyKey: body.idempotencyKey,
          journalEntryId: journal.id,
          createdBy: req.actor!.userId,
          createdAtMs: deps.clock.nowMs(),
        }
        await transaction.receivableEvents.create(event)
        return { event, replayed: false }
      },
    )

    return sendReceivableEvent(reply, result.event, result.replayed)
  }
  app.post('/receivables/writeoffs', receivableWriteOptions, writeoffReceivable)
  app.post('/treasury/receivables/writeoffs', receivableWriteOptions, writeoffReceivable)

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
   * Uses the same LINES and the same `kaish` line role الترميم will use, so a hand-made sweep and an
   * automatic
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
        ? manualKaish(office, body.amount, deps.ids.uuid())
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
   * Publish today's effective restoration targets as one audited, branch-serialized command.
   * The effective-dated rows leave prior restorations unchanged; once today is restored the target
   * is frozen and a successor must start on a later business date.
   */
  app.put(
    '/treasury/capital-targets',
    { config: { permission: 'journal.manual.write', subject: targetBranch } },
    async (req) => {
      const capitalTargetText = z.string().trim().regex(/^-?\d+(\.\d{1,2})?$/)
      const body = z.object({
        cashTarget: capitalTargetText,
        walletTarget: capitalTargetText,
        reason: z.string().trim().min(1).max(500),
      }).parse(req.body)
      const branchId = resolveBranch(req)
      const businessDate = todayFor(deps)
      const actorId = req.actor!.userId
      const cashTarget = parseMinor(body.cashTarget)
      const walletTarget = parseMinor(body.walletTarget)

      if (cashTarget < 0n || walletTarget < 0n) {
        throw new ServiceError(422, 'capital_target_negative')
      }
      assertPersistableTreasuryMinor('capitalTargets.office_cash', cashTarget)
      assertPersistableTreasuryMinor('capitalTargets.office_wallet', walletTarget)
      await assertWeekOpen(deps, branchId, businessDate)

      await deps.financialUnitOfWork.run(
        {
          lockKey: `receivables:${branchId}`,
          actorId,
          requestId: req.requestId,
        },
        async (tx: FinancialTransactionDeps) => {
          if ((await tx.restorations.find(branchId, businessDate)) !== null) {
            throw new ServiceError(409, 'capital_target_date_already_restored', { businessDate })
          }
          await tx.capitalTargets.upsert({
            branchId,
            fundCode: 'office_cash',
            target: cashTarget,
            effectiveFrom: businessDate,
            createdBy: actorId,
            note: body.reason,
          })
          await tx.capitalTargets.upsert({
            branchId,
            fundCode: 'office_wallet',
            target: walletTarget,
            effectiveFrom: businessDate,
            createdBy: actorId,
            note: body.reason,
          })
        },
      )

      return {
        businessDate,
        cashTarget: serializeMoney(cashTarget),
        walletTarget: serializeMoney(walletTarget),
      }
    },
  )

  /**
   * Build the positions from the SEALED COUNT before posting, never from the request body.
   *
   * Owner decision (j): «count first, then ترميم». The whole point is that it settles against money
   * somebody physically counted — computing the actionable plan from the ledger would make it a
   * tautology that can never find anything. The live-ledger mode is read-only and used only after
   * the immutable restoration exists, so a reloaded card describes the post-action position.
   */
  async function positionsFor(
    branchId: string,
    businessDate: string,
    source: 'sealed_count' | 'live_ledger' = 'sealed_count',
    readDeps: Pick<Deps, 'cashCounts' | 'capitalTargets' | 'ledger'> = deps,
  ) {
    const [count, targets, ordinaryReceivables, shiftFundingReceivables] = await Promise.all([
      readDeps.cashCounts.find(branchId, businessDate),
      readDeps.capitalTargets.resolve(branchId, businessDate),
      readDeps.ledger.balancesByPrefix(branchId, 'driver_receivable_'),
      readDeps.ledger.balancesByPrefix(branchId, 'driver_shift_funding_'),
    ])
    const sumFor = (suffix: string): Minor => {
      const total = [...Object.entries(ordinaryReceivables), ...Object.entries(shiftFundingReceivables)]
        .filter(([code]) =>
          code.startsWith(`driver_receivable_${suffix}:`) ||
          code.startsWith(`driver_shift_funding_${suffix}:`),
        )
        .reduce((acc, [, value]) => acc + value, 0n)
      assertPersistableTreasuryMinor(`restoration.receivables.${suffix}`, total)
      return minor(total)
    }

    for (const [fundCode, balance] of [
      ...Object.entries(ordinaryReceivables),
      ...Object.entries(shiftFundingReceivables),
    ]) {
      if (balance < 0n) throw new ServiceError(500, 'receivable_balance_integrity_error', { fundCode })
    }

    return {
      count,
      positions: await Promise.all(
        (['office_cash', 'office_wallet'] as const).map(async (fundCode) => {
          const counted = source === 'live_ledger'
            ? await readDeps.ledger.fundBalance(branchId, fundCode)
            : count?.lines.find((line) => line.fundCode === fundCode)?.counted ?? minor(0n)
          const receivables = sumFor(fundCode === 'office_cash' ? 'cash' : 'wallet')
          const capitalTarget = targets[fundCode] ?? null
          assertPersistableTreasuryMinor(`restoration.counted.${fundCode}`, counted)
          if (capitalTarget !== null) {
            assertPersistableTreasuryMinor(`restoration.capitalTarget.${fundCode}`, capitalTarget)
          }
          return { fundCode, counted, receivables, capitalTarget }
        }),
      ),
    }
  }

  const serializeLeg = (l: RestorationPlan['legs'][number]) => ({
    fundCode: l.fundCode,
    counted: serializeMoney(l.counted),
    receivables: serializeMoney(l.receivables),
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
    const completed = await deps.restorations.find(branchId, businessDate)
    // Before execution, only the sealed physical count is authoritative. Afterwards the posting
    // has moved the funds, so a card labelled "current position" must use live ledger balances;
    // `alreadyRestored` still disables a second execution and the stored record remains immutable.
    const { count, positions } = await positionsFor(
      branchId,
      businessDate,
      completed === null ? 'sealed_count' : 'live_ledger',
    )
    const plan = planRestoration(positions)
    assertPersistableRestorationPlan(plan)
    return {
      businessDate,
      counted: count !== null,
      alreadyRestored: completed !== null,
      legs: plan.legs.map(serializeLeg),
      netToCompany: serializeMoney(plan.netToCompany),
      feasible: plan.feasible,
      refusals: plan.refusals,
    }
  })

  app.post('/treasury/restoration', { config: { permission: 'journal.manual.write', subject: targetBranch } }, async (req, reply) => {
    const body = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body)
    const branchId = resolveBranch(req)
    const businessDate = todayFor(deps)
    await assertWeekOpen(deps, branchId, businessDate)
    const actorId = req.actor!.userId
    const fxDayId = await ensureFxDay(deps, businessDate)

    const outcome = await deps.financialUnitOfWork.run(
      {
        // This exact branch lock is shared by shift open/close, direct receivables, and every Pg
        // ledger posting. The sealed-balance check and both journal phases therefore see one
        // serial branch-money history.
        lockKey: `receivables:${branchId}`,
        actorId,
        requestId: req.requestId,
      },
      async (tx: FinancialTransactionDeps) => {
        // This check belongs inside the serialized transaction. Two concurrent managers both pass
        // an outside check; here the waiter observes the winner's immutable record and returns 409.
        if ((await tx.restorations.find(branchId, businessDate)) !== null) {
          throw new ServiceError(409, 'already_restored_today')
        }

        const { count, positions } = await positionsFor(branchId, businessDate, 'sealed_count', tx)
        if (count === null) throw new ServiceError(422, 'cash_count_required')
        if (count.sealedAtMs === null || count.proofSha256 === null || sealProof(count) !== count.proofSha256) {
          throw new ServiceError(422, 'cash_count_proof_invalid')
        }

        const requiredFunds = ['office_cash', 'office_wallet'] as const
        const countLines = new Map(count.lines.map((line) => [line.fundCode, line]))
        const reconciliationLines: Array<{
          fundCode: typeof requiredFunds[number]
          variance: Minor
          resolution: string | null
        }> = []

        for (const fundCode of requiredFunds) {
          const line = countLines.get(fundCode)
          if (!line) throw new ServiceError(422, 'cash_count_incomplete', { fundCode })
          const calculatedVariance = minor(line.counted - line.computed)
          if (calculatedVariance !== line.variance) {
            throw new ServiceError(422, 'cash_count_formula_invalid', { fundCode })
          }
          if (line.variance !== 0n && (!line.resolution || line.resolution.trim() === '')) {
            throw new ServiceError(422, 'cash_count_resolution_required', {
              fundCode,
              variance: serializeMoney(line.variance),
            })
          }

          // Never fold a posting made after the count into the signed variance: that would repair
          // a different number than the manager explained. The manager must recount instead.
          const current = await tx.ledger.fundBalance(branchId, fundCode)
          if (current !== line.computed) {
            throw new ServiceError(409, 'cash_count_stale', {
              fundCode,
              counted: serializeMoney(line.counted),
              computedAtCount: serializeMoney(line.computed),
              current: serializeMoney(current),
            })
          }
          reconciliationLines.push({ fundCode, variance: line.variance, resolution: line.resolution })
        }

        const plan = planRestoration(positions)
        assertPersistableRestorationPlan(plan)
        if (!plan.feasible) {
          throw new ServiceError(422, 'restoration_infeasible', { refusals: plan.refusals })
        }

        const reconciliationPostings = postingsForCashCountReconciliation({
          branchId,
          cashCountId: count.id,
          proofSha256: count.proofSha256,
          lines: reconciliationLines,
        })
        const restorationPostings = postingsForRestoration(plan, businessDate)
        const postings = [...reconciliationPostings, ...restorationPostings]
        assertPersistableTreasuryPostings(postings)
        const entries = postings.length === 0 ? [] : await tx.ledger.post(branchId, postings, {
          shiftId: null,
          businessDate,
          postingDate: businessDate,
          weekStartDate: weekStartFor(businessDate),
          fxDayId,
          createdBy: actorId,
          reason: body.reason,
        })

        // A missing result means an occurrence key already existed without the restoration fact.
        // Never bless an orphan/mismatched journal as this run's evidence.
        if (entries.length !== postings.length) {
          throw new ServiceError(409, 'restoration_journal_conflict')
        }

        const reconciliationKeys = new Set(reconciliationPostings.map((posting) => posting.occurrenceKey))
        const restorationKeys = new Set(restorationPostings.map((posting) => posting.occurrenceKey))
        const serializedLegs = plan.legs.map(serializeLeg)
        try {
          await tx.restorations.create({
            branchId,
            businessDate,
            cashCountId: count.id,
            plan: {
              schemaVersion: 2,
              cashCountProofSha256: count.proofSha256,
              cashCountSealedAt: new Date(count.sealedAtMs).toISOString(),
              countReconciliation: reconciliationLines.map((line) => ({
                fundCode: line.fundCode,
                variance: serializeMoney(line.variance),
                resolution: line.resolution,
              })),
              reconciliationJournalEntryIds: entries
                .filter((entry) => reconciliationKeys.has(entry.occurrenceKey))
                .map((entry) => entry.id),
              restorationJournalEntryIds: entries
                .filter((entry) => restorationKeys.has(entry.occurrenceKey))
                .map((entry) => entry.id),
              legs: serializedLegs,
            },
            netToCompany: plan.netToCompany,
            reason: body.reason,
            performedBy: actorId,
          })
        } catch (err) {
          if ((err as { code?: string }).code === 'DUPLICATE_RESTORATION') {
            throw new ServiceError(409, 'already_restored_today')
          }
          throw err
        }

        return {
          legs: serializedLegs,
          netToCompany: plan.netToCompany,
          restorationPostings: restorationPostings.length,
          reconciliationPostings: reconciliationPostings.length,
        }
      },
    )

    return reply.code(201).send({
      businessDate,
      legs: outcome.legs,
      netToCompany: serializeMoney(outcome.netToCompany),
      postings: outcome.restorationPostings,
      reconciliationPostings: outcome.reconciliationPostings,
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
  const lines = record.lines
    // A tuple encoded by JSON is prefix-safe: delimiters inside a manager's explanation remain a
    // string value and cannot masquerade as another fund line. Money is serialized explicitly
    // because JSON cannot encode bigint and the wire representation is the evidence managers see.
    .map((line): [string, string, string, string, string] => [
      line.fundCode,
      serializeMoney(line.counted),
      serializeMoney(line.computed),
      serializeMoney(line.variance),
      line.resolution ?? '',
    ])
    .sort((left, right) => {
      const a = JSON.stringify(left)
      const b = JSON.stringify(right)
      return a < b ? -1 : a > b ? 1 : 0
    })
  const canonical = JSON.stringify([record.branchId, record.businessDate, record.countedBy, lines])
  return createHash('sha256')
    .update(canonical)
    .digest('hex')
}

function serializeCount(record: CashCountRecord) {
  return {
    id: record.id,
    businessDate: record.businessDate,
    countedBy: record.countedBy,
    countedAt: new Date(record.countedAtMs).toISOString(),
    proofSha256: record.proofSha256,
    status: record.status,
    supersededById: record.supersededById,
    closedAt: record.closedAtMs === null ? null : new Date(record.closedAtMs).toISOString(),
    closedBy: record.closedBy,
    closedReason: record.closedReason,
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
