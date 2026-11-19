import type {
  CalendarDate,
  CompanyPaidFrom,
  Currency,
  Minor,
  MirrorDirection,
} from '@ash/domain'
import type { FinancialTransactionDeps, JournalEntryRecord } from './ports.ts'

/**
 * «صندوق الشركة» — the company ledger's command records and read model (finance redesign C2).
 *
 * Every record mirrors one row of migration 0067. A command's `id` is the client's idempotency key
 * AND the journal occurrence key; its `journalEntryId` is the one entry the row is the fact of. The
 * database guard checks the pair line for line; the memory adapter trusts the caller, which is why
 * the PostgreSQL tests are the proof.
 */

interface CompanyCommandBase {
  /** Client UUID = idempotency key = journal occurrence key. */
  id: string
  /** The company (HQ) row. */
  branchId: string
  /** The day it really happened; never after `businessDate`. */
  occurredOn: CalendarDate
  /** The day it was booked — today, the entry's business and posting date. */
  businessDate: CalendarDate
  journalEntryId: number
  createdBy: string
  createdAtMs: number
}

/** «إيداع المالك» / «سحب المالك» — `company_moves`. */
export interface CompanyMoveRecord extends CompanyCommandBase {
  kind: 'deposit' | 'withdrawal'
  /** deposit ⇒ owner_funding | opening; withdrawal ⇒ owner_drawings. */
  equityAccount: 'owner_funding' | 'owner_drawings' | 'opening'
  currency: Currency
  amount: Minor
  /** Frozen on the row and the entry; non-null exactly for USD. */
  sypMinorPerUsd: bigint | null
  reason: string
}

/** «صرفية الشركة» — `company_expenses`. */
export interface CompanyExpenseRecord extends CompanyCommandBase {
  kind: 'expense'
  currency: Currency
  amount: Minor
  sypMinorPerUsd: bigint | null
  categoryId: string
  costCenterKind: 'general' | 'vehicle' | 'asset'
  vehicleId: string | null
  assetId: string | null
  paidFrom: CompanyPaidFrom
  receiptMediaId: string | null
  description: string
}

/** «مدخول الشركة» — `company_incomes`. */
export interface CompanyIncomeRecord extends CompanyCommandBase {
  kind: 'income'
  currency: Currency
  amount: Minor
  sypMinorPerUsd: bigint | null
  categoryId: string
  description: string
}

/** «تصريف عملة» — `company_fx_exchanges`. Both actual amounts; the rate they imply, frozen. */
export interface CompanyExchangeRecord extends CompanyCommandBase {
  kind: 'exchange'
  fromCurrency: Currency
  fromAmount: Minor
  toCurrency: Currency
  toAmount: Minor
  sypMinorPerUsd: bigint
  reason: string
}

export type CompanyReversalTargetKind = 'move' | 'expense' | 'income' | 'exchange'

/** «عكس» — `company_reversals`: the exact inverse of one command, at its frozen rate. */
export interface CompanyReversalRecord extends CompanyCommandBase {
  kind: 'reversal'
  targetKind: CompanyReversalTargetKind
  targetId: string
  targetEntryId: number
  sypMinorPerUsd: bigint | null
  reason: string
}

export type CompanyCommandRecord =
  | CompanyMoveRecord
  | CompanyExpenseRecord
  | CompanyIncomeRecord
  | CompanyExchangeRecord
  | CompanyReversalRecord

/** Which reversal target kind a command is, or null for a command nothing may reverse. */
export function reversalTargetKindOf(command: CompanyCommandRecord): CompanyReversalTargetKind | null {
  switch (command.kind) {
    case 'deposit':
    case 'withdrawal':
      return 'move'
    case 'expense':
    case 'income':
    case 'exchange':
      return command.kind
    case 'reversal':
      return null
  }
}

/** `company_ledger_cutovers` — one per branch, ever. */
export interface CompanyCutoverRecord {
  branchId: string
  companyBranchId: string
  /** Frozen branch company_box balance. A link-only transition does NOT transfer this cash. */
  openingAmount: Minor
  /** Old transitions may have an opening transfer; every link-only transition leaves this null. */
  openingEntryId: number | null
  /** Absent on legacy callers means the old, already posted cash-opening workflow. */
  mode?: 'cash_opening' | 'link_only'
  /** Frozen, disclosed unmatched starting difference; never a balancing cash entry. */
  baselineDifference?: Minor
  /** max(journal_entries.id) read under the locks. Every company_box line after it is mirrored. */
  watermarkEntryId: number
  businessDate: CalendarDate
  reason: string
  performedBy: string
  performedAtMs: number
}

