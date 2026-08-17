import type { CloseDraftRecord, CloseDraftRepo } from '@ash/contracts'
import type { MemoryMediaRepo } from './media.ts'

export class MemoryCloseDraftRepo implements CloseDraftRepo {
  readonly rows = new Map<string, CloseDraftRecord>()
  readonly observations = new Map<string, Parameters<CloseDraftRepo['saveRead']>[0]['observations'][number]>()
  private readonly media: MemoryMediaRepo

  constructor(media: MemoryMediaRepo) {
    this.media = media
  }

  async findByShift(shiftId: string): Promise<CloseDraftRecord | null> {
    const row = this.rows.get(shiftId)
    return row ? structuredClone(row) : null
  }

  async getOrCreate(input: Omit<CloseDraftRecord, 'revision'>): Promise<CloseDraftRecord> {
    const current = this.rows.get(input.shiftId)
    if (current) return structuredClone(current)
    const created: CloseDraftRecord = { ...structuredClone(input), revision: 0 }
    this.rows.set(input.shiftId, created)
    return structuredClone(created)
  }

  async update(input: Parameters<CloseDraftRepo['update']>[0]): Promise<CloseDraftRecord | null> {
    const current = this.rows.get(input.shiftId)
    if (!current || current.revision !== input.expectedRevision || current.submittedAtMs !== null) return null
    const updated: CloseDraftRecord = {
      ...current,
      revision: current.revision + 1,
      draftHash: input.draftHash,
      data: structuredClone(input.data),
      updatedAtMs: input.updatedAtMs,
      updatedBy: input.updatedBy,
    }
    this.rows.set(input.shiftId, updated)
    return structuredClone(updated)
  }

  async markSubmitted(input: Parameters<CloseDraftRepo['markSubmitted']>[0]): Promise<CloseDraftRecord | null> {
    const current = this.rows.get(input.shiftId)
    if (!current || current.revision !== input.expectedRevision || current.draftHash !== input.expectedDraftHash) return null
    if (current.submittedAtMs !== null) return structuredClone(current)
    const updated = {
      ...current,
      submittedAtMs: input.submittedAtMs,
      updatedAtMs: input.submittedAtMs,
      updatedBy: input.updatedBy,
    }
    this.rows.set(input.shiftId, updated)
    return structuredClone(updated)
  }

  async reopen(input: Parameters<CloseDraftRepo['reopen']>[0]): Promise<CloseDraftRecord | null> {
    const current = this.rows.get(input.shiftId)
    if (!current) return null
    if (current.submittedAtMs === null) return structuredClone(current)
    const updated: CloseDraftRecord = {
      ...current,
      revision: current.revision + 1,
      submittedAtMs: null,
      updatedAtMs: input.updatedAtMs,
      updatedBy: input.updatedBy,
    }
    this.rows.set(input.shiftId, updated)
    return structuredClone(updated)
  }

  async saveRead(input: Parameters<CloseDraftRepo['saveRead']>[0]): Promise<CloseDraftRecord | null> {
    const attached = (await this.media.listSlots(input.shiftId)).find(
      (slot) =>
        slot.package === 'end' &&
        slot.slot === input.slot &&
        slot.mediaId === input.mediaId &&
        slot.attachmentToken === input.attachmentToken,
    )
    if (!attached) return null
    const updated = await this.update({
      shiftId: input.shiftId,
      expectedRevision: input.expectedRevision,
      data: input.data,
      draftHash: input.draftHash,
      updatedAtMs: input.updatedAtMs,
      updatedBy: input.updatedBy,
    })
    if (!updated) return null
    for (const observation of input.observations) this.observations.set(observation.id, structuredClone(observation))
    return updated
  }

  snapshot(): { rows: Map<string, CloseDraftRecord>; observations: Map<string, unknown> } {
    return {
      rows: new Map([...this.rows].map(([key, row]) => [key, structuredClone(row)])),
      observations: new Map([...this.observations].map(([key, row]) => [key, structuredClone(row)])),
    }
  }

  restore(snapshot: ReturnType<MemoryCloseDraftRepo['snapshot']>): void {
    this.rows.clear()
    for (const [key, row] of snapshot.rows) this.rows.set(key, structuredClone(row))
    this.observations.clear()
    for (const [key, row] of snapshot.observations) {
      this.observations.set(key, structuredClone(row) as Parameters<CloseDraftRepo['saveRead']>[0]['observations'][number])
    }
  }
}
