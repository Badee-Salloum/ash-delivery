import { describe, expect, it, vi } from 'vitest'
import {
  browserReceivableOperationMutex,
  browserReceivableOperationStorage,
  clearPendingReceivableOperation,
  executeReceivableOperation,
  loadPendingReceivableOperation,
  pendingReceivableOperation,
  pendingReceivableOperationMatches,
  receivableDirectoryDrivers,
  receivableDriverMaySubmit,
  receivableOutboxKey,
  receivableOperationReady,
  receivableRejectionDefinitelyDidNotCommit,
  receivableWriteoffAmountWithinBalance,
  savePendingReceivableOperation,
  type ReceivableOperationMutex,
  type ReceivableOperationStorage,
} from './receivable-idempotency.ts'

const payload = {
  driverId: 'driver-1',
  receivableKind: 'ordinary' as const,
  channel: 'cash' as const,
  direction: 'create' as const,
  amount: '250.00',
  reason: 'Cash handed to the driver',
}

class MemoryStorage implements ReceivableOperationStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

class NonBlockingMutex implements ReceivableOperationMutex {
  private readonly held = new Set<string>()

  async tryRunExclusive<T>(
    name: string,
    task: () => Promise<T> | T,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    if (this.held.has(name)) return { acquired: false }
    this.held.add(name)
    try {
      return { acquired: true, value: await task() }
    } finally {
      this.held.delete(name)
    }
  }
}

