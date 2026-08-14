import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { evaluateBr1, expectedFromGates, type ShiftOrder } from '../../src/br1/equation.ts'
import { minor } from '../../src/money/minor.ts'

const CASH_SCAN = minor(-50n)
const CASH_DEDUCTION = minor(-CASH_SCAN)

const order: ShiftOrder = {
  orderNo: 'order-1',
  payMode: 'electronic',
  fee: minor(100n),
}

describe('BR1 cash deductions', () => {
  it('represents a scanned -50 operation as a positive 50 magnitude and subtracts it from cash only', () => {
    const result = evaluateBr1({
      floatTotal: minor(100n),
      topupTotal: minor(20n),
      endCashDeclared: minor(50n),
      endWalletDeclared: minor(100n),
      orders: [order],
      cashDeductions: [CASH_DEDUCTION],
    })

    expect(CASH_SCAN).toBe(-50n)
    expect(CASH_DEDUCTION).toBe(50n)
    expect(result.expectedCash).toBe(50n)
    expect(result.expectedWallet).toBe(100n)
    expect(result.expectedTotal).toBe(150n)
    expect(result.scalarDiff).toBe(0n)
    expect(result.cashDiff).toBe(0n)
    expect(result.walletDiff).toBe(0n)
    expect(result.balanced).toBe(true)
    expect(result.splitBalanced).toBe(true)
  })

  it('does not alter fee, Yallago, or order-derived block totals', () => {
    const common = {
      floatTotal: minor(100n),
      topupTotal: minor(20n),
      endCashDeclared: minor(0n),
      endWalletDeclared: minor(0n),
      orders: [order],
    }
    const withoutDeduction = evaluateBr1(common)
    const withDeduction = evaluateBr1({ ...common, cashDeductions: [CASH_DEDUCTION] })

    expect(withDeduction.totals).toEqual(withoutDeduction.totals)
    expect(withDeduction.expectedWallet).toBe(withoutDeduction.expectedWallet)
    expect(withDeduction.expectedCash).toBe(withoutDeduction.expectedCash - CASH_DEDUCTION)
    expect(withDeduction.expectedTotal).toBe(withoutDeduction.expectedTotal - CASH_DEDUCTION)
  })

  it('subtracts multiple positive magnitudes exactly once from the displayed BR1 right-hand side', () => {
    const result = evaluateBr1({
      floatTotal: minor(100n),
      topupTotal: minor(20n),
      endCashDeclared: minor(25n),
      endWalletDeclared: minor(20n),
      orders: [],
      cashDeductions: [minor(50n), minor(25n)],
    })

    expect(result.expectedCash).toBe(25n)
    expect(result.expectedWallet).toBe(20n)
    expect(expectedFromGates(minor(100n), minor(20n), minor(0n), minor(75n))).toBe(result.expectedTotal)
  })

  it('rejects signed or zero values instead of turning them into cash additions', () => {
    const base = {
      floatTotal: minor(100n),
      topupTotal: minor(0n),
      endCashDeclared: minor(100n),
      endWalletDeclared: minor(0n),
      orders: [],
    }

    expect(() => evaluateBr1({ ...base, cashDeductions: [CASH_SCAN] })).toThrow(RangeError)
    expect(() => evaluateBr1({ ...base, cashDeductions: [minor(0n)] })).toThrow(RangeError)
    expect(() => expectedFromGates(minor(100n), minor(0n), minor(0n), CASH_SCAN)).toThrow(RangeError)
  })

  it('subtracts any list of positive deductions while preserving every non-cash result', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }).map((value) => minor(BigInt(value))), {
          maxLength: 12,
        }),
        (cashDeductions) => {
          const base = {
            floatTotal: minor(2_000_000n),
            topupTotal: minor(20n),
            endCashDeclared: minor(0n),
            endWalletDeclared: minor(0n),
            orders: [order],
          }
          const ordinary = evaluateBr1(base)
          const deducted = evaluateBr1({ ...base, cashDeductions })
          const total = cashDeductions.reduce((sum, value) => sum + value, 0n)

          expect(deducted.expectedCash).toBe(ordinary.expectedCash - total)
          expect(deducted.expectedWallet).toBe(ordinary.expectedWallet)
          expect(deducted.totals).toEqual(ordinary.totals)
        },
      ),
    )
  })
})
