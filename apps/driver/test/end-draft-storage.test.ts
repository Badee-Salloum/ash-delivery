import { describe, expect, it } from 'vitest'
import {
  END_DRAFT_TTL_MS,
  clearAllEndDrafts,
  clearEndDraft,
  endDraftStorageKey,
  parseEndDraft,
  readEndDraft,
  restoreEndDraftScalars,
  sweepExpiredEndDrafts,
  writeEndDraft,
} from '../src/end-draft-storage.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()
  get length(): number {
    return this.values.size
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const scalars = {
  persistedCashDeclared: '120.00',
  persistedWalletDeclared: '60.00',
  persistedOdometerKm: 6940,
  persistedOdometerAnomalyConfirmed: false,
  cash: '123.45',
  wallet: '67.89',
  walletOcr: '67.80',
  walletHumanEdited: true,
  odo: '6948',
  odoOcr: 6943,
  odoAiAuthoritative: true,
  odoHumanEdited: true,
  odoConfirmed: true,
}

const operations = {
  manualOrders: [{
    clientKey: 'manual-1',
    providerOrderNo: '',
    payMode: 'cash' as const,
    fee: '100',
    occurredMinute: null,
    occurredDate: null,
    pointA: null,
    pointB: null,
    source: 'manual' as const,
  }],
  manualCashDeductions: [],
  manualMovements: [],
  rowEdits: [{ clientKey: 'ocr-1', kind: 'order' as const, fee: '225' }],
}
const base = { revision: 7, draftHash: 'hash-7' }

describe('closing draft crash recovery', () => {
  it('round-trips an owner-scoped human overlay without storing File/image bytes', () => {
    const storage = new MemoryStorage()
    expect(writeEndDraft(storage, 'driver-a', 'shift/a', scalars, operations, 'dirty-1', base, 1234)).toBe(true)
    expect(storage.values.has(endDraftStorageKey('driver-a', 'shift/a'))).toBe(true)
    expect(readEndDraft(storage, 'driver-a', 'shift/a', 1235)).toMatchObject({
      version: 2,
      ownerDriverId: 'driver-a',
      shiftId: 'shift/a',
      savedAt: 1234,
      expiresAt: 1234 + END_DRAFT_TTL_MS,
      fingerprint: 'dirty-1',
      baseRevision: 7,
      baseDraftHash: 'hash-7',
      operations,
      ...scalars,
    })
    expect(storage.getItem(endDraftStorageKey('driver-a', 'shift/a'))).not.toContain('data:image')
    expect(readEndDraft(storage, 'driver-b', 'shift/a', 1235)).toBeNull()
  })

  it('restores unsaved scalars over a canonical/default draft', () => {
    const storage = new MemoryStorage()
    writeEndDraft(storage, 'driver-a', 'shift-1', scalars, operations, 'dirty', base, 100)
    const saved = readEndDraft(storage, 'driver-a', 'shift-1', 101)!
    expect(
      restoreEndDraftScalars(
        {
          cash: '', wallet: '', walletOcr: null, walletHumanEdited: false,
          persistedCashDeclared: null, persistedWalletDeclared: null,
          persistedOdometerKm: null, persistedOdometerAnomalyConfirmed: false,
          odo: '', odoOcr: null, odoAiAuthoritative: false, odoHumanEdited: false,
          odoConfirmed: false, untouched: 'kept',
        },
        saved,
      ),
    ).toEqual({ ...scalars, untouched: 'kept' })
  })

  it('keeps legacy v2 records readable but marks their base as unknown', () => {
    const storage = new MemoryStorage()
    writeEndDraft(storage, 'driver-a', 'shift-1', scalars, operations, 'dirty', base, 100)
    const key = endDraftStorageKey('driver-a', 'shift-1')
    const legacy = JSON.parse(storage.getItem(key)!) as Record<string, unknown>
    delete legacy.baseRevision
    delete legacy.baseDraftHash
    storage.setItem(key, JSON.stringify(legacy))

    const read = readEndDraft(storage, 'driver-a', 'shift-1', 101)!
    expect(read.version).toBe(2)
    expect(read.baseRevision).toBeUndefined()
    expect(read.baseDraftHash).toBeUndefined()
  })

  it('fails closed and removes a corrupt, expired or cross-identity record', () => {
    const storage = new MemoryStorage()
    const key = endDraftStorageKey('driver-a', 'shift-1')
    storage.setItem(key, '{"version":2,"ownerDriverId":"driver-a"}')
    expect(readEndDraft(storage, 'driver-a', 'shift-1')).toBeNull()
    expect(storage.getItem(key)).toBeNull()

    writeEndDraft(storage, 'driver-a', 'shift-1', scalars, operations, 'dirty', base, 100)
    expect(readEndDraft(storage, 'driver-a', 'shift-1', 100 + END_DRAFT_TTL_MS)).toBeNull()
    expect(parseEndDraft('not json')).toBeNull()
  })

  it('clears a canonical/terminal shift and all retained work at the logout privacy boundary', () => {
    const storage = new MemoryStorage()
    writeEndDraft(storage, 'driver-a', 'shift-1', scalars, operations, 'one', base, 1)
    writeEndDraft(storage, 'driver-a', 'shift-2', scalars, operations, 'two', base, 2)
    clearEndDraft(storage, 'driver-a', 'shift-1')
    expect(readEndDraft(storage, 'driver-a', 'shift-1', 3)).toBeNull()
    expect(readEndDraft(storage, 'driver-a', 'shift-2', 3)).not.toBeNull()

    storage.setItem('ash:driver:end-draft:v1:legacy', '{}')
    clearAllEndDrafts(storage)
    expect(storage.length).toBe(0)
  })

  it('sweeps TTL-expired and legacy unscoped work while preserving a live owner-scoped overlay', () => {
    const storage = new MemoryStorage()
    writeEndDraft(storage, 'driver-a', 'expired', scalars, operations, 'old', base, 0)
    writeEndDraft(storage, 'driver-a', 'live', scalars, operations, 'new', base, END_DRAFT_TTL_MS)
    storage.setItem('ash:driver:end-draft:v1:legacy', '{}')
    sweepExpiredEndDrafts(storage, END_DRAFT_TTL_MS + 1)
    expect(readEndDraft(storage, 'driver-a', 'expired', END_DRAFT_TTL_MS + 1)).toBeNull()
    expect(readEndDraft(storage, 'driver-a', 'live', END_DRAFT_TTL_MS + 1)).not.toBeNull()
    expect(storage.getItem('ash:driver:end-draft:v1:legacy')).toBeNull()
  })

  it('never lets unavailable/quota-blocked storage break the closing screen', () => {
    const blocked = {
      get length(): number { throw new Error('blocked') },
      key(): string | null { throw new Error('blocked') },
      getItem(): string | null { throw new Error('blocked') },
      setItem(): void { throw new Error('quota') },
      removeItem(): void { throw new Error('blocked') },
    }
    expect(readEndDraft(blocked, 'driver-a', 'shift-1')).toBeNull()
    expect(writeEndDraft(blocked, 'driver-a', 'shift-1', scalars, operations, 'dirty', base)).toBe(false)
    expect(() => clearEndDraft(blocked, 'driver-a', 'shift-1')).not.toThrow()
    expect(() => clearAllEndDrafts(blocked)).not.toThrow()
  })
})