const KEY_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const KEY_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const KEY_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('direct receivable submit idempotency', () => {
  it('keeps the same key for an exact retry after an uncertain response', () => {
    const generate = vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2')
    const first = pendingReceivableOperation(null, payload, generate)
    const retry = pendingReceivableOperation(first, payload, generate)

    expect(retry).toBe(first)
    expect(retry.idempotencyKey).toBe('key-1')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it.each(['250', '250.0', '250.00', '0250.00', ' 250.00 '])(
    'reuses the key for the economically equal amount %j',
    (amount) => {
      const generate = vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2')
      const first = pendingReceivableOperation(null, payload, generate)
      const retry = pendingReceivableOperation(first, { ...payload, amount }, generate)

      expect(retry).toBe(first)
      expect(retry.payload.amount).toBe('250.00')
      expect(generate).toHaveBeenCalledTimes(1)
    },
  )

  it('generates a new key after the successful operation has been cleared', () => {
    const generate = vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2')
    const first = pendingReceivableOperation(null, payload, generate)
    const afterSuccess = pendingReceivableOperation(null, payload, generate)

    expect(first.idempotencyKey).toBe('key-1')
    expect(afterSuccess.idempotencyKey).toBe('key-2')
  })

  it.each([
    ['driver', { driverId: 'driver-2' }],
    ['kind', { receivableKind: 'shift_funding' as const }],
    ['channel', { channel: 'wallet' as const }],
    ['direction', { direction: 'collect' as const }],
    ['write-off direction', { direction: 'writeoff' as const }],
    ['amount', { amount: '251.00' }],
    ['reason', { reason: 'Different reason' }],
  ])('keeps the pending command immutable when the %s changes', (_label, change) => {
    const generate = vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2')
    const first = pendingReceivableOperation(null, payload, generate)
    const changed = pendingReceivableOperation(first, { ...payload, ...change }, generate)

    expect(changed).toBe(first)
    expect(changed.idempotencyKey).toBe('key-1')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('requires a driver, positive amount, and nonblank audited reason', () => {
    expect(receivableOperationReady(payload)).toBe(true)
    expect(receivableOperationReady({ ...payload, driverId: '' })).toBe(false)
    expect(receivableOperationReady({ ...payload, amount: '' })).toBe(false)
    expect(receivableOperationReady({ ...payload, amount: '0' })).toBe(false)
    expect(receivableOperationReady({ ...payload, amount: '-1' })).toBe(false)
    expect(receivableOperationReady({ ...payload, amount: 'not-money' })).toBe(false)
    expect(receivableOperationReady({ ...payload, reason: '   ' })).toBe(false)
  })

  it('keeps inactive debtors available for collection and write-off, but never new advances', () => {
    const active = { id: 'active', active: true }
    const inactiveDebtor = { id: 'inactive-debtor', active: false }
    const inactiveClear = { id: 'inactive-clear', active: false }
    const directory = receivableDirectoryDrivers(
      [active, inactiveDebtor, inactiveClear],
      new Set(['inactive-debtor']),
    )

    expect(directory).toEqual([active, inactiveDebtor])
    expect(receivableDriverMaySubmit(active, 'create')).toBe(true)
    expect(receivableDriverMaySubmit(inactiveDebtor, 'create')).toBe(false)
    expect(receivableDriverMaySubmit(inactiveDebtor, 'collect')).toBe(true)
    expect(receivableDriverMaySubmit(inactiveDebtor, 'writeoff')).toBe(true)
    expect(receivableDriverMaySubmit(undefined, 'collect')).toBe(false)
  })

  it('accepts a write-off only for an ordinary receivable', () => {
    expect(receivableOperationReady({ ...payload, direction: 'writeoff' })).toBe(true)
    expect(receivableOperationReady({
      ...payload,
      direction: 'writeoff',
      receivableKind: 'shift_funding',
    })).toBe(false)
  })

  it('persists and restores the exact write-off command for a lost response retry', () => {
    const storage = new MemoryStorage()
    const writeoffPayload = { ...payload, direction: 'writeoff' as const, reason: 'approved loss' }
    const operation = pendingReceivableOperation(null, writeoffPayload, () => KEY_1)
    expect(savePendingReceivableOperation(storage, 'actor-1', 'branch-1', operation)).toBe(true)
    expect(loadPendingReceivableOperation(storage, 'actor-1', 'branch-1')).toEqual({
      status: 'pending',
      operation,
    })
  })

  it('allows an exact write-off replay after the committed write-off reduced the loaded balance', () => {
    const writeoffPayload = {
      ...payload,
      direction: 'writeoff' as const,
      amount: '500.00',
      reason: 'approved loss',
    }

    expect(receivableWriteoffAmountWithinBalance(writeoffPayload, '0.00', false)).toBe(false)
    expect(receivableWriteoffAmountWithinBalance(writeoffPayload, '0.00', true)).toBe(true)
    expect(receivableWriteoffAmountWithinBalance(writeoffPayload, '500.00', false)).toBe(true)
  })

  it('restores a complete outbox only for the same actor and branch', () => {
    const storage = new MemoryStorage()
    const operation = pendingReceivableOperation(null, payload, () => KEY_1)
    expect(savePendingReceivableOperation(storage, 'actor-1', 'branch-1', operation)).toBe(true)

    expect(loadPendingReceivableOperation(storage, 'actor-1', 'branch-1')).toEqual({
      status: 'pending',
      operation,
    })
    expect(loadPendingReceivableOperation(storage, 'actor-1', 'branch-2')).toEqual({ status: 'none' })
    expect(loadPendingReceivableOperation(storage, 'actor-2', 'branch-1')).toEqual({ status: 'none' })

    const recovery = loadPendingReceivableOperation(storage, 'actor-1', 'branch-1')
    expect(recovery.status).toBe('pending')
    if (recovery.status !== 'pending') throw new Error('expected pending recovery')
    const restored = recovery.operation
    expect(pendingReceivableOperationMatches(restored, { ...payload, amount: '250.0' })).toBe(true)
    expect(pendingReceivableOperationMatches(restored, { ...payload, amount: '251.0' })).toBe(false)
    const afterReload = pendingReceivableOperation(
      restored,
      { ...payload, amount: '250.0' },
      () => KEY_2,
    )
    expect(afterReload.idempotencyKey).toBe(KEY_1)
  })

  it('keeps independent branch outboxes and refuses to overwrite a pending command', () => {
    const storage = new MemoryStorage()
    const branchOne = pendingReceivableOperation(null, payload, () => KEY_1)
    const branchTwo = pendingReceivableOperation(null, { ...payload, driverId: 'driver-2' }, () => KEY_2)
    expect(savePendingReceivableOperation(storage, 'actor-1', 'branch-1', branchOne)).toBe(true)
    expect(savePendingReceivableOperation(storage, 'actor-1', 'branch-2', branchTwo)).toBe(true)

    const changed = pendingReceivableOperation(null, { ...payload, amount: '251.00' }, () => KEY_3)
    expect(savePendingReceivableOperation(storage, 'actor-1', 'branch-1', changed)).toBe(false)

    expect(loadPendingReceivableOperation(storage, 'actor-1', 'branch-1')).toEqual({
      status: 'pending',
      operation: branchOne,
    })
    expect(loadPendingReceivableOperation(storage, 'actor-1', 'branch-2')).toEqual({
      status: 'pending',
      operation: branchTwo,
    })
  })

  it('clears and verifies only the confirmed matching key', () => {
    const storage = new MemoryStorage()
    const operation = pendingReceivableOperation(null, payload, () => KEY_1)
    expect(savePendingReceivableOperation(storage, 'actor-1', 'branch-1', operation)).toBe(true)

    expect(clearPendingReceivableOperation(storage, 'actor-1', 'branch-1', KEY_2)).toBe(false)
    expect(loadPendingReceivableOperation(storage, 'actor-1', 'branch-1')).toEqual({
      status: 'pending',
      operation,
    })
    expect(clearPendingReceivableOperation(storage, 'actor-1', 'branch-1', KEY_1)).toBe(true)
    expect(loadPendingReceivableOperation(storage, 'actor-1', 'branch-1')).toEqual({ status: 'none' })
    expect(clearPendingReceivableOperation(storage, 'actor-1', 'branch-1', KEY_1)).toBe(true)
  })

  it('uses durable localStorage, never sessionStorage', () => {
    const local = new MemoryStorage()
    const session = new MemoryStorage()
    vi.stubGlobal('window', { localStorage: local, sessionStorage: session })
    expect(browserReceivableOperationStorage()).toBe(local)
    vi.unstubAllGlobals()

    const unavailable = {}
    Object.defineProperty(unavailable, 'localStorage', { get: () => { throw new Error('disabled') } })
    vi.stubGlobal('window', unavailable)
    expect(browserReceivableOperationStorage()).toBeNull()
    vi.unstubAllGlobals()
  })

  it('fails closed when the browser has no atomic cross-tab lock', () => {
    vi.stubGlobal('window', { localStorage: new MemoryStorage(), navigator: {} })
    expect(browserReceivableOperationMutex()).toBeNull()
    vi.unstubAllGlobals()
  })

  it('allows only one tab to own the actor+branch command through the HTTP result', async () => {
    const storage = new MemoryStorage()
    const mutex = new NonBlockingMutex()
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstStarted!: () => void
    const firstIsSending = new Promise<void>((resolve) => { firstStarted = resolve })
    const issued: string[] = []

    const first = executeReceivableOperation({
      storage,
      mutex,
      actorId: 'actor-1',
      branchId: 'branch-1',
      payload,
      current: null,
      generateKey: () => KEY_1,
      execute: async (operation) => {
        issued.push(operation.idempotencyKey)
        firstStarted()
        await firstMayFinish
        return 'saved-first'
      },
    })
    await firstIsSending

    const secondExecute = vi.fn(async () => 'saved-second')
    const second = await executeReceivableOperation({
      storage,
      mutex,
      actorId: 'actor-1',
      branchId: 'branch-1',
      payload: { ...payload, amount: '999.00' },
      current: null,
      generateKey: () => KEY_2,
      execute: secondExecute,
    })

    expect(second.status).toBe('busy')
    expect(secondExecute).not.toHaveBeenCalled()
    expect(issued).toEqual([KEY_1])
    const duringRequest = loadPendingReceivableOperation(storage, 'actor-1', 'branch-1')
    expect(duringRequest.status).toBe('pending')
    if (duringRequest.status !== 'pending') throw new Error('expected first tab durable ownership')
    expect(duringRequest.operation.idempotencyKey).toBe(KEY_1)

    releaseFirst()
    await expect(first).resolves.toMatchObject({ status: 'success', value: 'saved-first' })
    expect(loadPendingReceivableOperation(storage, 'actor-1', 'branch-1')).toEqual({ status: 'none' })
  })

  it('reuses the durable UUID after an ambiguous response once the owning tab releases the lock', async () => {
    const storage = new MemoryStorage()
    const mutex = new NonBlockingMutex()
    const first = await executeReceivableOperation({
      storage,
      mutex,
      actorId: 'actor-1',
      branchId: 'branch-1',
      payload,
      current: null,
      generateKey: () => KEY_1,
      execute: async () => { throw new TypeError('connection lost') },
    })
    expect(first.status).toBe('ambiguous_failure')

    const seen: string[] = []
    const retry = await executeReceivableOperation({
      storage,
      mutex,
      actorId: 'actor-1',
      branchId: 'branch-1',
      payload: { ...payload, amount: '250.0' },
      current: null,
      generateKey: () => KEY_2,
      execute: async (operation) => {
        seen.push(operation.idempotencyKey)
        return 'replayed'
      },
    })
    expect(retry).toMatchObject({ status: 'success', value: 'replayed' })
    expect(seen).toEqual([KEY_1])
    expect(loadPendingReceivableOperation(storage, 'actor-1', 'branch-1')).toEqual({ status: 'none' })
  })

  it('fails closed when storage is absent, throws, or cannot verify the write', () => {
    const operation = pendingReceivableOperation(null, payload, () => KEY_1)
    expect(loadPendingReceivableOperation(null, 'actor-1', 'branch-1')).toEqual({ status: 'unavailable' })
    expect(savePendingReceivableOperation(null, 'actor-1', 'branch-1', operation)).toBe(false)

    const throwingGet: ReceivableOperationStorage = {
      getItem() { throw new Error('disabled') },
      setItem() { throw new Error('disabled') },
      removeItem() { throw new Error('disabled') },
    }
    expect(loadPendingReceivableOperation(throwingGet, 'actor-1', 'branch-1')).toEqual({ status: 'unavailable' })
    expect(savePendingReceivableOperation(throwingGet, 'actor-1', 'branch-1', operation)).toBe(false)

    const throwingSet = new MemoryStorage()
    throwingSet.setItem = () => { throw new Error('quota') }
    expect(savePendingReceivableOperation(throwingSet, 'actor-1', 'branch-1', operation)).toBe(false)

    const unreadableAfterWrite = new MemoryStorage()
    unreadableAfterWrite.getItem = () => null
    expect(savePendingReceivableOperation(unreadableAfterWrite, 'actor-1', 'branch-1', operation)).toBe(false)
  })

  it('refuses a changed fingerprint even when a caller reuses the pending UUID', () => {
    const storage = new MemoryStorage()
    const operation = pendingReceivableOperation(null, payload, () => KEY_1)
    expect(savePendingReceivableOperation(storage, 'actor-1', 'branch-1', operation)).toBe(true)
    const changed = {
      ...pendingReceivableOperation(null, { ...payload, amount: '251.00' }, () => KEY_1),
      idempotencyKey: KEY_1,
    }
    expect(savePendingReceivableOperation(storage, 'actor-1', 'branch-1', changed)).toBe(false)
    expect(loadPendingReceivableOperation(storage, 'actor-1', 'branch-1')).toEqual({
      status: 'pending',
      operation,
    })
  })

  it('treats malformed persisted data as a blocking corruption, not an empty outbox', () => {
    const storage = new MemoryStorage()
    storage.setItem(receivableOutboxKey('actor-1', 'branch-1'), '{broken')
    expect(loadPendingReceivableOperation(storage, 'actor-1', 'branch-1')).toEqual({ status: 'corrupt' })

    storage.setItem(receivableOutboxKey('actor-1', 'branch-1'), JSON.stringify({ idempotencyKey: KEY_1 }))
    expect(loadPendingReceivableOperation(storage, 'actor-1', 'branch-1')).toEqual({ status: 'corrupt' })
  })

  it('releases only a proven non-409 4xx response', () => {
    for (const status of [400, 401, 403, 404, 422, 499]) {
      expect(receivableRejectionDefinitelyDidNotCommit({ status, error: 'rejected' }), String(status)).toBe(true)
    }
    for (const value of [new TypeError('offline'), {}, { status: 409 }, { status: 500 }, { status: 503 }]) {
      expect(receivableRejectionDefinitelyDidNotCommit(value)).toBe(false)
    }
  })

})
