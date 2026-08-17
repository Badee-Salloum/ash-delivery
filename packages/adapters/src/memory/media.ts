import type {
  AttachedSlot,
  AttachmentHistoryRecord,
  BlobStore,
  EvidencePackage,
  MediaRecord,
  MediaRepo,
} from '@ash/contracts'

/**
 * In-memory evidence storage.
 *
 * `MemoryBlobStore` is for tests. `LocalDiskBlobStore` and `S3BlobStore` live in
 * `@ash/adapters/blob` — on a serverless host (Vercel) local disk is ephemeral, so production
 * MUST use an object store. `assertDurableBlobStore()` in the API refuses to start in
 * production against a non-durable one, because photos that vanish on redeploy are worse than
 * no photos: the ledger would still claim the shift was evidenced.
 */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, { bytes: Uint8Array; contentType: string }>()
  readonly durable = false

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.blobs.set(key, { bytes, contentType })
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.blobs.get(key)?.bytes ?? null
  }
  async exists(key: string): Promise<boolean> {
    return this.blobs.has(key)
  }
  get size(): number {
    return this.blobs.size
  }
}

export class MemoryMediaRepo implements MediaRepo {
  readonly records = new Map<string, MediaRecord>()
  /** key: `${shiftId}|${package}|${slot}` — one photo per slot, mirroring the DB unique index. */
  readonly slots = new Map<string, AttachedSlot>()
  /** Append-only provenance, mirroring shift_media_attachment_history. */
  readonly attachmentHistory: AttachmentHistoryRecord[] = []
  readonly restoreDecisions: Array<{
    shiftId: string
    historyId: string
    fromAttachmentToken: string | null
    toAttachmentToken: string
    actorId: string
    reason: string
    restoredAtMs: number
  }> = []
  private nextAttachmentToken = 1
  private nextHistoryId = 1

  snapshotState() {
    return {
      slots: new Map([...this.slots].map(([key, value]) => [key, { ...value }])),
      attachmentHistory: this.attachmentHistory.map((row) => ({ ...row })),
      restoreDecisions: this.restoreDecisions.map((row) => ({ ...row })),
      nextAttachmentToken: this.nextAttachmentToken,
      nextHistoryId: this.nextHistoryId,
    }
  }

  restoreState(snapshot: ReturnType<MemoryMediaRepo['snapshotState']>): void {
    this.slots.clear()
    for (const [key, value] of snapshot.slots) this.slots.set(key, { ...value })
    this.attachmentHistory.splice(0, this.attachmentHistory.length, ...snapshot.attachmentHistory.map((row) => ({ ...row })))
    this.restoreDecisions.splice(0, this.restoreDecisions.length, ...snapshot.restoreDecisions.map((row) => ({ ...row })))
    this.nextAttachmentToken = snapshot.nextAttachmentToken
    this.nextHistoryId = snapshot.nextHistoryId
  }

  async put(record: MediaRecord): Promise<MediaRecord> {
    // Content-addressed: the same bytes uploaded twice (a retry after Wi-Fi dropped) resolve to
    // the same record rather than storing the photo again.
    const existing = await this.findBySha(record.branchId, record.sha256)
    if (existing) return existing
    this.records.set(record.id, { ...record })
    return record
  }

  async findBySha(branchId: string, sha256: string): Promise<MediaRecord | null> {
    for (const r of this.records.values()) {
      if (r.branchId === branchId && r.sha256 === sha256) return { ...r }
    }
    return null
  }

  async findById(id: string): Promise<MediaRecord | null> {
    const r = this.records.get(id)
    return r ? { ...r } : null
  }

  async attach(
    shiftId: string,
    pkg: EvidencePackage,
    slot: string,
    mediaId: string,
    metadata: {
      actorId: string | null
      attachedAtMs?: number
      reusedFromShiftId?: string | null
      expectedAttachmentToken?: string | null
    },
  ): Promise<void> {
    const key = `${shiftId}|${pkg}|${slot}`
    const existing = this.slots.get(key)
    if (
      metadata.expectedAttachmentToken !== undefined &&
      (existing?.attachmentToken ?? null) !== metadata.expectedAttachmentToken
    ) {
      throw Object.assign(new Error('evidence attachment changed before replacement'), {
        code: 'MEDIA_ATTACHMENT_CHANGED',
      })
    }
    for (const [candidateKey, candidate] of this.slots) {
      if (!candidateKey.startsWith(`${shiftId}|`) || candidateKey === key || candidate.mediaId !== mediaId) continue
      throw Object.assign(new Error('the same evidence is already active in another slot'), {
        code: 'MEDIA_ALREADY_ATTACHED',
        sourcePackage: candidate.package,
        sourceSlot: candidate.slot,
      })
    }
    // An exact retry is idempotent evidence attachment: keep its original time and acknowledgement.
    if (existing?.mediaId === mediaId) return
    let reusedFromShiftId = metadata.reusedFromShiftId ?? null
    if (reusedFromShiftId === null) {
      for (const prior of this.attachmentHistory.toReversed()) {
        if (prior.mediaId !== mediaId) continue
        reusedFromShiftId = prior.shiftId
        break
      }
    }
    const attached: AttachedSlot = {
      package: pkg,
      slot,
      mediaId,
      attachmentToken: `memory-attachment-${this.nextAttachmentToken++}`,
      attachedAtMs: metadata.attachedAtMs ?? Date.now(),
      reusedFromShiftId,
      staleAcknowledgedAtMs: null,
      staleAcknowledgedBy: null,
    }
    this.slots.set(key, attached)
    this.attachmentHistory.push({
      id: String(this.nextHistoryId++),
      shiftId,
      package: pkg,
      slot,
      mediaId,
      attachmentToken: attached.attachmentToken,
      attachedAtMs: attached.attachedAtMs,
      reusedFromShiftId,
    })
  }

