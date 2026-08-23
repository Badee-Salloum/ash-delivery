import { describe, expect, it } from 'vitest'
import { createExpenseRequest } from '../src/wire.ts'

const valid = {
  idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  categoryId: 'fuel',
  costCenterKind: 'general' as const,
  vehicleId: null,
  amount: '1.00',
  description: 'Charging electricity',
}

describe('expense request boundary', () => {
  it.each(['0', '0.00', '-0.01', '-100.00'])(
    'rejects non-positive expense amount %s before persistence',
    (amount) => {
      expect(createExpenseRequest.safeParse({ ...valid, amount }).success).toBe(false)
    },
  )

  it('accepts a strictly positive bigint-safe amount', () => {
    const parsed = createExpenseRequest.parse(valid)
    expect(parsed.amount).toBe(100n)
  })

  it('requires a client-generated UUID idempotency key', () => {
    const { idempotencyKey: _missing, ...withoutKey } = valid
    expect(createExpenseRequest.safeParse(withoutKey).success).toBe(false)
    expect(createExpenseRequest.safeParse({ ...valid, idempotencyKey: 'tap-1' }).success).toBe(false)
  })
})
