import { describe, expect, it } from 'vitest'
import { correctionCashPreview } from './screens/CompanyFinanceReview.tsx'

const expense = { amount: '20000.00', currency: 'SYP_NEW' as const, paidFrom: 'pocket', description: 'تجربة', occurredOn: '2026-10-03', categoryId: 'category' }

describe('expense correction cash preview', () => {
  it('restores company cash when a confirmed expense was really paid by the owner', () => {
    expect(correctionCashPreview(expense, { ...expense, amount: '15000.00', paidFrom: 'owner_outside' })).toEqual({ pockets: { SYP_NEW: '20000.00', USD: '0.00' }, reserves: { SYP_NEW: '0.00', USD: '0.00' }, custody: { SYP_NEW: '0.00', USD: '0.00' }, ownerPayments: { SYP_NEW: '15000.00', USD: '0.00' } })
  })
  it('keeps both currencies separate rather than summing them', () => {
    const result = correctionCashPreview(expense, { ...expense, amount: '2.25', currency: 'USD' })
    expect(result.pockets).toEqual({ SYP_NEW: '20000.00', USD: '-2.25' })
    expect(result.ownerPayments).toEqual({ SYP_NEW: '0.00', USD: '0.00' })
  })
  it('previews a source change without modifying any branch balance', () => {
    const result = correctionCashPreview({ ...expense, paidFrom: 'reserve' }, expense)
    expect(result.reserves.SYP_NEW).toBe('20000.00')
    expect(result.pockets.SYP_NEW).toBe('-20000.00')
    expect(result).not.toHaveProperty('branch')
  })
})
