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
  /** The branch's company_box balance at cutover, moved as-is. */
  openingAmount: Minor
  /** The `company_opening_transfer` entry; null exactly when the opening amount is zero. */
  openingEntryId: number | null
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

export interface CompanyLedgerRepo {
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
   * in — the running balance in posting order, counting every entry, shown or not.
   */
  pocketAfter: Partial<Record<Currency, Minor>>
}

export interface CompanyLedgerSource {
  readOverview(
    companyBranchId: string,
    range: { from: CalendarDate; to: CalendarDate },
  ): Promise<CompanyOverviewRecord>
  /** The company row's entries whose business date is in the range, oldest first. */
  listMovements(
    companyBranchId: string,
    range: { from: CalendarDate; to: CalendarDate },
  ): Promise<CompanyMovementRecord[]>
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