/** `company_restoration_mirrors` — the HQ half of a branch company_box movement after cutover. */
export interface CompanyMirrorRecord {
  id: string
  sourceBranchId: string
  sourceEntryId: number
  mirrorEntryId: number
  direction: MirrorDirection
  amount: Minor
  /** The ترميم run the source belongs to; null for any other company_box movement. */
  restorationId: number | null
  createdBy: string
  createdAtMs: number
}

/** One verified historical HQ transfer reclassified without replaying its cash movement. */
export interface CompanyHistoricalRestorationSettlementLeg {
  restorationId: number
  sourceReference: string
  historicalJournalEntryId: number
  direction: MirrorDirection
  amount: Minor
  /** New HQ entry, containing only historical_branch_transit and branch_clearing. */
  journalEntryId: number
}

/** A whole restoration run: all of its branch legs and all of its linked HQ sources. */
export interface CompanyHistoricalRestorationSettlementGroup {
  restorationId: number
  /** Original branch financial day, not the new reclassification's booking day. */
  businessDate: CalendarDate
  /** Verified company_box movements, fixed to SYP_NEW; opposing directions remain separate. */
  branchSourceEntries: Array<{ sourceEntryId: number; direction: MirrorDirection; amount: Minor }>
  /** Complete source set for this run. A subset of a multi-source run cannot be settled. */
  sourceReferences: string[]
  branchNet: Minor
  companyNet: Minor
  /** branchNet − companyNet, disclosed rather than silently adjusted. */
  variance: Minor
}

/**
 * Append-only, human-approved cash-neutral reclassification of linked historical transfers.
 * The frozen link-only cutover baseline is evidence, never rewritten by this record.
 */
export interface CompanyHistoricalRestorationSettlement {
  /** Canonical client UUID; also the batch's idempotency key. */
  id: string
  companyBranchId: string
  sourceBranchId: string
  /** Consecutive within sourceBranchId; persisted with compare-and-swap under branch → HQ locks. */
  version: number
  cutoverWatermarkEntryId: number
  /** Preview fingerprint of the cutover, effective evidence, current clearing and prior batches. */
  evidenceHash: string
  /** Immutable fingerprint of the approved request and actor for retry/conflict detection. */
  requestHash: string
  /** Current financial day; original cash entries keep their original dates. */
  businessDate: CalendarDate
  reason: string
  groups: CompanyHistoricalRestorationSettlementGroup[]
  legs: CompanyHistoricalRestorationSettlementLeg[]
  createdBy: string
  createdAtMs: number
}

export interface CompanyHistoricalBranchLink {
  id: string; companyBranchId: string; sourceBranchId: string; sourceEntryId: number; companyEntryId: number
  createdEntry: boolean; amount: Minor; direction: MirrorDirection; occurredOn: CalendarDate
  reason: string; requestHash: string; createdBy: string; createdAtMs: number
}

export interface CompanyLedgerRepo {
  createHistoricalBranchLink(row: CompanyHistoricalBranchLink): Promise<void>
  findHistoricalBranchLink(id: string): Promise<CompanyHistoricalBranchLink | null>
  listHistoricalBranchLinks(companyBranchId: string): Promise<CompanyHistoricalBranchLink[]>
  /**
   * Store one command row. Written AFTER its journal entry, in the same unit of work.
   * Throws `{ code: 'DUPLICATE_COMPANY_COMMAND' }` when the id is already a command of any kind.
   */
  createCommand(row: CompanyCommandRecord): Promise<void>
  /**
   * The command stored under this client key — in ANY command table. One key names one command:
   * a key spent on a deposit and sent again to an expense is a conflict, never a second posting.
   */
  findCommand(id: string): Promise<CompanyCommandRecord | null>
  /** The command whose journal is this entry, or null. */
  findCommandByEntry(journalEntryId: number): Promise<CompanyCommandRecord | null>
  /** The reversal that already undid this entry, or null. */
  findReversalOf(targetEntryId: number): Promise<CompanyReversalRecord | null>
  /** Every command of the company row, oldest first; bounded by business date when a range is given. */
  listCommands(
    companyBranchId: string,
    range?: { from: CalendarDate; to: CalendarDate },
  ): Promise<CompanyCommandRecord[]>

  cutoverFor(branchId: string): Promise<CompanyCutoverRecord | null>
  listCutovers(): Promise<CompanyCutoverRecord[]>
  /** Throws `{ code: 'DUPLICATE_CUTOVER' }` when the branch already has one. */
  createCutover(row: CompanyCutoverRecord): Promise<void>
  /** max(journal_entries.id), 0 for an empty ledger — the cutover watermark. Read it under the locks. */
  latestEntryId(): Promise<number>

  /** Throws `{ code: 'DUPLICATE_MIRROR' }` when the source entry is already mirrored. */
  createMirror(row: CompanyMirrorRecord): Promise<void>
  findMirrorBySource(sourceEntryId: number): Promise<CompanyMirrorRecord | null>
  listMirrors(sourceBranchId: string): Promise<CompanyMirrorRecord[]>

