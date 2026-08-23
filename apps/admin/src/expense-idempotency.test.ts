import { describe, expect, it, vi } from 'vitest'
import { pendingExpenseOperation } from './expense-idempotency.ts'

const payload = {
  categoryId: 'fuel',
  costCenterKind: 'general' as const,
  vehicleId: null,
  amount: '25.00',
  description: 'Charging electricity',
}

describe('expense submit idempotency', () => {
  it('keeps the same key when a lost-response retry has the exact same payload', () => {
    const generate = vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2')
    const first = pendingExpenseOperation(null, payload, generate)
    const retry = pendingExpenseOperation(first, payload, generate)

    expect(first.idempotencyKey).toBe('key-1')
    expect(retry).toBe(first)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('generates a new key when any money-relevant field changes', () => {
    const generate = vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2')
    const first = pendingExpenseOperation(null, payload, generate)
    const changed = pendingExpenseOperation(first, { ...payload, amount: '30.00' }, generate)

    expect(changed.idempotencyKey).toBe('key-2')
    expect(generate).toHaveBeenCalledTimes(2)
  })
})
