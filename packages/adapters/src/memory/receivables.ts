import type {
  ReceivableEventRecord,
  ReceivableEventRepo,
} from '@ash/contracts'

/** Immutable in-memory direct-receivable command log. */
export class MemoryReceivableEventRepo implements ReceivableEventRepo {
  readonly rows = new Map<string, ReceivableEventRecord>()

  async findByIdempotencyKey(
    branchId: string,
    idempotencyKey: string,
  ): Promise<ReceivableEventRecord | null> {
    const found = [...this.rows.values()].find(
      (row) => row.branchId === branchId && row.idempotencyKey === idempotencyKey,
    )
    return found ? structuredClone(found) : null
  }

  async create(event: ReceivableEventRecord): Promise<void> {
    const prior = await this.findByIdempotencyKey(event.branchId, event.idempotencyKey)
    if (prior || this.rows.has(event.id)) {
      throw Object.assign(new Error(`duplicate receivable event key ${event.idempotencyKey}`), {
        code: 'DUPLICATE_IDEMPOTENCY_KEY',
      })
    }
    this.rows.set(event.id, structuredClone(event))
  }

  async listByBranchAndDriver(
    branchId: string,
    driverId?: string,
  ): Promise<ReceivableEventRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.branchId === branchId && (driverId === undefined || row.driverId === driverId))
      .sort((left, right) => right.createdAtMs - left.createdAtMs)
      .map((row) => structuredClone(row))
  }

  snapshot(): Map<string, ReceivableEventRecord> {
    return structuredClone(this.rows)
  }

  restore(snapshot: Map<string, ReceivableEventRecord>): void {
    this.rows.clear()
    for (const [id, row] of snapshot) this.rows.set(id, structuredClone(row))
  }
}
