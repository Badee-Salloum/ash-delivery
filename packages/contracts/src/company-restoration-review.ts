import type { CalendarDate, Minor, MirrorDirection } from '@ash/domain'
import type { JournalEntryRecord } from './ports.ts'

/** Immutable evidence of the ALREADY executed branch half. Review never writes that ledger. */
export interface CompanyRestorationSourceLeg {
  sourceEntryId: number
  fundCode: 'office_cash' | 'office_wallet'
  direction: MirrorDirection
  amount: Minor
  sourceEntry: JournalEntryRecord
}

export interface CompanyRestorationProposal {
  /** Historical adoption references an existing run before the activation watermark. */
  origin?: 'live' | 'historical'
  /** The restoration request UUID; a retry returns this exact run and proposal. */
  id: string
  restorationId: number
  branchId: string
  companyBranchId: string
  businessDate: CalendarDate
  reason: string
  requestHash: string
  runNo: number
  snapshot: unknown
  response: unknown
  legs: CompanyRestorationSourceLeg[]
  createdBy: string
  createdAtMs: number
}

export interface CompanyRestorationReviewLeg {
  sourceEntryId: number
  /** Actual amount confirmed/proposed by HQ, never a replacement branch amount. */
  amount: Minor
  /** HQ-only entry: null for revisions/defer or a zero confirmation. */
  journalEntryId: number | null
  /** On a correction, exact inverse of the previous HQ confirmation (never branch). */
  reversalEntryId: number | null
}

/** Immutable versions; no UPDATE to an accounting fact or source snapshot. */
export interface CompanyRestorationReviewRevision {
  id: string
  proposalId: string
  version: number
  kind: 'revise' | 'defer' | 'confirm' | 'correct'
  requestHash: string
  reason: string
  occurredOn: CalendarDate
  businessDate: CalendarDate
  legs: CompanyRestorationReviewLeg[]
  createdBy: string
  createdAtMs: number
}

export interface CompanyRestorationReviewRepo {
  get(id: string): Promise<CompanyRestorationProposal | null>
  getByRestoration(restorationId: number): Promise<CompanyRestorationProposal | null>
  getBySource(sourceEntryId: number): Promise<CompanyRestorationProposal | null>
  list(companyBranchId: string, branchId?: string): Promise<CompanyRestorationProposal[]>
  create(row: CompanyRestorationProposal): Promise<void>
  getRevision(id: string): Promise<CompanyRestorationReviewRevision | null>
  listRevisions(proposalId: string): Promise<CompanyRestorationReviewRevision[]>
  /** Caller holds the company lock. Repository also enforces consecutive versions/unique UUID. */
  appendRevision(row: CompanyRestorationReviewRevision): Promise<void>
}
