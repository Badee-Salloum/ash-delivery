import { describe, expect, it, vi } from 'vitest'
import { pendingAfterAttempt, pendingMoneyMove } from './money-move-idempotency.ts'

const payload = {
  command: 'company_deposit',
  branchId: 'branch-damascus',
  amount: '500.00',
  reason: 'رأس مال',
}

describe('treasury money-move idempotency', () => {
  it('keeps the same key when a lost-response retry has the exact same payload', () => {
    const generate = vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2')
    const first = pendingMoneyMove(null, payload, generate)
    const retry = pendingMoneyMove(first, payload, generate)

    expect(first.idempotencyKey).toBe('key-1')
    expect(retry).toBe(first)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('generates a new key when any field changes — including which command it is', () => {
    for (const changed of [
      { ...payload, amount: '501.00' },
      { ...payload, reason: 'شحن' },
      { ...payload, branchId: 'branch-aleppo' },
      // Deposit then withdraw with the same figures is two decisions, never a replay of one.
      { ...payload, command: 'company_withdraw' },
    ]) {
      const generate = vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2')
      const first = pendingMoneyMove(null, payload, generate)
      expect(pendingMoneyMove(first, changed, generate).idempotencyKey).toBe('key-2')
    }
  })

  it('drops the key after success or a conflict, and keeps it after any other failure', () => {
    const operation = pendingMoneyMove(null, payload, () => 'key-1')
    expect(pendingAfterAttempt(operation, { ok: true })).toBeNull()
    expect(pendingAfterAttempt(operation, { ok: false, error: 'idempotency_key_conflict' })).toBeNull()
    // A lost response may have posted: the next press must ask for the SAME operation.
    expect(pendingAfterAttempt(operation, { ok: false, error: undefined })).toBe(operation)
    expect(pendingAfterAttempt(operation, { ok: false, error: 'http_504' })).toBe(operation)
    expect(pendingAfterAttempt(operation, { ok: false, error: 'insufficient_funds' })).toBe(operation)
  })
})
