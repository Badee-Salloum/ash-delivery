import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type {
  CompanyCommandRecord,
  CompanyDebtEventRecord,
  CompanyDebtRecord,
  CompanyExpenseRecord,
  CompanyIncomeRecord,
  CompanyMoveRecord,
  CompanyReversalRecord,
  Deps,
  DepreciationReleaseRecord,
  DepreciationTransferRecord,
  FinancialTransactionDeps,
  FixedAssetRecord,
  JournalEntryRecord,
  AssetInstallmentOccurrenceRecord,
  AssetInstallmentPlanRecord,
} from '@ash/contracts'
import { lockBranchThenCompany, moneySchema, reversalTargetKindOf, serializeMoney } from '@ash/contracts'
import {
  type AssetPaidFrom,
  type CalendarDate,
  type CompanyDebtDirection,
  type CompanyDebtOrigin,
  type CompanyExpenseCentre,
  type CompanyPaidFrom,
  type Currency,
  type Minor,
  addDays,
  assetBookValue,
  assetPurchase,
  can,
  countOccurrencesBetween,
  companyDebtOpen,
  companyDebtOutstanding,
  companyDebtPayment,
  companyDebtWriteoff,
  companyDeposit,
  companyExpense,
  companyFxExchange,
  companyIncome,
  companyOpeningTransfer,
  companyReversal,
  companyWithdrawal,
  depreciationRelease,
  depreciationSchedule,
  depreciationTransfer,
  defaultDueWindow,
  daysBetween,
  dueStatus,
  exchangeRate,
  fundCode,
  fundRefFromCode,
  isCalendarDate,
  minor,
  monthStartFor,
  normalizePartyName,
  occurrencesBetween,
  planDepreciationTransfer,
  recurrenceMatches,
  resolveFxDay,
  weekStartFor,
} from '@ash/domain'
import { grantsFromRows } from './rbac.ts'
import { ServiceError, assertWeekOpen, ensureFxDay, todayFor } from './shifts.service.ts'

const currencySchema = z.enum(['SYP_NEW', 'USD'])
const dateSchema = z.string().refine(isCalendarDate, 'expected a real YYYY-MM-DD date')
const idSchema = z.string().uuid()
const reasonSchema = z.string().trim().min(1).max(500)
const positiveMoney = moneySchema.refine((value) => value > 0n, 'amount must be positive')
const nonNegativeMoney = moneySchema.refine((value) => value >= 0n, 'amount cannot be negative')

function companyCentre(kind: 'general' | 'vehicle' | 'asset', id: string | null): CompanyExpenseCentre {
  if (kind === 'general') {
    if (id !== null) throw new ServiceError(422, 'company_cost_center_mismatch')
    return 'general'
  }
  if (id === null) throw new ServiceError(422, 'company_cost_center_mismatch')
  return kind === 'vehicle' ? `vehicle:${id}` : `asset:${id}`
}

function wireRate(rate: bigint | null): string | null {
  return rate === null ? null : rate.toString()
}

function presentCommand(command: CompanyCommandRecord): Record<string, unknown> {
  switch (command.kind) {
    case 'deposit':
    case 'withdrawal':
      return { ...command, amount: serializeMoney(command.amount), sypMinorPerUsd: wireRate(command.sypMinorPerUsd) }
    case 'expense':
    case 'income':
      return { ...command, amount: serializeMoney(command.amount), sypMinorPerUsd: wireRate(command.sypMinorPerUsd) }
    case 'exchange':
      return {
        ...command,
        fromAmount: serializeMoney(command.fromAmount),
        toAmount: serializeMoney(command.toAmount),
        sypMinorPerUsd: command.sypMinorPerUsd.toString(),
      }
    case 'reversal':
      return { ...command, sypMinorPerUsd: wireRate(command.sypMinorPerUsd) }
  }
}

function commandMatches(existing: CompanyCommandRecord, requested: CompanyCommandRecord): boolean {
  if (
    existing.id !== requested.id || existing.kind !== requested.kind || existing.branchId !== requested.branchId ||
    existing.occurredOn !== requested.occurredOn || existing.businessDate !== requested.businessDate ||
    existing.createdBy !== requested.createdBy
  ) return false
  switch (existing.kind) {
    case 'deposit':
    case 'withdrawal': {
      if (requested.kind !== existing.kind) return false
      return existing.equityAccount === requested.equityAccount && existing.currency === requested.currency &&
        existing.amount === requested.amount && existing.sypMinorPerUsd === requested.sypMinorPerUsd &&
        existing.reason === requested.reason
    }
    case 'expense': {
      if (requested.kind !== 'expense') return false
      return existing.currency === requested.currency && existing.amount === requested.amount &&
        existing.sypMinorPerUsd === requested.sypMinorPerUsd && existing.categoryId === requested.categoryId &&
        existing.costCenterKind === requested.costCenterKind && existing.vehicleId === requested.vehicleId &&
        existing.assetId === requested.assetId && existing.paidFrom === requested.paidFrom &&
        existing.receiptMediaId === requested.receiptMediaId && existing.description === requested.description
    }
    case 'income': {
      if (requested.kind !== 'income') return false
      return existing.currency === requested.currency && existing.amount === requested.amount &&
        existing.sypMinorPerUsd === requested.sypMinorPerUsd && existing.categoryId === requested.categoryId &&
        existing.description === requested.description
    }
    case 'exchange': {
      if (requested.kind !== 'exchange') return false
      return existing.fromCurrency === requested.fromCurrency && existing.fromAmount === requested.fromAmount &&
        existing.toCurrency === requested.toCurrency && existing.toAmount === requested.toAmount &&
        existing.sypMinorPerUsd === requested.sypMinorPerUsd && existing.reason === requested.reason
    }
    case 'reversal': {
      if (requested.kind !== 'reversal') return false
      return existing.targetKind === requested.targetKind && existing.targetId === requested.targetId &&
        existing.targetEntryId === requested.targetEntryId && existing.sypMinorPerUsd === requested.sypMinorPerUsd &&
        existing.reason === requested.reason
    }
  }
}

function debtMatches(existing: CompanyDebtRecord, requested: CompanyDebtRecord): boolean {
  return existing.id === requested.id && existing.branchId === requested.branchId &&
    existing.direction === requested.direction && existing.partyName === requested.partyName &&
    existing.partyKey === requested.partyKey && existing.currency === requested.currency &&
    existing.principal === requested.principal && existing.sypMinorPerUsd === requested.sypMinorPerUsd &&
    existing.openedOn === requested.openedOn && existing.businessDate === requested.businessDate &&
    existing.dueOn === requested.dueOn && existing.note === requested.note && existing.origin === requested.origin &&
    existing.expenseCategoryId === requested.expenseCategoryId && existing.incomeCategoryId === requested.incomeCategoryId &&
    existing.costCenterKind === requested.costCenterKind && existing.vehicleId === requested.vehicleId &&
    existing.assetId === requested.assetId && existing.createdBy === requested.createdBy
}

function eventMatches(existing: CompanyDebtEventRecord, requested: CompanyDebtEventRecord): boolean {
  return existing.id === requested.id && existing.debtId === requested.debtId &&
    existing.branchId === requested.branchId && existing.kind === requested.kind && existing.amount === requested.amount &&
    existing.source === requested.source && existing.sypMinorPerUsd === requested.sypMinorPerUsd &&
    existing.occurredOn === requested.occurredOn && existing.businessDate === requested.businessDate &&
    existing.reason === requested.reason && existing.createdBy === requested.createdBy
}

function presentDebt(debt: CompanyDebtRecord, outstanding: Minor, events?: CompanyDebtEventRecord[]): Record<string, unknown> {
  return {
    ...debt,
    principal: serializeMoney(debt.principal),
    outstanding: serializeMoney(outstanding),
    sypMinorPerUsd: wireRate(debt.sypMinorPerUsd),
    ...(events === undefined ? {} : {
      events: events.map((event) => ({
        ...event,
        amount: serializeMoney(event.amount),
        sypMinorPerUsd: wireRate(event.sypMinorPerUsd),
      })),
    }),
  }
}

function debtFundCode(debt: CompanyDebtRecord): string {
  const head = debt.direction === 'payable' ? 'company_payable' : 'company_receivable'
  return `${head}:${debt.currency}:${debt.id}`
}

function wireInstallmentPlan(plan: AssetInstallmentPlanRecord): Record<string, unknown> {
  return { ...plan, amount: serializeMoney(plan.amount) }
}

function wireInstallmentOccurrence(occurrence: AssetInstallmentOccurrenceRecord): Record<string, unknown> {
  return { ...occurrence }
}

/** A deactivated plan retains earlier dues, but never produces one on/after its deactivation day. */
function installmentSchedule(plan: AssetInstallmentPlanRecord) {
  return {
    kind: plan.scheduleKind,
    startsOn: plan.startsOn,
    endsOn: plan.deactivatedOn === null ? null : addDays(plan.deactivatedOn, -1),
    weekday: plan.weekday,
    intervalDays: plan.intervalDays,
  }
}

function installmentPlanMatches(existing: AssetInstallmentPlanRecord, requested: AssetInstallmentPlanRecord): boolean {
  return existing.id === requested.id && existing.assetId === requested.assetId && existing.debtId === requested.debtId &&
    existing.branchId === requested.branchId && existing.currency === requested.currency && existing.amount === requested.amount &&
    existing.paidFrom === requested.paidFrom && existing.scheduleKind === requested.scheduleKind &&
    existing.weekday === requested.weekday && existing.intervalDays === requested.intervalDays &&
    existing.startsOn === requested.startsOn && existing.createdBy === requested.createdBy
}

function installmentPaymentReason(asset: FixedAssetRecord, dueDate: CalendarDate): string {
  return `Asset installment for ${asset.name} due ${dueDate}`
}

function postingFromEntry(entry: JournalEntryRecord) {
  return {
    eventType: entry.eventType,
    occurrenceKey: entry.occurrenceKey,
    lines: entry.lines.map((line) => ({
      fund: fundRefFromCode(line.fundCode),
      side: line.side,
      amount: line.amount,
      ...(line.role === undefined ? {} : { role: line.role }),
    })),
  }
}

async function assertCompanyPocketBalances(
  tx: Pick<FinancialTransactionDeps, 'ledger'>,
  branchId: string,
  posting: ReturnType<typeof companyDeposit>,
): Promise<void> {
  const deltas = new Map<string, Minor>()
  for (const line of posting.lines) {
    if (line.fund.kind !== 'company_cash' && line.fund.kind !== 'depreciation_reserve') continue
    const code = fundCode(line.fund)
    const signed = line.side === 'D' ? line.amount : minor(-line.amount)
    deltas.set(code, minor((deltas.get(code) ?? 0n) + signed))
  }
  for (const [code, delta] of deltas) {
    if (delta >= 0n) continue
    const held = await tx.ledger.fundBalance(branchId, code)
    if (held + delta < 0n) {
      throw new ServiceError(422, 'insufficient_funds', {
        fundCode: code,
        held: serializeMoney(held),
      })
    }
  }
}

