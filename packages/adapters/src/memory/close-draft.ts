import type {
  CloseDraftObservationRecord,
  CloseDraftReadRecord,
  CloseDraftRecord,
  CloseDraftRepo,
  OcrField,
} from '@ash/contracts'
import type { MemoryMediaRepo } from './media.ts'

/** Mirrors the durable `shift_close_draft_reads` row this adapter has to behave like. */
type MemoryDraftRead = {
  readId: string
  shiftId: string
  mediaId: string
  attachmentToken: string
  slot: string
  field: OcrField
  status: CloseDraftReadRecord['status']
}

export class MemoryCloseDraftRepo implements CloseDraftRepo {
  readonly rows = new Map<string, CloseDraftRecord>()
  readonly observations = new Map<string, CloseDraftObservationRecord>()
  readonly reads = new Map<string, MemoryDraftRead>()
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
    // At most one COMPLETE read per (shift, media, attachment generation, field) — the same rule the
    // Postgres repo enforces under the shift row lock. See the comment there for why.
    if (input.read.status === 'complete' && input.replacesCompletedRead !== true) {
      for (const read of this.reads.values()) {
        if (
          read.shiftId === input.shiftId &&
          read.mediaId === input.mediaId &&
          read.attachmentToken === input.attachmentToken &&
          read.field === input.read.field &&
          read.status === 'complete'
        ) {
          const current = this.rows.get(input.shiftId)
          return current ? structuredClone(current) : null
        }
      }
    }
    const updated = await this.update({
      shiftId: input.shiftId,
      expectedRevision: input.expectedRevision,
      data: input.data,
      draftHash: input.draftHash,
      updatedAtMs: input.updatedAtMs,
      updatedBy: input.updatedBy,
    })
    if (!updated) return null
    this.reads.set(input.read.readId, {
      readId: input.read.readId,
      shiftId: input.shiftId,
      mediaId: input.mediaId,
      attachmentToken: input.attachmentToken,
      slot: input.slot,
      field: input.read.field,
      status: input.read.status,
    })
    for (const observation of input.observations) {
      this.observations.set(observation.id, structuredClone({
        ...observation,
        readId: input.read.readId,
        shiftId: input.shiftId,
        mediaId: input.mediaId,
        attachmentToken: input.attachmentToken,
        slot: input.slot,
        field: input.read.field,
        createdAtMs: input.updatedAtMs,
      }))
    }
    return updated
  }

  async listObservationsByShift(shiftId: string): Promise<CloseDraftObservationRecord[]> {
    return [...this.observations.values()]
      .filter((observation) => observation.shiftId === shiftId)
      .sort((a, b) =>
        a.attachmentToken === b.attachmentToken
          ? a.rowIndex - b.rowIndex
          : a.attachmentToken < b.attachmentToken ? -1 : 1)
      .map((observation) => structuredClone(observation))
  }

  snapshot(): {
    rows: Map<string, CloseDraftRecord>
    observations: Map<string, unknown>
    reads: Map<string, unknown>
  } {
    return {
      rows: new Map([...this.rows].map(([key, row]) => [key, structuredClone(row)])),
      observations: new Map([...this.observations].map(([key, row]) => [key, structuredClone(row)])),
      reads: new Map([...this.reads].map(([key, row]) => [key, structuredClone(row)])),
    }
  }

  restore(snapshot: ReturnType<MemoryCloseDraftRepo['snapshot']>): void {
    this.rows.clear()
    for (const [key, row] of snapshot.rows) this.rows.set(key, structuredClone(row))
    this.observations.clear()
    for (const [key, row] of snapshot.observations) {
      this.observations.set(key, structuredClone(row) as CloseDraftObservationRecord)
    }
    this.reads.clear()
    for (const [key, row] of snapshot.reads) this.reads.set(key, structuredClone(row) as MemoryDraftRead)
  }
}
