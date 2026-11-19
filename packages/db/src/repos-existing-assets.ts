import type {
  ExistingAssetEventRecord,
  ExistingAssetEvidenceRecord,
  ExistingAssetRecord,
  ExistingAssetRepo,
  ExistingAssetPaymentEvent,
} from '@ash/contracts'
import { minor } from '@ash/domain'
import { withTransaction, type Pool } from './pool.ts'

const encode = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'bigint' ? item.toString() : item)

function hydrateCard(value: unknown): ExistingAssetRecord {
  const card = structuredClone(value) as ExistingAssetRecord
  if (card.price !== null) card.price = minor(BigInt(card.price))
  if (card.pendingEdit?.price !== null && card.pendingEdit?.price !== undefined) card.pendingEdit.price = minor(BigInt(card.pendingEdit.price))
  if (card.depreciation) card.depreciation.residualValue = minor(BigInt(card.depreciation.residualValue))
  if (card.depreciationSchedule) card.depreciationSchedule = card.depreciationSchedule.map(row => ({ ...row, amount: minor(BigInt(row.amount)) }))
  if (card.recognition) {
    card.recognition.cost = minor(BigInt(card.recognition.cost))
    card.recognition.accumulatedDepreciation = minor(BigInt(card.recognition.accumulatedDepreciation))
  }
  if (card.sale) {
    card.sale.price = minor(BigInt(card.sale.price))
    card.sale.receivedAmount = minor(BigInt(card.sale.receivedAmount))
    if (card.sale.bookValue !== null) card.sale.bookValue = minor(BigInt(card.sale.bookValue))
  }
  return card
}

function hydrateEvent(row: Record<string, unknown>): ExistingAssetEventRecord {
  return {
    id: String(row.id), assetId: String(row.asset_id), branchId: String(row.branch_id),
    kind: String(row.kind) as ExistingAssetEventRecord['kind'], expectedVersion: Number(row.expected_version),
    version: Number(row.version), requestFingerprint: String(row.request_fingerprint), reason: String(row.reason),
    snapshot: hydrateCard(row.snapshot), createdBy: String(row.created_by),
    createdAtMs: row.created_at instanceof Date ? row.created_at.getTime() : new Date(String(row.created_at)).getTime(),
  }
}

function hydrateEvidence(row: Record<string, unknown>): ExistingAssetEvidenceRecord {
  return {
    id: String(row.id), assetId: String(row.asset_id), operationId: row.operation_id === null ? null : String(row.operation_id),
    journalEntryId: row.journal_entry_id === null ? null : Number(row.journal_entry_id),
    mediaId: row.media_id === null ? null : String(row.media_id), description: String(row.description),
    createdBy: String(row.created_by),
    createdAtMs: row.created_at instanceof Date ? row.created_at.getTime() : new Date(String(row.created_at)).getTime(),
  }
}