export function registerCompanyRoutes(app: FastifyInstance, deps: Deps): void {
  const permission = { config: { permission: 'company_fund.manage' as const } }

  async function companyBranch() {
    const branch = await deps.directory.companyBranch()
    if (!branch) throw new ServiceError(500, 'company_branch_missing')
    return branch
  }

  async function companyDay(currency: Currency): Promise<{
    companyBranchId: string
    businessDate: CalendarDate
    fxDayId: number
    rate: bigint | null
  }> {
    const branch = await companyBranch()
    const businessDate = todayFor(deps)
    await assertWeekOpen(deps, branch.id, businessDate)
    const fxDayId = await ensureFxDay(deps, businessDate)
    const rate = currency === 'USD' ? resolveFxDay(await deps.fx.list(), businessDate).sypMinorPerUsd : null
    return { companyBranchId: branch.id, businessDate, fxDayId, rate }
  }

  async function postCommand(
    req: FastifyRequest,
    draft: CompanyCommandRecord,
    posting: ReturnType<typeof companyDeposit>,
    fxDayId: number,
    reason: string,
  ): Promise<{ command: CompanyCommandRecord; replayed: boolean }> {
    const prior = await deps.companyLedger.findCommand(draft.id)
    if (prior) {
      if (!commandMatches(prior, draft)) throw new ServiceError(409, 'idempotency_key_conflict')
      return { command: prior, replayed: true }
    }
    return deps.financialUnitOfWork.run(
      { lockKey: `receivables:${draft.branchId}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const concurrent = await tx.companyLedger.findCommand(draft.id)
        if (concurrent) {
          if (!commandMatches(concurrent, draft)) throw new ServiceError(409, 'idempotency_key_conflict')
          return { command: concurrent, replayed: true }
        }
        await assertCompanyPocketBalances(tx, draft.branchId, posting)
        const [entry] = await tx.ledger.post(draft.branchId, [posting], {
          shiftId: null,
          businessDate: draft.businessDate,
          postingDate: draft.businessDate,
          weekStartDate: weekStartFor(draft.businessDate),
          fxDayId,
          sypMinorPerUsd: draft.sypMinorPerUsd,
          createdBy: draft.createdBy,
          reason,
        })
        if (!entry) throw new ServiceError(409, 'idempotency_key_conflict')
        const command = { ...draft, journalEntryId: entry.id }
        await tx.companyLedger.createCommand(command)
        return { command, replayed: false }
      },
    )
  }

  const rangeSchema = z.object({ from: dateSchema.optional(), to: dateSchema.optional() })
  app.get('/company/overview', permission, async (req) => {
    const q = rangeSchema.parse(req.query)
    const branch = await companyBranch()
    const today = todayFor(deps)
    const from = q.from ?? today
    const to = q.to ?? today
    if (from > to) throw new ServiceError(422, 'invalid_date_range')
    const overview = await deps.companyLedgerSource.readOverview(branch.id, { from, to })
    return {
      from,
      to,
      pockets: { SYP_NEW: serializeMoney(overview.pockets.SYP_NEW), USD: serializeMoney(overview.pockets.USD) },
      reserves: { SYP_NEW: serializeMoney(overview.reserves.SYP_NEW), USD: serializeMoney(overview.reserves.USD) },
      branches: overview.branches.map((row) => ({
        ...row,
        companyBox: serializeMoney(row.companyBox),
        clearing: serializeMoney(row.clearing),
        balanced: row.companyBox + row.clearing === 0n,
      })),
      period: Object.fromEntries(Object.entries(overview.period).map(([currency, totals]) => [currency, {
        income: serializeMoney(totals.income),
        expense: serializeMoney(totals.expense),
        deposits: serializeMoney(totals.deposits),
        withdrawals: serializeMoney(totals.withdrawals),
        net: serializeMoney(totals.net),
      }])),
    }
  })

  // Compatibility name used by the existing dashboard. It now reads the HQ SYP pocket; the old
  // per-branch `company_box` total remains visible in `branches` as clearing evidence only.
  app.get('/company-fund', permission, async () => {
    const branch = await companyBranch()
    const today = todayFor(deps)
    const currentMonth = monthStartFor(today)
    const [overview, assets, debts, schedule, sypAllocations, usdAllocations] = await Promise.all([
      deps.companyLedgerSource.readOverview(branch.id, { from: today, to: today }),
      deps.companyFinance.listAssets(branch.id),
      deps.companyFinance.listDebts(branch.id),
      deps.companyFinance.listAssetSchedule(),
      deps.companyFinance.listDepreciationAllocations(branch.id, 'SYP_NEW'),
      deps.companyFinance.listDepreciationAllocations(branch.id, 'USD'),
    ])
    const operating = await deps.directory.listBranches()
    const names = new Map(operating.map((row) => [row.id, row]))
    const debtTotals = async (currency: Currency) => {
      let payable = 0n
      let receivable = 0n
      for (const debt of debts.filter((row) => row.currency === currency)) {
        const outstanding = companyDebtOutstanding(
          debt.direction,
          await deps.ledger.fundBalance(branch.id, debtFundCode(debt)),
        )
        if (debt.direction === 'payable') payable += outstanding
        else receivable += outstanding
      }
      return { payable: serializeMoney(minor(payable)), receivable: serializeMoney(minor(receivable)) }
    }
    const depreciationDue = (currency: Currency): string => {
      const assetIds = new Set(assets.filter((asset) => asset.currency === currency).map((asset) => asset.id))
      const scheduled = schedule.filter((row) => assetIds.has(row.assetId) && row.periodMonth <= currentMonth)
        .reduce((sum, row) => sum + row.amount, 0n)
      const allocations = (currency === 'SYP_NEW' ? sypAllocations : usdAllocations)
        .reduce((sum, row) => sum + row.amount, 0n)
      return serializeMoney(minor(scheduled - allocations))
    }
    const [sypDebts, usdDebts] = await Promise.all([debtTotals('SYP_NEW'), debtTotals('USD')])
    return {
      total: serializeMoney(overview.pockets.SYP_NEW),
      usd: serializeMoney(overview.pockets.USD),
      reserve: {
        SYP_NEW: serializeMoney(overview.reserves.SYP_NEW),
        USD: serializeMoney(overview.reserves.USD),
      },
      depreciationDue: { SYP_NEW: depreciationDue('SYP_NEW'), USD: depreciationDue('USD') },
      debts: { SYP_NEW: sypDebts, USD: usdDebts },
      assets: {
        SYP_NEW: serializeMoney(minor(assets.filter((asset) => asset.currency === 'SYP_NEW')
          .reduce((sum, asset) => sum + assetBookValue(asset.price, asset.purchasedOn, today), 0n))),
        USD: serializeMoney(minor(assets.filter((asset) => asset.currency === 'USD')
          .reduce((sum, asset) => sum + assetBookValue(asset.price, asset.purchasedOn, today), 0n))),
      },
      branches: overview.branches.map((row) => ({
        branchId: row.branchId,
        code: names.get(row.branchId)?.code ?? row.branchId,
        nameAr: names.get(row.branchId)?.nameAr ?? row.branchId,
        balance: serializeMoney(row.companyBox),
        clearing: serializeMoney(row.clearing),
        cutOver: row.cutOver,
      })),
    }
  })

  app.get('/company/movements', permission, async (req) => {
    const q = rangeSchema.parse(req.query)
    const branch = await companyBranch()
    const today = todayFor(deps)
    const from = q.from ?? today
    const to = q.to ?? today
    if (from > to) throw new ServiceError(422, 'invalid_date_range')
    const [movements, commands] = await Promise.all([
      deps.companyLedgerSource.listMovements(branch.id, { from, to }),
      deps.companyLedger.listCommands(branch.id, { from, to }),
    ])
    const byEntry = new Map(commands.map((command) => [command.journalEntryId, command]))
    return {
      from,
      to,
      movements: movements.map((movement) => ({
        entry: {
          ...movement.entry,
          sypMinorPerUsd: wireRate(movement.entry.sypMinorPerUsd),
          lines: movement.entry.lines.map((line) => ({ ...line, amount: serializeMoney(line.amount) })),
        },
        command: byEntry.has(movement.entry.id) ? presentCommand(byEntry.get(movement.entry.id)!) : null,
        pocketAfter: Object.fromEntries(Object.entries(movement.pocketAfter).map(([currency, value]) => [
          currency, serializeMoney(value!),
        ])),
      })),
    }
  })

  const moveSchema = z.object({
    idempotencyKey: idSchema,
    currency: currencySchema.default('SYP_NEW'),
    amount: positiveMoney,
    occurredOn: dateSchema.optional(),
    reason: reasonSchema,
    account: z.enum(['owner_funding', 'opening']).default('owner_funding'),
  })

  async function move(req: FastifyRequest, reply: FastifyReply, kind: 'deposit' | 'withdrawal') {
    const body = moveSchema.parse(req.body)
    const day = await companyDay(body.currency)
    const occurredOn = body.occurredOn ?? day.businessDate
    if (occurredOn > day.businessDate) throw new ServiceError(422, 'future_company_event')
    const draft: CompanyMoveRecord = {
      id: body.idempotencyKey,
      branchId: day.companyBranchId,
      kind,
      equityAccount: kind === 'deposit' ? body.account : 'owner_drawings',
      currency: body.currency,
      amount: body.amount,
      sypMinorPerUsd: day.rate,
      occurredOn,
      businessDate: day.businessDate,
      reason: body.reason,
      journalEntryId: 0,
      createdBy: req.actor!.userId,
      createdAtMs: deps.clock.nowMs(),
    }
    const posting = kind === 'deposit'
      ? companyDeposit(body.currency, body.amount, body.account, body.idempotencyKey)
      : companyWithdrawal(body.currency, body.amount, body.idempotencyKey)
    const outcome = await postCommand(req, draft, posting, day.fxDayId, body.reason)
    return reply.code(outcome.replayed ? 200 : 201).send({
      command: presentCommand(outcome.command),
      replayed: outcome.replayed,
      balance: serializeMoney(await deps.ledger.fundBalance(day.companyBranchId, `company_cash:${body.currency}`)),
    })
  }

  app.post('/company/deposits', permission, (req, reply) => move(req, reply, 'deposit'))
  app.post('/company/withdrawals', permission, (req, reply) => move(req, reply, 'withdrawal'))
  app.post('/company-fund/deposit', permission, (req, reply) => move(req, reply, 'deposit'))
  app.post('/company-fund/withdraw', permission, (req, reply) => move(req, reply, 'withdrawal'))

  const expenseSchema = z.object({
    idempotencyKey: idSchema,
    currency: currencySchema,
    amount: positiveMoney,
    categoryId: idSchema,
    costCenterKind: z.enum(['general', 'vehicle', 'asset']).default('general'),
    vehicleId: idSchema.nullable().default(null),
    assetId: idSchema.nullable().default(null),
    paidFrom: z.enum(['pocket', 'reserve', 'owner_outside']).default('pocket'),
    receiptMediaId: idSchema.nullable().default(null),
    occurredOn: dateSchema.optional(),
    description: reasonSchema,
  })

  app.post('/company/expenses', permission, async (req, reply) => {
    const body = expenseSchema.parse(req.body)
    const day = await companyDay(body.currency)
    const occurredOn = body.occurredOn ?? day.businessDate
    if (occurredOn > day.businessDate) throw new ServiceError(422, 'future_company_event')
    const centreId = body.costCenterKind === 'vehicle' ? body.vehicleId : body.costCenterKind === 'asset' ? body.assetId : null
    const centre = companyCentre(body.costCenterKind, centreId)
    if (body.costCenterKind !== 'vehicle' && body.vehicleId !== null) throw new ServiceError(422, 'company_cost_center_mismatch')
    if (body.costCenterKind !== 'asset' && body.assetId !== null) throw new ServiceError(422, 'company_cost_center_mismatch')
    const category = (await deps.expenses.listCategories()).find((row) => row.id === body.categoryId && row.active)
    if (!category) throw new ServiceError(422, 'unknown_expense_category')
    if (body.vehicleId !== null && !(await deps.directory.vehicle(body.vehicleId))) throw new ServiceError(404, 'vehicle_not_found')
    if (body.assetId !== null && !(await deps.companyFinance.getAsset(body.assetId))) throw new ServiceError(404, 'asset_not_found')
    if (body.receiptMediaId !== null && !(await deps.media.findById(body.receiptMediaId))) {
      throw new ServiceError(422, 'receipt_media_invalid')
    }
    const draft: CompanyExpenseRecord = {
      id: body.idempotencyKey,
      branchId: day.companyBranchId,
      kind: 'expense',
      currency: body.currency,
      amount: body.amount,
      sypMinorPerUsd: day.rate,
      categoryId: body.categoryId,
      costCenterKind: body.costCenterKind,
      vehicleId: body.vehicleId,
      assetId: body.assetId,
      paidFrom: body.paidFrom,
      receiptMediaId: body.receiptMediaId,
      description: body.description,
      occurredOn,
      businessDate: day.businessDate,
      journalEntryId: 0,
      createdBy: req.actor!.userId,
      createdAtMs: deps.clock.nowMs(),
    }
    const outcome = await postCommand(
      req,
      draft,
      companyExpense(body.currency, body.amount, centre, body.paidFrom, body.idempotencyKey),
      day.fxDayId,
      body.description,
    )
    return reply.code(outcome.replayed ? 200 : 201).send({ command: presentCommand(outcome.command), replayed: outcome.replayed })
  })

  const incomeSchema = z.object({
    idempotencyKey: idSchema,
    currency: currencySchema,
    amount: positiveMoney,
    categoryId: idSchema,
    occurredOn: dateSchema.optional(),
    description: reasonSchema,
  })

  app.post('/company/incomes', permission, async (req, reply) => {
    const body = incomeSchema.parse(req.body)
    const day = await companyDay(body.currency)
    const occurredOn = body.occurredOn ?? day.businessDate
    if (occurredOn > day.businessDate) throw new ServiceError(422, 'future_company_event')
    const category = (await deps.incomes.listCategories()).find((row) => row.id === body.categoryId && row.active)
    if (!category) throw new ServiceError(422, 'unknown_income_category')
    const draft: CompanyIncomeRecord = {
      id: body.idempotencyKey,
      branchId: day.companyBranchId,
      kind: 'income',
      currency: body.currency,
      amount: body.amount,
      sypMinorPerUsd: day.rate,
      categoryId: body.categoryId,
      description: body.description,
      occurredOn,
      businessDate: day.businessDate,
      journalEntryId: 0,
      createdBy: req.actor!.userId,
      createdAtMs: deps.clock.nowMs(),
    }
    const outcome = await postCommand(
      req, draft, companyIncome(body.currency, body.amount, body.idempotencyKey), day.fxDayId, body.description,
    )
    return reply.code(outcome.replayed ? 200 : 201).send({ command: presentCommand(outcome.command), replayed: outcome.replayed })
  })

  const exchangeSchema = z.object({
    idempotencyKey: idSchema,
    fromCurrency: currencySchema,
    fromAmount: positiveMoney,
    toCurrency: currencySchema,
    toAmount: positiveMoney,
    occurredOn: dateSchema.optional(),
    reason: reasonSchema,
  })

  app.post('/company/exchanges', permission, async (req, reply) => {
    const body = exchangeSchema.parse(req.body)
    if (body.fromCurrency === body.toCurrency) throw new ServiceError(422, 'exchange_currency_must_differ')
    const day = await companyDay('USD')
    const occurredOn = body.occurredOn ?? day.businessDate
    if (occurredOn > day.businessDate) throw new ServiceError(422, 'future_company_event')
    const from = { currency: body.fromCurrency, amount: body.fromAmount }
    const to = { currency: body.toCurrency, amount: body.toAmount }
    const rate = exchangeRate(from, to)
    const draft: CompanyCommandRecord = {
      id: body.idempotencyKey,
      branchId: day.companyBranchId,
      kind: 'exchange',
      fromCurrency: body.fromCurrency,
      fromAmount: body.fromAmount,
      toCurrency: body.toCurrency,
      toAmount: body.toAmount,
      sypMinorPerUsd: rate,
      reason: body.reason,
      occurredOn,
      businessDate: day.businessDate,
      journalEntryId: 0,
      createdBy: req.actor!.userId,
      createdAtMs: deps.clock.nowMs(),
    }
    const outcome = await postCommand(req, draft, companyFxExchange(from, to, body.idempotencyKey), day.fxDayId, body.reason)
    return reply.code(outcome.replayed ? 200 : 201).send({ command: presentCommand(outcome.command), replayed: outcome.replayed })
  })

  const reversalSchema = z.object({
    idempotencyKey: idSchema,
    targetId: idSchema,
    occurredOn: dateSchema.optional(),
    reason: reasonSchema,
  })

  app.post('/company/reversals', permission, async (req, reply) => {
    const body = reversalSchema.parse(req.body)
    const target = await deps.companyLedger.findCommand(body.targetId)
    if (!target) throw new ServiceError(404, 'company_command_not_found')
    const targetKind = reversalTargetKindOf(target)
    if (targetKind === null) throw new ServiceError(422, 'company_command_not_reversible')
    const alreadyReversed = await deps.companyLedger.findReversalOf(target.journalEntryId)
    if (alreadyReversed && alreadyReversed.id !== body.idempotencyKey) {
      throw new ServiceError(409, 'company_command_already_reversed', { reversalId: alreadyReversed.id })
    }
    const event = target.kind === 'deposit' ? 'company_deposit'
      : target.kind === 'withdrawal' ? 'company_withdrawal'
        : target.kind === 'expense' ? 'company_expense'
          : target.kind === 'income' ? 'company_income'
            : 'company_fx_exchange'
    const entry = await deps.ledger.findStandaloneEntry(target.branchId, event, target.id)
    if (!entry || entry.id !== target.journalEntryId) throw new ServiceError(500, 'company_command_integrity_error')
    const currency: Currency = target.kind === 'exchange'
      ? 'USD'
      : target.kind === 'reversal' ? 'SYP_NEW' : target.currency
    const day = await companyDay(currency)
    const occurredOn = body.occurredOn ?? day.businessDate
    if (occurredOn > day.businessDate) throw new ServiceError(422, 'future_company_event')
    const posting = companyReversal(postingFromEntry(entry), body.idempotencyKey)
    const draft: CompanyReversalRecord = {
      id: body.idempotencyKey,
      branchId: day.companyBranchId,
      kind: 'reversal',
      targetKind,
      targetId: target.id,
      targetEntryId: target.journalEntryId,
      sypMinorPerUsd: entry.sypMinorPerUsd,
      reason: body.reason,
      occurredOn,
      businessDate: day.businessDate,
      journalEntryId: 0,
      createdBy: req.actor!.userId,
      createdAtMs: deps.clock.nowMs(),
    }
    const outcome = await postCommand(req, draft, posting, day.fxDayId, body.reason)
    return reply.code(outcome.replayed ? 200 : 201).send({ command: presentCommand(outcome.command), replayed: outcome.replayed })
  })

  const cutoverSchema = z.object({
    // Test doubles and historical imports use opaque branch ids; PostgreSQL still enforces UUID.
    branchId: z.string().trim().min(1).max(64),
    expectedOpening: nonNegativeMoney,
    reason: reasonSchema,
  })

  app.post('/company/cutover', permission, async (req, reply) => {
    const body = cutoverSchema.parse(req.body)
    const grants = grantsFromRows(await deps.directory.grants())
    if (!can(req.actor!, 'settings.write', {}, grants).allowed) {
      throw new ServiceError(403, 'forbidden', { permission: 'settings.write' })
    }
    const branch = await deps.directory.branch(body.branchId)
    if (!branch || branch.kind !== 'branch') throw new ServiceError(404, 'branch_not_found')
    const company = await companyBranch()
    const businessDate = todayFor(deps)
    await Promise.all([
      assertWeekOpen(deps, branch.id, businessDate),
      assertWeekOpen(deps, company.id, businessDate),
    ])
    const fxDayId = await ensureFxDay(deps, businessDate)
    const existing = await deps.companyLedger.cutoverFor(branch.id)
    if (existing) {
      if (existing.openingAmount !== body.expectedOpening || existing.reason !== body.reason || existing.performedBy !== req.actor!.userId) {
        throw new ServiceError(409, 'branch_already_cut_over')
      }
      return reply.code(200).send({
        ...existing,
        openingAmount: serializeMoney(existing.openingAmount),
        replayed: true,
      })
    }
    const cutover = await deps.financialUnitOfWork.run(
      { lockKey: `receivables:${branch.id}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        await lockBranchThenCompany(tx, branch.id, company.id)
        const concurrent = await tx.companyLedger.cutoverFor(branch.id)
        if (concurrent) return concurrent
        const opening = await tx.ledger.fundBalance(branch.id, 'company_box')
        if (opening !== body.expectedOpening) {
          throw new ServiceError(409, 'company_cutover_balance_changed', {
            expected: serializeMoney(body.expectedOpening),
            actual: serializeMoney(opening),
          })
        }
        const watermarkEntryId = await tx.companyLedger.latestEntryId()
        let openingEntryId: number | null = null
        if (opening > 0n) {
          const [entry] = await tx.ledger.post(company.id, [companyOpeningTransfer(branch.id, opening)], {
            shiftId: null,
            businessDate,
            postingDate: businessDate,
            weekStartDate: weekStartFor(businessDate),
            fxDayId,
            sypMinorPerUsd: null,
            createdBy: req.actor!.userId,
            reason: body.reason,
          })
          if (!entry) throw new ServiceError(409, 'company_cutover_conflict')
          openingEntryId = entry.id
        }
        const row = {
          branchId: branch.id,
          companyBranchId: company.id,
          openingAmount: opening,
          openingEntryId,
          watermarkEntryId,
          businessDate,
          reason: body.reason,
          performedBy: req.actor!.userId,
          performedAtMs: deps.clock.nowMs(),
        }
        await tx.companyLedger.createCutover(row)
        return row
      },
    )
    return reply.code(201).send({ ...cutover, openingAmount: serializeMoney(cutover.openingAmount), replayed: false })
  })

  const debtOpenSchema = z.object({
    idempotencyKey: idSchema,
    direction: z.enum(['payable', 'receivable']),
    partyName: z.string().trim().min(1).max(120),
    currency: currencySchema,
    principal: positiveMoney,
    openedOn: dateSchema,
    dueOn: dateSchema.nullable().default(null),
    note: z.string().trim().min(1).max(500).nullable().default(null),
    origin: z.enum(['cash', 'expense', 'income', 'opening']),
    expenseCategoryId: idSchema.nullable().default(null),
    incomeCategoryId: idSchema.nullable().default(null),
    costCenterKind: z.enum(['general', 'vehicle']).nullable().default(null),
    vehicleId: idSchema.nullable().default(null),
  })

  app.get('/company/debts', permission, async () => {
    const company = await companyBranch()
    const rows = await deps.companyFinance.listDebts(company.id)
    return {
      debts: await Promise.all(rows.map(async (debt) => presentDebt(
        debt,
        companyDebtOutstanding(debt.direction, await deps.ledger.fundBalance(company.id, debtFundCode(debt))),
      ))),
    }
  })

  app.get('/company/debts/:id', permission, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params)
    const debt = await deps.companyFinance.getDebt(id)
    if (!debt) throw new ServiceError(404, 'company_debt_not_found')
    const [balance, events] = await Promise.all([
      deps.ledger.fundBalance(debt.branchId, debtFundCode(debt)),
      deps.companyFinance.listDebtEvents(debt.id),
    ])
    return presentDebt(debt, companyDebtOutstanding(debt.direction, balance), events)
  })

  app.post('/company/debts', permission, async (req, reply) => {
    const body = debtOpenSchema.parse(req.body)
    const day = await companyDay(body.currency)
    if (body.openedOn > day.businessDate || (body.dueOn !== null && body.dueOn < body.openedOn)) {
      throw new ServiceError(422, 'invalid_company_debt_dates')
    }
    if (body.origin === 'expense') {
      if (body.direction !== 'payable' || body.expenseCategoryId === null || body.costCenterKind === null) {
        throw new ServiceError(422, 'company_debt_origin_mismatch')
      }
      if (!(await deps.expenses.listCategories()).some((row) => row.id === body.expenseCategoryId && row.active)) {
        throw new ServiceError(422, 'unknown_expense_category')
      }
    } else if (body.expenseCategoryId !== null || body.costCenterKind !== null || body.vehicleId !== null) {
      throw new ServiceError(422, 'company_debt_origin_mismatch')
    }
    if (body.origin === 'income') {
      if (body.direction !== 'receivable' || body.incomeCategoryId === null) {
        throw new ServiceError(422, 'company_debt_origin_mismatch')
      }
      if (!(await deps.incomes.listCategories()).some((row) => row.id === body.incomeCategoryId && row.active)) {
        throw new ServiceError(422, 'unknown_income_category')
      }
    } else if (body.incomeCategoryId !== null) {
      throw new ServiceError(422, 'company_debt_origin_mismatch')
    }
    if ((body.costCenterKind === 'vehicle') !== (body.vehicleId !== null)) {
      throw new ServiceError(422, 'company_cost_center_mismatch')
    }
    if (body.vehicleId !== null && !(await deps.directory.vehicle(body.vehicleId))) throw new ServiceError(404, 'vehicle_not_found')
    const centre = body.costCenterKind === 'vehicle' && body.vehicleId !== null ? `vehicle:${body.vehicleId}` as const : 'general'
    const draft: CompanyDebtRecord = {
      id: body.idempotencyKey,
      branchId: day.companyBranchId,
      direction: body.direction,
      partyName: body.partyName,
      partyKey: normalizePartyName(body.partyName),
      currency: body.currency,
      principal: body.principal,
      sypMinorPerUsd: day.rate,
      openedOn: body.openedOn,
      businessDate: day.businessDate,
      dueOn: body.dueOn,
      note: body.note,
      origin: body.origin,
      expenseCategoryId: body.expenseCategoryId,
      incomeCategoryId: body.incomeCategoryId,
      costCenterKind: body.costCenterKind,
      vehicleId: body.vehicleId,
      assetId: null,
      journalEntryId: 0,
      createdBy: req.actor!.userId,
      createdAtMs: deps.clock.nowMs(),
    }
    const prior = await deps.companyFinance.getDebt(draft.id)
    if (prior) {
      if (!debtMatches(prior, draft)) throw new ServiceError(409, 'idempotency_key_conflict')
      const balance = await deps.ledger.fundBalance(prior.branchId, debtFundCode(prior))
      return reply.code(200).send({ debt: presentDebt(prior, companyDebtOutstanding(prior.direction, balance)), replayed: true })
    }
    const posting = companyDebtOpen({
      debtId: draft.id,
      direction: draft.direction,
      currency: draft.currency,
      principal: draft.principal,
      origin: draft.origin,
      occurrenceKey: draft.id,
      expenseCentre: centre,
    })
    const result = await deps.financialUnitOfWork.run(
      { lockKey: `receivables:${draft.branchId}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const concurrent = await tx.companyFinance.getDebt(draft.id)
        if (concurrent) {
          if (!debtMatches(concurrent, draft)) throw new ServiceError(409, 'idempotency_key_conflict')
          return { debt: concurrent, replayed: true }
        }
        const [entry] = await tx.ledger.post(draft.branchId, [posting], {
          shiftId: null,
          businessDate: draft.businessDate,
          postingDate: draft.businessDate,
          weekStartDate: weekStartFor(draft.businessDate),
          fxDayId: day.fxDayId,
          sypMinorPerUsd: draft.sypMinorPerUsd,
          createdBy: draft.createdBy,
          reason: draft.note ?? draft.partyName,
        })
        if (!entry) throw new ServiceError(409, 'idempotency_key_conflict')
        const debt = { ...draft, journalEntryId: entry.id }
        await tx.companyFinance.createDebt(debt)
        return { debt, replayed: false }
      },
    )
    return reply.code(result.replayed ? 200 : 201).send({
      debt: presentDebt(result.debt, result.debt.principal),
      replayed: result.replayed,
    })
  })

  const debtEventSchema = z.object({
    idempotencyKey: idSchema,
    amount: positiveMoney,
    source: z.enum(['pocket', 'reserve', 'owner_outside']).optional(),
    occurredOn: dateSchema.optional(),
    reason: reasonSchema,
  })

  async function debtEvent(
    req: FastifyRequest,
    reply: FastifyReply,
    kind: 'payment' | 'writeoff',
  ) {
    const { id: debtId } = z.object({ id: idSchema }).parse(req.params)
    const body = debtEventSchema.parse(req.body)
    const debt = await deps.companyFinance.getDebt(debtId)
    if (!debt) throw new ServiceError(404, 'company_debt_not_found')
    if (kind === 'payment' && debt.direction === 'payable' && body.source === undefined) {
      throw new ServiceError(422, 'company_debt_source_required')
    }
    if ((kind === 'writeoff' || debt.direction === 'receivable') && body.source !== undefined) {
      throw new ServiceError(422, 'company_debt_source_not_allowed')
    }
    const day = await companyDay(debt.currency)
    const occurredOn = body.occurredOn ?? day.businessDate
    if (occurredOn > day.businessDate) throw new ServiceError(422, 'future_company_event')
    const draft: CompanyDebtEventRecord = {
      id: body.idempotencyKey,
      debtId: debt.id,
      branchId: debt.branchId,
      kind,
      amount: body.amount,
      source: kind === 'payment' && debt.direction === 'payable' ? body.source! : null,
      sypMinorPerUsd: day.rate,
      occurredOn,
      businessDate: day.businessDate,
      reason: body.reason,
      journalEntryId: 0,
      createdBy: req.actor!.userId,
      createdAtMs: deps.clock.nowMs(),
    }
    const prior = await deps.companyFinance.getDebtEvent(draft.id)
    if (prior) {
      if (!eventMatches(prior, draft)) throw new ServiceError(409, 'idempotency_key_conflict')
      const balance = await deps.ledger.fundBalance(debt.branchId, debtFundCode(debt))
      return reply.code(200).send({
        event: { ...prior, amount: serializeMoney(prior.amount), sypMinorPerUsd: wireRate(prior.sypMinorPerUsd) },
        outstanding: serializeMoney(companyDebtOutstanding(debt.direction, balance)),
        replayed: true,
      })
    }
    const result = await deps.financialUnitOfWork.run(
      { lockKey: `receivables:${debt.branchId}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const concurrent = await tx.companyFinance.getDebtEvent(draft.id)
        if (concurrent) {
          if (!eventMatches(concurrent, draft)) throw new ServiceError(409, 'idempotency_key_conflict')
          const balance = await tx.ledger.fundBalance(debt.branchId, debtFundCode(debt))
          return { event: concurrent, outstanding: companyDebtOutstanding(debt.direction, balance), replayed: true }
        }
        const balance = await tx.ledger.fundBalance(debt.branchId, debtFundCode(debt))
        const outstanding = companyDebtOutstanding(debt.direction, balance)
        let posting
        try {
          posting = kind === 'payment'
            ? companyDebtPayment(debt.direction === 'payable'
              ? {
                  debtId: debt.id,
                  direction: 'payable',
                  currency: debt.currency,
                  amount: body.amount,
                  outstanding,
                  paidFrom: body.source!,
                  occurrenceKey: body.idempotencyKey,
                }
              : {
                  debtId: debt.id,
                  direction: 'receivable',
                  currency: debt.currency,
                  amount: body.amount,
                  outstanding,
                  occurrenceKey: body.idempotencyKey,
                })
            : companyDebtWriteoff({
                debtId: debt.id,
                direction: debt.direction,
                currency: debt.currency,
                amount: body.amount,
                outstanding,
                occurrenceKey: body.idempotencyKey,
              })
        } catch (error) {
          if (error instanceof RangeError) throw new ServiceError(422, 'company_debt_overpayment')
          throw error
        }
        await assertCompanyPocketBalances(tx, debt.branchId, posting)
        const [entry] = await tx.ledger.post(debt.branchId, [posting], {
          shiftId: null,
          businessDate: draft.businessDate,
          postingDate: draft.businessDate,
          weekStartDate: weekStartFor(draft.businessDate),
          fxDayId: day.fxDayId,
          sypMinorPerUsd: draft.sypMinorPerUsd,
          createdBy: draft.createdBy,
          reason: draft.reason,
        })
        if (!entry) throw new ServiceError(409, 'idempotency_key_conflict')
        const event = { ...draft, journalEntryId: entry.id }
        await tx.companyFinance.createDebtEvent(event)
        return { event, outstanding: minor(outstanding - body.amount), replayed: false }
      },
    )
    return reply.code(result.replayed ? 200 : 201).send({
      event: { ...result.event, amount: serializeMoney(result.event.amount), sypMinorPerUsd: wireRate(result.event.sypMinorPerUsd) },
      outstanding: serializeMoney(result.outstanding),
      replayed: result.replayed,
    })
  }

  app.post('/company/debts/:id/payments', permission, (req, reply) => debtEvent(req, reply, 'payment'))
  app.post('/company/debts/:id/writeoffs', permission, (req, reply) => debtEvent(req, reply, 'writeoff'))

  const installmentPlanFields = z.object({
    amount: positiveMoney,
    paidFrom: z.enum(['pocket', 'reserve', 'owner_outside']).default('pocket'),
    scheduleKind: z.enum(['weekly', 'monthly_first', 'every_n_days']),
    weekday: z.number().int().min(0).max(6).nullable().default(null),
    intervalDays: z.number().int().min(1).max(366).nullable().default(null),
    startsOn: dateSchema,
  }).superRefine((body, context) => {
    const matches =
      (body.scheduleKind === 'weekly' && body.weekday !== null && body.intervalDays === null) ||
      (body.scheduleKind === 'monthly_first' && body.weekday === null && body.intervalDays === null) ||
      (body.scheduleKind === 'every_n_days' && body.weekday === null && body.intervalDays !== null)
    if (!matches) context.addIssue({ code: 'custom', message: 'installment schedule fields do not match kind' })
  })
  const installmentPlanCreateSchema = z.object({ idempotencyKey: idSchema }).and(installmentPlanFields)
  const installmentPlanParamsSchema = z.object({ assetId: idSchema, planId: idSchema })
  const installmentOccurrenceParamsSchema = installmentPlanParamsSchema.extend({ dueDate: z.string() })

  type InstallmentPlanTerms = z.infer<typeof installmentPlanFields>

  const planDraft = (
    id: string,
    terms: InstallmentPlanTerms,
    asset: FixedAssetRecord,
    debt: CompanyDebtRecord,
    actorId: string,
    now: number,
  ): AssetInstallmentPlanRecord => ({
    id,
    assetId: asset.id,
    debtId: debt.id,
    branchId: asset.branchId,
    currency: asset.currency,
    amount: terms.amount,
    paidFrom: terms.paidFrom,
    scheduleKind: terms.scheduleKind,
    weekday: terms.weekday,
    intervalDays: terms.intervalDays,
    startsOn: terms.startsOn,
    active: true,
    deactivatedOn: null,
    deactivatedAtMs: null,
    deactivatedBy: null,
    deactivationReason: null,
    createdBy: actorId,
    createdAtMs: now,
  })

  async function financedAsset(assetId: string, companyBranchId: string): Promise<{
    asset: FixedAssetRecord
    debt: CompanyDebtRecord
  }> {
    const asset = await deps.companyFinance.getAsset(assetId)
    if (!asset || asset.branchId !== companyBranchId) throw new ServiceError(404, 'asset_not_found')
    if (asset.debtId === null) throw new ServiceError(422, 'asset_installment_requires_financed_asset')
    const debt = await deps.companyFinance.getDebt(asset.debtId)
    if (
      debt === null || debt.branchId !== asset.branchId || debt.id !== asset.debtId || debt.assetId !== asset.id ||
      debt.direction !== 'payable' || debt.origin !== 'asset_purchase' || debt.currency !== asset.currency
    ) throw new ServiceError(409, 'asset_installment_debt_mismatch')
    return { asset, debt }
  }

  function assertInstallmentStartsAfterPurchase(terms: InstallmentPlanTerms, asset: FixedAssetRecord): void {
    if (terms.startsOn < asset.purchasedOn) throw new ServiceError(422, 'asset_installment_starts_before_purchase')
  }

  /**
   * A deactivated plan remains usable for a due that it generated before its deactivation date:
   * those historical obligations must be paid or explicitly skipped rather than silently erased.
   * It must never, however, accept a due introduced after a replacement/deactivation won the lock.
   */
  function assertInstallmentOccurrenceDate(plan: AssetInstallmentPlanRecord, dueDate: CalendarDate): void {
    if (recurrenceMatches(installmentSchedule(plan), dueDate)) return
    if (!plan.active && plan.deactivatedOn !== null && dueDate >= plan.deactivatedOn) {
      throw new ServiceError(409, 'asset_installment_plan_inactive')
    }
    throw new ServiceError(422, 'asset_installment_invalid_due_date')
  }

  function matchesInstallmentPayment(
    occurrence: AssetInstallmentOccurrenceRecord,
    event: CompanyDebtEventRecord | null,
    debt: CompanyDebtRecord,
    idempotencyKey: string,
    source: 'pocket' | 'reserve' | 'owner_outside',
    occurredOn: CalendarDate,
    reason: string,
    actorId: string,
  ): boolean {
    return occurrence.status === 'paid' && occurrence.debtEventId === idempotencyKey && event !== null &&
      event.id === idempotencyKey && event.debtId === debt.id && event.kind === 'payment' && event.source === source &&
      event.occurredOn === occurredOn && event.reason === reason && event.createdBy === actorId
  }

  // Static routes stay before `/company/assets/:id`, otherwise Fastify would read
  // `installment-plans` as an asset UUID in some routers.
  app.get('/company/assets/installment-plans/due', permission, async (req) => {
    const query = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query)
    const today = todayFor(deps)
    const defaults = defaultDueWindow(today)
    const from = (query.from ?? defaults.from) as CalendarDate
    const to = (query.to ?? defaults.to) as CalendarDate
    if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) throw new ServiceError(422, 'invalid_date_range')
    if (daysBetween(from, to) + 1 > 366) {
      throw new ServiceError(422, 'range_too_large', { maxDays: 366 })
    }
    const company = await companyBranch()
    const [plans, resolved, assets] = await Promise.all([
      deps.companyFinance.listInstallmentPlans(company.id, true),
      deps.companyFinance.listAssetInstallmentOccurrences(company.id, from, to),
      deps.companyFinance.listAssets(company.id),
    ])
    const resolvedKeys = new Set(resolved.map((row) => `${row.planId}|${row.dueDate}`))
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
    const due: Array<Record<string, unknown>> = []
    let olderUnresolved = 0
    for (const plan of plans) {
      const [debt, asset] = await Promise.all([
        deps.companyFinance.getDebt(plan.debtId),
        Promise.resolve(assetsById.get(plan.assetId) ?? null),
      ])
      if (debt === null || asset === null) continue
      const outstanding = companyDebtOutstanding(debt.direction, await deps.ledger.fundBalance(company.id, debtFundCode(debt)))
      if (outstanding <= 0n) continue
      const schedule = installmentSchedule(plan)
      for (const dueDate of occurrencesBetween(schedule, from, to)) {
        if (!resolvedKeys.has(`${plan.id}|${dueDate}`)) {
          due.push({
            ...wireInstallmentPlan(plan),
            assetName: asset.name,
            dueDate,
            status: dueStatus(dueDate, today),
            amountDue: serializeMoney(minor(plan.amount < outstanding ? plan.amount : outstanding)),
          })
        }
      }
      const before = addDays(from, -1)
      if (schedule.startsOn <= before && (schedule.endsOn === null || schedule.endsOn >= schedule.startsOn)) {
        const effectiveBefore = schedule.endsOn !== null && schedule.endsOn < before ? schedule.endsOn : before
        const generated = effectiveBefore < schedule.startsOn ? 0 : countOccurrencesBetween(schedule, schedule.startsOn, effectiveBefore)
        const acted = await deps.companyFinance.countAssetInstallmentOccurrencesBefore(plan.id, from)
        olderUnresolved += Math.max(0, generated - acted)
      }
    }
    due.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)) || String(a.assetName).localeCompare(String(b.assetName)))
    return { today, from, to, olderUnresolved, due }
  })

  app.get('/company/assets/:assetId/installment-plans', permission, async (req) => {
    const { assetId } = z.object({ assetId: idSchema }).parse(req.params)
    const { includeInactive } = z.object({ includeInactive: z.enum(['true', 'false']).optional() }).parse(req.query)
    const company = await companyBranch()
    await financedAsset(assetId, company.id)
    return {
      plans: (await deps.companyFinance.listAssetInstallmentPlans(assetId, includeInactive === 'true')).map(wireInstallmentPlan),
    }
  })

  app.get('/company/assets/:assetId/installment-plans/:planId/occurrences', permission, async (req) => {
    const { assetId, planId } = installmentPlanParamsSchema.parse(req.params)
    const company = await companyBranch()
    const { asset, debt } = await financedAsset(assetId, company.id)
    const plan = await deps.companyFinance.getAssetInstallmentPlan(planId)
    if (plan === null || plan.assetId !== asset.id || plan.debtId !== debt.id || plan.branchId !== company.id) {
      throw new ServiceError(404, 'asset_installment_plan_not_found')
    }
    const occurrences = await deps.companyFinance.listAssetInstallmentOccurrencesForPlan(plan.id)
    return {
      occurrences: await Promise.all(occurrences.map(async (occurrence) => {
        const event = occurrence.debtEventId === null ? null : await deps.companyFinance.getDebtEvent(occurrence.debtEventId)
        return {
          ...wireInstallmentOccurrence(occurrence),
          event: event === null ? null : {
            ...event,
            amount: serializeMoney(event.amount),
            sypMinorPerUsd: wireRate(event.sypMinorPerUsd),
          },
        }
      })),
    }
  })

  app.post('/company/assets/:assetId/installment-plans', permission, async (req, reply) => {
    const { assetId } = z.object({ assetId: idSchema }).parse(req.params)
    const body = installmentPlanCreateSchema.parse(req.body)
    const company = await companyBranch()
    const { asset, debt } = await financedAsset(assetId, company.id)
    assertInstallmentStartsAfterPurchase(body, asset)
    const draft = planDraft(body.idempotencyKey, body, asset, debt, req.actor!.userId, deps.clock.nowMs())
    const prior = await deps.companyFinance.getAssetInstallmentPlan(draft.id)
    if (prior) {
      if (!installmentPlanMatches(prior, draft)) throw new ServiceError(409, 'idempotency_key_conflict')
      return reply.code(200).send({ plan: wireInstallmentPlan(prior), replayed: true })
    }
    const result = await deps.financialUnitOfWork.run(
      { lockKey: `receivables:${company.id}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const concurrent = await tx.companyFinance.getAssetInstallmentPlan(draft.id)
        if (concurrent) {
          if (!installmentPlanMatches(concurrent, draft)) throw new ServiceError(409, 'idempotency_key_conflict')
          return { plan: concurrent, created: false }
        }
        if ((await tx.companyFinance.listAssetInstallmentPlans(asset.id)).some((row) => row.active)) {
          throw new ServiceError(409, 'asset_installment_plan_active')
        }
        const outstanding = companyDebtOutstanding(
          debt.direction,
          await tx.ledger.fundBalance(company.id, debtFundCode(debt)),
        )
        if (outstanding <= 0n) throw new ServiceError(422, 'asset_debt_not_outstanding')
        await tx.companyFinance.createAssetInstallmentPlan(draft)
        return { plan: draft, created: true }
      },
    )
    return reply.code(result.created ? 201 : 200).send({ plan: wireInstallmentPlan(result.plan), replayed: !result.created })
  })

  app.post('/company/assets/:assetId/installment-plans/:planId/deactivate', permission, async (req) => {
    const { assetId, planId } = installmentPlanParamsSchema.parse(req.params)
    const { reason } = z.object({ reason: reasonSchema }).parse(req.body)
    const company = await companyBranch()
    await financedAsset(assetId, company.id)
    const current = await deps.companyFinance.getAssetInstallmentPlan(planId)
    if (current === null || current.assetId !== assetId || current.branchId !== company.id) {
      throw new ServiceError(404, 'asset_installment_plan_not_found')
    }
    if (!current.active) {
      if (current.deactivationReason !== reason) throw new ServiceError(409, 'asset_installment_plan_inactive')
      return { plan: wireInstallmentPlan(current), replayed: true }
    }
    const now = deps.clock.nowMs()
    const result = await deps.financialUnitOfWork.run(
      { lockKey: `receivables:${company.id}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const locked = await tx.companyFinance.getAssetInstallmentPlan(planId)
        if (locked === null || locked.assetId !== assetId || locked.branchId !== company.id) {
          throw new ServiceError(404, 'asset_installment_plan_not_found')
        }
        if (!locked.active) {
          if (locked.deactivationReason !== reason) throw new ServiceError(409, 'asset_installment_plan_inactive')
          return { plan: locked, replayed: true }
        }
        const updated: AssetInstallmentPlanRecord = {
          ...locked,
          active: false,
          deactivatedOn: todayFor(deps),
          deactivatedAtMs: now,
          deactivatedBy: req.actor!.userId,
          deactivationReason: reason,
        }
        await tx.companyFinance.deactivateAssetInstallmentPlan(updated)
        return { plan: updated, replayed: false }
      },
    )
    return { plan: wireInstallmentPlan(result.plan), replayed: result.replayed }
  })

  const installmentPaySchema = z.object({
    idempotencyKey: idSchema,
    source: z.enum(['pocket', 'reserve', 'owner_outside']).optional(),
    occurredOn: dateSchema.optional(),
    reason: z.string().trim().min(1).max(500).nullable().default(null),
  })

  app.post('/company/assets/:assetId/installment-plans/:planId/occurrences/:dueDate/pay', permission, async (req, reply) => {
    const { assetId, planId, dueDate: rawDueDate } = installmentOccurrenceParamsSchema.parse(req.params)
    if (!isCalendarDate(rawDueDate)) throw new ServiceError(422, 'invalid_due_date')
    const dueDate = rawDueDate as CalendarDate
    const body = installmentPaySchema.parse(req.body)
    const company = await companyBranch()
    const { asset, debt } = await financedAsset(assetId, company.id)
    const plan = await deps.companyFinance.getAssetInstallmentPlan(planId)
    if (plan === null || plan.assetId !== asset.id || plan.debtId !== debt.id || plan.branchId !== company.id) {
      throw new ServiceError(404, 'asset_installment_plan_not_found')
    }
    const day = await companyDay(debt.currency)
    const occurredOn = body.occurredOn ?? dueDate
    const source = body.source ?? plan.paidFrom
    const reason = body.reason ?? installmentPaymentReason(asset, dueDate)
    const existing = await deps.companyFinance.getAssetInstallmentOccurrence(plan.id, dueDate)
    if (existing) {
      const event = existing.debtEventId === null ? null : await deps.companyFinance.getDebtEvent(existing.debtEventId)
      if (!matchesInstallmentPayment(existing, event, debt, body.idempotencyKey, source, occurredOn, reason, req.actor!.userId)) {
        throw new ServiceError(409, 'asset_installment_already_resolved')
      }
      const outstanding = companyDebtOutstanding(debt.direction, await deps.ledger.fundBalance(company.id, debtFundCode(debt)))
      return reply.code(200).send({
        occurrence: wireInstallmentOccurrence(existing),
        event: { ...event!, amount: serializeMoney(event!.amount), sypMinorPerUsd: wireRate(event!.sypMinorPerUsd) },
        outstanding: serializeMoney(outstanding),
        replayed: true,
      })
    }
    if (dueDate > day.businessDate) throw new ServiceError(409, 'asset_installment_not_due')
    if (occurredOn < dueDate || occurredOn > day.businessDate) throw new ServiceError(422, 'asset_installment_invalid_payment_date')
    assertInstallmentOccurrenceDate(plan, dueDate)
    const result = await deps.financialUnitOfWork.run(
      { lockKey: `receivables:${company.id}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const lockedPlan = await tx.companyFinance.getAssetInstallmentPlan(planId)
        if (lockedPlan === null || lockedPlan.assetId !== asset.id || lockedPlan.debtId !== debt.id || lockedPlan.branchId !== company.id) {
          throw new ServiceError(404, 'asset_installment_plan_not_found')
        }
        const concurrent = await tx.companyFinance.getAssetInstallmentOccurrence(plan.id, dueDate)
        if (concurrent) {
          const event = concurrent.debtEventId === null ? null : await tx.companyFinance.getDebtEvent(concurrent.debtEventId)
          if (!matchesInstallmentPayment(concurrent, event, debt, body.idempotencyKey, source, occurredOn, reason, req.actor!.userId)) {
            throw new ServiceError(409, 'asset_installment_already_resolved')
          }
          const outstanding = companyDebtOutstanding(debt.direction, await tx.ledger.fundBalance(company.id, debtFundCode(debt)))
          return { occurrence: concurrent, event: event!, outstanding, created: false }
        }
        assertInstallmentOccurrenceDate(lockedPlan, dueDate)
        const priorOccurrence = await tx.companyFinance.getAssetInstallmentOccurrenceById(body.idempotencyKey)
        if (priorOccurrence !== null) throw new ServiceError(409, 'idempotency_key_conflict')
        const priorEvent = await tx.companyFinance.getDebtEvent(body.idempotencyKey)
        if (priorEvent !== null) throw new ServiceError(409, 'idempotency_key_conflict')
        const outstanding = companyDebtOutstanding(debt.direction, await tx.ledger.fundBalance(company.id, debtFundCode(debt)))
        if (outstanding <= 0n) throw new ServiceError(422, 'asset_debt_not_outstanding')
        const amount = minor(lockedPlan.amount < outstanding ? lockedPlan.amount : outstanding)
        const posting = companyDebtPayment({
          debtId: debt.id,
          direction: 'payable',
          currency: debt.currency,
          amount,
          outstanding,
          paidFrom: source,
          occurrenceKey: body.idempotencyKey,
        })
        await assertCompanyPocketBalances(tx, company.id, posting)
        const [entry] = await tx.ledger.post(company.id, [posting], {
          shiftId: null,
          businessDate: day.businessDate,
          postingDate: day.businessDate,
          weekStartDate: weekStartFor(day.businessDate),
          fxDayId: day.fxDayId,
          sypMinorPerUsd: day.rate,
          createdBy: req.actor!.userId,
          reason,
        })
        if (!entry) throw new ServiceError(409, 'idempotency_key_conflict')
        const event: CompanyDebtEventRecord = {
          id: body.idempotencyKey,
          debtId: debt.id,
          branchId: company.id,
          kind: 'payment',
          amount,
          source,
          sypMinorPerUsd: day.rate,
          occurredOn,
          businessDate: day.businessDate,
          reason,
          journalEntryId: entry.id,
          createdBy: req.actor!.userId,
          createdAtMs: deps.clock.nowMs(),
        }
        await tx.companyFinance.createDebtEvent(event)
        const occurrence: AssetInstallmentOccurrenceRecord = {
          id: body.idempotencyKey,
          planId: lockedPlan.id,
          branchId: company.id,
          dueDate,
          status: 'paid',
          debtEventId: event.id,
          reason: null,
          actedBy: req.actor!.userId,
          actedAtMs: deps.clock.nowMs(),
        }
        await tx.companyFinance.createAssetInstallmentOccurrence(occurrence)
        return { occurrence, event, outstanding: minor(outstanding - amount), created: true }
      },
    )
    return reply.code(result.created ? 201 : 200).send({
      occurrence: wireInstallmentOccurrence(result.occurrence),
      event: { ...result.event, amount: serializeMoney(result.event.amount), sypMinorPerUsd: wireRate(result.event.sypMinorPerUsd) },
      outstanding: serializeMoney(result.outstanding),
      replayed: !result.created,
    })
  })

  app.post('/company/assets/:assetId/installment-plans/:planId/occurrences/:dueDate/skip', permission, async (req, reply) => {
    const { assetId, planId, dueDate: rawDueDate } = installmentOccurrenceParamsSchema.parse(req.params)
    if (!isCalendarDate(rawDueDate)) throw new ServiceError(422, 'invalid_due_date')
    const dueDate = rawDueDate as CalendarDate
    const { idempotencyKey, reason } = z.object({ idempotencyKey: idSchema, reason: reasonSchema }).parse(req.body)
    const company = await companyBranch()
    const { asset, debt } = await financedAsset(assetId, company.id)
    const plan = await deps.companyFinance.getAssetInstallmentPlan(planId)
    if (plan === null || plan.assetId !== asset.id || plan.debtId !== debt.id || plan.branchId !== company.id) {
      throw new ServiceError(404, 'asset_installment_plan_not_found')
    }
    const existing = await deps.companyFinance.getAssetInstallmentOccurrence(plan.id, dueDate)
    if (existing) {
      if (existing.status === 'skipped' && existing.id === idempotencyKey && existing.reason === reason) {
        return reply.code(200).send({ occurrence: wireInstallmentOccurrence(existing), replayed: true })
      }
      throw new ServiceError(409, 'asset_installment_already_resolved')
    }
    assertInstallmentOccurrenceDate(plan, dueDate)
    if (dueDate > todayFor(deps)) throw new ServiceError(409, 'asset_installment_not_due')
    const occurrence: AssetInstallmentOccurrenceRecord = {
      id: idempotencyKey,
      planId: plan.id,
      branchId: company.id,
      dueDate,
      status: 'skipped',
      debtEventId: null,
      reason,
      actedBy: req.actor!.userId,
      actedAtMs: deps.clock.nowMs(),
    }
    const result = await deps.financialUnitOfWork.run(
      { lockKey: `receivables:${company.id}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const lockedPlan = await tx.companyFinance.getAssetInstallmentPlan(planId)
        if (lockedPlan === null || lockedPlan.assetId !== asset.id || lockedPlan.debtId !== debt.id || lockedPlan.branchId !== company.id) {
          throw new ServiceError(404, 'asset_installment_plan_not_found')
        }
        const existing = await tx.companyFinance.getAssetInstallmentOccurrence(plan.id, dueDate)
        if (existing) {
          if (existing.status === 'skipped' && existing.id === idempotencyKey && existing.reason === reason) {
            return { occurrence: existing, created: false }
          }
          throw new ServiceError(409, 'asset_installment_already_resolved')
        }
        assertInstallmentOccurrenceDate(lockedPlan, dueDate)
        const priorOccurrence = await tx.companyFinance.getAssetInstallmentOccurrenceById(idempotencyKey)
        if (priorOccurrence !== null) throw new ServiceError(409, 'idempotency_key_conflict')
        await tx.companyFinance.createAssetInstallmentOccurrence({ ...occurrence, planId: lockedPlan.id })
        return { occurrence, created: true }
      },
    )
    return reply.code(result.created ? 201 : 200).send({ occurrence: wireInstallmentOccurrence(result.occurrence), replayed: !result.created })
  })

  const assetSchema = z.object({
    idempotencyKey: idSchema,
    kind: z.enum(['vehicle', 'equipment', 'property', 'other']),
    vehicleId: idSchema.nullable().default(null),
    name: z.string().trim().min(1).max(160),
    currency: currencySchema,
    price: positiveMoney,
    purchasedOn: dateSchema,
    paidNow: nonNegativeMoney,
    paidFrom: z.enum(['pocket', 'reserve', 'owner_outside', 'opening']),
    description: reasonSchema,
    financedPartyName: z.string().trim().min(1).max(120).nullable().default(null),
    financedDueOn: dateSchema.nullable().default(null),
    financedNote: z.string().trim().min(1).max(500).nullable().default(null),
    /** Created atomically with a financed purchase; later corrections deactivate and replace it. */
    installmentPlan: installmentPlanCreateSchema.nullable().optional(),
  })

  async function presentAsset(asset: FixedAssetRecord, asOf: CalendarDate): Promise<Record<string, unknown>> {
    const [schedule, installmentPlans] = await Promise.all([
      deps.companyFinance.listAssetSchedule(asset.id),
      deps.companyFinance.listAssetInstallmentPlans(asset.id, true),
    ])
    const activeInstallmentPlan = installmentPlans.find((plan) => plan.active) ?? null
    const funded = await deps.companyFinance.listDepreciationAllocations(asset.branchId, asset.currency)
    const fundedTotal = minor(funded.filter((row) => row.assetId === asset.id).reduce((sum, row) => sum + row.amount, 0n))
    const dueTotal = minor(schedule.filter((row) => row.periodMonth <= monthStartFor(asOf)).reduce((sum, row) => sum + row.amount, 0n))
    const debt = asset.debtId === null ? null : await deps.companyFinance.getDebt(asset.debtId)
    const outstanding = debt === null
      ? minor(0n)
      : companyDebtOutstanding(debt.direction, await deps.ledger.fundBalance(asset.branchId, debtFundCode(debt)))
    return {
      ...asset,
      price: serializeMoney(asset.price),
      paidNow: serializeMoney(asset.paidNow),
      sypMinorPerUsd: wireRate(asset.sypMinorPerUsd),
      bookValue: serializeMoney(assetBookValue(asset.price, asset.purchasedOn, asOf)),
      depreciationDue: serializeMoney(minor(dueTotal - fundedTotal)),
      depreciationFunded: serializeMoney(fundedTotal),
      outstanding: serializeMoney(outstanding),
      schedule: schedule.map((row) => ({ ...row, amount: serializeMoney(row.amount) })),
      installmentPlans: installmentPlans.map(wireInstallmentPlan),
      activeInstallmentPlan: activeInstallmentPlan === null ? null : wireInstallmentPlan(activeInstallmentPlan),
    }
  }

  app.get('/company/assets', permission, async (req) => {
    const { asOf } = z.object({ asOf: dateSchema.optional() }).parse(req.query)
    const company = await companyBranch()
    const date = asOf ?? todayFor(deps)
    return { assets: await Promise.all((await deps.companyFinance.listAssets(company.id)).map((asset) => presentAsset(asset, date))) }
  })

  app.get('/company/assets/by-vehicle/:vehicleId', permission, async (req) => {
    const { vehicleId } = z.object({ vehicleId: idSchema }).parse(req.params)
    const { asOf } = z.object({ asOf: dateSchema.optional() }).parse(req.query)
    const asset = await deps.companyFinance.getAssetByVehicle(vehicleId)
    if (!asset) throw new ServiceError(404, 'asset_not_found')
    return presentAsset(asset, asOf ?? todayFor(deps))
  })

  app.get('/company/assets/:id', permission, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params)
    const { asOf } = z.object({ asOf: dateSchema.optional() }).parse(req.query)
    const asset = await deps.companyFinance.getAsset(id)
    if (!asset) throw new ServiceError(404, 'asset_not_found')
    return presentAsset(asset, asOf ?? todayFor(deps))
  })

  app.post('/company/assets', permission, async (req, reply) => {
    const body = assetSchema.parse(req.body)
    const day = await companyDay(body.currency)
    if (
      body.purchasedOn > day.businessDate || body.paidNow > body.price ||
      (body.financedDueOn !== null && body.financedDueOn < body.purchasedOn)
    ) {
      throw new ServiceError(422, 'invalid_asset_purchase')
    }
    if ((body.kind === 'vehicle') !== (body.vehicleId !== null)) throw new ServiceError(422, 'asset_vehicle_mismatch')
    if (body.vehicleId !== null && !(await deps.directory.vehicle(body.vehicleId))) throw new ServiceError(404, 'vehicle_not_found')
    const financed = minor(body.price - body.paidNow)
    if ((financed > 0n) !== (body.financedPartyName !== null)) throw new ServiceError(422, 'asset_financing_party_mismatch')
    if (body.installmentPlan !== undefined && body.installmentPlan !== null) {
      if (financed <= 0n) throw new ServiceError(422, 'asset_installment_requires_financed_asset')
      if (body.installmentPlan.startsOn < body.purchasedOn) {
        throw new ServiceError(422, 'asset_installment_starts_before_purchase')
      }
    }
    const assetMatches = async (
      asset: FixedAssetRecord,
      source: Pick<FinancialTransactionDeps, 'companyFinance'>,
    ): Promise<boolean> => {
      const base = asset.kind === body.kind && asset.vehicleId === body.vehicleId && asset.name === body.name &&
        asset.currency === body.currency && asset.price === body.price && asset.purchasedOn === body.purchasedOn &&
        asset.paidNow === body.paidNow && asset.paidFrom === body.paidFrom && asset.description === body.description &&
        asset.createdBy === req.actor!.userId
      if (!base) return false
      if (asset.debtId === null) {
        return body.financedPartyName === null && body.financedDueOn === null && body.financedNote === null
      }
      const linkedDebt = await source.companyFinance.getDebt(asset.debtId)
      const debtMatchesAsset = linkedDebt !== null && linkedDebt.partyName === body.financedPartyName &&
        linkedDebt.dueOn === body.financedDueOn && linkedDebt.note === body.financedNote &&
        linkedDebt.principal === financed
      if (!debtMatchesAsset) return false
      if (body.installmentPlan === undefined || body.installmentPlan === null) return true
      const plan = await source.companyFinance.getAssetInstallmentPlan(body.installmentPlan.idempotencyKey)
      return plan !== null && installmentPlanMatches(
        plan,
        planDraft(body.installmentPlan.idempotencyKey, body.installmentPlan, asset, linkedDebt, req.actor!.userId, plan.createdAtMs),
      )
    }
    const prior = await deps.companyFinance.getAsset(body.idempotencyKey)
    if (prior) {
      if (!(await assetMatches(prior, deps))) throw new ServiceError(409, 'idempotency_key_conflict')
      return reply.code(200).send({ asset: await presentAsset(prior, day.businessDate), replayed: true })
    }
    if (body.installmentPlan !== undefined && body.installmentPlan !== null) {
      if (await deps.companyFinance.getAssetInstallmentPlan(body.installmentPlan.idempotencyKey)) {
        throw new ServiceError(409, 'idempotency_key_conflict')
      }
    }
    const debtId = financed > 0n ? deps.ids.uuid() : null
    const purchase = assetPurchase({
      assetId: body.idempotencyKey,
      currency: body.currency,
      price: body.price,
      paidNow: body.paidNow,
      paidFrom: body.paidFrom,
      ...(debtId === null ? {} : { debtId }),
      occurrenceKey: body.idempotencyKey,
    })
    const result = await deps.financialUnitOfWork.run(
      { lockKey: `receivables:${day.companyBranchId}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const concurrent = await tx.companyFinance.getAsset(body.idempotencyKey)
        if (concurrent) {
          if (!(await assetMatches(concurrent, tx))) throw new ServiceError(409, 'idempotency_key_conflict')
          return { asset: concurrent, replayed: true }
        }
        if (body.installmentPlan !== undefined && body.installmentPlan !== null) {
          if (await tx.companyFinance.getAssetInstallmentPlan(body.installmentPlan.idempotencyKey)) {
            throw new ServiceError(409, 'idempotency_key_conflict')
          }
        }
        await assertCompanyPocketBalances(tx, day.companyBranchId, purchase.posting)
        const [entry] = await tx.ledger.post(day.companyBranchId, [purchase.posting], {
          shiftId: null,
          businessDate: day.businessDate,
          postingDate: day.businessDate,
          weekStartDate: weekStartFor(day.businessDate),
          fxDayId: day.fxDayId,
          sypMinorPerUsd: day.rate,
          createdBy: req.actor!.userId,
          reason: body.description,
        })
        if (!entry) throw new ServiceError(409, 'idempotency_key_conflict')
        const createdAtMs = deps.clock.nowMs()
        const asset: FixedAssetRecord = {
          id: body.idempotencyKey,
          branchId: day.companyBranchId,
          kind: body.kind,
          vehicleId: body.vehicleId,
          name: body.name,
          currency: body.currency,
          price: body.price,
          sypMinorPerUsd: day.rate,
          purchasedOn: body.purchasedOn,
          businessDate: day.businessDate,
          usefulMonths: 36,
          paidNow: body.paidNow,
          paidFrom: body.paidFrom,
          debtId,
          description: body.description,
          journalEntryId: entry.id,
          createdBy: req.actor!.userId,
          createdAtMs,
        }
        await tx.companyFinance.createAsset(asset)
        if (debtId !== null) {
          const debt: CompanyDebtRecord = {
            id: debtId,
            branchId: day.companyBranchId,
            direction: 'payable',
            partyName: body.financedPartyName!,
            partyKey: normalizePartyName(body.financedPartyName!),
            currency: body.currency,
            principal: purchase.financed,
            sypMinorPerUsd: day.rate,
            openedOn: body.purchasedOn,
            businessDate: day.businessDate,
            dueOn: body.financedDueOn,
            note: body.financedNote,
            origin: 'asset_purchase',
            expenseCategoryId: null,
            incomeCategoryId: null,
            costCenterKind: null,
            vehicleId: null,
            assetId: asset.id,
            journalEntryId: entry.id,
            createdBy: req.actor!.userId,
            createdAtMs,
          }
          await tx.companyFinance.createDebt(debt)
          if (body.installmentPlan !== undefined && body.installmentPlan !== null) {
            await tx.companyFinance.createAssetInstallmentPlan(
              planDraft(body.installmentPlan.idempotencyKey, body.installmentPlan, asset, debt, req.actor!.userId, createdAtMs),
            )
          }
        }
        await tx.companyFinance.createAssetSchedule(depreciationSchedule(asset.id, asset.price, asset.purchasedOn))
        return { asset, replayed: false }
      },
    )
    return reply.code(result.replayed ? 200 : 201).send({
      asset: await presentAsset(result.asset, day.businessDate),
      replayed: result.replayed,
    })
  })

  async function depreciationPlan(
    companyBranchId: string,
    currency: Currency,
    asOfMonth: CalendarDate,
    tx: Pick<Deps, 'companyFinance' | 'ledger'> = deps,
  ) {
    const [schedule, funded, available] = await Promise.all([
      tx.companyFinance.listAssetSchedule(),
      tx.companyFinance.listDepreciationAllocations(companyBranchId, currency),
      tx.ledger.fundBalance(companyBranchId, `company_cash:${currency}`),
    ])
    const assets = await tx.companyFinance.listAssets(companyBranchId)
    const assetIds = new Set(assets.filter((asset) => asset.currency === currency).map((asset) => asset.id))
    return planDepreciationTransfer({
      schedule: schedule.filter((row) => assetIds.has(row.assetId)),
      funded,
      asOfMonth,
      available,
    })
  }

  app.get('/company/depreciation', permission, async (req) => {
    const today = todayFor(deps)
    const { asOfMonth } = z.object({ asOfMonth: dateSchema.optional() }).parse(req.query)
    const month = monthStartFor(asOfMonth ?? today)
    const company = await companyBranch()
    const [syp, usd, transfers, releases] = await Promise.all([
      depreciationPlan(company.id, 'SYP_NEW', month),
      depreciationPlan(company.id, 'USD', month),
      deps.companyFinance.listDepreciationTransfers(company.id),
      deps.companyFinance.listDepreciationReleases(company.id),
    ])
    const presentPlan = (plan: ReturnType<typeof planDepreciationTransfer>) => ({
      totalDue: serializeMoney(plan.totalDue),
      transferAmount: serializeMoney(plan.transferAmount),
      remainingDue: serializeMoney(plan.remainingDue),
      allocations: plan.allocations.map((row) => ({ ...row, amount: serializeMoney(row.amount) })),
    })
    return {
      asOfMonth: month,
      currencies: { SYP_NEW: presentPlan(syp), USD: presentPlan(usd) },
      transfers: transfers.map((row) => ({
        ...row,
        amount: serializeMoney(row.amount),
        expectedAmount: serializeMoney(row.expectedAmount),
        sypMinorPerUsd: wireRate(row.sypMinorPerUsd),
      })),
      releases: releases.map((row) => ({
        ...row,
        amount: serializeMoney(row.amount),
        sypMinorPerUsd: wireRate(row.sypMinorPerUsd),
      })),
    }
  })

  const depreciationTransferSchema = z.object({
    idempotencyKey: idSchema,
    currency: currencySchema,
    asOfMonth: dateSchema,
    expectedAmount: positiveMoney,
    reason: reasonSchema,
  })

  app.post('/company/depreciation/transfers', permission, async (req, reply) => {
    const body = depreciationTransferSchema.parse(req.body)
    const day = await companyDay(body.currency)
    const asOfMonth = monthStartFor(body.asOfMonth)
    if (asOfMonth !== body.asOfMonth || asOfMonth > monthStartFor(day.businessDate)) {
      throw new ServiceError(422, 'invalid_depreciation_month')
    }
    const existing = (await deps.companyFinance.listDepreciationTransfers(day.companyBranchId))
      .find((row) => row.id === body.idempotencyKey)
    if (existing) {
      const exact = existing.currency === body.currency && existing.asOfMonth === asOfMonth &&
        existing.expectedAmount === body.expectedAmount && existing.reason === body.reason &&
        existing.createdBy === req.actor!.userId
      if (!exact) throw new ServiceError(409, 'idempotency_key_conflict')
      return reply.code(200).send({
        transfer: {
          ...existing,
          amount: serializeMoney(existing.amount),
          expectedAmount: serializeMoney(existing.expectedAmount),
          sypMinorPerUsd: wireRate(existing.sypMinorPerUsd),
        },
        replayed: true,
      })
    }
    const result = await deps.financialUnitOfWork.run(
      { lockKey: `receivables:${day.companyBranchId}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const concurrent = (await tx.companyFinance.listDepreciationTransfers(day.companyBranchId))
          .find((row) => row.id === body.idempotencyKey)
        if (concurrent) {
          const exact = concurrent.currency === body.currency && concurrent.asOfMonth === asOfMonth &&
            concurrent.expectedAmount === body.expectedAmount && concurrent.reason === body.reason &&
            concurrent.createdBy === req.actor!.userId
          if (!exact) throw new ServiceError(409, 'idempotency_key_conflict')
          return { transfer: concurrent, replayed: true }
        }
        const plan = await depreciationPlan(day.companyBranchId, body.currency, asOfMonth, tx)
        if (plan.transferAmount === 0n) throw new ServiceError(422, 'no_depreciation_transfer_due')
        if (plan.transferAmount !== body.expectedAmount) {
          throw new ServiceError(409, 'depreciation_amount_changed', {
            expected: serializeMoney(body.expectedAmount),
            actual: serializeMoney(plan.transferAmount),
          })
        }
        const posting = depreciationTransfer(body.currency, plan.transferAmount, body.idempotencyKey)
        const [entry] = await tx.ledger.post(day.companyBranchId, [posting], {
          shiftId: null,
          businessDate: day.businessDate,
          postingDate: day.businessDate,
          weekStartDate: weekStartFor(day.businessDate),
          fxDayId: day.fxDayId,
          sypMinorPerUsd: day.rate,
          createdBy: req.actor!.userId,
          reason: body.reason,
        })
        if (!entry) throw new ServiceError(409, 'idempotency_key_conflict')
        const transfer: DepreciationTransferRecord = {
          id: body.idempotencyKey,
          branchId: day.companyBranchId,
          currency: body.currency,
          amount: plan.transferAmount,
          expectedAmount: body.expectedAmount,
          sypMinorPerUsd: day.rate,
          asOfMonth,
          businessDate: day.businessDate,
          reason: body.reason,
          journalEntryId: entry.id,
          createdBy: req.actor!.userId,
          createdAtMs: deps.clock.nowMs(),
        }
        await tx.companyFinance.createDepreciationTransfer(
          transfer,
          plan.allocations.map((allocation) => ({
            transferId: transfer.id,
            assetId: allocation.assetId,
            period: allocation.period,
            amount: allocation.amount,
          })),
        )
        return { transfer, replayed: false }
      },
    )
    return reply.code(result.replayed ? 200 : 201).send({
      transfer: {
        ...result.transfer,
        amount: serializeMoney(result.transfer.amount),
        expectedAmount: serializeMoney(result.transfer.expectedAmount),
        sypMinorPerUsd: wireRate(result.transfer.sypMinorPerUsd),
      },
      replayed: result.replayed,
    })
  })

  const depreciationReleaseSchema = z.object({
    idempotencyKey: idSchema,
    currency: currencySchema,
    amount: positiveMoney,
    occurredOn: dateSchema.optional(),
    reason: reasonSchema,
  })

  app.post('/company/depreciation/releases', permission, async (req, reply) => {
    const body = depreciationReleaseSchema.parse(req.body)
    const day = await companyDay(body.currency)
    const occurredOn = body.occurredOn ?? day.businessDate
    if (occurredOn > day.businessDate) throw new ServiceError(422, 'future_company_event')
    const existing = (await deps.companyFinance.listDepreciationReleases(day.companyBranchId))
      .find((row) => row.id === body.idempotencyKey)
    if (existing) {
      const exact = existing.currency === body.currency && existing.amount === body.amount &&
        existing.occurredOn === occurredOn && existing.reason === body.reason && existing.createdBy === req.actor!.userId
      if (!exact) throw new ServiceError(409, 'idempotency_key_conflict')
      return reply.code(200).send({
        release: { ...existing, amount: serializeMoney(existing.amount), sypMinorPerUsd: wireRate(existing.sypMinorPerUsd) },
        replayed: true,
      })
    }
    const result = await deps.financialUnitOfWork.run(
      { lockKey: `receivables:${day.companyBranchId}`, actorId: req.actor!.userId, requestId: req.requestId },
      async (tx) => {
        const concurrent = (await tx.companyFinance.listDepreciationReleases(day.companyBranchId))
          .find((row) => row.id === body.idempotencyKey)
        if (concurrent) {
          const exact = concurrent.currency === body.currency && concurrent.amount === body.amount &&
            concurrent.occurredOn === occurredOn && concurrent.reason === body.reason &&
            concurrent.createdBy === req.actor!.userId
          if (!exact) throw new ServiceError(409, 'idempotency_key_conflict')
          return { release: concurrent, replayed: true }
        }
        const posting = depreciationRelease(body.currency, body.amount, body.idempotencyKey)
        await assertCompanyPocketBalances(tx, day.companyBranchId, posting)
        const [entry] = await tx.ledger.post(day.companyBranchId, [posting], {
          shiftId: null,
          businessDate: day.businessDate,
          postingDate: day.businessDate,
          weekStartDate: weekStartFor(day.businessDate),
          fxDayId: day.fxDayId,
          sypMinorPerUsd: day.rate,
          createdBy: req.actor!.userId,
          reason: body.reason,
        })
        if (!entry) throw new ServiceError(409, 'idempotency_key_conflict')
        const release: DepreciationReleaseRecord = {
          id: body.idempotencyKey,
          branchId: day.companyBranchId,
          currency: body.currency,
          amount: body.amount,
          sypMinorPerUsd: day.rate,
          occurredOn,
          businessDate: day.businessDate,
          reason: body.reason,
          journalEntryId: entry.id,
          createdBy: req.actor!.userId,
          createdAtMs: deps.clock.nowMs(),
        }
        await tx.companyFinance.createDepreciationRelease(release)
        return { release, replayed: false }
      },
    )
    return reply.code(result.replayed ? 200 : 201).send({
      release: {
        ...result.release,
        amount: serializeMoney(result.release.amount),
        sypMinorPerUsd: wireRate(result.release.sypMinorPerUsd),
      },
      replayed: result.replayed,
    })
  })
}
