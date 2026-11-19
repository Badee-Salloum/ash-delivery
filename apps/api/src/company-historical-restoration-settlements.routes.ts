import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { CompanyHistoricalRestorationSettlement, CompanyHistoricalRestorationSettlementGroup,
  CompanyHistoricalImportReceiptRecord, Deps, FinancialTransactionDeps } from '@ash/contracts'
import { serializeMoney } from '@ash/contracts'
import { companyBoxMovement, hasVisibleText, historicalRestorationReclassification, minor, weekStartFor } from '@ash/domain'
import { ServiceError, assertWeekOpen, ensureFxDay, todayFor } from './shifts.service.ts'

const branchSchema = z.string().trim().min(1).max(128).refine(value => !value.includes(':'))
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const runPlan = z.object({ schemaVersion: z.union([z.literal(3), z.literal(4)]), restorationJournalEntryIds: z.array(positiveId).min(1).max(2) })
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value,
  (_key, part: unknown) => typeof part === 'bigint' ? part.toString() : part)).digest('hex')
const wire = (value: bigint) => serializeMoney(minor(value))
const signed = (direction: 'to_company' | 'from_company', amount: bigint) => direction === 'to_company' ? amount : -amount
const receipt = (row: CompanyHistoricalRestorationSettlement) => ({ id: row.id, version: row.version,
  businessDate: row.businessDate, reason: row.reason, groupCount: row.groups.length, sourceCount: row.legs.length,
  createdAtMs: row.createdAtMs })

function assertReviewer(req: FastifyRequest): void {
  if (req.actor?.roleKey !== 'general_manager' && req.actor?.roleKey !== 'system_admin') {
    throw new ServiceError(403, 'forbidden', { reason: 'company_financial_review_roles_only' })
  }
}