export class PgExistingAssetRepo implements ExistingAssetRepo {
  private readonly pool: Pool
  constructor(pool: Pool) { this.pool = pool }
  async paymentEvents(branchId: string): Promise<ExistingAssetPaymentEvent[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM company_existing_asset_payment_events WHERE branch_id=$1 ORDER BY asset_id,version', [branchId])
    return rows.map(row => ({ id: String(row.id), assetId: String(row.asset_id), branchId: String(row.branch_id), version: Number(row.version),
      kind: String(row.kind) as ExistingAssetPaymentEvent['kind'], requestHash: String(row.request_hash), reason: String(row.reason),
      data: row.data as ExistingAssetPaymentEvent['data'], createdBy: String(row.created_by),
      createdAtMs: new Date(String(row.created_at)).getTime() }))
  }
  async addPaymentEvent(row: ExistingAssetPaymentEvent): Promise<void> {
    await this.pool.query(`INSERT INTO company_existing_asset_payment_events
      (id,asset_id,branch_id,version,kind,request_hash,reason,data,created_by,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [row.id,row.assetId,row.branchId,row.version,row.kind,row.requestHash,row.reason,encode(row.data),row.createdBy,new Date(row.createdAtMs)])
  }
  async get(id: string): Promise<ExistingAssetRecord | null> {
    const { rows } = await this.pool.query<{ snapshot: unknown }>('SELECT snapshot FROM company_existing_assets WHERE id = $1', [id])
    return rows[0] ? hydrateCard(rows[0].snapshot) : null
  }
  async getByVehicle(vehicleId: string): Promise<ExistingAssetRecord | null> {
    const { rows } = await this.pool.query<{ snapshot: unknown }>(
      "SELECT snapshot FROM company_existing_assets WHERE vehicle_id = $1 AND status <> 'sold'", [vehicleId])
    return rows[0] ? hydrateCard(rows[0].snapshot) : null
  }
  async list(companyBranchId: string): Promise<ExistingAssetRecord[]> {
    const { rows } = await this.pool.query<{ snapshot: unknown }>(
      'SELECT snapshot FROM company_existing_assets WHERE branch_id = $1 ORDER BY created_at, id', [companyBranchId])
    return rows.map((row) => hydrateCard(row.snapshot))
  }
  async getEvent(id: string): Promise<ExistingAssetEventRecord | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>('SELECT * FROM company_existing_asset_events WHERE id = $1', [id])
    return rows[0] ? hydrateEvent(rows[0]) : null
  }
  async listEvents(assetId: string): Promise<ExistingAssetEventRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM company_existing_asset_events WHERE asset_id = $1 ORDER BY version', [assetId])
    return rows.map(hydrateEvent)
  }
  async apply(event: ExistingAssetEventRecord): Promise<void> {
    await withTransaction(this.pool, { actorId: event.createdBy }, async (client) => {
      await client.query(
        `INSERT INTO company_existing_asset_events
         (id,asset_id,branch_id,kind,expected_version,version,request_fingerprint,reason,snapshot,created_by,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [event.id,event.assetId,event.branchId,event.kind,event.expectedVersion,event.version,event.requestFingerprint,
         event.reason,encode(event.snapshot),event.createdBy,new Date(event.createdAtMs)])
      const card = event.snapshot
      if (event.expectedVersion === 0) {
        await client.query(
          `INSERT INTO company_existing_assets
           (id,branch_id,vehicle_id,name,currency,price_minor,purchased_on,use_started_on,funding_source,
            description,status,accounting_status,version,snapshot,created_by,created_at,updated_by,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18)`,
          [card.id,card.branchId,card.vehicleId,card.name,card.currency,card.price?.toString() ?? null,
           card.purchasedOn,card.useStartedOn,card.fundingSource,card.description,card.status,card.accountingStatus,
           card.version,encode(card),card.createdBy,new Date(card.createdAtMs),card.updatedBy,new Date(card.updatedAtMs)])
      } else {
        const result = await client.query(
          `UPDATE company_existing_assets SET vehicle_id=$2,name=$3,currency=$4,price_minor=$5,
           purchased_on=$6,use_started_on=$7,funding_source=$8,description=$9,status=$10,
           accounting_status=$11,version=$12,snapshot=$13::jsonb,updated_by=$14,updated_at=$15
           WHERE id=$1 AND version=$16`,
          [card.id,card.vehicleId,card.name,card.currency,card.price?.toString() ?? null,card.purchasedOn,
           card.useStartedOn,card.fundingSource,card.description,card.status,card.accountingStatus,card.version,
           encode(card),card.updatedBy,new Date(card.updatedAtMs),event.expectedVersion])
        if (result.rowCount !== 1) throw Object.assign(new Error('EXISTING_ASSET_VERSION_CONFLICT'), { code: 'EXISTING_ASSET_VERSION_CONFLICT' })
      }
    })
  }
  async listEvidence(assetId: string): Promise<ExistingAssetEvidenceRecord[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM company_existing_asset_evidence WHERE asset_id=$1 ORDER BY created_at,id', [assetId])
    return rows.map(hydrateEvidence)
  }
  async addEvidence(row: ExistingAssetEvidenceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO company_existing_asset_evidence
       (id,asset_id,operation_id,journal_entry_id,media_id,description,created_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.id,row.assetId,row.operationId,row.journalEntryId,row.mediaId,row.description,row.createdBy,new Date(row.createdAtMs)])
  }
  async linkedToOperation(operationId: string, journalEntryId: number): Promise<ExistingAssetRecord[]> {
    const { rows } = await this.pool.query<{ snapshot: unknown }>(
      `SELECT a.snapshot FROM company_existing_assets a WHERE EXISTS (
         SELECT 1 FROM company_existing_asset_evidence e WHERE e.asset_id=a.id
           AND (e.operation_id=$1 OR e.journal_entry_id=$2))
       OR a.snapshot->'recognition'->>'journalEntryId'=$2::text
       OR a.snapshot->'sale'->>'receiptEntryId'=$2::text
       OR a.snapshot->'sale'->>'disposalEntryId'=$2::text`, [operationId,journalEntryId])
    return rows.map((row) => hydrateCard(row.snapshot))
  }
}
