import type {
  CompanyCommandRecord, CompanyExpenseCorrectionValues, CompanyExpenseRecord, CompanyMovementCorrection,
  CompanyMovementMetadata, FinancialTransactionDeps, JournalEntryRecord, BranchRecord, Deps,
} from '@ash/contracts'
import { serializeMoney } from '@ash/contracts'
import { type Currency, type Minor, minor } from '@ash/domain'
import { ServiceError } from './shifts.service.ts'

/** Follow audited direct edit receipts; a final deletion resolves to null. */
export function currentCompanyOperation(original: CompanyCommandRecord, commands: ReadonlyMap<string, CompanyCommandRecord>,
  metadata: readonly CompanyMovementMetadata[]): CompanyCommandRecord | null {
  let current = original
  const seen = new Set<string>()
  for (;;) {
    if (seen.has(current.id)) throw new ServiceError(500, 'company_correction_integrity_error')
    seen.add(current.id)
    const receipt = metadata.find(row => row.operationChange?.targetId === current.id)?.operationChange
    if (!receipt) return current
    if (receipt.action === 'delete') return null
    const next = receipt.replacementId ? commands.get(receipt.replacementId) : null
    if (!next || next.branchId !== original.branchId || next.kind !== original.kind) throw new ServiceError(500, 'company_correction_integrity_error')
    current = next
  }
}

/** Replacement commands are ledger legs, never fresh business-event identities. */
export function originalCorrectionTargetId(targetId: string, corrections: readonly CompanyMovementCorrection[],
  parents: ReadonlyMap<string, string> = new Map(corrections.filter((row) => row.status === 'confirmed' && row.financial)
    .map((row) => [row.replacementId, row.targetId])),
): string {
  let current = targetId
  const seen = new Set<string>()
  while (true) {
    if (seen.has(current)) throw new ServiceError(500, 'company_correction_integrity_error')
    seen.add(current)
    const parent = parents.get(current)
    if (!parent) return current
    current = parent
  }
}

export function assertOriginalCorrectionTarget(targetId: string, corrections: readonly CompanyMovementCorrection[]): void {
  const parents = new Map(corrections.filter((row) => row.status === 'confirmed' && row.financial)
    .map((row) => [row.replacementId, row.targetId]))
  const originalTargetId = originalCorrectionTargetId(targetId, corrections, parents)
  if (originalTargetId !== targetId) {
    throw new ServiceError(409, 'company_correction_original_target_required', { originalTargetId })
  }
  // Pre-deployment/local malformed histories must fail closed, not disappear from owner totals.
  // No journal is changed to repair such a chain implicitly.
  const noncanonical = corrections.find((row) => row.status === 'confirmed' && row.targetId !== targetId &&
    originalCorrectionTargetId(row.targetId, corrections, parents) === targetId)
  if (noncanonical) {
    throw new ServiceError(409, 'company_correction_noncanonical_history', { originalTargetId: targetId,
      correctionId: noncanonical.id })
  }
}

/** A confirmed view overlays metadata only; original accounting facts remain immutable. */
export function effectiveExpenseView(
  original: CompanyExpenseRecord, commands: ReadonlyMap<string, CompanyCommandRecord>,
  corrections: readonly CompanyMovementCorrection[], metadata: CompanyMovementMetadata | null,
) {
  assertOriginalCorrectionTarget(original.id, corrections)
  const confirmed = corrections.filter((row) => row.targetId === original.id && row.status === 'confirmed')
    .sort((a, b) => a.targetVersion - b.targetVersion)
  let effective = original
  let values: CompanyExpenseCorrectionValues | null = null
  for (const row of confirmed) {
    if (row.financial) {
      const command = commands.get(row.replacementId)
      if (!command || command.kind !== 'expense') throw new Error('company correction replacement missing')
      effective = command
    }
    values = row.values
  }
  const currentMetadata = values === null ? metadata : {
    commandId: effective.id, branchId: original.branchId, occurredPrecision: values.occurredPrecision,
    occurredMonth: values.occurredMonth, rateBasis: values.rateBasis, sourceUnit: values.sourceUnit,
    receiptReference: values.receiptReference, intakeSessionId: metadata?.intakeSessionId ?? null,
  }
  const wire = { ...effective, ...(values ?? {}), amount: values?.amount ?? serializeMoney(effective.amount),
    sypMinorPerUsd: values === null ? effective.sypMinorPerUsd?.toString() ?? null : values.sypMinorPerUsd }
  const last = confirmed.at(-1) ?? null
  return { effective, wire, metadata: currentMetadata, version: confirmed.length + 1, confirmed,
    correction: last === null ? null : { id: last.id, confirmedAtMs: last.confirmedAtMs, financial: last.financial,
      reversalEntryId: last.reversalEntryId, replacementEntryId: last.replacementEntryId } }
}

