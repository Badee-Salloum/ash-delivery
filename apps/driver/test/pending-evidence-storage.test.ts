import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isPendingEvidenceRecord,
  pendingEvidenceExpired,
  pendingEvidenceKey,
  pendingEvidenceRecord,
  putPendingEvidence,
} from '../src/pending-evidence-storage.ts'

afterEach(() => vi.unstubAllGlobals())

describe('pending evidence IndexedDB storage', () => {
  it('copies only the visible Uint8Array bytes and keys them by exact shift/package/slot', () => {
    const pooled = new Uint8Array([9, 1, 2, 8])
    const visible = pooled.subarray(1, 3)
    const record = pendingEvidenceRecord(
      {
        shiftId: 'shift/1',
        package: 'end',
        slot: 'dashboard_2',
        generationId: 'generation-1',
        fileName: 'page.jpg',
        mimeType: 'image/jpeg',
        lastModified: 123,
        bytes: visible,
      },
      456,
    )

    expect(record.key).toBe(pendingEvidenceKey('shift/1', 'end', 'dashboard_2'))
    expect([...new Uint8Array(record.bytes)]).toEqual([1, 2])
    expect(record).toMatchObject({ version: 2, createdAt: 456, savedAt: 456 })
    expect(isPendingEvidenceRecord(record)).toBe(true)
    expect(pendingEvidenceExpired(record, 456 + 48 * 60 * 60_000 - 1)).toBe(false)
    expect(pendingEvidenceExpired(record, 456 + 48 * 60 * 60_000)).toBe(true)
  })

  it('does not resolve a write on request success before the transaction commits', async () => {
    let transactionComplete: (() => void) | null = null
    const putRequest: { onsuccess: (() => void) | null; onerror: (() => void) | null; error: null } = {
      onsuccess: null,
      onerror: null,
      error: null,
    }
    const transaction = {
      error: null,
      onabort: null as (() => void) | null,
      onerror: null as (() => void) | null,
      oncomplete: null as (() => void) | null,
      objectStore: () => ({ put: () => putRequest }),
    }
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: vi.fn(),
      transaction: () => transaction,
      close: vi.fn(),
    }
    const openRequest = {
      result: db,
      error: null,
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onblocked: null as (() => void) | null,
    }
    vi.stubGlobal('indexedDB', {
      open: () => {
        queueMicrotask(() => openRequest.onsuccess?.())
        return openRequest
      },
    } as unknown as IDBFactory)

    let settled = false
    const write = putPendingEvidence({
      shiftId: 'shift-1',
      package: 'end',
      slot: 'dashboard',
      generationId: 'generation-1',
      fileName: 'page.jpg',
      mimeType: 'image/jpeg',
      lastModified: 1,
      bytes: new Uint8Array([1]),
    }).then(() => {
      settled = true
    })
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    transactionComplete = transaction.oncomplete
    putRequest.onsuccess?.()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(settled).toBe(false)

    transactionComplete?.()
    await write
    expect(settled).toBe(true)
    expect(db.close).toHaveBeenCalledOnce()
  })

  it('clears retained bytes across logout or a different account without storing image data in localStorage', () => {
    const app = readFileSync(new URL('../src/DriverApp.tsx', import.meta.url), 'utf8')
    expect(app).toContain("const PENDING_EVIDENCE_OWNER_KEY = 'ash.pendingEvidenceOwner'")
    expect(app).toContain('remembered !== next')
    expect(app).toContain('void deleteAllPendingEvidence()')
    expect(app).toContain('await deleteAllPendingEvidence()')
    expect(app).toContain('clearAllEndDrafts(storage)')
    expect(app).toContain('sweepExpiredEndDrafts(storage)')
    expect(app).not.toContain('localStorage.setItem(PENDING_EVIDENCE_OWNER_KEY, JSON.stringify')
  })
})
