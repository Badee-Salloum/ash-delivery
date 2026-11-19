import type {
  CompanyHistoricalDraft, CompanyHistoricalDraftIdentity, CompanyHistoricalDraftRepo, CompanyHistoricalDraftRevision,
} from '@ash/contracts'
import type { Pool } from './pool.ts'

/** All writers use an attributed transaction-bound pool. There is no financial journal seam. */
export class PgCompanyHistoricalDraftRepo implements CompanyHistoricalDraftRepo {
  private readonly pool: Pool
  constructor(pool: Pool) { this.pool = pool }

  async get(id: string): Promise<CompanyHistoricalDraft | null> {
    const identity = await this.pool.query<{ payload: CompanyHistoricalDraftIdentity }>(
      'SELECT payload FROM company_historical_drafts WHERE id=$1', [id])
    if (!identity.rows[0]) return null
    const versions = await this.pool.query<{ payload: CompanyHistoricalDraftRevision }>(
      'SELECT payload FROM company_historical_draft_revisions WHERE draft_id=$1 ORDER BY version', [id])
    const revisions = versions.rows.map(row => row.payload), current = revisions.at(-1)
    return current ? { ...identity.rows[0].payload, version: current.version, updatedBy: current.actorId,
      updatedAtMs: current.createdAtMs, payload: current.payload, revisions } : null
  }
  async list(companyBranchId: string): Promise<CompanyHistoricalDraft[]> {
    const roots = await this.pool.query<{ id: string }>(
      'SELECT id FROM company_historical_drafts WHERE branch_id=$1 ORDER BY created_at,id', [companyBranchId])
    const drafts = await Promise.all(roots.rows.map(row => this.get(row.id)))
    return drafts.filter((draft): draft is CompanyHistoricalDraft => draft !== null)
  }
  async getByRequest(requestId: string): Promise<CompanyHistoricalDraftRevision | null> {
    const { rows } = await this.pool.query<{ payload: CompanyHistoricalDraftRevision }>(
      'SELECT payload FROM company_historical_draft_revisions WHERE request_id=$1', [requestId])
    return rows[0]?.payload ?? null
  }
  async create(identity: CompanyHistoricalDraftIdentity, revision: CompanyHistoricalDraftRevision): Promise<void> {
    await this.pool.query('INSERT INTO company_historical_drafts(id,branch_id,created_by,created_at,payload) VALUES($1,$2,$3,$4,$5)',
      [identity.id, identity.companyBranchId, identity.createdBy, new Date(identity.createdAtMs), JSON.stringify(identity)])
    await this.append(revision, 0)
  }
  async append(revision: CompanyHistoricalDraftRevision, expectedVersion: number): Promise<void> {
    if (revision.expectedVersion !== expectedVersion || revision.version !== expectedVersion + 1) {
      throw Object.assign(new Error('historical draft version conflict'), { code: 'HISTORICAL_DRAFT_VERSION_CONFLICT' })
    }
    await this.pool.query(`INSERT INTO company_historical_draft_revisions(draft_id,version,expected_version,request_id,
      request_hash,actor_id,created_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [revision.draftId, revision.version, expectedVersion, revision.requestId, revision.requestHash,
        revision.actorId, new Date(revision.createdAtMs), JSON.stringify(revision)])
  }
}
