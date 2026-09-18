/**
 * A durable buffer for GPS fixes, so a minute without signal is not a hole in the trail.
 *
 * Until now every failed post was discarded — `.catch(() => undefined)` in `use-gps-beacon.ts` —
 * so a fix taken in a basement, a lift, or one of the dead spots between Damascus districts was
 * gone the instant the request failed. Measured on 2026-09-08: of seven open shifts exactly one was
 * broadcasting, and its single stored fix had been captured thirty-two minutes before it arrived.
 *
 * Modelled on `pending-evidence-storage.ts` deliberately, down to the shape of `withStore`:
 *
 *   - hand-rolled over raw `IDBRequest` with no `idb` package, because the driver bundle is a
 *     separate one with a tight budget;
 *   - every write resolves on `tx.oncomplete`, never on request success — request success is not
 *     durability, and a fix that survives a crash is the entire point of this file;
 *   - IndexedDB being unavailable is never a gate. A phone in a private window still tracks; it
 *     just cannot survive a reload, which is strictly better than not tracking at all.
 *
 * It is a QUEUE, unlike its model, which is a keyed store recovered by a human tap. Nothing here
 * asks the driver anything: he is riding a motorbike.
 */

const DB_NAME = 'ash-driver-gps'
const DB_VERSION = 1
const STORE = 'outbox'

/**
 * How many fixes may wait at once.
 *
 * At a fix every 15 s this is about eight hours — longer than any shift, so an ordinary day out of
 * signal loses nothing. Past it the OLDEST are dropped: when the buffer is full the recent minutes
 * are the ones worth keeping, and a stale position is exactly what the live map must not show.
 */
export const GPS_OUTBOX_MAX = 2_000

/** A fix older than this is not worth a round trip. The server's own window is the same day. */
export const GPS_OUTBOX_TTL_MS = 24 * 60 * 60_000

export interface QueuedFix {
  /** `${shiftId}:${capturedAtMs}` — the server's natural key, so a double-enqueue is free too. */
  key: string
  shiftId: string
  lat: number
  lng: number
  accuracyM: number | null
  capturedAtMs: number
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
    // Tracking still works without IndexedDB. This store is crash survival, never a gate.
    return null
  } finally {
    db?.close()
  }
}

export function fixKey(shiftId: string, capturedAtMs: number): string {
  return `${encodeURIComponent(shiftId)}:${capturedAtMs}`
}

/** Everything buffered. An unavailable store reads as empty, never as an error. */
async function readAll(): Promise<QueuedFix[]> {
  const all = await withStore<QueuedFix[]>('readonly', (store, resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => resolve((request.result as QueuedFix[]) ?? [])
    request.onerror = () => reject(request.error ?? new Error('indexeddb_getall_failed'))
  })
  return all ?? []
}

/** Buffer one fix. Keyed by the server's natural key, so enqueuing the same instant twice is free. */
export async function enqueueFix(fix: Omit<QueuedFix, 'key'>): Promise<void> {
  await withStore<void>('readwrite', (store, resolve, reject) => {
    const request = store.put({ ...fix, key: fixKey(fix.shiftId, fix.capturedAtMs) } satisfies QueuedFix)
    request.onsuccess = () => resolve(undefined)
    request.onerror = () => reject(request.error ?? new Error('indexeddb_put_failed'))
  })
}

/**
 * The oldest `limit` fixes for one shift, in CAPTURE order.
 *
 * Capture order all the way through: the server stores a batch in the order it is given so its
 * identity column runs with the clock, and the trail is read back the same way. A buffer flushed
 * out of order would zigzag the route and inflate its measured distance.
 */
export function nextFlushBatch(
  all: readonly QueuedFix[],
  shiftId: string,
  limit: number,
): QueuedFix[] {
  return all
    .filter((fix) => fix.shiftId === shiftId)
    .sort((a, b) => a.capturedAtMs - b.capturedAtMs)
    .slice(0, limit)
}

export async function peekFixes(shiftId: string, limit: number): Promise<QueuedFix[]> {
  const all = await readAll()
  return nextFlushBatch(all, shiftId, limit)
}

/** Forget fixes the server has taken. Called only on a 2xx, or on the 409 that ends a shift. */
export async function dropFixes(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return
  await withStore<void>('readwrite', (store, resolve, reject) => {
    let left = keys.length
    for (const key of keys) {
      const request = store.delete(key)
      request.onerror = () => reject(request.error ?? new Error('indexeddb_delete_failed'))
      request.onsuccess = () => {
        left -= 1
        if (left === 0) resolve(undefined)
      }
    }
  })
}

/** Everything buffered for one shift — used when the server says the shift is over. */
export async function dropShift(shiftId: string): Promise<void> {
  const all = await readAll()
  await dropFixes(all.filter((fix) => fix.shiftId === shiftId).map((fix) => fix.key))
}

/**
 * Bound the buffer: drop what has expired, then the oldest beyond the cap.
 *
 * Both rules exist because this store must never be the reason a phone runs out of room. A shift
 * that ends without a flush — a force-close, an uninstall, a driver who never regains signal —
 * would otherwise leave its fixes behind forever.
 */
export function outboxSweepPlan(all: readonly QueuedFix[], nowMs: number): string[] {
  const expired = all.filter((fix) => nowMs - fix.capturedAtMs > GPS_OUTBOX_TTL_MS)
  const live = all
    .filter((fix) => nowMs - fix.capturedAtMs <= GPS_OUTBOX_TTL_MS)
    .sort((a, b) => a.capturedAtMs - b.capturedAtMs)
  // Oldest first out of the cap: when the buffer is full, recent minutes are the ones worth keeping
  // — a stale position is exactly what the live map must not be given.
  const overflow = live.slice(0, Math.max(0, live.length - GPS_OUTBOX_MAX))
  return [...expired, ...overflow].map((fix) => fix.key)
}

export async function sweepOutbox(nowMs: number): Promise<{ dropped: number }> {
  const keys = outboxSweepPlan(await readAll(), nowMs)
  await dropFixes(keys)
  return { dropped: keys.length }
}
