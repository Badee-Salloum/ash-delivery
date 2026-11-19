import type { CompanyRestorationProposal, CompanyRestorationReviewRepo, CompanyRestorationReviewRevision } from '@ash/contracts'
import { minor } from '@ash/domain'
import { PG, isPgError, type Pool } from './pool.ts'

/** JSON money carries explicit strings, never lossy numbers; restored at the boundary. */
const encode = (row: unknown): string => JSON.stringify(row, (_key, value: unknown) =>
  typeof value === 'bigint' ? { minor: value.toString() } : value)
const decode = <T>(row: unknown): T => JSON.parse(JSON.stringify(row), (_key, value: unknown) => {
  if (value !== null && typeof value === 'object' && Object.keys(value).length === 1 && 'minor' in value) {
    return minor(BigInt(String(value.minor)))
  }
  return value
}) as T

export class PgCompanyRestorationReviewRepo implements CompanyRestorationReviewRepo {
  private readonly pool: Pool
  constructor(pool: Pool) { this.pool = pool }
  async get(id: string): Promise<CompanyRestorationProposal | null> {
    const { rows } = await this.pool.query<{ payload: unknown }>('SELECT payload FROM company_restoration_proposals WHERE id=$1', [id])
    return rows[0] ? decode(rows[0].payload) : null
  }
  async getByRestoration(restorationId: number): Promise<CompanyRestorationProposal | null> {
    const { rows } = await this.pool.query<{ payload: unknown }>('SELECT payload FROM company_restoration_proposals WHERE restoration_id=$1', [restorationId])
    return rows[0] ? decode(rows[0].payload) : null
  }
  async getBySource(sourceEntryId: number): Promise<CompanyRestorationProposal | null> {
    const { rows } = await this.pool.query<{ payload: unknown }>(
      'SELECT p.payload FROM company_restoration_proposals p JOIN company_restoration_proposal_legs l ON l.proposal_id=p.id WHERE l.source_entry_id=$1', [sourceEntryId])
    return rows[0] ? decode(rows[0].payload) : null
  }
  async list(companyBranchId: string, branchId?: string): Promise<CompanyRestorationProposal[]> {
    const { rows } = await this.pool.query<{ payload: unknown }>(
      'SELECT payload FROM company_restoration_proposals WHERE company_branch_id=$1 AND ($2::uuid IS NULL OR source_branch_id=$2) ORDER BY created_at, id',
      [companyBranchId, branchId ?? null],
    )
    return rows.map((row) => decode(row.payload))
  }
  async create(row: CompanyRestorationProposal): Promise<void> {
    try {
      await this.pool.query(`INSERT INTO company_restoration_proposals
        (id,restoration_id,source_branch_id,company_branch_id,business_date,created_by,created_at,payload)
        VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7::double precision/1000),$8::jsonb)`,
      [row.id,row.restorationId,row.branchId,row.companyBranchId,row.businessDate,row.createdBy,row.createdAtMs,encode(row)])
      for (const leg of row.legs) {
        await this.pool.query(`INSERT INTO company_restoration_proposal_legs
          (proposal_id,source_entry_id,fund_code,direction,amount_minor) VALUES ($1,$2,$3,$4,$5)`,
        [row.id,leg.sourceEntryId,leg.fundCode,leg.direction,leg.amount.toString()])
      }
    } catch (error) {
      if (isPgError(error, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error('duplicate restoration proposal'), { code: 'DUPLICATE_RESTORATION_PROPOSAL' })
      }
      throw error
    }
  }
  async getRevision(id: string): Promise<CompanyRestorationReviewRevision | null> {
    const { rows } = await this.pool.query<{ payload: unknown }>('SELECT payload FROM company_restoration_review_revisions WHERE id=$1', [id])
    return rows[0] ? decode(rows[0].payload) : null
  }
  async listRevisions(proposalId: string): Promise<CompanyRestorationReviewRevision[]> {
    const { rows } = await this.pool.query<{ payload: unknown }>(
      'SELECT payload FROM company_restoration_review_revisions WHERE proposal_id=$1 ORDER BY version', [proposalId])
    return rows.map((row) => decode(row.payload))
  }
  async appendRevision(row: CompanyRestorationReviewRevision): Promise<void> {
    try {
      await this.pool.query(`INSERT INTO company_restoration_review_revisions
        (id,proposal_id,version,kind,reason,occurred_on,business_date,created_by,created_at,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9::double precision/1000),$10::jsonb)`,
      [row.id,row.proposalId,row.version,row.kind,row.reason,row.occurredOn,row.businessDate,row.createdBy,row.createdAtMs,encode(row)])
      for (const leg of row.legs) {
        await this.pool.query(`INSERT INTO company_restoration_review_legs
          (revision_id,proposal_id,source_entry_id,amount_minor,journal_entry_id,reversal_entry_id)
          VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.id,row.proposalId,leg.sourceEntryId,leg.amount.toString(),leg.journalEntryId,leg.reversalEntryId])
      }
    } catch (error) {
      if (isPgError(error, PG.UNIQUE_VIOLATION)) {
        throw Object.assign(new Error('restoration review version conflict'), { code: 'RESTORATION_REVIEW_VERSION_CONFLICT' })
      }
      throw error
    }
  }
}