/**
 * Source split of the EXACT posting-period expense net. A current correction does not silently
 * restate the old closed period: reverse the old source today, charge the replacement source
 * today. Full-period totals count the effective expense once, including plain reversals.
 */
export async function expenseSourceBreakdown(
  repo: Pick<FinancialTransactionDeps, 'companyLedger'>, branchId: string, from: string, to: string,
): Promise<Record<Currency, { companyFundedExpense: Minor; ownerOutsideExpense: Minor }>> {
  const all = await repo.companyLedger.listCommands(branchId)
  const byId = new Map(all.map((command) => [command.id, command]))
  const result = { SYP_NEW: { companyFundedExpense: 0n, ownerOutsideExpense: 0n },
    USD: { companyFundedExpense: 0n, ownerOutsideExpense: 0n } }
  for (const command of all) {
    if (command.businessDate < from || command.businessDate > to) continue
    const expense = command.kind === 'expense' ? command
      : command.kind === 'reversal' && command.targetKind === 'expense' ? byId.get(command.targetId) : null
    if (!expense || expense.kind !== 'expense') continue
    const sign = command.kind === 'reversal' ? -1n : 1n
    const key = expense.paidFrom === 'owner_outside' ? 'ownerOutsideExpense' : 'companyFundedExpense'
    result[expense.currency][key] += expense.amount * sign
  }
  return { SYP_NEW: { companyFundedExpense: minor(result.SYP_NEW.companyFundedExpense), ownerOutsideExpense: minor(result.SYP_NEW.ownerOutsideExpense) },
    USD: { companyFundedExpense: minor(result.USD.companyFundedExpense), ownerOutsideExpense: minor(result.USD.ownerOutsideExpense) } }
}

/** Existing owner money received by an office is funding, never an HQ expense or deposit. */
export async function ownerBranchFundingRead(
  repo: Pick<FinancialTransactionDeps, 'ledger'>, branches: readonly BranchRecord[],
  from: string, to: string, today: string,
) {
  const totals = { SYP_NEW: 0n, USD: 0n }
  const payments: Array<Record<string, unknown>> = []
  for (const branch of branches.filter((row) => row.kind === 'branch')) {
    // Read immutable receipts through the existing cursor port. No branch money lock is taken
    // after HQ's lock (branch writers acquire branch -> HQ); this read never writes either book.
    const entries = new Map<number, JournalEntryRecord>()
    for (const eventType of ['manual', 'correction'] as const) {
      let beforeId: number | undefined
      do {
        const page = await repo.ledger.listTreasuryMovements(branch.id, {
          from: '2000-01-01', to: today, eventType, limit: 500, ...(beforeId === undefined ? {} : { beforeId }),
        })
        for (const entry of page.entries) {
          if (entry.branchId === branch.id && entry.businessDate <= today) entries.set(entry.id, entry)
        }
        if (page.nextBeforeId === null) break
        if (beforeId !== undefined && page.nextBeforeId >= beforeId) throw new ServiceError(500, 'owner_funding_cursor_invalid')
        beforeId = page.nextBeforeId
      } while (true)
    }
    const direct = (entry: JournalEntryRecord) => {
      if (entry.eventType !== 'manual' || entry.shiftId !== null || entry.lines.length !== 2) return null
      const office = entry.lines.find((line) => line.side === 'D' &&
        (line.fundCode === 'office_cash' || line.fundCode === 'office_wallet'))
      const owner = entry.lines.find((line) => line.side === 'C' && line.fundCode === 'cost_center:owner_funding')
      if (!office || !owner || office.amount <= 0n || office.amount !== owner.amount || office.currency !== owner.currency) return null
      return office
    }
    const inverseOf = (entry: JournalEntryRecord, original: JournalEntryRecord): boolean => {
      const signature = (row: JournalEntryRecord, invert: boolean) => row.lines.map((line) =>
        `${line.fundCode}|${invert ? (line.side === 'D' ? 'C' : 'D') : line.side}|${line.currency}|${line.amount}`,
      ).sort().join('\n')
      return entry.shiftId === null && entry.lines.length === original.lines.length &&
        signature(entry, false) === signature(original, true)
    }
    const roots = new Map<number, { originalId: number; sign: bigint } | null>()
    const resolve = (entry: JournalEntryRecord, seen = new Set<number>()): { originalId: number; sign: bigint } | null => {
      if (roots.has(entry.id)) return roots.get(entry.id) ?? null
      if (seen.has(entry.id)) return null
      if (direct(entry)) {
        const result = { originalId: entry.id, sign: 1n }; roots.set(entry.id, result); return result
      }
      const source = entry.eventType === 'correction' ? /^reversal-of-(\d+)$/.exec(entry.occurrenceKey) : null
      const original = source ? entries.get(Number(source[1])) : undefined
      if (!original || original.id >= entry.id || !inverseOf(entry, original)) { roots.set(entry.id, null); return null }
      const parent = resolve(original, new Set([...seen, entry.id]))
      const result = parent === null ? null : { originalId: parent.originalId, sign: -parent.sign }
      roots.set(entry.id, result)
      return result
    }
    const net = new Map<number, { amount: bigint; entryIds: number[] }>()
    for (const entry of entries.values()) {
      const resolved = resolve(entry)
      if (!resolved) continue
      const office = direct(entries.get(resolved.originalId)!)!
      const held = net.get(resolved.originalId) ?? { amount: 0n, entryIds: [] }
      held.amount += office.amount * resolved.sign
      held.entryIds.push(entry.id)
      net.set(resolved.originalId, held)
    }
    for (const [originalId, value] of net) {
      const original = entries.get(originalId)!, office = direct(original)!
      if (value.amount === 0n || original.businessDate < from || original.businessDate > to) continue
      totals[office.currency] += value.amount
      payments.push({ id: `branch-funding:${branch.id}:${original.id}`, kind: 'branch_funding',
        branchId: branch.id, branchNameAr: branch.nameAr, channel: office.fundCode === 'office_wallet' ? 'wallet' : 'cash',
        currency: office.currency, amount: serializeMoney(minor(value.amount)), originalAmount: serializeMoney(office.amount),
        occurredOn: original.businessDate, businessDate: original.businessDate, postingDate: original.postingDate,
        description: original.reason ?? '', journalEntryId: original.id, journalEntryIds: value.entryIds.sort((a, b) => a - b),
        paidFrom: 'owner_outside', createdBy: original.createdBy, companyCashEffect: '0.00', expenseEffect: '0.00' })
    }
  }
  return { totals: { SYP_NEW: serializeMoney(minor(totals.SYP_NEW)), USD: serializeMoney(minor(totals.USD)) },
    payments: payments.sort((a, b) => String(a.occurredOn).localeCompare(String(b.occurredOn)) || Number(a.journalEntryId) - Number(b.journalEntryId)) }
}

