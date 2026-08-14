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
  odo: '6948',
  odoOcr: 6943,
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
          odo: '',
          odoOcr: null,
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
