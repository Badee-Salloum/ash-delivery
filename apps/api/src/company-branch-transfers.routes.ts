import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Deps, FinancialTransactionDeps, JournalEntryRecord } from '@ash/contracts'
import { lockBranchThenCompany, moneySchema, serializeMoney } from '@ash/contracts'
import { assertBalanced, can, companyBoxMovement, historicalBranchTransfer, fundCode, fundRefFromCode, hasVisibleText, isCalendarDate,
  manualKaish, minor, restorationMirror, weekStartFor, type Posting } from '@ash/domain'
import { branchSubject } from './branch-scope.ts'
import { grantsFromRows } from './rbac.ts'
import { assertWeekOpen, ensureFxDay, ServiceError, todayFor } from './shifts.service.ts'

const requestSchema = z.object({
  idempotencyKey: z.string().uuid().transform(value => value.toLowerCase()),
  branchId: z.string().trim().min(1).max(64).transform(value =>
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : value),
  direction: z.enum(['to_branch', 'from_branch']), source: z.enum(['company', 'owner_outside']),
  channel: z.enum(['cash', 'wallet']), currency: z.literal('SYP_NEW'),
  amount: moneySchema.refine(value => value > 0n),
  occurredOn: z.string().refine(isCalendarDate),
  description: z.string().trim().min(1).max(500).refine(hasVisibleText),
  notPreviouslyRecorded: z.literal(true).optional(),
}).strict().refine(body => body.source !== 'owner_outside' || body.direction === 'to_branch', {
  message: 'direct owner funding can only enter the branch', path: ['direction'],
})

function sameReceipt(entry: JournalEntryRecord, posting: Posting, req: FastifyRequest,
  body: z.infer<typeof requestSchema>): boolean {
  return entry.branchId === body.branchId && entry.shiftId === null && entry.eventType === 'manual' &&
    entry.occurrenceKey === posting.occurrenceKey && entry.createdBy === req.actor!.userId &&
    entry.businessDate === body.occurredOn && entry.reason === body.description &&
    entry.lines.length === posting.lines.length && posting.lines.every(line => entry.lines.some(stored =>
      stored.fundCode === fundCode(line.fund) && stored.side === line.side && stored.amount === line.amount &&
      stored.currency === body.currency && (stored.role ?? null) === (line.role ?? null)))
}

function sameEconomicLines(entry: JournalEntryRecord, posting: Posting): boolean {
  return entry.lines.length === posting.lines.length && posting.lines.every(line => entry.lines.some(stored =>
    stored.fundCode === fundCode(line.fund) && stored.side === line.side && stored.amount === line.amount &&
    stored.currency === 'SYP_NEW' && (stored.role ?? null) === (line.role ?? null)))
}

