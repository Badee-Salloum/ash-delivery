import type { ShiftBreakEndReason, ShiftBreakRecord, ShiftBreakRepo } from '@ash/contracts'

export class MemoryShiftBreakRepo implements ShiftBreakRepo {
  readonly rows = new Map<string, ShiftBreakRecord>()

  async findById(id: string): Promise<ShiftBreakRecord | null> {
    const row = this.rows.get(id)
    return row ? { ...row } : null
  }

  async listByShift(shiftId: string): Promise<ShiftBreakRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.shiftId === shiftId)
      .sort((a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id))
      .map((row) => ({ ...row }))
  }

  async listByShiftIds(shiftIds: readonly string[]): Promise<ShiftBreakRecord[]> {
    const wanted = new Set(shiftIds)
    return [...this.rows.values()]
      .filter((row) => wanted.has(row.shiftId))
      .sort((a, b) => a.shiftId.localeCompare(b.shiftId) || a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id))
      .map((row) => ({ ...row }))
  }

  async create(record: ShiftBreakRecord, _actorId: string): Promise<void> {
    if (this.rows.has(record.id)) throw new Error(`duplicate break ${record.id}`)
    if ([...this.rows.values()].some((row) => row.shiftId === record.shiftId && row.endedAtMs === null)) {
      throw new Error(`active break already exists for ${record.shiftId}`)
    }
    this.rows.set(record.id, { ...record })
  }

  async end(id: string, endedAtMs: number, reason: ShiftBreakEndReason, overLimitMs: number, _actorId: string): Promise<void> {
    const row = this.rows.get(id)
    if (!row || row.endedAtMs !== null) throw new Error(`active break ${id} changed during transaction`)
    this.rows.set(id, { ...row, endedAtMs, endReason: reason, overLimitMs })
  }
}
