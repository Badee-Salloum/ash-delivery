import type { ShiftBreakRecord, ShiftBreakRepo, ShiftBreakEndReason } from '@ash/contracts'
import { type Pool, withTransaction } from './pool.ts'

const asBreak = (row: Record<string, unknown>): ShiftBreakRecord => ({
  id: String(row.id),
  shiftId: String(row.shift_id),
  startedAtMs: new Date(String(row.started_at)).getTime(),
  endedAtMs: row.ended_at === null ? null : new Date(String(row.ended_at)).getTime(),
  endReason: row.end_reason as ShiftBreakEndReason | null,
  limitMinutes: Number(row.limit_minutes),
  consumedBeforeMs: Number(row.consumed_before_ms),
  overLimitMs: Number(row.over_limit_ms),
})

export class PgShiftBreakRepo implements ShiftBreakRepo {
  private readonly pool: Pool
  constructor(pool: Pool) { this.pool = pool }

  async findById(id: string): Promise<ShiftBreakRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM shift_breaks WHERE id = $1', [id])
    return rows[0] ? asBreak(rows[0]) : null
  }

  async listByShift(shiftId: string): Promise<ShiftBreakRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM shift_breaks WHERE shift_id = $1 ORDER BY started_at, id', [shiftId],
    )
    return rows.map(asBreak)
  }

  async listByShiftIds(shiftIds: readonly string[]): Promise<ShiftBreakRecord[]> {
    if (shiftIds.length === 0) return []
    const { rows } = await this.pool.query(
      'SELECT * FROM shift_breaks WHERE shift_id = ANY($1::uuid[]) ORDER BY shift_id, started_at, id',
      [[...shiftIds]],
    )
    return rows.map(asBreak)
  }

  async create(record: ShiftBreakRecord, actorId: string): Promise<void> {
    await withTransaction(this.pool, { actorId }, (client) => client.query(
      `INSERT INTO shift_breaks
       (id, shift_id, started_at, limit_minutes, consumed_before_ms, started_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [record.id, record.shiftId, new Date(record.startedAtMs), record.limitMinutes,
        record.consumedBeforeMs, actorId],
    ))
  }

  async end(id: string, endedAtMs: number, reason: ShiftBreakEndReason, overLimitMs: number, actorId: string): Promise<void> {
    const result = await withTransaction(this.pool, { actorId }, (client) => client.query(
      `UPDATE shift_breaks SET ended_at = $2, end_reason = $3, over_limit_ms = $4, ended_by = $5
        WHERE id = $1 AND ended_at IS NULL`,
      [id, new Date(endedAtMs), reason, overLimitMs, actorId],
    ))
    if (result.rowCount !== 1) throw new Error(`active break ${id} changed during locked shift transaction`)
  }
}
