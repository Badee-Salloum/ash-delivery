/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  clearPendingTranche,
  isStrictlyPositiveTrancheAmount,
  newPendingTranche,
  readPendingTranche,
  trancheRejectionDefinitelyDidNotCommit,
  writePendingTranche,
} from './pending-tranche.ts'

const liveShiftsSource = readFileSync(new URL('./screens/LiveShifts.tsx', import.meta.url), 'utf8')

class MemoryStorage {
  readonly rows = new Map<string, string>()
  getItem(key: string): string | null { return this.rows.get(key) ?? null }
  setItem(key: string, value: string): void { this.rows.set(key, value) }
  removeItem(key: string): void { this.rows.delete(key) }
}

describe('durable pending tranche recovery', () => {
  it('rehydrates the exact key and payload after a simulated reload, then clears after success', () => {
    const storage = new MemoryStorage()
    const operation = newPendingTranche('shift-1', 'float', ' 100.00 ', 'event-1', '2026-08-23T00:00:00.000Z')

    expect(writePendingTranche(operation, storage)).toBe(true)
    expect(readPendingTranche('shift-1', storage)).toEqual({
      status: 'pending',
      operation: { ...operation, amount: '100.00' },
    })
    expect(clearPendingTranche('shift-1', storage)).toBe(true)
    expect(readPendingTranche('shift-1', storage)).toEqual({ status: 'none' })
  })

  it('fails closed on corrupt stored data instead of discarding an uncertain operation', () => {
    const storage = new MemoryStorage()
    storage.setItem('ash.pending-tranche.shift-1', '{not-json')

    expect(readPendingTranche('shift-1', storage)).toEqual({ status: 'corrupt' })
    expect(storage.getItem('ash.pending-tranche.shift-1')).toBe('{not-json')
  })

  it('blocks a request when durable browser storage is unavailable', () => {
    const operation = newPendingTranche('shift-1', 'topup', '25', 'event-2', '2026-08-23T00:00:00.000Z')
    expect(readPendingTranche('shift-1', null)).toEqual({ status: 'unavailable' })
    expect(writePendingTranche(operation, null)).toBe(false)
    expect(clearPendingTranche('shift-1', null)).toBe(false)
  })

  it.each([
    ['100', true],
    ['0', false],
    ['-1', false],
    ['', false],
    ['not-money', false],
  ])('recognises whether %j is a strictly positive amount', (value, expected) => {
    expect(isStrictlyPositiveTrancheAmount(value)).toBe(expected)
  })

  it('only unlocks a staged operation after an explicit non-conflict 4xx rejection', () => {
    expect(trancheRejectionDefinitelyDidNotCommit({ status: 422, error: 'money_total_out_of_range' })).toBe(true)
    expect(trancheRejectionDefinitelyDidNotCommit({ status: 401, error: 'unauthorized' })).toBe(true)
    expect(trancheRejectionDefinitelyDidNotCommit({ status: 409, error: 'idempotency_key_conflict' })).toBe(false)
    expect(trancheRejectionDefinitelyDidNotCommit({ status: 409, error: 'unknown' })).toBe(false)
    expect(trancheRejectionDefinitelyDidNotCommit({ status: 500, error: 'internal_error' })).toBe(false)
    expect(trancheRejectionDefinitelyDidNotCommit(new TypeError('network lost'))).toBe(false)
  })

  it('persists before POST, sends recovered immutable details, and clears only after success', () => {
    const persist = liveShiftsSource.indexOf('writePendingTranche(operation)')
    const post = liveShiftsSource.indexOf('await api.addTranche')
    const clear = liveShiftsSource.indexOf('clearPendingTranche(shift.id)', post)

    expect(persist).toBeGreaterThan(-1)
    expect(persist).toBeLessThan(post)
    expect(post).toBeLessThan(clear)
    expect(liveShiftsSource).toContain('kind: operation.kind')
    expect(liveShiftsSource).toContain('amount: operation.amount')
    expect(liveShiftsSource).toContain('occurrenceKey: operation.occurrenceKey')
    expect(liveShiftsSource).toContain("disabled={trancheRecovery.status === 'pending'}")
  })
})