/** Ordinary actual transfers: independent from restoration execution and HQ review proposals. */
export function registerCompanyBranchTransferRoutes(app: FastifyInstance, deps: Deps): void {
  const permission = { config: { permission: 'company_fund.manage' as const } }
  const historicalScope = async (req: FastifyRequest, branchId: string) => {
    if (!['general_manager','system_admin'].includes(req.actor!.roleKey)) throw new ServiceError(403,'forbidden')
    const [company, branches] = await Promise.all([deps.directory.companyBranch(),deps.directory.listBranches()])
    if (!company) throw new ServiceError(500,'company_branch_missing')
    if (!branches.some(branch => branch.id === branchId && branch.kind === 'branch')) throw new ServiceError(404,'branch_not_found')
    return company.id
  }
  const evidence = async (tx: Pick<FinancialTransactionDeps,'ledger'|'companyLedger'|'companyRestorationReviews'>, companyId: string, branchId: string, sourceId: number) => {
    const entry = await tx.ledger.findEntryById(sourceId), cutover = await tx.companyLedger.cutoverFor(branchId)
    const movement = entry ? companyBoxMovement(entry.lines) : null
    const office = entry?.lines.find(line => line.fundCode === 'office_cash' || line.fundCode === 'office_wallet')
    if (!entry || entry.branchId !== branchId || entry.shiftId !== null || entry.eventType !== 'manual' || !movement ||
      entry.lines.length !== 2 || !office || office.amount !== movement.amount || office.currency !== 'SYP_NEW' ||
      entry.businessDate < '2000-01-01' || entry.businessDate > todayFor(deps) ||
      !cutover || cutover.companyBranchId !== companyId || cutover.mode !== 'link_only' || entry.id > cutover.watermarkEntryId ||
      await tx.companyLedger.findMirrorBySource(entry.id) || await tx.companyRestorationReviews.getBySource(entry.id) ||
      await tx.ledger.findStandaloneEntry(branchId,'correction',`reversal-of-${entry.id}`)) throw new ServiceError(422,'historical_transfer_source_not_eligible')
    return { entry, movement }
  }
  app.get('/company/branch-transfers/historical-sources',permission,async req => {
    const { branchId } = z.object({ branchId: z.string().min(1).max(64) }).strict().parse(req.query)
    const companyId = await historicalScope(req,branchId)
    const links = await deps.companyLedger.listHistoricalBranchLinks(companyId)
    const entries = await deps.ledger.listByRange(branchId,'2000-01-01',todayFor(deps)), sources = []
    for (const entry of entries) {
      if (links.some(link => link.sourceEntryId === entry.id)) continue
      try { const source = await evidence(deps,companyId,branchId,entry.id)
        sources.push({ sourceEntryId:entry.id,occurredOn:entry.businessDate,description:entry.reason,
          direction:source.movement.direction,amount:serializeMoney(source.movement.amount) })
      } catch (error) { if (!(error instanceof ServiceError)) throw error }
    }
    const movements = await deps.companyLedgerSource.listMovements(companyId,{ from:'2000-01-01',to:todayFor(deps) })
    const validMovements = []
    for (const movement of movements) if (!await deps.companyLedger.findReversalOf(movement.entry.id)) validMovements.push(movement)
    const companyReceipts = validMovements.filter(({entry}) => entry.eventType === 'company_historical_transfer' &&
      entry.lines.some(line => line.fundCode === `historical_branch_transit:${branchId}`) && !links.some(link => link.companyEntryId === entry.id))
      .map(({entry}) => { const cash = entry.lines.find(line => line.fundCode === 'company_cash:SYP_NEW')!
        return { companyEntryId:entry.id,occurredOn:entry.businessDate,amount:serializeMoney(cash.amount),
          direction:cash.side === 'D' ? 'to_company' : 'from_company',description:entry.reason } })
    return { sources,companyReceipts,links:links.filter(row => row.sourceBranchId === branchId).map(row => ({ ...row,amount:serializeMoney(row.amount) })) }
  })
  app.post('/company/branch-transfers/historical-link',permission,async (req,reply) => {
    const body = z.object({ idempotencyKey:z.string().uuid().transform(value=>value.toLowerCase()),branchId:z.string().min(1).max(64),
      sourceEntryId:z.number().int().positive(),companyEntryId:z.number().int().positive().nullable().default(null),
      reason:z.string().trim().min(1).max(500).refine(hasVisibleText),acknowledged:z.literal(true) }).strict().parse(req.body)
    const companyId = await historicalScope(req,body.branchId), actorId = req.actor!.userId
    const hash = createHash('sha256').update(JSON.stringify({ ...body,companyId,actorId })).digest('hex')
    const result = await deps.financialUnitOfWork.run({lockKey:`historical-transfer:${body.idempotencyKey}`,actorId,requestId:req.requestId},async tx => {
      await lockBranchThenCompany(tx,body.branchId,companyId)
      const old = await tx.companyLedger.findHistoricalBranchLink(body.idempotencyKey)
      if (old) { if (old.requestHash !== hash) throw new ServiceError(409,'idempotency_key_conflict'); return {row:old,replayed:true} }
      if (await tx.companyLedger.findCommand(body.idempotencyKey)) throw new ServiceError(409,'idempotency_key_conflict')
      const { entry,movement } = await evidence(tx,companyId,body.branchId,body.sourceEntryId)
      const links = await tx.companyLedger.listHistoricalBranchLinks(companyId)
      if (links.some(row=>row.sourceEntryId === body.sourceEntryId || row.companyEntryId === body.companyEntryId)) throw new ServiceError(409,'historical_transfer_already_linked')
      let companyEntryId = body.companyEntryId
      if (companyEntryId !== null) {
        const target = await tx.ledger.findEntryById(companyEntryId)
        const expected = historicalBranchTransfer(movement.direction,movement.amount,body.branchId,body.idempotencyKey)
        if (!target || target.branchId !== companyId || target.eventType !== 'company_historical_transfer' ||
          target.businessDate !== entry.businessDate || !sameEconomicLines(target,expected) || await tx.companyLedger.findReversalOf(target.id)) {
          throw new ServiceError(422,'historical_transfer_company_entry_mismatch')
        }
      } else {
        // Only the missing HQ receipt; the immutable branch journal is never replayed.
        const fxDayId = await ensureFxDay(deps,todayFor(deps))
        const [target] = await tx.ledger.post(companyId,[historicalBranchTransfer(movement.direction,movement.amount,body.branchId,body.idempotencyKey)],
          {shiftId:null,businessDate:entry.businessDate,postingDate:entry.businessDate,weekStartDate:weekStartFor(entry.businessDate),
            fxDayId,sypMinorPerUsd:null,createdBy:actorId,reason:body.reason,externalReference:`HQ-LINK-${body.idempotencyKey}`,priorPeriodReason:body.reason})
        if (!target) throw new ServiceError(409,'historical_transfer_journal_conflict')
        companyEntryId = target.id
      }
      const row = {id:body.idempotencyKey,companyBranchId:companyId,sourceBranchId:body.branchId,sourceEntryId:entry.id,
        companyEntryId,createdEntry:body.companyEntryId === null,amount:movement.amount,direction:movement.direction,
        occurredOn:entry.businessDate,reason:body.reason,requestHash:hash,createdBy:actorId,createdAtMs:deps.clock.nowMs()}
      await tx.companyLedger.createHistoricalBranchLink(row)
      return {row,replayed:false}
    })
    return reply.code(result.replayed?200:201).send({link:{...result.row,amount:serializeMoney(result.row.amount)},replayed:result.replayed,
      branchCashEffect:'0.00',companyCashEffect:result.row.createdEntry ? serializeMoney(minor(result.row.direction==='to_company'?result.row.amount:-result.row.amount)):'0.00'})
  })
  app.post('/company/branch-transfers', { config: { permission: 'company_fund.manage', subject: branchSubject } }, async (req, reply) => {
    const body = requestSchema.parse(req.body)
    const [operatingBranches, company, grants] = await Promise.all([
      deps.directory.listBranches(), deps.directory.companyBranch(), deps.directory.grants(),
    ])
    // Resolve only verified directory IDs; arbitrary input must never reach a PostgreSQL UUID cast.
    const branch = operatingBranches.find(row => row.id === body.branchId)
    if (!branch || branch.kind !== 'branch') throw new ServiceError(404, 'branch_not_found')
    if (!company) throw new ServiceError(500, 'company_branch_missing')
    const grantTable = grantsFromRows(grants)
    for (const [permission, branchId] of [['journal.manual.write', branch.id], ['company_fund.manage', company.id]] as const) {
      if (!can(req.actor!, permission, { branchId }, grantTable).allowed) throw new ServiceError(403, 'forbidden', { permission })
    }
    const office = body.channel === 'wallet' ? 'office_wallet' : 'office_cash'
    // Shares legacy treasury receipt keys so a committed matching receipt is reused, not posted
    // again. UUID concurrency is scoped to this transfer command, not unrelated legacy routes.
    // `manual` is essential; no immutable restoration is manufactured.
    const occurrenceKey = `client:${body.idempotencyKey}`
    const findExisting = async (repo: Pick<FinancialTransactionDeps, 'ledger' | 'companyLedger'>) => {
      if (await repo.companyLedger.findHistoricalBranchLink(body.idempotencyKey)) throw new ServiceError(409,'idempotency_key_conflict')
      if (await repo.companyLedger.findCommand(body.idempotencyKey)) throw new ServiceError(409, 'idempotency_key_conflict')
      const receipts = (await Promise.all(operatingBranches.map(row =>
        repo.ledger.findStandaloneEntry(row.id, 'manual', occurrenceKey)))).filter((row): row is JournalEntryRecord => row !== null)
      if (receipts.length > 1) throw new ServiceError(409, 'idempotency_key_conflict')
      return receipts[0] ?? null
    }
    const posting: Posting = body.source === 'owner_outside' ? assertBalanced({ eventType: 'manual', occurrenceKey,
      lines: [{ fund: fundRefFromCode(office), side: 'D', amount: body.amount },
        { fund: fundRefFromCode('owner_funding'), side: 'C', amount: body.amount }] })
      : body.direction === 'from_branch' ? manualKaish(office, body.amount, occurrenceKey)
        : assertBalanced({ eventType: 'manual', occurrenceKey, lines: [
          { fund: fundRefFromCode(office), side: 'D', amount: body.amount, role: 'shahn' },
          { fund: { kind: 'company_box' }, side: 'C', amount: body.amount },
        ] })
    const readReceipt = async (tx: Pick<FinancialTransactionDeps, 'ledger' | 'companyLedger'>, entry: JournalEntryRecord, replayed: boolean) => {
      if (!sameReceipt(entry, posting, req, body)) throw new ServiceError(409, 'idempotency_key_conflict')
      const mirror = await tx.companyLedger.findMirrorBySource(entry.id)
      if (body.source === 'company') {
        const direction = body.direction === 'from_branch' ? 'to_company' : 'from_company'
        if (!mirror || mirror.sourceBranchId !== branch.id || mirror.amount !== body.amount ||
          mirror.direction !== direction || mirror.restorationId !== null) throw new ServiceError(409, 'company_transfer_mirror_integrity_error')
        const companyEntry = await tx.ledger.findEntryById(mirror.mirrorEntryId)
        const expected = restorationMirror(direction, body.amount, branch.id, entry.id)
        if (!companyEntry || companyEntry.branchId !== company.id || companyEntry.shiftId !== null ||
          companyEntry.eventType !== expected.eventType || companyEntry.occurrenceKey !== expected.occurrenceKey ||
          companyEntry.businessDate !== entry.businessDate || companyEntry.createdBy !== entry.createdBy ||
          companyEntry.reason !== entry.reason || !sameEconomicLines(companyEntry, expected)) {
          throw new ServiceError(409, 'company_transfer_mirror_integrity_error')
        }
      } else if (mirror !== null) {
        throw new ServiceError(409, 'company_transfer_mirror_integrity_error')
      }
      return { replayed, transfer: { id: body.idempotencyKey, branchId: branch.id, branchNameAr: branch.nameAr,
        direction: body.direction, source: body.source, channel: body.channel, currency: body.currency,
        amount: serializeMoney(body.amount), occurredOn: entry.businessDate, postedOn: entry.postingDate,
        description: entry.reason, branchEntryId: entry.id, companyEntryId: mirror?.mirrorEntryId ?? null,
        expenseEffect: '0.00', companyCashEffect: body.source === 'owner_outside' ? '0.00'
          : serializeMoney(minor(body.direction === 'from_branch' ? body.amount : -body.amount)),
        branchCashEffect: serializeMoney(minor(body.direction === 'to_branch' ? body.amount : -body.amount)) } }
    }
    const committed = await findExisting(deps)
    if (committed) return reply.code(200).send(await readReceipt(deps, committed, true))
    // This command changes today's LIVE branch balance. Historical overlap needs source matching,
    // never a second branch movement merely to complete the HQ history.
    const today = todayFor(deps)
    if (body.occurredOn < '2000-01-01' || body.occurredOn > today) throw new ServiceError(422,'invalid_occurrence_date')
    if (body.occurredOn !== today && !body.notPreviouslyRecorded) throw new ServiceError(422, 'historical_branch_transfer_requires_matching')
    if (body.occurredOn !== today && !['general_manager','system_admin'].includes(req.actor!.roleKey)) throw new ServiceError(403,'forbidden')
    if (body.occurredOn === today) {
      await assertWeekOpen(deps, branch.id, today)
      if (body.source === 'company') await assertWeekOpen(deps, company.id, today)
    }
    const fxDayId = await ensureFxDay(deps, today)
    const outcome = await deps.financialUnitOfWork.run({ lockKey: `company-branch-transfer:${body.idempotencyKey}`,
      actorId: req.actor!.userId, requestId: req.requestId }, async tx => {
      if (body.source === 'company') await lockBranchThenCompany(tx, branch.id, company.id)
      else await tx.locks.acquire(`receivables:${branch.id}`)
      const prior = await findExisting(tx)
      if (prior) return readReceipt(tx, prior, true)
      if (body.source === 'company') {
        const cutover = await tx.companyLedger.cutoverFor(branch.id)
        if (!cutover || cutover.companyBranchId !== company.id) throw new ServiceError(422, 'company_transfer_cutover_required')
      }
      if (body.direction === 'from_branch') {
        const held = body.occurredOn === today ? await tx.ledger.fundBalance(branch.id, office)
          : minor((await tx.ledger.listByRange(branch.id,'2000-01-01',body.occurredOn)).reduce((sum,entry)=>sum+
            entry.lines.filter(line=>line.fundCode===office).reduce((value,line)=>value+(line.side==='D'?line.amount:-line.amount),0n),0n))
        if (body.amount > held) throw new ServiceError(422, 'insufficient_funds', { held: serializeMoney(held), from: office })
      }
      const meta = { shiftId: null, businessDate: body.occurredOn, postingDate: body.occurredOn, weekStartDate: weekStartFor(body.occurredOn),
        fxDayId, sypMinorPerUsd: null, createdBy: req.actor!.userId, reason: body.description,
        ...(body.occurredOn < today ? {priorPeriodReason:body.description} : {}) }
      const [entry] = await tx.ledger.post(branch.id, [posting], meta)
      if (!entry) throw new ServiceError(409, 'idempotency_key_conflict')
      if (body.source === 'company') {
        const direction = body.direction === 'from_branch' ? 'to_company' : 'from_company'
        // Same cutover settlement machinery, but this is an ordinary manual transfer, not a
        // restoration proposal. Negative HQ pocket after a genuine top-up remains allowed.
        const [mirror] = await tx.ledger.post(company.id, [restorationMirror(direction, body.amount, branch.id, entry.id)], meta)
        if (!mirror) throw new ServiceError(409, 'company_mirror_conflict')
        await tx.companyLedger.createMirror({ id: deps.ids.uuid(), sourceBranchId: branch.id,
          sourceEntryId: entry.id, mirrorEntryId: mirror.id, direction, amount: body.amount,
          restorationId: null, createdBy: req.actor!.userId, createdAtMs: deps.clock.nowMs() })
      }
      return readReceipt(tx, entry, false)
    })
    return reply.code(outcome.replayed ? 200 : 201).send(outcome)
  })
}
