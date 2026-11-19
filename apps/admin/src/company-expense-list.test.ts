import { describe, expect, it } from 'vitest'
import { expenseDeleteRequest, newestFinancialRows, visibleCompanyMovement } from './company-expense-list.ts'

describe('simple expense deletion and display', () => {
  it('hides the deleted expense and its reversal without hiding other movements', () => {
    expect(visibleCompanyMovement({ command: { kind: 'expense' }, reversed: true })).toBe(false)
    expect(visibleCompanyMovement({ command: { kind: 'reversal', targetKind: 'expense' } })).toBe(false)
    expect(visibleCompanyMovement({ command: { kind: 'expense' }, reversed: false })).toBe(true)
    expect(visibleCompanyMovement({ command: { kind: 'reversal', targetKind: 'exchange' } })).toBe(false)
    expect(visibleCompanyMovement({ command: { kind: 'income' }, reversed: true })).toBe(false)
    expect(visibleCompanyMovement({ command: null })).toBe(true)
  })
  it('orders by occurrence then newest ID before paging without changing balances or input', () => {
    const rows = [{ id: 50, date: '2026-09-01', balance: '1.00' }, { id: 3, date: '2026-09-20', balance: '2.00' }, { id: 4, date: '2026-09-20', balance: '3.00' }]
    const before = structuredClone(rows)
    expect(newestFinancialRows(rows, row => row.date, row => row.id).map(row => row.id)).toEqual([4, 3, 50])
    expect(rows).toEqual(before)
  })
  it('uses an exact posted-expense reversal or a no-cash evidence exclusion, never both', () => {
    expect(expenseDeleteRequest({ kind: 'command', id: 'effective-expense', description: 'Rent' }, 'retry-key')).toMatchObject({
      path: '/company/reversals', body: { targetId: 'effective-expense', idempotencyKey: 'retry-key' } })
    expect(expenseDeleteRequest({ kind: 'source', reference: 'HQ-SRC-10', description: 'Bags' }, 'retry-key', 2)).toMatchObject({
      path: '/company/historical-source-corrections', body: { sourceReference: 'HQ-SRC-10', expectedVersion: 2,
        values: { excluded: true }, acknowledgeCashEffect: true } })
    expect(() => expenseDeleteRequest({ kind: 'source', reference: 'HQ-SRC-10', description: 'Bags' }, 'key')).toThrow()
  })
  it('breaks same-day ties by original recording time before the stable journal sequence', () => {
    const rows = [{ id: 900, date: '2026-10-16', recorded: 9000 }, { id: 5, date: '2026-10-17', recorded: 5000 },
      { id: 9, date: '2026-10-17', recorded: 1000 }, { id: 6, date: '2026-10-17', recorded: 5000 }]
    expect(newestFinancialRows(rows, row => row.date, row => row.id, row => row.recorded).map(row => row.id)).toEqual([6, 5, 9, 900])
    expect(rows[0]!.id).toBe(900)
  })
})
