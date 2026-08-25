/**
 * Crash-safe storage for a compressed image that has not reached a persisted read outcome yet.
 *
 * Files never go into localStorage: its small synchronous quota can freeze the close screen and a
 * base64 copy inflates an image by a third. IndexedDB stores the exact upload bytes as an
 * ArrayBuffer. The generation id makes cleanup conditional, so a late completion from an older
 * upload cannot delete a newer replacement selected for the same slot.
 */
export interface PendingEvidenceRecord {
  version: 2
  key: string
  shiftId: string
  package: 'start' | 'end'
  slot: string
  generationId: string
  /** Server attachment generation accepted for these bytes; absent on records from older clients. */
  acceptedAttachmentToken?: string | null
  fileName: string
  mimeType: string
  lastModified: number
  createdAt: number
  savedAt: number
  bytes: ArrayBuffer
}

export interface PendingEvidenceInput {
  shiftId: string
  package: 'start' | 'end'
  slot: string
  generationId: string
  fileName: string
  mimeType: string
  lastModified: number
  bytes: Uint8Array
}

const DB_NAME = 'ash-driver-evidence'
const DB_VERSION = 1
const STORE = 'pending-evidence'
export const PENDING_EVIDENCE_TTL_MS = 48 * 60 * 60_000

export function pendingEvidenceKey(shiftId: string, pkg: 'start' | 'end', slot: string): string {
  return `${encodeURIComponent(shiftId)}:${pkg}:${encodeURIComponent(slot)}`
}

export function pendingEvidenceRecord(input: PendingEvidenceInput, now = Date.now()): PendingEvidenceRecord {
  // `Uint8Array.buffer` may cover a larger pooled buffer. Slice only the visible bytes so no other
  // in-memory data is accidentally persisted beside the image.
  const bytes = input.bytes.buffer.slice(
    input.bytes.byteOffset,
    input.bytes.byteOffset + input.bytes.byteLength,
  ) as ArrayBuffer
  return {
    version: 2,
    key: pendingEvidenceKey(input.shiftId, input.package, input.slot),
    shiftId: input.shiftId,
    package: input.package,
    slot: input.slot,
    generationId: input.generationId,
    acceptedAttachmentToken: null,
    fileName: input.fileName,
    mimeType: input.mimeType,
    lastModified: input.lastModified,
    createdAt: now,
    savedAt: now,
    bytes,
  }
}

export function isPendingEvidenceRecord(value: unknown): value is PendingEvidenceRecord {
  if (value === null || typeof value !== 'object') return false
  const row = value as Partial<PendingEvidenceRecord>
  return (
    row.version === 2 &&
    typeof row.key === 'string' &&
    typeof row.shiftId === 'string' &&
    (row.package === 'start' || row.package === 'end') &&
    typeof row.slot === 'string' &&
    typeof row.generationId === 'string' &&
    (row.acceptedAttachmentToken === undefined ||
      row.acceptedAttachmentToken === null ||
      typeof row.acceptedAttachmentToken === 'string') &&
    typeof row.fileName === 'string' &&
    typeof row.mimeType === 'string' &&
    typeof row.lastModified === 'number' &&
    Number.isFinite(row.lastModified) &&
    typeof row.createdAt === 'number' &&
    Number.isFinite(row.createdAt) &&
    typeof row.savedAt === 'number' &&
    Number.isFinite(row.savedAt) &&
    row.bytes instanceof ArrayBuffer
  )
}

export function pendingEvidenceExpired(
  record: Pick<PendingEvidenceRecord, 'createdAt'>,
  now = Date.now(),
): boolean {
  return now - record.createdAt >= PENDING_EVIDENCE_TTL_MS
}

function factory(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB
  } catch {
    return null
  }
}

