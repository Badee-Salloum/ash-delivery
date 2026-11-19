import type {
  CompanyCommandRecord, CompanyMovementCorrection, CompanyMovementMetadata, CompanyMovementRecord,
  CompanyRestorationProposal, CompanyRestorationReviewRevision, JournalEntryRecord,
  CompanyHistoricalImportReceiptRecord, CompanyHistoricalSourceCorrection,
} from '@ash/contracts'
import { serializeMoney } from '@ash/contracts'
import { isCalendarDate, minor, monthEndFor, parseMinor, type Currency } from '@ash/domain'
import { currentCompanyOperation, effectiveExpenseView } from './company-movement-read.service.ts'
import { effectiveHistoricalSource } from './company-historical-source.service.ts'
import { ServiceError } from './shifts.service.ts'

export type CompanyReportView = 'as_booked' | 'current_corrected'
export type CompanyReportDateBasis = 'posting' | 'occurrence'

export interface CompanyReportSnapshot {
  movements: CompanyMovementRecord[]
  commands: CompanyCommandRecord[]
  corrections: CompanyMovementCorrection[]
  metadata: CompanyMovementMetadata[]
  /** Dates from existing debt/asset receipts; absent dates are explicitly marked as a fallback. */
  receiptOccurrences: ReadonlyMap<number, string>
  receiptSourceEntries?: ReadonlyMap<number, number>
  restorations: Array<{ proposal: CompanyRestorationProposal; revisions: CompanyRestorationReviewRevision[] }>
  historicalSources?: CompanyHistoricalImportReceiptRecord[]
  historicalSourceCorrections?: CompanyHistoricalSourceCorrection[]
}

type MoneyLine = { fundCode: string; currency: Currency; side: 'D' | 'C'; role: string | null; grossAmount: string; netAmount: string }
export interface CompanyReportRow {
  /** Audit-only annotation. Never changes immutable amounts or posting dates. */
  auditState?: 'deleted_expense' | 'expense_deletion'
  id: string
  nature: 'business_event' | 'journal_only'
  kind: string
  occurredOn: string
  occurredPrecision: 'day' | 'month'
  occurredMonth: string | null
  occurrenceSource: 'recorded' | 'posting_fallback'
  /** Current snapshots are grouped ONCE by the original posting date, not every revision date. */
  postingDate: string
  latestPostingDate: string
  canonicalCommandId: string | null
  activeCommandId: string | null
  originalEntryId: number | null
  activeEntryId: number | null
  sourceEntryId: number | null
  relatedEntryIds: number[]
  correctionIds: string[]
  version: number
  reversed: boolean
  currency: Currency | null
  grossAmount: string | null
  netAmount: string | null
  fromCurrency: Currency | null
  fromAmount: string | null
  toCurrency: Currency | null
  toAmount: string | null
  source: string | null
  branchId: string | null
  description: string
  externalReference: string | null
  receiptReference: string | null
  sypMinorPerUsd: string | null
  rateBasis: 'documented' | 'estimated' | null
  lines: MoneyLine[]
}

const moneyText = (value: bigint) => serializeMoney(minor(value))
const inRange = (day: string, from: string, to: string) => day >= from && day <= to
const branchOf = (entry: JournalEntryRecord) => {
  const code = entry.lines.find(line => line.fundCode.startsWith('branch_clearing:') ||
    line.fundCode.startsWith('historical_branch_transit:'))?.fundCode
  return code?.split(':')[1] ?? null
}
const linesOf = (entry: JournalEntryRecord, reversed = false): MoneyLine[] => entry.lines.map(line => ({
  fundCode: line.fundCode, currency: line.currency, side: line.side, role: line.role ?? null,
  grossAmount: serializeMoney(line.amount), netAmount: reversed ? '0.00' : serializeMoney(line.amount),
}))

