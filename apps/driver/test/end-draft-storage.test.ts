import { describe, expect, it } from 'vitest'
import {
  clearEndDraft,
  endDraftStorageKey,
  parseEndDraft,
  readEndDraft,
  restoreEndDraftScalars,
  writeEndDraft,
} from '../src/end-draft-storage.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()
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

describe('closing draft crash recovery', () => {
  it('round-trips scalars under a shift-specific key without trying to serialise a File', () => {
    const storage = new MemoryStorage()
    expect(writeEndDraft(storage, 'shift/a', scalars, 1234)).toBe(true)
    expect(storage.values.has(endDraftStorageKey('shift/a'))).toBe(true)
    expect(readEndDraft(storage, 'shift/a')).toEqual({ version: 1, savedAt: 1234, ...scalars })
    expect(readEndDraft(storage, 'other-shift')).toBeNull()
  })

  it('restores local unsent values over server/default scalars, including anomaly acknowledgement', () => {
    const saved = { version: 1 as const, savedAt: 1234, ...scalars }
    expect(
      restoreEndDraftScalars(
        {
          cash: '',
          wallet: '',
          walletOcr: null,
          walletHumanEdited: false,
          odo: '',
          odoOcr: null,
          odoAiAuthoritative: false,
          odoHumanEdited: false,
          odoConfirmed: false,
          untouched: 'kept',
        },
        saved,
      ),
    ).toEqual({ ...scalars, untouched: 'kept' })
  })

  it('fails closed and removes a corrupt or partial draft', () => {
    const storage = new MemoryStorage()
    storage.setItem(endDraftStorageKey('shift-1'), '{"version":1,"odo":"6948"}')
    expect(readEndDraft(storage, 'shift-1')).toBeNull()
    expect(storage.getItem(endDraftStorageKey('shift-1'))).toBeNull()
    expect(parseEndDraft('not json')).toBeNull()
  })

  it('clears untrusted legacy wallet and odometer machine fields after the authority update', () => {
    const legacy = JSON.stringify({
      version: 1,
      savedAt: 1234,
      cash: '4935',
      wallet: '214.0',
      walletOcr: '279.50',
      odo: '6030',
      odoOcr: 6030,
      odoHumanEdited: false,
      odoConfirmed: false,
    })
    expect(parseEndDraft(legacy)).toMatchObject({
      wallet: '',
      walletOcr: null,
      walletHumanEdited: false,
      cash: '4935',
      odo: '',
      odoOcr: null,
      odoAiAuthoritative: false,
    })
  })

  it('preserves an explicitly typed legacy odometer while dropping its untrusted machine baseline', () => {
    const legacy = JSON.stringify({
      version: 1,
      savedAt: 1234,
      cash: '4935',
      wallet: '279.50',
      walletOcr: '279.50',
      walletHumanEdited: false,
      odo: '6031',
      odoOcr: 214,
      odoHumanEdited: true,
      odoConfirmed: false,
    })
    expect(parseEndDraft(legacy)).toMatchObject({
      odo: '6031',
      odoOcr: null,
      odoAiAuthoritative: false,
      odoHumanEdited: true,
    })
  })

  it('clears the exact shift at terminal without touching another shift', () => {
    const storage = new MemoryStorage()
    writeEndDraft(storage, 'shift-1', scalars, 1)
    writeEndDraft(storage, 'shift-2', scalars, 2)
    clearEndDraft(storage, 'shift-1')
    expect(readEndDraft(storage, 'shift-1')).toBeNull()
    expect(readEndDraft(storage, 'shift-2')).not.toBeNull()
  })

  it('never lets unavailable/quota-blocked storage break the closing screen', () => {
    const blocked = {
      getItem(): string | null {
        throw new Error('blocked')
      },
      setItem(): void {
        throw new Error('quota')
      },
      removeItem(): void {
        throw new Error('blocked')
      },
    }
    expect(readEndDraft(blocked, 'shift-1')).toBeNull()
    expect(writeEndDraft(blocked, 'shift-1', scalars)).toBe(false)
    expect(() => clearEndDraft(blocked, 'shift-1')).not.toThrow()
  })
})