export interface RestorationReviewBalance {
  pendingRestorationDifference: Minor
  pendingReviewCount: number
  confirmedVarianceCount: number
  pendingToCompany: Minor
  pendingFromCompany: Minor
  /** Disclosed historical branch/HQ amount variance; no balancing cash or profit entry. */
  historicalSettlementDifference?: Minor
}

/** Existing branch runs are a separate review queue, never fabricated cash receipts. */
export async function unlinkedHistoricalRestorations(
  repo: Pick<Deps, 'restorations' | 'companyLedger' | 'companyRestorationReviews' | 'companyLedgerSource'>,
  companyBranchId: string, today: string, branches: readonly BranchRecord[],
) {
  const [cutovers, proposals, historical] = await Promise.all([
    repo.companyLedger.listCutovers(), repo.companyRestorationReviews.list(companyBranchId),
    repo.companyLedgerSource.listHistoricalImportReceipts(companyBranchId, { from: '2000-01-01', to: today }),
  ])
  const mirrors = (await Promise.all(cutovers.filter(row => branches.some(branch => branch.id === row.branchId))
    .map(row => repo.companyLedger.listMirrors(row.branchId)))).flat()
  return (await Promise.all(branches.filter(branch => branch.kind === 'branch').map(async branch => {
    const runs = await repo.restorations.list(branch.id), cutover = cutovers.find(row => row.branchId === branch.id)
    return runs.filter(run => {
      const ids = (run.plan as { restorationJournalEntryIds?: number[] })?.restorationJournalEntryIds
      return (!cutover || cutover.mode === 'link_only') && Array.isArray(ids) && ids.length > 0 &&
        ids.every(id => !cutover || id <= cutover.watermarkEntryId) &&
        !proposals.some(row => row.restorationId === run.id) && !mirrors.some(row => row.restorationId === run.id) &&
        !historical.some(row => row.restorationId === run.id && row.sourceBranchId === branch.id && row.journalEntryId !== null)
    }).map(run => ({ restorationId: run.id, branchId: branch.id, branchNameAr: branch.nameAr,
      businessDate: run.businessDate, netToCompany: serializeMoney(run.netToCompany), status: 'unlinked_legacy',
      activationRequired: !cutover, reason: run.reason }))
  }))).flat()
}

