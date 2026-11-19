import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { CompanyRestorationProposal, CompanyRestorationReviewRevision, Deps, FinancialTransactionDeps } from '@ash/contracts'
import { moneySchema, serializeMoney } from '@ash/contracts'
import { companyBoxMovement, hasVisibleText, isCalendarDate, minor, restorationMirror, weekStartFor, type Minor, type Posting } from '@ash/domain'
import { ServiceError, assertWeekOpen, ensureFxDay, todayFor } from './shifts.service.ts'
import { restorationReviewBalances, unlinkedHistoricalRestorations } from './company-movement-read.service.ts'

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const reviewReason = z.string().trim().min(1).max(500).refine(hasVisibleText)
const reviewLegs = z.array(z.object({ sourceEntryId: positiveId, amount: moneySchema.refine((amount) => amount >= 0n) })).max(2)
const baseRequest = z.object({
  id: z.string().uuid().transform((id) => id.toLowerCase()),
  expectedVersion: z.number().int().nonnegative(),
  reason: reviewReason,
  occurredOn: z.string().refine(isCalendarDate).optional(),
  confirmedLegs: reviewLegs.optional(),
})

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value,
  (_key, part: unknown) => typeof part === 'bigint' ? part.toString() : part)).digest('hex')

// PostgreSQL JSONB reorders object keys. A persisted immutable snapshot must compare by
// values, not JS insertion order; preserve array order and every financial/audit field.
const canonicalSnapshot = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalSnapshot)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, part]) => [key, canonicalSnapshot(part)]))
    : value
const journalDigest = (value: unknown): string => digest(canonicalSnapshot(value))

export async function presentRestorationReview(deps: Pick<Deps, 'companyRestorationReviews'>, proposal: CompanyRestorationProposal) {
  const revisions = await deps.companyRestorationReviews.listRevisions(proposal.id)
  const current = revisions.at(-1)
  const confirmed = [...revisions].reverse().find((revision) => revision.kind === 'confirm' || revision.kind === 'correct')
  const signed = (direction: 'to_company' | 'from_company', amount: Minor) => direction === 'to_company' ? amount : -amount
  const confirmedNet = proposal.legs.reduce((sum, source) => sum + signed(source.direction,
    confirmed?.legs.find((leg) => leg.sourceEntryId === source.sourceEntryId)?.amount ?? minor(0n)), 0n)
  const originalNet = proposal.legs.reduce((sum, source) => sum + signed(source.direction, source.amount), 0n)
  return {
    id: proposal.id, restorationId: proposal.restorationId, branchId: proposal.branchId,
    companyBranchId: proposal.companyBranchId, businessDate: proposal.businessDate,
    createdAtMs: proposal.createdAtMs, reason: proposal.reason, runNo: proposal.runNo, origin: proposal.origin ?? 'live',
    snapshot: proposal.snapshot,
    version: current?.version ?? 0, status: current?.kind === 'defer' ? 'deferred' : confirmed ? 'confirmed' : 'pending_review',
    branchStatus: 'executed', currency: 'SYP_NEW',
    originalNet: serializeMoney(minor(originalNet)), confirmedNet: serializeMoney(minor(confirmedNet)),
    pendingDifference: serializeMoney(minor(originalNet - confirmedNet)),
    matched: confirmed !== undefined && originalNet === confirmedNet && proposal.legs.every((source) =>
      confirmed.legs.find((leg) => leg.sourceEntryId === source.sourceEntryId)?.amount === source.amount),
    legs: proposal.legs.map((source) => ({
      sourceEntryId: source.sourceEntryId, fundCode: source.fundCode, direction: source.direction,
      originalAmount: serializeMoney(source.amount), amount: serializeMoney(source.amount),
      proposedAmount: serializeMoney(current?.legs.find((leg) => leg.sourceEntryId === source.sourceEntryId)?.amount ?? source.amount),
      confirmedAmount: confirmed ? serializeMoney(confirmed.legs.find((leg) => leg.sourceEntryId === source.sourceEntryId)?.amount ?? minor(0n)) : null,
      sourceBusinessDate: source.sourceEntry.businessDate, sourcePostingDate: source.sourceEntry.postingDate,
    })),
    confirmedLegs: proposal.legs.map((source) => ({ sourceEntryId: source.sourceEntryId,
      amount: serializeMoney(current?.legs.find((leg) => leg.sourceEntryId === source.sourceEntryId)?.amount ?? source.amount),
    })),
    revisions: revisions.map((revision) => ({ ...revision, legs: revision.legs.map((leg) => ({ ...leg, amount: serializeMoney(leg.amount) })) })),
  }
}