/** A pure read projection: no writes, recosting, FX-day lookups, or historical journal replacement. */
export function companyReport(snapshot: CompanyReportSnapshot, input: {
  from: string; to: string; view: CompanyReportView; dateBasis: CompanyReportDateBasis; generatedAtMs: number; all?: boolean
}) {
  const byEntry = new Map(snapshot.movements.map(row => [row.entry.id, row.entry]))
  const commands = new Map(snapshot.commands.map(row => [row.id, row]))
  const reversalByEntry = new Map(snapshot.commands.filter(row => row.kind === 'reversal').map(row => [row.targetEntryId, row]))
  const commandByEntry = new Map(snapshot.commands.map(row => [row.journalEntryId, row]))
  const metadata = new Map(snapshot.metadata.map(row => [row.commandId, row]))
  const operationChanges = snapshot.metadata.filter(row => row.operationChange)
  const operationReplacementIds = new Set(operationChanges.flatMap(row => row.operationChange?.replacementId ? [row.operationChange.replacementId] : []))
  const confirmed = snapshot.corrections.filter(row => row.status === 'confirmed')
  const correctionEntries = new Map<number, CompanyMovementCorrection>()
  for (const row of confirmed) for (const entryId of [row.reversalEntryId, row.replacementEntryId]) {
    if (entryId !== null) correctionEntries.set(entryId, row)
  }
  const restorationEntries = new Map<number, { proposal: CompanyRestorationProposal; revision: CompanyRestorationReviewRevision }>()
  for (const { proposal, revisions } of snapshot.restorations) for (const revision of revisions) {
    for (const leg of revision.legs) for (const id of [leg.journalEntryId, leg.reversalEntryId]) {
      if (id !== null) restorationEntries.set(id, { proposal, revision })
    }
  }
  const entryRequired = (id: number) => {
    const entry = byEntry.get(id)
    if (!entry) throw new ServiceError(500, 'company_report_integrity_error')
    return entry
  }
  const base = (entry: JournalEntryRecord, command: CompanyCommandRecord | undefined,
    evidence: CompanyMovementMetadata | undefined | null): CompanyReportRow => {
    const restoration = restorationEntries.get(entry.id)
    const recorded = command?.occurredOn ?? restoration?.revision.occurredOn ?? snapshot.receiptOccurrences.get(entry.id)
      ?? (entry.eventType === 'company_custody_transfer' ? entry.businessDate : undefined)
    const correction = correctionEntries.get(entry.id)
    const canonical = correction ? commands.get(correction.targetId) : command?.kind === 'reversal' ? commands.get(command.targetId) : undefined
    const canonicalEntry = canonical ? entryRequired(canonical.journalEntryId) : entry
    const amount = command && 'amount' in command ? serializeMoney(command.amount) : null
    const historicalTransfer = entry.eventType === 'company_historical_transfer'
    const transferCashLine = historicalTransfer ? entry.lines.find(line => line.fundCode === 'company_cash:SYP_NEW') : undefined
    const transferDirection = transferCashLine?.side === 'D' ? 'to_company' : transferCashLine?.side === 'C' ? 'from_company' : null
    return {
      id: `journal:${entry.id}`, nature: command || historicalTransfer || entry.eventType === 'company_custody_transfer' ? 'business_event' : 'journal_only',
      kind: historicalTransfer ? transferCashLine?.side === 'D' ? 'branch_receipt' : 'branch_payment' : command?.kind ?? entry.eventType,
      occurredOn: recorded ?? (historicalTransfer ? entry.businessDate : entry.postingDate), occurredPrecision: evidence?.occurredPrecision ?? 'day',
      occurredMonth: evidence?.occurredMonth ?? null, occurrenceSource: recorded || historicalTransfer ? 'recorded' : 'posting_fallback',
      postingDate: entry.postingDate, latestPostingDate: entry.postingDate,
      canonicalCommandId: correction?.targetId ?? canonical?.id ?? command?.id ?? (historicalTransfer ? entry.occurrenceKey : null),
      activeCommandId: command?.id ?? (historicalTransfer ? entry.occurrenceKey : null),
      originalEntryId: canonicalEntry.id, activeEntryId: entry.id,
      sourceEntryId: restoration?.revision.legs.find(leg => leg.journalEntryId === entry.id || leg.reversalEntryId === entry.id)?.sourceEntryId ?? snapshot.receiptSourceEntries?.get(entry.id) ?? null,
      relatedEntryIds: [entry.id],
      correctionIds: correction ? [correction.id] : restoration ? [restoration.revision.id] : [],
      version: correction ? correction.targetVersion + 1 : 1, reversed: false,
      currency: historicalTransfer ? 'SYP_NEW' : command && 'currency' in command ? command.currency : null,
      grossAmount: transferCashLine ? serializeMoney(transferCashLine.amount) : amount,
      netAmount: transferCashLine ? serializeMoney(transferCashLine.amount) : amount,
      fromCurrency: command?.kind === 'exchange' ? command.fromCurrency : null,
      fromAmount: command?.kind === 'exchange' ? serializeMoney(command.fromAmount) : null,
      toCurrency: command?.kind === 'exchange' ? command.toCurrency : null,
      toAmount: command?.kind === 'exchange' ? serializeMoney(command.toAmount) : null,
      source: entry.eventType === 'company_custody_transfer' || entry.lines.some(line=>line.side==='C' && line.fundCode.startsWith('company_custody:')) ? 'owner_custody' : historicalTransfer ? transferDirection : command?.kind === 'expense' ? command.paidFrom :
        command?.kind === 'reversal' && canonical?.kind === 'expense' ? canonical.paidFrom : null,
      branchId: restoration?.proposal.branchId ?? branchOf(entry),
      description: command && 'description' in command ? command.description : command && 'reason' in command ? command.reason : entry.reason ?? '',
      externalReference: canonicalEntry.externalReference, receiptReference: evidence?.receiptReference ?? null,
      sypMinorPerUsd: entry.sypMinorPerUsd?.toString() ?? null, rateBasis: evidence?.rateBasis ?? null,
      lines: linesOf(entry),
    }
  }
  let allRows: CompanyReportRow[]
  if (input.view === 'as_booked') {
    const deleted = new Map<string, CompanyCommandRecord>()
    for (const command of snapshot.commands) {
      if (command.kind !== 'expense' || correctionEntries.has(command.journalEntryId)) continue
      const view = effectiveExpenseView(command, commands, snapshot.corrections, metadata.get(command.id) ?? null)
      const reversal = reversalByEntry.get(view.effective.journalEntryId)
      if (!reversal) continue
      for (const id of [command.id, ...view.confirmed.map(item => item.replacementId).filter((id): id is string => id !== null)]) deleted.set(id, reversal)
    }
    // The raw mode retains every entry, every line, original dates/rate, and correction legs.
    allRows = snapshot.movements.map(({ entry }) => {
      const command = commandByEntry.get(entry.id)
      const row = base(entry, command, command ? metadata.get(command.id) : null)
      const deletion = command ? deleted.get(command.id) : undefined
      if (deletion) {
        row.auditState = 'deleted_expense'
        row.relatedEntryIds.push(deletion.journalEntryId)
      } else if (command?.kind === 'reversal' && deleted.get(command.targetId)?.id === command.id) row.auditState = 'expense_deletion'
      return row
    })
  } else {
    allRows = []
    for (const { entry } of snapshot.movements) {
      const command = commandByEntry.get(entry.id)
      if (correctionEntries.has(entry.id) || restorationEntries.has(entry.id) || command?.kind === 'reversal' || command && operationReplacementIds.has(command.id)) continue
      const row = base(entry, command, command ? metadata.get(command.id) : null)
      if (command?.kind === 'expense') {
        const view = effectiveExpenseView(command, commands, snapshot.corrections, metadata.get(command.id) ?? null)
        const active = entryRequired(view.effective.journalEntryId)
        const reversal = reversalByEntry.get(active.id)
        const reversed = reversal !== undefined
        Object.assign(row, {
          id: `command:${command.id}`, activeCommandId: view.effective.id, activeEntryId: active.id,
          latestPostingDate: reversal ? entryRequired(reversal.journalEntryId).postingDate : active.postingDate, occurredOn: view.wire.occurredOn,
          occurredPrecision: view.metadata?.occurredPrecision ?? 'day', occurredMonth: view.metadata?.occurredMonth ?? null,
          receiptReference: view.metadata?.receiptReference ?? null, sypMinorPerUsd: view.wire.sypMinorPerUsd,
          rateBasis: view.metadata?.rateBasis ?? null, grossAmount: view.wire.amount, netAmount: reversed ? '0.00' : view.wire.amount,
          currency: view.wire.currency, source: view.wire.paidFrom, description: view.wire.description,
          version: view.version, reversed, correctionIds: view.confirmed.map(item => item.id),
          relatedEntryIds: [entry.id, ...view.confirmed.flatMap(item => [item.reversalEntryId, item.replacementEntryId].filter((id): id is number => id !== null)), ...(reversal ? [reversal.journalEntryId] : [])],
          lines: linesOf(active, reversed),
        })
      } else if (command) {
        const activeCommand = currentCompanyOperation(command, commands, snapshot.metadata)
        if (activeCommand === null) continue
        const activeEntry = entryRequired(activeCommand.journalEntryId)
        const related: number[] = [entry.id], changeIds: string[] = []
        let targetId = command.id
        for (;;) {
          const receipt = operationChanges.find(item => item.operationChange?.targetId === targetId)
          if (!receipt?.operationChange?.replacementId) break
          const undo = commands.get(receipt.commandId), replacement = commands.get(receipt.operationChange.replacementId)
          if (!undo || !replacement) throw new ServiceError(500, 'company_report_integrity_error')
          related.push(undo.journalEntryId, replacement.journalEntryId); changeIds.push(receipt.commandId)
          targetId = replacement.id
        }
        if (activeCommand.id !== command.id) {
          const activeRow = base(activeEntry, activeCommand, metadata.get(activeCommand.id))
          Object.assign(row, activeRow, { canonicalCommandId: command.id, originalEntryId: entry.id, postingDate: entry.postingDate,
            relatedEntryIds: related, correctionIds: changeIds, version: changeIds.length + 1, externalReference: entry.externalReference })
        }
        const reversal = reversalByEntry.get(activeEntry.id)
        row.id = `command:${command.id}`
        if (reversal) {
          row.reversed = true; row.netAmount = row.grossAmount === null ? null : '0.00'
          row.lines = linesOf(entry, true); row.relatedEntryIds.push(reversal.journalEntryId)
          row.latestPostingDate = entryRequired(reversal.journalEntryId).postingDate
        }
      }
      // Operational reports have no deleted expense, even for a period before its reversal.
      // The immutable original and reversal remain available exclusively in the audit view.
      if (!row.reversed) allRows.push(row)
    }
    // Review proposals are not cash. A confirmed restoration leg is ONE current event, including
    // a confirmed zero, never one row for every confirmation/reversal/replacement.
    for (const { proposal, revisions } of snapshot.restorations) {
      const confirmations = revisions.filter(row => row.kind === 'confirm' || row.kind === 'correct')
      const first = confirmations[0], latest = confirmations.at(-1)
      if (!first || !latest) continue
      for (const source of proposal.legs) {
        const current = latest.legs.find(leg => leg.sourceEntryId === source.sourceEntryId)
        if (!current) throw new ServiceError(500, 'company_report_integrity_error')
        const ids = confirmations.flatMap(revision => revision.legs.filter(leg => leg.sourceEntryId === source.sourceEntryId)
          .flatMap(leg => [leg.journalEntryId, leg.reversalEntryId].filter((id): id is number => id !== null)))
        const firstId = ids[0] ?? null
        const activeId = current.journalEntryId
        const active = current.journalEntryId === null ? null : entryRequired(current.journalEntryId)
        allRows.push({
          id: `restoration:${proposal.id}:${source.sourceEntryId}`, nature: 'business_event', kind: 'company_restoration_mirror',
          occurredOn: latest.occurredOn, occurredPrecision: 'day', occurredMonth: null, occurrenceSource: 'recorded',
          postingDate: first.businessDate, latestPostingDate: latest.businessDate, canonicalCommandId: proposal.id,
          activeCommandId: latest.id, originalEntryId: firstId, activeEntryId: activeId, sourceEntryId: source.sourceEntryId, relatedEntryIds: ids,
          correctionIds: confirmations.map(revision => revision.id), version: latest.version, reversed: false,
          currency: 'SYP_NEW', grossAmount: serializeMoney(current.amount), netAmount: serializeMoney(current.amount),
          fromCurrency: null, fromAmount: null, toCurrency: null, toAmount: null,
          source: source.direction, branchId: proposal.branchId, description: latest.reason,
          externalReference: null, receiptReference: null, sypMinorPerUsd: null, rateBasis: null,
          lines: active ? linesOf(active) : [],
        })
      }
    }
  }
  if (input.view === 'current_corrected') {
    // Administrative metadata may be corrected without rewriting the immutable cash journal.
    // Cash-backed sources cannot change amount/currency or be excluded by this route.
    const sources = new Map((snapshot.historicalSources ?? []).map(source=>[source.sourceReference, source]))
    for (const row of allRows) {
      // A subsequent financial edit owns the effective occurrence/description. Older imported
      // source annotations must not overwrite the reviewed replacement on current reports.
      if (row.correctionIds.some(id => metadata.get(id)?.operationChange)) continue
      const source = row.externalReference === null ? undefined : sources.get(row.externalReference)
      if (!source) continue
      const current = effectiveHistoricalSource(source, snapshot.historicalSourceCorrections ?? [])
      row.occurredOn = current.occurredOn
      row.description = current.description
      row.occurrenceSource = 'recorded'
      row.correctionIds.push(...current.correctionIds)
      row.version += current.version - 1
    }
  }
  let availableFrom = allRows.reduce<string | null>((earliest, row) => {
    const day = input.dateBasis === 'posting' ? row.postingDate : row.occurredOn
    return earliest === null || day < earliest ? day : earliest
  }, null)
  if (input.all) {
    // The all-history screen also contains the separate current owner-information panel.
    // Its administrative evidence may predate the first HQ journal, including an existing
    // branch receipt whose source occurrence differs from its later system posting date.
    // Month-only imported evidence is already anchored to the month's first day in occurredOn.
    // Widen only the displayed range; these sources must never become GL rows or cash/P&L.
    for (const source of snapshot.historicalSources ?? []) {
      const current = effectiveHistoricalSource(source, snapshot.historicalSourceCorrections ?? [])
      if (current.excluded || current.paidFrom !== 'owner_outside' || current.currency === null ||
        current.amount === null || current.amount <= 0n ||
        !['expense', 'asset_payment', 'branch_payment'].includes(current.movementType)) continue
      const day = current.occurredOn
      if (!isCalendarDate(day) || day < '2000-01-01' || day > input.to) continue
      if (availableFrom === null || day < availableFrom) availableFrom = day
    }
  }
  const from = input.all ? availableFrom ?? input.to : input.from
  const rows = allRows.filter(row => input.dateBasis === 'posting' ? inRange(row.postingDate, from, input.to)
    : row.occurredOn <= input.to && (row.occurredPrecision === 'month' ? monthEndFor(row.occurredOn) : row.occurredOn) >= from)
    .sort((a, b) => (input.dateBasis === 'posting' ? a.postingDate.localeCompare(b.postingDate) : a.occurredOn.localeCompare(b.occurredOn)) || (a.originalEntryId ?? 0) - (b.originalEntryId ?? 0))
  const totals = { SYP_NEW: { debits: 0n, credits: 0n, cashNet: 0n, cashReceipts: 0n, cashPayments: 0n, income: 0n, expense: 0n, companyFundedExpense: 0n, ownerOutsideExpense: 0n },
    USD: { debits: 0n, credits: 0n, cashNet: 0n, cashReceipts: 0n, cashPayments: 0n, income: 0n, expense: 0n, companyFundedExpense: 0n, ownerOutsideExpense: 0n } }
  const cashBalances = { SYP_NEW: { opening: 0n, closing: 0n }, USD: { opening: 0n, closing: 0n } }
  const custodyBalances = { SYP_NEW: { opening: 0n, closing: 0n }, USD: { opening: 0n, closing: 0n } }
  for (const row of allRows) {
    const day = input.dateBasis === 'posting' ? row.postingDate : row.occurredOn
    const beforeDay = input.dateBasis === 'occurrence' && row.occurredPrecision === 'month' ? monthEndFor(day) : day
    for (const line of row.lines) if (line.fundCode === `company_cash:${line.currency}` || line.fundCode === `company_custody:${line.currency}`) {
      const balances = line.fundCode.startsWith('company_custody:') ? custodyBalances : cashBalances
      const signed = parseMinor(line.netAmount) * (line.side === 'D' ? 1n : -1n)
      if (beforeDay < from) balances[line.currency].opening += signed
      if (beforeDay < from || day <= input.to && beforeDay >= from) balances[line.currency].closing += signed
    }
  }
  for (const row of rows) {
    for (const line of row.lines) {
      const value = parseMinor(line.netAmount), signed = line.side === 'D' ? value : -value, total = totals[line.currency]
      total[line.side === 'D' ? 'debits' : 'credits'] += value
      if (line.fundCode === `company_cash:${line.currency}`) {
        total.cashNet += signed
        total[line.side === 'D' ? 'cashReceipts' : 'cashPayments'] += value
      }
      if (line.fundCode.startsWith('company_income:')) total.income -= signed
      if (line.fundCode.startsWith('company_expense:')) total.expense += signed
    }
    // Only actual expense commands are classified by payment source; debt/writeoff costs remain
    // separate book facts, never silently relabeled as a company cash payment.
    const command = row.activeEntryId === null ? undefined : commandByEntry.get(row.activeEntryId)
    const expense = command?.kind === 'expense' ? command : command?.kind === 'reversal' && command.targetKind === 'expense' ? commands.get(command.targetId) : undefined
    if (expense?.kind === 'expense') {
      const cost = row.lines.filter(line => line.fundCode.startsWith('company_expense:'))
        .reduce((sum, line) => sum + (line.side === 'D' ? parseMinor(line.netAmount) : -parseMinor(line.netAmount)), 0n)
      totals[expense.currency][expense.paidFrom === 'owner_outside' ? 'ownerOutsideExpense' : 'companyFundedExpense'] += cost
    }
  }
  return {
    ...input, from, availableFrom, scope: 'company_hq', currencyUnit: 'SYP_NEW',
    custodyBalances: Object.fromEntries((['SYP_NEW', 'USD'] as const).map(currency => [currency, {
      opening: moneyText(custodyBalances[currency].opening), closing: moneyText(custodyBalances[currency].closing),
    }])),
    cashBalances: Object.fromEntries((['SYP_NEW', 'USD'] as const).map(currency => [currency, {
      opening: moneyText(cashBalances[currency].opening), closing: moneyText(cashBalances[currency].closing),
    }])),
    periodSemantics: input.view === 'as_booked' ? 'immutable_journals' : 'current_snapshot_original_posting_anchor',
    totals: Object.fromEntries((['SYP_NEW', 'USD'] as const).map(currency => [currency, {
      ...Object.fromEntries(Object.entries(totals[currency]).map(([key, value]) => [key, moneyText(value)])) as Record<keyof typeof totals.SYP_NEW, string>,
      otherBookExpense: moneyText(totals[currency].expense - totals[currency].companyFundedExpense - totals[currency].ownerOutsideExpense),
    }])), rows, occurrenceFallbackCount: rows.filter(row => row.occurrenceSource === 'posting_fallback').length,
    journalOnlyCount: rows.filter(row => row.nature === 'journal_only').length,
    pendingRestorationCount: snapshot.restorations.filter(({ proposal, revisions }) => inRange(proposal.businessDate, from, input.to) && !revisions.some(row => row.kind === 'confirm' || row.kind === 'correct')).length,
    /** These are cards, not GL-recognized book costs. No historical cost policy is inferred. */
    historicalBookCostPolicy: 'not_reclassified',
    ownerInformation: { endpoint: '/company/owner-payments', dateBasis: 'occurrence', separateFromHqCash: true },
  }
}