/** All-time settlement evidence: a date filter must not manufacture a clearing discrepancy. */
export async function restorationReviewBalances(
  repo: Pick<FinancialTransactionDeps, 'companyRestorationReviews' | 'companyLedger'>, companyBranchId: string,
): Promise<Map<string, RestorationReviewBalance>> {
  const proposals = await repo.companyRestorationReviews.list(companyBranchId)
  const reviews = await Promise.all(proposals.map(async (proposal) => {
    const revisions = await repo.companyRestorationReviews.listRevisions(proposal.id)
    const confirmed = revisions.filter((row) => row.kind === 'confirm' || row.kind === 'correct')
      .sort((a, b) => b.version - a.version)[0]
    let difference = 0n
    let matched = confirmed !== undefined
    for (const source of proposal.legs) {
      const actual = confirmed?.legs.find((leg) => leg.sourceEntryId === source.sourceEntryId)?.amount ?? 0n
      difference += (source.direction === 'to_company' ? 1n : -1n) * (source.amount - actual)
      if (actual !== source.amount) matched = false
    }
    return { branchId: proposal.branchId, difference, pending: confirmed === undefined, variance: confirmed !== undefined && !matched,
      toCompany: proposal.legs.filter((leg) => leg.direction === 'to_company').reduce((sum, leg) => sum + leg.amount, 0n),
      fromCompany: proposal.legs.filter((leg) => leg.direction === 'from_company').reduce((sum, leg) => sum + leg.amount, 0n) }
  }))
  const result = new Map<string, RestorationReviewBalance>()
  for (const row of reviews) {
    const held = result.get(row.branchId) ?? { pendingRestorationDifference: minor(0n), pendingReviewCount: 0, confirmedVarianceCount: 0,
      pendingToCompany: minor(0n), pendingFromCompany: minor(0n) }
    held.pendingRestorationDifference = minor(held.pendingRestorationDifference + row.difference)
    held.pendingReviewCount += row.pending ? 1 : 0
    held.confirmedVarianceCount += row.variance ? 1 : 0
    if (row.pending) {
      held.pendingToCompany = minor(held.pendingToCompany + row.toCompany)
      held.pendingFromCompany = minor(held.pendingFromCompany + row.fromCompany)
    }
    result.set(row.branchId, held)
  }
  const historical = await repo.companyLedger.listHistoricalSettlements(companyBranchId)
  for (const settlement of historical) {
    const held = result.get(settlement.sourceBranchId) ?? { pendingRestorationDifference: minor(0n), pendingReviewCount: 0,
      confirmedVarianceCount: 0, pendingToCompany: minor(0n), pendingFromCompany: minor(0n) }
    held.historicalSettlementDifference = minor((held.historicalSettlementDifference ?? 0n) +
      settlement.groups.reduce((sum, group) => sum + group.variance, 0n))
    held.confirmedVarianceCount += settlement.groups.filter(group => group.variance !== 0n).length
    result.set(settlement.sourceBranchId, held)
  }
  return result
}

export function presentRestorationBalance(
  companyBox: Minor, clearing: Minor, review?: RestorationReviewBalance, cutOver = true, unlinkedHistoricalCount = 0,
) {
  const pendingRestorationDifference = review?.pendingRestorationDifference ?? minor(0n)
  const historicalSettlementDifference = review?.historicalSettlementDifference ?? minor(0n)
  const unexplainedDifference = minor(companyBox + clearing - pendingRestorationDifference - historicalSettlementDifference)
  const pendingReviewCount = review?.pendingReviewCount ?? 0
  const confirmedVarianceCount = review?.confirmedVarianceCount ?? 0
  const balanced = unexplainedDifference === 0n
  const settlementStatus = !cutOver ? 'not_linked' : !balanced || confirmedVarianceCount > 0 ? 'variance'
    : pendingReviewCount > 0 || unlinkedHistoricalCount > 0 ? 'waiting_review' : 'matched'
  return { balanced: settlementStatus === 'matched', totalDifference: serializeMoney(minor(companyBox + clearing)),
    pendingRestorationDifference: serializeMoney(pendingRestorationDifference),
    historicalSettlementDifference: serializeMoney(historicalSettlementDifference),
    unexplainedDifference: serializeMoney(unexplainedDifference), settlementStatus,
    pendingReviewCount, confirmedVarianceCount, unlinkedHistoricalCount,
    pendingToCompany: serializeMoney(review?.pendingToCompany ?? minor(0n)),
    pendingFromCompany: serializeMoney(review?.pendingFromCompany ?? minor(0n)) }
}