  /** Append one batch with version = expectedVersion + 1; sources can belong to one batch only. */
  createHistoricalSettlement(row: CompanyHistoricalRestorationSettlement, expectedVersion: number): Promise<void>
  findHistoricalSettlement(id: string): Promise<CompanyHistoricalRestorationSettlement | null>
  listHistoricalSettlements(
    companyBranchId: string,
    sourceBranchId?: string,
  ): Promise<CompanyHistoricalRestorationSettlement[]>
  findHistoricalSettlementBySource(
    historicalJournalEntryId: number,
  ): Promise<CompanyHistoricalRestorationSettlement | null>
}

export interface CompanyPeriodTotals {
  /** Σ company_income credits − debits in the range. */
  income: Minor
  /** Σ company_expense debits − credits in the range. */
  expense: Minor
  /** Owner deposits (owner_funding and opening) into the pocket, net of reversals. */
  deposits: Minor
  /** Owner withdrawals, net of reversals. */
  withdrawals: Minor
  /** income − expense. Depreciation is not in it (C5 shows it apart). */
  net: Minor
}

export interface CompanyOverviewRecord {
  /** `company_cash:<CUR>` — may be negative after a restoration top-up (owner decision). */
  pockets: Record<Currency, Minor>
  /** `depreciation_reserve:<CUR>`. */
  reserves: Record<Currency, Minor>
  /**
   * Every operating branch: its `company_box` and the company's `branch_clearing` for it. Before a
   * branch's cutover the clearing is zero and `cutOver` is false.
   */
  branches: Array<{ branchId: string; companyBox: Minor; clearing: Minor; cutOver: boolean }>
  /** The range's flows, per currency, by business date. */
  period: Record<Currency, CompanyPeriodTotals>
}

export interface CompanyMovementRecord {
  entry: JournalEntryRecord
  /**
   * The company pocket balance right AFTER this entry, for each currency the entry moved a pocket
   * in — the running balance in financial-day order (then entry id), counting every entry,
   * shown or not. Backfilled history must not be displayed after later live transactions.
   */
  pocketAfter: Partial<Record<Currency, Minor>>
}

/** Final historical source evidence. Owner-direct rows have no HQ journal by design. */
export interface CompanyHistoricalImportReceiptRecord {
  sourceReference: string
  sourcePosition: number
  occurredOn: CalendarDate
  movementType: 'branch_receipt' | 'branch_payment' | 'expense' | 'asset_payment' | 'exchange' | 'refund'
  paidFrom: 'pocket' | 'owner_outside'
  currency: Currency | null
  amount: Minor | null
  description: string
  originalAmount: string
  originalDescription: string
  sourceFunding: string
  originalDeltas: readonly [number, number, number, number]
  fromCurrency: Currency | null
  fromAmount: Minor | null
  toCurrency: Currency | null
  toAmount: Minor | null
  rateBasis: 'documented' | 'estimated' | null
  sypMinorPerUsd: bigint | null
  sourceBranchId: string | null
  journalEntryId: number | null
  branchJournalEntryId: number | null
  restorationId: number | null
  /** Original import provenance, not a new financial approval or an amount-only match. */
  linkStatus?: string | null
  linkNote?: string | null
}

export interface CompanyLedgerSource {
  readOverview(
    companyBranchId: string,
    range: { from: CalendarDate; to: CalendarDate },
  ): Promise<CompanyOverviewRecord>
  /** The company row's entries whose business date is in the range, financial-day oldest first. */
  listMovements(
    companyBranchId: string,
    range: { from: CalendarDate; to: CalendarDate },
  ): Promise<CompanyMovementRecord[]>
  listHistoricalImportReceipts(
    companyBranchId: string,
    range: { from: CalendarDate; to: CalendarDate },
  ): Promise<CompanyHistoricalImportReceiptRecord[]>
}

/** Transaction-scoped financial locks, in the namespace `FinancialUnitOfWorkInput.lockKey` uses. */
export interface FinancialLocks {
  /** Idempotent within a transaction: taking a lock already held is a no-op. */
  acquire(lockKey: string): Promise<void>
}

/**
 * THE lock order for every transaction that writes two ledgers: the branch first, the company row
 * last. A transaction that holds the company lock never asks for a branch lock afterwards — so a
 * company-only command (which takes only the company lock) and a restoration (branch, then company)
 * can never wait on each other in a cycle.
 */
export async function lockBranchThenCompany(
  tx: Pick<FinancialTransactionDeps, 'locks'>,
  branchId: string,
  companyBranchId: string,
): Promise<void> {
  if (branchId === companyBranchId) throw new Error('lockBranchThenCompany needs a branch and the company row')
  await tx.locks.acquire(`receivables:${branchId}`)
  await tx.locks.acquire(`receivables:${companyBranchId}`)
}
