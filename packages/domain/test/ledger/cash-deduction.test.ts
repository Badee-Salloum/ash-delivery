import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ShiftOrder } from '../../src/br1/equation.ts'
import {
  balanceOf,
  closingBalances,
  creditsOf,
  debitsOf,
  driverCashDeduction,
  fundCode,
  isFund,
  postingsForApproval,
  postingsForOpen,
} from '../../src/ledger/recipes.ts'
import { minor } from '../../src/money/minor.ts'
import { splitBlock, totalFees } from '../../src/money/allocate.ts'
import { DEFAULT_BANDS, bpsForCount } from '../../src/tier/rules.ts'

const DRIVER = 'driver-1'

const cashOrders = (count: number, fee = minor(100n)): ShiftOrder[] =>
  Array.from({ length: count }, (_, i) => ({
    orderNo: `cash-${i + 1}`,
    payMode: 'cash',
    fee,
  }))

describe('driver cash deduction recipe', () => {
  it('allocates one operation between share and cash receivable and credits driver cash in full', () => {
    const posting = driverCashDeduction(DRIVER, minor(50n), minor(30n), 'scan-operation-42')

    expect(posting.eventType).toBe('driver_cash_deduction')
    expect(posting.occurrenceKey).toBe('scan-operation-42')
    expect(posting.lines).toEqual([
      {
        fund: { kind: 'driver_share_payable', driverId: DRIVER },
        side: 'D',
        amount: minor(30n),
        role: 'cash_deduction_share',
      },
      {
        fund: { kind: 'driver_receivable_cash', driverId: DRIVER },
        side: 'D',
        amount: minor(20n),
        role: 'cash_deduction_overflow',
      },
      {
        fund: { kind: 'driver_cash', driverId: DRIVER },
        side: 'C',
        amount: minor(50n),
        role: 'cash_deduction',
      },
    ])
    expect(debitsOf(posting)).toBe(50n)
    expect(creditsOf(posting)).toBe(50n)
  })

  it('supports both allocation boundaries without emitting zero-value lines', () => {
    const allShare = driverCashDeduction(DRIVER, minor(50n), minor(50n), 'all-share')
    const allReceivable = driverCashDeduction(DRIVER, minor(50n), minor(0n), 'all-receivable')

    expect(allShare.lines.map((line) => fundCode(line.fund))).toEqual([
      `driver_share_payable:${DRIVER}`,
      `driver_cash:${DRIVER}`,
    ])
    expect(allReceivable.lines.map((line) => fundCode(line.fund))).toEqual([
      `driver_receivable_cash:${DRIVER}`,
      `driver_cash:${DRIVER}`,
    ])
  })

  it('enforces a positive amount and 0 <= sharePortion <= amount', () => {
    expect(() => driverCashDeduction(DRIVER, minor(0n), minor(0n), 'zero')).toThrow(RangeError)
    expect(() => driverCashDeduction(DRIVER, minor(-1n), minor(0n), 'negative')).toThrow(RangeError)
    expect(() => driverCashDeduction(DRIVER, minor(50n), minor(-1n), 'share-negative')).toThrow(RangeError)
    expect(() => driverCashDeduction(DRIVER, minor(50n), minor(51n), 'share-too-large')).toThrow(RangeError)
  })

  it('balances for every valid share/overflow allocation', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.nat(), (rawAmount, rawShare) => {
        const amount = minor(BigInt(rawAmount))
        const sharePortion = minor(BigInt(rawShare % (rawAmount + 1)))
        const posting = driverCashDeduction(DRIVER, amount, sharePortion, `scan-${rawAmount}-${rawShare}`)

        expect(debitsOf(posting)).toBe(amount)
        expect(creditsOf(posting)).toBe(amount)
        expect(balanceOf([posting], isFund('driver_share_payable'))).toBe(sharePortion)
        expect(balanceOf([posting], isFund('driver_receivable_cash'))).toBe(amount - sharePortion)
        expect(balanceOf([posting], isFund('driver_cash'))).toBe(-amount)
      }),
    )
  })
})