/** Full immutable source groups, never a new branch restoration or a second cash receipt. */
export async function historicalSettlementPreview(deps: Deps, tx: FinancialTransactionDeps, companyBranchId: string, branchId: string) {
  const cutover = await tx.companyLedger.cutoverFor(branchId)
  const past = await tx.companyLedger.listHistoricalSettlements(companyBranchId, branchId)
  const version = Math.max(0, ...past.map(row => row.version))
  const blockers = new Set<string>()
  if (!cutover || cutover.companyBranchId !== companyBranchId || cutover.mode !== 'link_only') blockers.add('company_link_only_cutover_required')
  const allReceipts = await tx.companyLedgerSource.listHistoricalImportReceipts(companyBranchId,
    { from: '2000-01-01', to: todayFor(deps) })
  const linked = allReceipts.filter(row => row.sourceBranchId === branchId && row.restorationId !== null && row.journalEntryId !== null)
    .sort((a, b) => a.sourcePosition - b.sourcePosition || a.sourceReference.localeCompare(b.sourceReference))
  const settled = new Set(past.flatMap(row => row.legs.map(leg => leg.historicalJournalEntryId)))
  const grouped = new Map<number, CompanyHistoricalImportReceiptRecord[]>()
  for (const source of linked) grouped.set(source.restorationId!, [...(grouped.get(source.restorationId!) ?? []), source])
  const [runs, proposed, mirrors, commands] = await Promise.all([tx.restorations.list(branchId),
    tx.companyRestorationReviews.list(companyBranchId, branchId), tx.companyLedger.listMirrors(branchId),
    tx.companyLedger.listCommands(companyBranchId)])
  const runById = new Map(runs.map(run => [run.id, run]))
  const mirroredIds = new Set(mirrors.map(row => row.sourceEntryId))
  const proposedIds = new Set(proposed.flatMap(row => row.legs.map(leg => leg.sourceEntryId)))
  const reversedCompanyIds = new Set(commands.filter(row => row.kind === 'reversal').map(row => row.targetEntryId))
  const sourceIds = [...linked.map(row => row.journalEntryId!), ...[...grouped.keys()].flatMap(id => {
    const plan = runPlan.safeParse(runById.get(id)?.plan)
    return plan.success ? plan.data.restorationJournalEntryIds : []
  })]
  const entryById = new Map((await tx.ledger.findEntriesByIds([...new Set(sourceIds)])).map(entry => [entry.id, entry]))
  const groups: CompanyHistoricalRestorationSettlementGroup[] = []
  const sources: Array<{ restorationId: number; sourceReference: string; historicalJournalEntryId: number;
    direction: 'to_company' | 'from_company'; amount: ReturnType<typeof minor> }> = []
  const evidence: unknown[] = []
  const presentation: Array<CompanyHistoricalRestorationSettlementGroup & { sources: Array<{
    sourceReference: string; occurredOn: string; description: string; journalEntryId: number; amount: string;
    direction: 'to_company' | 'from_company'; linkStatus: string; linkNote: string | null }> }> = []
  for (const [restorationId, members] of [...grouped].sort(([a], [b]) => a - b)) {
    if (members.every(row => settled.has(row.journalEntryId!))) continue
    if (members.some(row => settled.has(row.journalEntryId!))) { blockers.add('historical_settlement_partial_group'); continue }
    const run = runById.get(restorationId)
    const plan = runPlan.safeParse(run?.plan)
    if (!run || run.branchId !== branchId || !plan.success ||
      new Set(plan.data.restorationJournalEntryIds).size !== plan.data.restorationJournalEntryIds.length) {
      blockers.add('historical_settlement_run_evidence_invalid'); continue
    }
    const branchSourceEntries: CompanyHistoricalRestorationSettlementGroup['branchSourceEntries'] = []
    const sourceRows: typeof presentation[number]['sources'] = []
    const groupEvidence: unknown[] = [run]
    for (const sourceEntryId of [...plan.data.restorationJournalEntryIds].sort((a, b) => a - b)) {
      const entry = entryById.get(sourceEntryId)
      const movement = entry ? companyBoxMovement(entry.lines) : null
      const office = entry?.lines.find(line => line.fundCode === 'office_cash' || line.fundCode === 'office_wallet')
      if (!entry || !movement || !office || entry.lines.length !== 2 || entry.branchId !== branchId ||
        entry.eventType !== 'restoration' || entry.businessDate !== run.businessDate || office.amount !== movement.amount ||
        office.currency !== 'SYP_NEW' || entry.id > (cutover?.watermarkEntryId ?? 0) ||
        mirroredIds.has(sourceEntryId) || proposedIds.has(sourceEntryId) ||
        await tx.ledger.findStandaloneEntry(branchId, 'correction', `reversal-of-${sourceEntryId}`)) {
        blockers.add('historical_settlement_branch_source_changed'); continue
      }
      branchSourceEntries.push({ sourceEntryId, ...movement })
      groupEvidence.push(entry)
    }
    for (const source of members) {
      const entry = entryById.get(source.journalEntryId!)
      const direction = source.movementType === 'branch_receipt' ? 'to_company' : 'from_company'
      const cash = entry?.lines.find(line => line.fundCode === 'company_cash:SYP_NEW')
      const transit = entry?.lines.find(line => line.fundCode === `historical_branch_transit:${branchId}`)
      if (!entry || !cash || !transit || entry.lines.length !== 2 || entry.branchId !== companyBranchId ||
        entry.eventType !== 'company_historical_transfer' || entry.id > (cutover?.watermarkEntryId ?? 0) ||
        entry.externalReference !== source.sourceReference ||
        source.paidFrom !== 'pocket' || source.currency !== 'SYP_NEW' || source.amount === null || source.amount <= 0n ||
        !['branch_receipt', 'branch_payment'].includes(source.movementType) || cash.amount !== source.amount ||
        transit.amount !== source.amount || cash.currency !== 'SYP_NEW' || transit.currency !== 'SYP_NEW' ||
        cash.side !== (direction === 'to_company' ? 'D' : 'C') || transit.side === cash.side ||
        reversedCompanyIds.has(entry.id) ||
        await tx.ledger.findStandaloneEntry(companyBranchId, 'correction', `reversal-of-${entry.id}`)) {
        blockers.add('historical_settlement_company_source_changed'); continue
      }
      sources.push({ restorationId, sourceReference: source.sourceReference, historicalJournalEntryId: entry.id,
        direction, amount: source.amount })
      sourceRows.push({ sourceReference: source.sourceReference, occurredOn: source.occurredOn, description: source.description,
        journalEntryId: entry.id, amount: wire(source.amount), direction,
        linkStatus: source.linkStatus ?? 'unknown', linkNote: source.linkNote ?? null })
      groupEvidence.push(source, entry)
    }
    const groupSources = sources.filter(row => row.restorationId === restorationId)
    if (groupSources.length !== members.length || branchSourceEntries.length !== plan.data.restorationJournalEntryIds.length) continue
    const branchNet = minor(branchSourceEntries.reduce((sum, row) => sum + signed(row.direction, row.amount), 0n))
    const companyNet = minor(groupSources.reduce((sum, row) => sum + signed(row.direction, row.amount), 0n))
    if (branchNet !== run.netToCompany) blockers.add('historical_settlement_run_net_mismatch')
    const group: CompanyHistoricalRestorationSettlementGroup = { restorationId, businessDate: run.businessDate,
      branchSourceEntries, sourceReferences: members.map(row => row.sourceReference), branchNet, companyNet,
      variance: minor(branchNet - companyNet) }
    groups.push(group)
    presentation.push({ ...group, sources: sourceRows })
    evidence.push(groupEvidence)
  }
  if (!groups.length) blockers.add('historical_settlement_no_unsettled_sources')
  if (new Set(sources.map(row => row.historicalJournalEntryId)).size !== sources.length ||
    new Set(sources.map(row => row.sourceReference)).size !== sources.length) blockers.add('historical_settlement_duplicate_source')
  const companyNet = groups.reduce((sum, row) => sum + row.companyNet, 0n)
  const branchNet = groups.reduce((sum, row) => sum + row.branchNet, 0n)
  const [transit, clearing, box] = await Promise.all([
    tx.ledger.fundBalance(companyBranchId, `historical_branch_transit:${branchId}`),
    tx.ledger.fundBalance(companyBranchId, `branch_clearing:${branchId}`), tx.ledger.fundBalance(branchId, 'company_box'),
  ])
  const unlinkedHistoricalCount = runs.filter(run => {
    const plan = runPlan.safeParse(run.plan)
    return !grouped.has(run.id) && !proposed.some(row => row.restorationId === run.id) && plan.success &&
      plan.data.restorationJournalEntryIds.every(id => id <= (cutover?.watermarkEntryId ?? 0) && !mirrors.some(row => row.sourceEntryId === id))
  }).length
  const evidenceHash = digest({ cutover, version, groups, evidence, balances: { transit, clearing, box },
    past: past.map(row => ({ id: row.id, version: row.version })) })
  const accounts = (historicalTransit: bigint, currentClearing: bigint) => ({ historicalTransit: wire(historicalTransit),
    clearing: wire(currentClearing), matchingDifference: wire(box + currentClearing) })
  const zero = () => ({ SYP_NEW: '0.00', USD: '0.00' })
  return { groups, sources, cutover, wire: { branchId, companyBranchId, version, evidenceHash, eligible: blockers.size === 0,
    blockingReasons: [...blockers], counts: { sourceCount: sources.length, hqJournalCount: sources.length,
      branchSourceCount: groups.reduce((sum, row) => sum + row.branchSourceEntries.length, 0), groupCount: groups.length },
    totals: { currency: 'SYP_NEW', hqNet: wire(companyNet), branchNet: wire(branchNet), amountDifference: wire(branchNet - companyNet) },
    groups: presentation.map(row => ({ restorationId: row.restorationId, businessDate: row.businessDate,
      branchEntryIds: row.branchSourceEntries.map(leg => leg.sourceEntryId), sourceReferences: row.sourceReferences,
      hqEntryIds: row.sources.map(source => source.journalEntryId), branchNet: wire(row.branchNet), companyNet: wire(row.companyNet),
      variance: wire(row.variance), sources: row.sources })),
    plan: { before: accounts(transit, clearing), after: accounts(transit + companyNet, clearing - companyNet) },
    impacts: { companyCash: zero(), branchCash: zero(), pnl: zero() }, settlements: past.map(receipt), unlinkedHistoricalCount } }
}

