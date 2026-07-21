import type { AttachedSlot, BlobStore, EvidencePackage, MediaRecord, MediaRepo } from '@ash/contracts'

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

  async attach(shiftId: string, pkg: EvidencePackage, slot: string, mediaId: string): Promise<void> {
    this.slots.set(`${shiftId}|${pkg}|${slot}`, { package: pkg, slot, mediaId })
  }

  async listSlots(shiftId: string): Promise<AttachedSlot[]> {
    const out: AttachedSlot[] = []
    for (const [key, value] of this.slots) {
      if (key.startsWith(`${shiftId}|`)) out.push(value)
    }
    return out
  }
}