describe('cash deductions in approval postings', () => {
  it('uses the supplied stable occurrence key and reduces closing cash, never wallet', () => {
    const orders = cashOrders(1)
    const input = {
      driverId: DRIVER,
      floatTranches: [minor(100n)],
      topupTranches: [minor(100n)],
      orders,
      cashDeductions: [{ amount: minor(50n), sharePortion: minor(20n), occurrenceKey: 'movement-id-7' }],
    }
    const without = closingBalances({ ...input, cashDeductions: [] })
    const withDeduction = closingBalances(input)
    const split = splitBlock(totalFees(orders.map((order) => order.fee)), 3_500)
    const postings = postingsForApproval(input, split)
    const deduction = postings.find((posting) => posting.eventType === 'driver_cash_deduction')

    expect(deduction?.occurrenceKey).toBe('movement-id-7')
    expect(withDeduction.endCash).toBe(without.endCash - 50n)
    expect(withDeduction.endWallet).toBe(without.endWallet)

    const all = [...postingsForOpen(input), ...postings]
    expect(balanceOf(all, isFund('driver_cash'))).toBe(0n)
    expect(balanceOf(all, isFund('driver_wallet'))).toBe(0n)
  })

  it('puts the amount over the current share into driver_receivable_cash', () => {
    const orders = cashOrders(1, minor(1_000n))
    const totals = totalFees(orders.map((order) => order.fee))
    const split = splitBlock(totals, 3_500)
    const amount = minor(split.driverShare + 120n)
    const input = {
      driverId: DRIVER,
      floatTranches: [minor(1_000n)],
      topupTranches: [minor(1_000n)],
      orders,
      cashDeductions: [
        {
          amount,
          sharePortion: split.driverShare,
          occurrenceKey: 'over-current-share',
        },
      ],
    }
    const postings = postingsForApproval(input, split)

    // share_split credits the earned share; the deduction debits the same amount.
    expect(balanceOf(postings, isFund('driver_share_payable'))).toBe(0n)
    expect(balanceOf(postings, isFund('driver_receivable_cash'))).toBe(120n)
    expect(balanceOf(postings, isFund('yalago_share'))).toBe(totals.yalagoTotal)

    const all = [...postingsForOpen(input), ...postings]
    expect(balanceOf(all, isFund('driver_cash'))).toBe(0n)
    expect(balanceOf(all, isFund('driver_wallet'))).toBe(0n)
  })

  it('does not change order count, tier share split, or Yallago cut', () => {
    const orders = cashOrders(15)
    const totals = totalFees(orders.map((order) => order.fee))
    const driverBps = bpsForCount(DEFAULT_BANDS, orders.length)
    const split = splitBlock(totals, driverBps)
    const base = {
      driverId: DRIVER,
      floatTranches: [minor(2_000n)],
      topupTranches: [minor(1_000n)],
      orders,
    }
    const ordinary = postingsForApproval(base, split)
    const deducted = postingsForApproval(
      {
        ...base,
        cashDeductions: [{ amount: minor(50n), sharePortion: minor(50n), occurrenceKey: 'scan-minus-50' }],
      },
      split,
    )

    expect(driverBps).toBe(4_000)
    expect(deducted.filter((posting) => posting.eventType === 'order_fee')).toHaveLength(orders.length)
    expect(deducted.filter((posting) => posting.eventType === 'yalago_cut')).toEqual(
      ordinary.filter((posting) => posting.eventType === 'yalago_cut'),
    )
    expect(deducted.find((posting) => posting.eventType === 'share_split')).toEqual(
      ordinary.find((posting) => posting.eventType === 'share_split'),
    )
    expect(balanceOf(deducted, isFund('yalago_share'))).toBe(balanceOf(ordinary, isFund('yalago_share')))
    expect(closingBalances({ ...base, cashDeductions: [] }).endWallet).toBe(
      closingBalances({
        ...base,
        cashDeductions: [{ amount: minor(50n), sharePortion: minor(50n), occurrenceKey: 'scan-minus-50' }],
      }).endWallet,
    )
  })
})