/** HQ-only writes. Branch lock stabilizes evidence, never used to mutate branch cash/targets. */
export function registerCompanyRestorationReviewRoutes(
  app: FastifyInstance, deps: Deps, options: { enabled?: boolean } = {},
): void {
  const read = { config: { permission: 'company_fund.manage' as const } }
  const write = { config: { permission: 'company_fund.manage' as const } }
  const enabled = async (branchId: string, source: Pick<FinancialTransactionDeps, 'companyLedger'> = deps) => {
    const cutover = await source.companyLedger.cutoverFor(branchId)
    if (cutover && (options.enabled || cutover.mode === 'link_only')) return
    throw new ServiceError(409, 'company_restoration_review_disabled')
  }
  async function companyId(source: Pick<Deps,'directory'> = deps): Promise<string> {
    const company = await source.directory.companyBranch()
    if (!company) throw new ServiceError(500, 'company_branch_missing')
    return company.id
  }
  async function historicalEvidence(restorationId: number, tx: FinancialTransactionDeps) {
    const run = await tx.restorations.getById(restorationId)
    if (!run) throw new ServiceError(404, 'restoration_not_found')
    const companyBranchId = await companyId(tx)
    const cutover = await tx.companyLedger.cutoverFor(run.branchId)
    if (!cutover || cutover.companyBranchId !== companyBranchId) throw new ServiceError(409, 'company_cutover_required')
    if (cutover.mode !== 'link_only') throw new ServiceError(409, 'restoration_legacy_opening_review_required')
    const plan = z.object({ schemaVersion: z.literal(4), restorationJournalEntryIds: z.array(positiveId).max(2),
      openingBalances: z.unknown(), legs: z.unknown() }).safeParse(run.plan)
    if (!plan.success || plan.data.restorationJournalEntryIds.length === 0 ||
      new Set(plan.data.restorationJournalEntryIds).size !== plan.data.restorationJournalEntryIds.length) {
      throw new ServiceError(409, 'restoration_legacy_evidence_review_required')
    }
    const receipts = await tx.companyLedgerSource.listHistoricalImportReceipts(companyBranchId,
      { from: '2000-01-01', to: todayFor(deps) })
    const linked = receipts.filter((row) => row.sourceBranchId === run.branchId && row.restorationId === restorationId && row.journalEntryId !== null)
    if (linked.length) throw new ServiceError(409, 'restoration_source_already_linked', { sourceReferences: linked.map((row) => row.sourceReference) })
    const legs = await Promise.all(plan.data.restorationJournalEntryIds.map(async (sourceEntryId) => {
      const entry = await tx.ledger.findEntryById(sourceEntryId)
      const movement = entry ? companyBoxMovement(entry.lines) : null
      const office = entry?.lines.find((line) => line.fundCode === 'office_cash' || line.fundCode === 'office_wallet')
      if (!entry || entry.id > cutover.watermarkEntryId || entry.branchId !== run.branchId || entry.eventType !== 'restoration' ||
        entry.businessDate !== run.businessDate || !movement || !office || office.amount !== movement.amount ||
        await tx.companyLedger.findMirrorBySource(sourceEntryId) || await tx.companyRestorationReviews.getBySource(sourceEntryId) ||
        await tx.ledger.findStandaloneEntry(run.branchId, 'correction', `reversal-of-${sourceEntryId}`)) {
        throw new ServiceError(409, 'restoration_source_requires_review', { sourceEntryId })
      }
      return { sourceEntryId, fundCode: office.fundCode as 'office_cash' | 'office_wallet', ...movement, sourceEntry: entry }
    }))
    return { run, companyBranchId, legs, snapshot: { openingBalances: plan.data.openingBalances, legs: plan.data.legs },
      evidenceHash: digest({ run, legs }) }
  }

  // Adoption records provenance only. It cannot create a second branch execution or an HQ receipt.
  app.post('/company/restoration-reviews/adopt', write, async (req, reply) => {
    const request = z.object({ id: z.string().uuid().optional(), idempotencyKey: z.string().uuid().optional(), restorationId: positiveId,
      evidenceHash: z.string().regex(/^[a-f0-9]{64}$/), reason: reviewReason }).strict().parse(req.body)
    if (!request.id && !request.idempotencyKey) throw new ServiceError(422, 'idempotency_key_required')
    if (request.id && request.idempotencyKey && request.id.toLowerCase() !== request.idempotencyKey.toLowerCase()) {
      throw new ServiceError(409, 'idempotency_key_conflict')
    }
    const body = { id: (request.id ?? request.idempotencyKey)!.toLowerCase(), restorationId: request.restorationId,
      evidenceHash: request.evidenceHash, reason: request.reason }
    const run = await deps.restorations.getById(body.restorationId)
    if (!run) throw new ServiceError(404, 'restoration_not_found')
    await enabled(run.branchId)
    const actorId = req.actor!.userId
    const requestHash = digest({ ...body, actorId })
    const result = await deps.financialUnitOfWork.run({ lockKey: `receivables:${run.branchId}`, actorId, requestId: req.requestId }, async (tx) => {
      await tx.locks.acquire(`receivables:${await companyId(tx)}`)
      await enabled(run.branchId, tx)
      const old = await tx.companyRestorationReviews.get(body.id)
      if (old) {
        if (old.requestHash !== requestHash) throw new ServiceError(409, 'idempotency_key_conflict')
        return { proposal: old, replayed: true }
      }
      if (await tx.companyRestorationReviews.getByRestoration(body.restorationId)) throw new ServiceError(409, 'restoration_already_proposed')
      const evidence = await historicalEvidence(body.restorationId, tx)
      if (evidence.evidenceHash !== body.evidenceHash) throw new ServiceError(409, 'restoration_source_changed')
      const proposal: CompanyRestorationProposal = { id: body.id, origin: 'historical', restorationId: evidence.run.id,
        branchId: evidence.run.branchId, companyBranchId: evidence.companyBranchId, businessDate: evidence.run.businessDate,
        reason: body.reason, requestHash, runNo: evidence.run.runNo, snapshot: evidence.snapshot,
        response: { restorationId: evidence.run.id, proposalId: body.id, branchStatus: 'executed', companyReviewStatus: 'pending_review' },
        legs: evidence.legs, createdBy: actorId, createdAtMs: deps.clock.nowMs() }
      await tx.companyRestorationReviews.create(proposal)
      return { proposal, replayed: false }
    })
    return reply.code(result.replayed ? 200 : 201).send({ ...await presentRestorationReview(deps, result.proposal), replayed: result.replayed })
  })
  app.get('/company/restoration-reviews/adoption-preview/:restorationId', read, async (req) => {
    const { restorationId } = z.object({ restorationId: z.coerce.number().int().positive() }).parse(req.params)
    const run = await deps.restorations.getById(restorationId)
    if (!run) throw new ServiceError(404, 'restoration_not_found')
    return deps.financialUnitOfWork.run({ lockKey: `receivables:${run.branchId}`, actorId: req.actor!.userId, requestId: req.requestId }, async (tx) => {
      await tx.locks.acquire(`receivables:${await companyId(tx)}`)
      const evidence = await historicalEvidence(restorationId, tx)
      return { restorationId, branchId: run.branchId, businessDate: run.businessDate, evidenceHash: evidence.evidenceHash,
        companyCashEffect: '0.00', branchCashEffect: '0.00',
        legs: evidence.legs.map((leg) => ({ sourceEntryId: leg.sourceEntryId, fundCode: leg.fundCode,
          direction: leg.direction, amount: serializeMoney(leg.amount) })) }
    })
  })
  app.get('/company/restoration-reviews', read, async (req) => {
    const { branchId } = z.object({ branchId: z.string().min(1).optional() }).parse(req.query)
    const companyBranchId = await companyId()
    return deps.financialUnitOfWork.run({ mode: 'read_snapshot', lockKey: `receivables:${companyBranchId}`, actorId: req.actor!.userId,
      requestId: req.requestId }, async tx => {
    const proposals = await tx.companyRestorationReviews.list(companyBranchId, branchId)
    const branches = (await tx.directory.listBranches()).filter((row) => row.kind === 'branch' && (!branchId || row.id === branchId))
    const branchNames = new Map(branches.map((row) => [row.id, row.nameAr]))
    const historical = await tx.companyLedgerSource.listHistoricalImportReceipts(companyBranchId, { from: '2000-01-01', to: todayFor(deps) })
    const summaries = await restorationReviewBalances(tx, companyBranchId)
    // Legacy cash mirrors are already posted. Show/link their receipt, never synthesize a proposal
    // or call restoration again. A run with two legs stays two immutable source links.
    const cutovers = await tx.companyLedger.listCutovers()
    const settlements = await tx.companyLedger.listHistoricalSettlements(companyBranchId, branchId)
    const mirrors = (await Promise.all(cutovers.filter((cutover) => !branchId || cutover.branchId === branchId)
      .map((cutover) => tx.companyLedger.listMirrors(cutover.branchId)))).flat()
    const unlinkedHistorical = await unlinkedHistoricalRestorations(tx,
      companyBranchId, todayFor(deps), branches)
    const isEnabled = (branchId: string) => cutovers.some(row => row.branchId === branchId && (options.enabled === true || row.mode === 'link_only'))
    return { enabled: branches.some(branch => isEnabled(branch.id)),
      branches: branches.map((branch) => {
        const summary = summaries.get(branch.id)
        return { branchId: branch.id, branchNameAr: branch.nameAr, currency: 'SYP_NEW', reviewEnabled: isEnabled(branch.id),
          pendingReviewCount: summary?.pendingReviewCount ?? 0, confirmedVarianceCount: summary?.confirmedVarianceCount ?? 0,
          unlinkedHistoricalCount: unlinkedHistorical.filter((row) => row.branchId === branch.id).length,
          pendingToCompany: serializeMoney(summary?.pendingToCompany ?? minor(0n)),
          pendingFromCompany: serializeMoney(summary?.pendingFromCompany ?? minor(0n)) }
      }),
      proposals: await Promise.all(proposals.map(async (proposal) => ({ ...await presentRestorationReview(tx, proposal),
        branchNameAr: branchNames.get(proposal.branchId) ?? proposal.branchId, reviewEnabled: isEnabled(proposal.branchId) }))),
      // Read the approved immutable grouping, never infer a match from equal dates or amounts.
      historicalGroups: settlements.flatMap(settlement => settlement.groups.map(group => ({
        restorationId: group.restorationId, branchId: settlement.sourceBranchId,
        businessDate: group.businessDate, settlementId: settlement.id,
        branchNet: serializeMoney(group.branchNet), companyNet: serializeMoney(group.companyNet),
        variance: serializeMoney(group.variance), sourceReferences: group.sourceReferences,
        branchSourceEntries: group.branchSourceEntries.map(leg => ({ ...leg, amount: serializeMoney(leg.amount) })),
      }))),
      linkedHistorical: historical.filter((row) => row.restorationId !== null && row.journalEntryId !== null &&
        row.sourceBranchId !== null && (!branchId || row.sourceBranchId === branchId)).map((row) => ({
        sourceReference: row.sourceReference, restorationId: row.restorationId, branchId: row.sourceBranchId,
        branchNameAr: branchNames.get(row.sourceBranchId!) ?? row.sourceBranchId, journalEntryId: row.journalEntryId,
        occurredOn: row.occurredOn, amount: row.amount === null ? null : serializeMoney(row.amount), currency: row.currency,
        status: 'linked_historical', description: row.description })),
      unlinkedHistorical,
      legacy: mirrors.filter((mirror) => mirror.restorationId !== null).map((mirror) => ({
        id: mirror.id, branchId: mirror.sourceBranchId, branchNameAr: branchNames.get(mirror.sourceBranchId) ?? mirror.sourceBranchId,
        restorationId: mirror.restorationId,
        sourceEntryId: mirror.sourceEntryId, journalEntryId: mirror.mirrorEntryId,
        direction: mirror.direction, amount: serializeMoney(mirror.amount), currency: 'SYP_NEW',
        status: 'posted_legacy', createdAtMs: mirror.createdAtMs,
      })),
    }
    })
  })
  app.get('/company/restoration-reviews/:id', read, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const proposal = await deps.companyRestorationReviews.get(id.toLowerCase())
    if (!proposal || proposal.companyBranchId !== await companyId()) throw new ServiceError(404, 'restoration_proposal_not_found')
    return presentRestorationReview(deps, proposal)
  })

  for (const [path, kind] of [['revisions', 'revise'], ['defer', 'defer'], ['confirm', 'confirm'], ['correct', 'correct']] as const) {
    app.post(`/company/restoration-reviews/:id/${path}`, write, async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid().transform((value) => value.toLowerCase()) }).parse(req.params)
      const retryKey = z.object({ id: z.string().uuid().optional(), idempotencyKey: z.string().uuid().optional() }).passthrough().parse(req.body)
      if (retryKey.id && retryKey.idempotencyKey && retryKey.id.toLowerCase() !== retryKey.idempotencyKey.toLowerCase()) {
        throw new ServiceError(409, 'idempotency_key_conflict')
      }
      const body = baseRequest.parse({ ...retryKey, id: retryKey.id ?? retryKey.idempotencyKey })
      const actorId = req.actor!.userId
      const requestHash = digest({ proposalId: id, kind, ...body, actorId })
      const existing = await deps.companyRestorationReviews.getRevision(body.id)
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ServiceError(409, 'idempotency_key_conflict')
        const proposal = await deps.companyRestorationReviews.get(id)
        if (!proposal) throw new ServiceError(404, 'restoration_proposal_not_found')
        return reply.code(200).send({ ...await presentRestorationReview(deps, proposal), replayed: true })
      }
      const proposal = await deps.companyRestorationReviews.get(id)
      if (!proposal || proposal.companyBranchId !== await companyId()) throw new ServiceError(404, 'restoration_proposal_not_found')
      await enabled(proposal.branchId)
      const today = todayFor(deps)
      const occurredOn = body.occurredOn ?? proposal.businessDate
      if (occurredOn < '2000-01-01' || occurredOn > today) throw new ServiceError(422, 'invalid_occurrence_date')
      // First recognition belongs to the actual cash movement's financial day. Audit creation
      // remains the real approval time. Later corrections still reverse/replace on today's day.
      const businessDate = kind === 'confirm' ? occurredOn : today
      const financial = kind === 'confirm' || kind === 'correct'
      if (financial) await assertWeekOpen(deps, proposal.companyBranchId, businessDate)
      const fxDayId = financial ? await ensureFxDay(deps, businessDate) : 0

      const replayed = await deps.financialUnitOfWork.run(
        { lockKey: `receivables:${proposal.branchId}`, actorId, requestId: req.requestId },
        async (tx: FinancialTransactionDeps) => {
          await tx.locks.acquire(`receivables:${proposal.companyBranchId}`)
          await enabled(proposal.branchId, tx)
          const prior = await tx.companyRestorationReviews.getRevision(body.id)
          if (prior) {
            if (prior.requestHash !== requestHash) throw new ServiceError(409, 'idempotency_key_conflict')
            return true
          }
          const revisions = await tx.companyRestorationReviews.listRevisions(id)
          const current = revisions.at(-1)
          if ((current?.version ?? 0) !== body.expectedVersion) throw new ServiceError(409, 'restoration_review_version_conflict')
          const previousConfirmation = [...revisions].reverse().find((revision) => revision.kind === 'confirm' || revision.kind === 'correct')
          if (kind === 'confirm' && previousConfirmation) throw new ServiceError(409, 'restoration_already_confirmed')
          if (kind === 'correct' && !previousConfirmation) throw new ServiceError(409, 'restoration_confirmation_required')
          if (kind === 'revise' && previousConfirmation) throw new ServiceError(409, 'restoration_use_correction')
          if (kind === 'defer' && previousConfirmation) throw new ServiceError(409, 'restoration_use_correction')

          const amounts = body.confirmedLegs ?? current?.legs ?? proposal.legs
          if (amounts.length !== proposal.legs.length || new Set(amounts.map((leg) => leg.sourceEntryId)).size !== amounts.length ||
            amounts.some((leg) => !proposal.legs.some((source) => source.sourceEntryId === leg.sourceEntryId))) {
            throw new ServiceError(422, 'restoration_review_legs_mismatch')
          }
          for (const source of proposal.legs) {
            const stored = await tx.ledger.findStandaloneEntry(proposal.branchId, 'restoration', source.sourceEntry.occurrenceKey)
            // A later unrelated branch movement does not change source identity. A true source
            // reversal does: hold for accountant review instead of reading today's office balance.
            const reversed = await tx.ledger.findStandaloneEntry(proposal.branchId, 'correction', `reversal-of-${source.sourceEntryId}`)
            if (!stored || journalDigest(stored) !== journalDigest(source.sourceEntry) || reversed) {
              throw new ServiceError(409, 'restoration_source_corrected', { sourceEntryId: source.sourceEntryId })
            }
            if (await tx.companyLedger.findMirrorBySource(source.sourceEntryId)) {
              throw new ServiceError(409, 'restoration_source_already_mirrored', { sourceEntryId: source.sourceEntryId })
            }
          }
          const revision: CompanyRestorationReviewRevision = {
            id: body.id, proposalId: id, version: body.expectedVersion + 1, kind, requestHash,
            reason: body.reason, occurredOn, businessDate, createdBy: actorId, createdAtMs: deps.clock.nowMs(),
            legs: amounts.map((leg) => ({ sourceEntryId: leg.sourceEntryId, amount: leg.amount, journalEntryId: null, reversalEntryId: null })),
          }
          if (financial) {
            // A correction reverses the previous HQ line set AND replaces it in one transaction.
            // No source journal is passed to ledger.post(), so branch balance cannot move again.
            for (const leg of revision.legs) {
              const source = proposal.legs.find((candidate) => candidate.sourceEntryId === leg.sourceEntryId)!
              const old = previousConfirmation?.legs.find((candidate) => candidate.sourceEntryId === leg.sourceEntryId)
              const writePosting = async (posting: Posting): Promise<number> => {
                const [entry] = await tx.ledger.post(proposal.companyBranchId, [posting], {
                  shiftId: null, businessDate, postingDate: businessDate, weekStartDate: weekStartFor(businessDate),
                  fxDayId, sypMinorPerUsd: null, createdBy: actorId, reason: body.reason,
                })
                if (!entry) throw new ServiceError(409, 'restoration_review_journal_conflict')
                return entry.id
              }
              if (kind === 'correct' && old && old.amount > 0n) {
                const previous = restorationMirror(source.direction, old.amount, proposal.branchId, source.sourceEntryId)
                leg.reversalEntryId = await writePosting({ ...previous,
                  occurrenceKey: `review-reverse:${body.id}:${source.sourceEntryId}`,
                  lines: previous.lines.map((line) => ({ ...line, side: line.side === 'D' ? 'C' as const : 'D' as const })),
                })
              }
              if (leg.amount > 0n) {
                const posting = restorationMirror(source.direction, leg.amount, proposal.branchId, source.sourceEntryId)
                leg.journalEntryId = await writePosting({ ...posting, occurrenceKey: `review:${body.id}:${source.sourceEntryId}` })
              }
            }
          }
          await tx.companyRestorationReviews.appendRevision(revision)
          return false
        },
      )
      return reply.code(replayed ? 200 : 201).send({ ...await presentRestorationReview(deps, proposal), replayed })
    })
  }
}
