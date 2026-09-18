import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const expenses = readFileSync(new URL('./screens/Expenses.tsx', import.meta.url), 'utf8')
const recurring = readFileSync(new URL('./screens/RecurringExpenses.tsx', import.meta.url), 'utf8')
const receipt = readFileSync(new URL('./receipt-upload.ts', import.meta.url), 'utf8')

describe('recurring-expense and receipt UI wiring', () => {
  it('keeps the approved log, due, and fixed-template tabs connected', () => {
    expect(expenses).toContain("['log', 'due', 'templates']")
    expect(expenses).toContain('<RecurringExpenses')
    expect(expenses).toContain("view={screenTab === 'due' ? 'due' : 'templates'}")
  })

  it('wires every human decision instead of auto-posting a due item', () => {
    expect(recurring).toContain('api.recurringExpensesDue()')
    expect(recurring).toContain('api.payRecurringExpense(')
    expect(recurring).toContain('api.skipRecurringExpense(')
    expect(recurring).toContain('api.createRecurringExpense(')
    expect(recurring).toContain('api.deactivateRecurringExpense(')
    expect(recurring).not.toContain('setInterval(')
  })

  it('uploads a compressed immutable media id into both manual and recurring expense forms', () => {
    expect(receipt).toContain('compressImage(file)')
    expect(receipt).toContain('api.uploadReceipt(')
    expect(expenses).toContain('receiptMediaId,')
    expect(recurring).toContain('receiptMediaId,')
  })
})
