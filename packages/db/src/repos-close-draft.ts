import type {
  CloseDraftData,
  CloseDraftRecord,
  CloseDraftRepo,
  OcrRow,
} from '@ash/contracts'
import { bindPoolToTransaction, type Pool, withTransaction } from './pool.ts'

type DraftRow = {
  shift_id: string
  revision: bigint
  draft_hash: string
  payload: CloseDraftData
  updated_at: Date
  updated_by: string
  submitted_at: Date | null
}

const toDraft = (row: DraftRow): CloseDraftRecord => ({
  shiftId: row.shift_id,
  revision: Number(row.revision),
  draftHash: row.draft_hash,
  data: structuredClone(row.payload),
  updatedAtMs: row.updated_at.getTime(),
  updatedBy: row.updated_by,
  submittedAtMs: row.submitted_at?.getTime() ?? null,
})

const selectDraft = async (pool: Pool, shiftId: string): Promise<CloseDraftRecord | null> => {
  const { rows } = await pool.query<DraftRow>('SELECT * FROM shift_close_drafts WHERE shift_id = $1', [shiftId])
  return rows[0] ? toDraft(rows[0]) : null
}

export class PgCloseDraftRepo implements CloseDraftRepo {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async findByShift(shiftId: string): Promise<CloseDraftRecord | null> {
    return selectDraft(this.pool, shiftId)
  }

  async getOrCreate(input: Omit<CloseDraftRecord, 'revision'>): Promise<CloseDraftRecord> {
    return withTransaction(this.pool, { actorId: input.updatedBy }, async (client) => {
    await client.query('SELECT id FROM shifts WHERE id = $1 FOR UPDATE', [input.shiftId])
    const { rows } = await client.query<DraftRow>(
      `INSERT INTO shift_close_drafts
         (shift_id, revision, draft_hash, payload, updated_at, updated_by, submitted_at)
       VALUES ($1, 0, $2, $3::jsonb, to_timestamp($4::double precision / 1000), $5,
               CASE WHEN $6::double precision IS NULL THEN NULL ELSE to_timestamp($6::double precision / 1000) END)
       ON CONFLICT (shift_id) DO NOTHING
       RETURNING *`,
      [
        input.shiftId,
        input.draftHash,
        JSON.stringify(input.data),
        input.updatedAtMs,
        input.updatedBy,
        input.submittedAtMs,
      ],
    )
    if (rows[0]) return toDraft(rows[0])
    const current = await client.query<DraftRow>('SELECT * FROM shift_close_drafts WHERE shift_id = $1', [input.shiftId])
    return toDraft(current.rows[0]!)
    })
  }

  async update(input: Parameters<CloseDraftRepo['update']>[0]): Promise<CloseDraftRecord | null> {
    return withTransaction(this.pool, { actorId: input.updatedBy }, async (client) => {
    await client.query('SELECT id FROM shifts WHERE id = $1 FOR UPDATE', [input.shiftId])
    const { rows } = await client.query<DraftRow>(
      `UPDATE shift_close_drafts
          SET revision = revision + 1,
              draft_hash = $3,
              payload = $4::jsonb,
              updated_at = to_timestamp($5::double precision / 1000),
              updated_by = $6
        WHERE shift_id = $1 AND revision = $2 AND submitted_at IS NULL
        RETURNING *`,
      [input.shiftId, input.expectedRevision, input.draftHash, JSON.stringify(input.data), input.updatedAtMs, input.updatedBy],
    )
    return rows[0] ? toDraft(rows[0]) : null
    })
  }

  async markSubmitted(input: Parameters<CloseDraftRepo['markSubmitted']>[0]): Promise<CloseDraftRecord | null> {
    return withTransaction(this.pool, { actorId: input.updatedBy }, async (client) => {
      const pool = bindPoolToTransaction(this.pool, client, { actorId: input.updatedBy })
      await client.query('SELECT id FROM shifts WHERE id = $1 FOR UPDATE', [input.shiftId])
      const current = await client.query<DraftRow>(
        'SELECT * FROM shift_close_drafts WHERE shift_id = $1 FOR UPDATE',
        [input.shiftId],
      )
      const row = current.rows[0]
      if (!row || Number(row.revision) !== input.expectedRevision || row.draft_hash !== input.expectedDraftHash) return null
      if (row.submitted_at !== null) return toDraft(row)
      const { rows } = await pool.query<DraftRow>(
        `UPDATE shift_close_drafts
            SET submitted_at = to_timestamp($2::double precision / 1000),
                updated_at = to_timestamp($2::double precision / 1000),
                updated_by = $3
          WHERE shift_id = $1
          RETURNING *`,
        [input.shiftId, input.submittedAtMs, input.updatedBy],
      )
      return rows[0] ? toDraft(rows[0]) : null
    })
  }