  async acknowledgeStale(
    shiftId: string,
    pkg: EvidencePackage,
    slot: string,
    expectedMediaId: string,
    expectedAttachmentToken: string,
    acknowledgedBy: string,
    acknowledgedAtMs: number,
  ): Promise<void> {
    const key = `${shiftId}|${pkg}|${slot}`
    const attached = this.slots.get(key)
    if (
      !attached ||
      attached.mediaId !== expectedMediaId ||
      attached.attachmentToken !== expectedAttachmentToken
    ) {
      throw Object.assign(new Error('evidence attachment changed before acknowledgement'), {
        code: 'MEDIA_ATTACHMENT_CHANGED',
      })
    }
    this.slots.set(key, {
      ...attached,
      staleAcknowledgedAtMs: acknowledgedAtMs,
      staleAcknowledgedBy: acknowledgedBy,
    })
  }

  async detach(
    shiftId: string,
    pkg: EvidencePackage,
    slot: string,
    _actorId: string | null,
    expectedAttachmentToken?: string,
  ): Promise<void> {
    // The blob and its `media` record stay: content-addressed bytes may be another slot's too.
    const key = `${shiftId}|${pkg}|${slot}`
    const current = this.slots.get(key)
    if (expectedAttachmentToken !== undefined && current?.attachmentToken !== expectedAttachmentToken) {
      throw Object.assign(new Error('evidence attachment changed before delete'), { code: 'MEDIA_ATTACHMENT_CHANGED' })
    }
    this.slots.delete(key)
  }

  async listSlots(shiftId: string): Promise<AttachedSlot[]> {
    const out: AttachedSlot[] = []
    for (const [key, value] of this.slots) {
      if (key.startsWith(`${shiftId}|`)) out.push(value)
    }
    return out
  }

  async listAttachmentHistory(shiftId: string): Promise<AttachmentHistoryRecord[]> {
    return this.attachmentHistory
      .filter((row) => row.shiftId === shiftId)
      .toReversed()
      .map((row) => ({ ...row }))
  }

  async latestAttachmentForMedia(
    mediaId: string,
    _options?: { lock?: boolean },
  ): Promise<AttachmentHistoryRecord | null> {
    const row = this.attachmentHistory.toReversed().find((candidate) => candidate.mediaId === mediaId)
    return row ? { ...row } : null
  }

  async restoreAttachment(input: {
    shiftId: string
    historyId: string
    expectedCurrentAttachmentToken: string | null
    actorId: string
    reason: string
    attachedAtMs: number
  }): Promise<AttachedSlot> {
    const historical = this.attachmentHistory.find(
      (row) => row.id === input.historyId && row.shiftId === input.shiftId,
    )
    if (!historical) throw Object.assign(new Error('attachment history not found'), { code: 'MEDIA_HISTORY_NOT_FOUND' })
    const current = this.slots.get(`${input.shiftId}|${historical.package}|${historical.slot}`)
    if ((current?.attachmentToken ?? null) !== input.expectedCurrentAttachmentToken) {
      throw Object.assign(new Error('attachment changed before restore'), { code: 'MEDIA_ATTACHMENT_CHANGED' })
    }
    if (current?.mediaId === historical.mediaId) {
      throw Object.assign(new Error('attachment history generation is already current'), { code: 'MEDIA_HISTORY_CURRENT' })
    }
    await this.attach(input.shiftId, historical.package, historical.slot, historical.mediaId, {
      actorId: input.actorId,
      attachedAtMs: input.attachedAtMs,
      reusedFromShiftId: historical.shiftId,
    })
    const restored = (await this.listSlots(input.shiftId)).find(
      (slot) => slot.package === historical.package && slot.slot === historical.slot,
    )!
    await this.acknowledgeStale(
      input.shiftId,
      restored.package,
      restored.slot,
      restored.mediaId,
      restored.attachmentToken,
      input.actorId,
      input.attachedAtMs,
    )
    this.restoreDecisions.push({
      shiftId: input.shiftId,
      historyId: input.historyId,
      fromAttachmentToken: current?.attachmentToken ?? null,
      toAttachmentToken: restored.attachmentToken,
      actorId: input.actorId,
      reason: input.reason,
      restoredAtMs: input.attachedAtMs,
    })
    return (await this.listSlots(input.shiftId)).find(
      (slot) => slot.package === historical.package && slot.slot === historical.slot,
    )!
  }
}
