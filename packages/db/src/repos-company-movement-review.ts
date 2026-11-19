import type {
  CompanyHistoricalIntakeSession, CompanyMovementCorrection, CompanyMovementMetadata, CompanyMovementReviewRepo,
  CompanyHistoricalSourceCorrection,
} from '@ash/contracts'
import type { Pool } from './pool.ts'

/** Journals remain append-only. These JSON snapshots contain decimal wire strings, never floats. */
export class PgCompanyMovementReviewRepo implements CompanyMovementReviewRepo {
  private readonly pool: Pool
  constructor(pool: Pool) { this.pool = pool }

  async listHistoricalSourceCorrections(branchId: string, sourceReference?: string): Promise<CompanyHistoricalSourceCorrection[]> {
    const { rows } = await this.pool.query<{ payload: CompanyHistoricalSourceCorrection }>(
      'SELECT payload FROM company_historical_source_corrections WHERE branch_id=$1 AND ($2::text IS NULL OR source_reference=$2) ORDER BY source_reference,version',
      [branchId,sourceReference ?? null])
    return rows.map(row=>row.payload)
  }
  async findHistoricalSourceCorrection(id: string): Promise<CompanyHistoricalSourceCorrection | null> {
    const { rows } = await this.pool.query<{ payload: CompanyHistoricalSourceCorrection }>(
      'SELECT payload FROM company_historical_source_corrections WHERE id=$1',[id])
    return rows[0]?.payload ?? null
  }
  async saveHistoricalSourceCorrection(row: CompanyHistoricalSourceCorrection, expectedVersion: number): Promise<void> {
    await this.pool.query(`INSERT INTO company_historical_source_corrections(id,branch_id,source_reference,version,created_by,payload)
      VALUES($1,$2,$3,$4,$5,$6)`,[row.id,row.branchId,row.sourceReference,expectedVersion+1,row.createdBy,JSON.stringify(row)])
  }

  async findMetadata(commandId: string): Promise<CompanyMovementMetadata | null> {
    const { rows } = await this.pool.query<{ payload: CompanyMovementMetadata }>(
      'SELECT payload FROM company_movement_metadata WHERE command_id=$1', [commandId])
    return rows[0]?.payload ?? null
  }
  async listMetadata(branchId: string): Promise<CompanyMovementMetadata[]> {
    const { rows } = await this.pool.query<{ payload: CompanyMovementMetadata }>(
      'SELECT payload FROM company_movement_metadata WHERE branch_id=$1 ORDER BY command_id', [branchId])
    return rows.map((row) => row.payload)
  }
  async createMetadata(row: CompanyMovementMetadata): Promise<void> {
    await this.pool.query('INSERT INTO company_movement_metadata(command_id,branch_id,payload) VALUES($1,$2,$3)',
      [row.commandId, row.branchId, JSON.stringify(row)])
  }
  async getIntakeSession(id: string): Promise<CompanyHistoricalIntakeSession | null> {
    const { rows } = await this.pool.query<{ payload: CompanyHistoricalIntakeSession }>(
      'SELECT payload FROM company_historical_intake_sessions WHERE id=$1', [id])
    return rows[0]?.payload ?? null
  }
  async listIntakeSessions(branchId: string): Promise<CompanyHistoricalIntakeSession[]> {
    const { rows } = await this.pool.query<{ payload: CompanyHistoricalIntakeSession }>(
      'SELECT payload FROM company_historical_intake_sessions WHERE branch_id=$1 ORDER BY created_at,id', [branchId])
    return rows.map((row) => row.payload)
  }
  async createIntakeSession(row: CompanyHistoricalIntakeSession): Promise<void> {
    await this.pool.query('INSERT INTO company_historical_intake_sessions(id,branch_id,payload,created_at) VALUES($1,$2,$3,$4)',
      [row.id, row.branchId, JSON.stringify(row), new Date(row.createdAtMs)])
  }
  async closeIntakeSession(row: CompanyHistoricalIntakeSession): Promise<void> {
    const result = await this.pool.query(
      `UPDATE company_historical_intake_sessions SET payload=$2 WHERE id=$1 AND payload->>'closedAtMs' IS NULL`,
      [row.id, JSON.stringify(row)])
    if (result.rowCount !== 1) throw Object.assign(new Error('intake session closed'), { code: 'INTAKE_SESSION_CLOSED' })
  }
  async getCorrection(id: string): Promise<CompanyMovementCorrection | null> {
    const { rows } = await this.pool.query<{ payload: CompanyMovementCorrection }>(
      'SELECT payload FROM company_movement_correction_versions WHERE id=$1 ORDER BY version DESC LIMIT 1', [id])
    return rows[0]?.payload ?? null
  }
  async getCorrectionByAction(actionId: string): Promise<CompanyMovementCorrection | null> {
    const { rows } = await this.pool.query<{ payload: CompanyMovementCorrection }>(
      'SELECT payload FROM company_movement_correction_versions WHERE action_id=$1', [actionId])
    return rows[0]?.payload ?? null
  }
  async listCorrections(branchId: string, targetId?: string): Promise<CompanyMovementCorrection[]> {
    const { rows } = await this.pool.query<{ payload: CompanyMovementCorrection }>(
      `SELECT payload FROM (SELECT DISTINCT ON(id) id,payload,created_at FROM company_movement_correction_versions
       WHERE branch_id=$1 AND ($2::uuid IS NULL OR target_id=$2) ORDER BY id,version DESC) latest ORDER BY created_at,id`,
      [branchId, targetId ?? null])
    return rows.map((row) => row.payload)
  }
  async listCorrectionHistory(id: string): Promise<CompanyMovementCorrection[]> {
    const { rows } = await this.pool.query<{ payload: CompanyMovementCorrection }>(
      'SELECT payload FROM company_movement_correction_versions WHERE id=$1 ORDER BY version', [id])
    return rows.map((row) => row.payload)
  }
  async saveCorrection(row: CompanyMovementCorrection, expectedVersion: number): Promise<void> {
    // Route holds the HQ financial lock. DB guard additionally verifies version and target revision.
    await this.pool.query(
      `INSERT INTO company_movement_correction_versions(id,version,branch_id,target_id,target_version,action_id,
       status,reversal_entry_id,replacement_entry_id,created_by,acted_by,created_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [row.id, expectedVersion + 1, row.branchId, row.targetId, row.targetVersion, row.actionId, row.status,
        row.reversalEntryId, row.replacementEntryId, row.createdBy, row.actedBy, new Date(row.createdAtMs), JSON.stringify(row)])
  }
}