  async reopen(input: Parameters<CloseDraftRepo['reopen']>[0]): Promise<CloseDraftRecord | null> {
    return withTransaction(this.pool, { actorId: input.updatedBy }, async (client) => {
      await client.query('SELECT id FROM shifts WHERE id = $1 FOR UPDATE', [input.shiftId])
      const { rows } = await client.query<DraftRow>(
        `UPDATE shift_close_drafts
            SET revision = revision + 1, submitted_at = NULL,
                updated_at = to_timestamp($2::double precision / 1000), updated_by = $3
          WHERE shift_id = $1 AND submitted_at IS NOT NULL
          RETURNING *`,
        [input.shiftId, input.updatedAtMs, input.updatedBy],
      )
      if (rows[0]) return toDraft(rows[0])
      const current = await client.query<DraftRow>(
        'SELECT * FROM shift_close_drafts WHERE shift_id = $1',
        [input.shiftId],
      )
      return current.rows[0] ? toDraft(current.rows[0]) : null
    })
  }

  async saveRead(input: Parameters<CloseDraftRepo['saveRead']>[0]): Promise<CloseDraftRecord | null> {
    return withTransaction(this.pool, { actorId: input.updatedBy }, async (client) => {
      await client.query('SELECT id FROM shifts WHERE id = $1 FOR UPDATE', [input.shiftId])
      const current = await client.query<DraftRow>(
        `SELECT d.*
           FROM shift_close_drafts d
           JOIN shift_media sm ON sm.shift_id = d.shift_id
             AND sm.package = 'end' AND sm.slot = $3
             AND sm.media_id = $4 AND sm.attachment_token = $5
          WHERE d.shift_id = $1 AND d.revision = $2 AND d.submitted_at IS NULL
          FOR UPDATE OF d, sm`,
        [input.shiftId, input.expectedRevision, input.slot, input.mediaId, input.attachmentToken],
      )
      if (!current.rows[0]) return null

      // Advance the optimistic draft before appending immutable provenance. If the CAS loses,
      // return without leaving a detached read row that a retry can neither reuse nor delete.
      const updated = await client.query<DraftRow>(
        `UPDATE shift_close_drafts
            SET revision = revision + 1, draft_hash = $3, payload = $4::jsonb,
                updated_at = to_timestamp($5::double precision / 1000), updated_by = $6
          WHERE shift_id = $1 AND revision = $2 AND submitted_at IS NULL
          RETURNING *`,
        [input.shiftId, input.expectedRevision, input.draftHash, JSON.stringify(input.data), input.updatedAtMs, input.updatedBy],
      )
      if (!updated.rows[0]) return null

      await client.query(
        `INSERT INTO shift_close_draft_reads
           (id, shift_id, media_id, attachment_token, package, slot, field, status, failure,
            attempts, result, created_at, updated_at, created_by)
         VALUES ($1,$2,$3,$4,'end',$5,$6,$7,$8,$9,$10::jsonb,
                 to_timestamp($11::double precision / 1000),to_timestamp($11::double precision / 1000),$12)`,
        [
          input.read.readId,
          input.shiftId,
          input.mediaId,
          input.attachmentToken,
          input.slot,
          input.read.field,
          input.read.status,
          input.read.failure,
          input.read.attempts,
          JSON.stringify({ rowCount: input.observations.length }),
          input.updatedAtMs,
          input.updatedBy,
        ],
      )

      for (const observation of input.observations) {
        await client.query(
          `INSERT INTO shift_close_draft_observations
             (id, read_id, shift_id, media_id, attachment_token, slot, row_index, row_count,
              date_section, y_top, y_bottom, row_data, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,
                   to_timestamp($13::double precision / 1000))`,
          [
            observation.id,
            input.read.readId,
            input.shiftId,
            input.mediaId,
            input.attachmentToken,
            input.slot,
            observation.rowIndex,
            observation.rowCount,
            observation.dateSection,
            observation.yTop,
            observation.yBottom,
            JSON.stringify(observation.row satisfies OcrRow),
            input.updatedAtMs,
          ],
        )
      }

      return toDraft(updated.rows[0])
    })
  }
}
