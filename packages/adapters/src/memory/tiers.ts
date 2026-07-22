import type { NotificationRecord, NotificationRepo, TierRepo, TierRuleRecord } from '@ash/contracts'

export class MemoryTierRepo implements TierRepo {
  readonly rows: TierRuleRecord[] = []
  private nextId = 1

  async list(): Promise<TierRuleRecord[]> {
    return this.rows.map((r) => structuredClone(r))
  }

  async publish(rule: Omit<TierRuleRecord, 'id' | 'status'>): Promise<TierRuleRecord> {
    // Supersede, never delete. A past day must still resolve to the rate that actually applied
    // to it — which is why resolution filters on 'active' AND 'superseded'.
    for (const existing of this.rows) {
      if (existing.vehicleTypeId === rule.vehicleTypeId && existing.status === 'active') {
        existing.status = 'superseded'
      }
    }
    const row: TierRuleRecord = { ...structuredClone(rule), id: this.nextId++, status: 'active' }
    this.rows.push(row)
    return structuredClone(row)
  }

  async withdraw(id: number, _actorId: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id)
    if (row) row.status = 'withdrawn'
  }
}

export class MemoryNotificationRepo implements NotificationRepo {
  readonly rows: NotificationRecord[] = []
  private nextId = 1

  async push(record: Omit<NotificationRecord, 'id'>): Promise<void> {
    // A bell that rings twice for one event is a bell people learn to ignore.
    if (record.dedupeKey !== null) {
      const exists = this.rows.some(
        (r) => r.recipientId === record.recipientId && r.dedupeKey === record.dedupeKey,
      )
      if (exists) return
    }
    this.rows.push({ ...record, id: this.nextId++ })
  }

  async listForRecipient(recipientId: string, unreadOnly: boolean): Promise<NotificationRecord[]> {
    return this.rows
      .filter((r) => r.recipientId === recipientId && (!unreadOnly || r.readAtMs === null))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
  }

  async markRead(id: number, recipientId: string, atMs: number): Promise<void> {
    const row = this.rows.find((r) => r.id === id && r.recipientId === recipientId)
    if (row && row.readAtMs === null) row.readAtMs = atMs
  }

  async unreadCount(recipientId: string): Promise<number> {
    return this.rows.filter((r) => r.recipientId === recipientId && r.readAtMs === null).length
  }
}
