import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DRIVER_BUILD_ID,
  canActivateDriverUpdate,
  driverWorkerRegistrationState,
  hasPendingEndDraft,
  hasPendingEvidence,
} from '../src/UpdateBar.tsx'

class KeyStorage {
  private readonly keys: string[]

  constructor(keys: string[]) {
    this.keys = keys
  }
  get length(): number { return this.keys.length }
  key(index: number): string | null { return this.keys[index] ?? null }
}

function evidenceFactory(countValue: number): IDBFactory {
  const countRequest = {
    result: 0,
    error: null,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
  }
  const transaction = {
    error: null,
    onabort: null as (() => void) | null,
    onerror: null as (() => void) | null,
    objectStore: () => ({
      count: () => {
        queueMicrotask(() => {
          countRequest.result = countValue
          countRequest.onsuccess?.()
        })
        return countRequest
      },
    }),
  }
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => transaction,
    close: () => undefined,
  }
  const openRequest = {
    result: database,
    error: null,
    onblocked: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onupgradeneeded: null as (() => void) | null,
    onsuccess: null as (() => void) | null,
  }
  return {
    open: () => {
      queueMicrotask(() => openRequest.onsuccess?.())
      return openRequest
    },
  } as unknown as IDBFactory
}

describe('driver PWA update safety', () => {
  it('activates only at a proven idle boundary after recovery storage is clear', () => {
    expect(canActivateDriverUpdate(false, 'clear')).toBe(false)
    expect(canActivateDriverUpdate(true, 'unchecked')).toBe(false)
    expect(canActivateDriverUpdate(true, 'blocked')).toBe(false)
    expect(canActivateDriverUpdate(true, 'clear')).toBe(true)
  })

  it('detects a waiting worker and an active worker that has not claimed this tab', () => {
    const controller = {} as ServiceWorker
    const active = {} as ServiceWorker
    const waiting = {} as ServiceWorker
    expect(driverWorkerRegistrationState(null, controller)).toBe('current')
    expect(driverWorkerRegistrationState({ waiting: null, active }, null)).toBe('current')
    expect(driverWorkerRegistrationState({ waiting, active: controller }, controller)).toBe('waiting')
    expect(driverWorkerRegistrationState({ waiting: null, active }, controller)).toBe('refresh')
    expect(driverWorkerRegistrationState({ waiting: null, active: controller }, controller)).toBe('current')
  })

  it('treats every close-draft generation and an unreadable store as pending work', () => {
    expect(hasPendingEndDraft(new KeyStorage(['language', 'ash:driver:end-draft:v1:driver:shift']))).toBe(true)
    expect(hasPendingEndDraft(new KeyStorage(['language', 'theme']))).toBe(false)
    expect(hasPendingEndDraft({
      get length() { throw new Error('storage disabled') },
      key: () => null,
    })).toBe(true)
  })

  it('blocks on retained evidence and permits an empty evidence store', async () => {
    await expect(hasPendingEvidence(evidenceFactory(1))).resolves.toBe(true)
    await expect(hasPendingEvidence(evidenceFactory(0))).resolves.toBe(false)
    await expect(hasPendingEvidence('blocked')).resolves.toBe(true)
    await expect(hasPendingEvidence({ open: () => { throw new Error('blocked') } } as unknown as IDBFactory))
      .resolves.toBe(true)
  })

  it('ships a readable deployment-specific build id and wires the gate inside DriverApp', () => {
    expect(DRIVER_BUILD_ID).toMatch(/^\d{6}\.\d{6}Z(?:-[0-9a-f]{7})?$/)
    const driver = readFileSync(new URL('../src/DriverApp.tsx', import.meta.url), 'utf8')
    const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
    expect(driver).toContain('<UpdateBar safeBoundary={safeUpdateBoundary} />')
    expect(driver).toContain('assignment?.driverId === session.driverId && !inFlight')
    expect(main).not.toContain('<UpdateBar')
  })
})