export function registerCompanyHistoricalRestorationSettlementRoutes(app: FastifyInstance, deps: Deps): void {
  const access = { config: { permission: 'company_fund.manage' as const } }
  const scope = async (branchId: string) => {
    const company = await deps.directory.companyBranch()
    const branch = (await deps.directory.listBranches()).find(row => row.id === branchId && row.kind === 'branch')
    if (!company) throw new ServiceError(500, 'company_branch_missing')
    if (!branch) throw new ServiceError(404, 'branch_not_found')
    return company.id
  }
  app.get('/company/historical-restoration-settlements/preview', access, async req => {
    assertReviewer(req)
    const { branchId } = z.object({ branchId: branchSchema }).strict().parse(req.query)
    const companyBranchId = await scope(branchId)
    return deps.financialUnitOfWork.run({ lockKey: `receivables:${branchId}`, actorId: req.actor!.userId, requestId: req.requestId }, async tx => {
      await tx.locks.acquire(`receivables:${companyBranchId}`)
      return (await historicalSettlementPreview(deps, tx, companyBranchId, branchId)).wire
    })
  })
  app.post('/company/historical-restoration-settlements', access, async (req, reply) => {
    assertReviewer(req)
    const body = z.object({ idempotencyKey: z.string().uuid().transform(value => value.toLowerCase()), branchId: branchSchema,
      evidenceHash: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.number().int().nonnegative(),
      reason: z.string().trim().min(1).max(500).refine(hasVisibleText), reviewedLinks: z.literal(true) }).strict().parse(req.body)
    const companyBranchId = await scope(body.branchId)
    const actorId = req.actor!.userId
    const requestHash = digest({ ...body, companyBranchId, actorId })
    const result = await deps.financialUnitOfWork.run({ lockKey: `receivables:${body.branchId}`, actorId, requestId: req.requestId }, async tx => {
      await tx.locks.acquire(`receivables:${companyBranchId}`)
      const old = await tx.companyLedger.findHistoricalSettlement(body.idempotencyKey)
      if (old) {
        if (old.requestHash !== requestHash) throw new ServiceError(409, 'idempotency_key_conflict')
        return { row: old, replayed: true }
      }
      const preview = await historicalSettlementPreview(deps, tx, companyBranchId, body.branchId)
      if (preview.wire.version !== body.expectedVersion) throw new ServiceError(409, 'historical_settlement_version_conflict')
      if (preview.wire.evidenceHash !== body.evidenceHash) throw new ServiceError(409, 'historical_settlement_source_changed')
      if (!preview.wire.eligible || !preview.cutover) throw new ServiceError(409, 'historical_settlement_review_required',
        { reasons: preview.wire.blockingReasons })
      const businessDate = todayFor(deps)
      await assertWeekOpen(deps, companyBranchId, businessDate)
      const fxDayId = await ensureFxDay(deps, businessDate)
      const row: CompanyHistoricalRestorationSettlement = { id: body.idempotencyKey, companyBranchId, sourceBranchId: body.branchId,
        version: body.expectedVersion + 1, cutoverWatermarkEntryId: preview.cutover.watermarkEntryId,
        evidenceHash: body.evidenceHash, requestHash, businessDate, reason: body.reason, groups: preview.groups, legs: [],
        createdBy: actorId, createdAtMs: deps.clock.nowMs() }
      for (const source of preview.sources) {
        const posting = historicalRestorationReclassification(source.direction, source.amount, body.branchId,
          source.historicalJournalEntryId, body.idempotencyKey)
        const [entry] = await tx.ledger.post(companyBranchId, [posting], { shiftId: null, businessDate, postingDate: businessDate,
          weekStartDate: weekStartFor(businessDate), fxDayId, sypMinorPerUsd: null, createdBy: actorId, reason: body.reason })
        if (!entry) throw new ServiceError(409, 'historical_settlement_journal_conflict')
        row.legs.push({ ...source, journalEntryId: entry.id })
      }
      await tx.companyLedger.createHistoricalSettlement(row, body.expectedVersion)
      return { row, replayed: false }
    })
    return reply.code(result.replayed ? 200 : 201).send({ ...receipt(result.row), replayed: result.replayed })
  })
}