function open(factoryValue: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factoryValue.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexeddb_open_failed'))
    request.onblocked = () => reject(new Error('indexeddb_blocked'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, setResult: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T | null> {
  const idb = factory()
  if (!idb) return null
  let db: IDBDatabase | null = null
  try {
    db = await open(idb)
    return await new Promise<T>((resolve, reject) => {
      const tx = db!.transaction(STORE, mode)
      let result: T
      tx.onabort = () => reject(tx.error ?? new Error('indexeddb_transaction_aborted'))
      tx.onerror = () => reject(tx.error ?? new Error('indexeddb_transaction_failed'))
      // Request success is not durability. Resolve only after the transaction commits.
      tx.oncomplete = () => resolve(result)
      run(tx.objectStore(STORE), (value) => {
        result = value
      }, reject)
    })
  } catch {
    // Evidence still uploads without IndexedDB. This store is crash recovery, never a gate.
    return null
  } finally {
    db?.close()
  }
}

export async function putPendingEvidence(input: PendingEvidenceInput): Promise<void> {
  const record = pendingEvidenceRecord(input)
  await withStore<void>('readwrite', (store, resolve, reject) => {
    const request = store.put(record)
    request.onsuccess = () => resolve(undefined)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Link retained bytes to the exact server attachment generation that accepted them.
 *
 * The generation comparison is part of the same IndexedDB transaction as the update. Therefore a
 * late accepted PUT cannot tag a newer replacement that has already occupied this slot locally.
 */
export async function markPendingEvidenceAccepted(
  shiftId: string,
  pkg: 'start' | 'end',
  slot: string,
  expectedGenerationId: string,
  attachmentToken: string,
): Promise<boolean> {
  const key = pendingEvidenceKey(shiftId, pkg, slot)
  const updated = await withStore<boolean>('readwrite', (store, resolve, reject) => {
    const get = store.get(key)
    get.onerror = () => reject(get.error)
    get.onsuccess = () => {
      const current = get.result
      if (!isPendingEvidenceRecord(current) || current.generationId !== expectedGenerationId) {
        resolve(false)
        return
      }
      const put = store.put({
        ...current,
        acceptedAttachmentToken: attachmentToken,
        savedAt: Date.now(),
      })
      put.onsuccess = () => resolve(true)
      put.onerror = () => reject(put.error)
    }
  })
  return updated ?? false
}

export interface PendingEvidenceOwner {
  generationId: string
  acceptedAttachmentToken: string | null
}

interface AttachmentReadOwner {
  attachmentToken: string
  read: { status: string } | null
}

/**
 * Return the local generation whose bytes may be removed after a persisted terminal read.
 *
 * The attachment token is the ownership boundary. A terminal result from the thumbnail currently
 * visible behind an offline replacement says nothing about that replacement and must retain it.
 */
export function terminalPendingEvidenceCleanup(
  pending: PendingEvidenceOwner | null,
  attachment: AttachmentReadOwner | null | undefined,
): PendingEvidenceOwner | null {
  if (
    pending === null ||
    pending.acceptedAttachmentToken === null ||
    attachment?.attachmentToken !== pending.acceptedAttachmentToken ||
    (attachment.read?.status !== 'complete' && attachment.read?.status !== 'failed')
  ) {
    return null
  }
  return pending
}

export async function getPendingEvidence(
  shiftId: string,
  pkg: 'start' | 'end',
  slot: string,
): Promise<PendingEvidenceRecord | null> {
  const value = await withStore<unknown>('readonly', (store, resolve, reject) => {
    const request = store.get(pendingEvidenceKey(shiftId, pkg, slot))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  // Leave corrupt legacy rows for the transactional sweep. An unconditional delete after this
  // readonly transaction could otherwise erase a valid replacement written in between.
  if (!isPendingEvidenceRecord(value)) return null
  if (pendingEvidenceExpired(value)) {
    await deletePendingEvidence(shiftId, pkg, slot, value.generationId)
    return null
  }
  return value
}

export async function deletePendingEvidence(
  shiftId: string,
  pkg: 'start' | 'end',
  slot: string,
  expectedGenerationId?: string,
): Promise<void> {
  const key = pendingEvidenceKey(shiftId, pkg, slot)
  await withStore<void>('readwrite', (store, resolve, reject) => {
    if (expectedGenerationId === undefined) {
      const request = store.delete(key)
      request.onsuccess = () => resolve(undefined)
      request.onerror = () => reject(request.error)
      return
    }
    const get = store.get(key)
    get.onerror = () => reject(get.error)
    get.onsuccess = () => {
      const current = get.result
      if (!isPendingEvidenceRecord(current) || current.generationId !== expectedGenerationId) {
        resolve(undefined)
        return
      }
      const remove = store.delete(key)
      remove.onsuccess = () => resolve(undefined)
      remove.onerror = () => reject(remove.error)
    }
  })
}

/** Terminal shift cleanup; only rows whose decoded owner exactly matches are removed. */
export async function deletePendingEvidenceForShift(shiftId: string): Promise<void> {
  await withStore<void>('readwrite', (store, resolve, reject) => {
    const cursor = store.openCursor()
    cursor.onerror = () => reject(cursor.error)
    cursor.onsuccess = () => {
      const current = cursor.result
      if (current === null) {
        resolve(undefined)
        return
      }
      if (isPendingEvidenceRecord(current.value) && current.value.shiftId === shiftId) {
        current.delete()
      }
      current.continue()
    }
  })
}

/** Remove expired/corrupt images even when their shift is never opened again on this phone. */
export async function sweepExpiredPendingEvidence(now = Date.now()): Promise<void> {
  await withStore<void>('readwrite', (store, resolve, reject) => {
    const cursor = store.openCursor()
    cursor.onerror = () => reject(cursor.error)
    cursor.onsuccess = () => {
      const current = cursor.result
      if (current === null) {
        resolve(undefined)
        return
      }
      const value = current.value
      if (!isPendingEvidenceRecord(value) || pendingEvidenceExpired(value, now)) {
        current.delete()
      }
      current.continue()
    }
  })
}

/** Privacy boundary for logout/account changes on a shared handset. */
export async function deleteAllPendingEvidence(): Promise<void> {
  await withStore<void>('readwrite', (store, resolve, reject) => {
    const request = store.clear()
    request.onsuccess = () => resolve(undefined)
    request.onerror = () => reject(request.error)
  })
}

export function pendingEvidenceBlob(record: PendingEvidenceRecord): Blob {
  return new Blob([record.bytes], { type: record.mimeType })
}
