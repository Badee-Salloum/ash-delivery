import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ShiftOrder } from '../../src/br1/equation.ts'
import {
  type CashDeduction,
  type Posting,
  balanceOf,
  cashSettledReturnPostings,
  closingBalances,
  creditsOf,
  debitsOf,
  isFund,
  postingsForCashSettledApproval,
  postingsForOpen,
} from '../../src/ledger/recipes.ts'
import { splitFixedDriverShare } from '../../src/money/allocate.ts'
import { type Minor, ZERO, abs, minor, sum } from '../../src/money/minor.ts'
import { planFixedShareSettlement } from '../../src/settlement/statement.ts'

const DRIVER = 'driver-fixed-40'
const BRANCH = 'branch-1'
const syp = (whole: number): Minor => minor(BigInt(whole) * 100n)

function fundBalance(postings: readonly Posting[], kind: Parameters<typeof isFund>[0]): Minor {
  return balanceOf(postings, isFund(kind))
}

describe('cash-settled approval assembly', () => {
  it('pays the driver share out of returned shift money without reducing company capital', () => {
    const fee = syp(100)
    const orders: ShiftOrder[] = [{ orderNo: 'capital-1', payMode: 'cash', fee }]
    const split = splitFixedDriverShare([fee])
    const input = {
      driverId: DRIVER,
      branchId: BRANCH,
      floatTranches: [syp(100)],
      topupTranches: [syp(20)],
      orders,
    }
    const expected = closingBalances(input)
    const settlement = planFixedShareSettlement({
      deliveryFeeTotal: fee,
      fixedDriverShare: split.driverShare,
      manualDriverShare: ZERO,
      cashDeductionTotal: ZERO,
      expectedCash: expected.endCash,
      expectedWallet: expected.endWallet,
      actualCash: expected.endCash,
      actualWallet: expected.endWallet,
    })
    const all = [
      ...postingsForOpen(input),
      ...postingsForCashSettledApproval(input, split, settlement),
    ]

    // The employee keeps the share from the money being returned. The office receives only the
    // residual, while its combined cash/wallet gain is exactly the company's earned share.
    expect(settlement.finalEmployeeCash).toBe(split.driverShare)
    expect(settlement.cashToOffice).toBe(minor(settlement.actualCash - split.driverShare))
    expect(sum([
      fundBalance(all, 'office_cash'),
      fundBalance(all, 'office_wallet'),
    ])).toBe(split.companyShare)

    expect(fundBalance(all, 'driver_share_payable')).toBe(ZERO)
    expect(all.flatMap((posting) => posting.lines).some((line) => line.fund.kind === 'company_box')).toBe(false)
  })

  it('posts the Thaer close exactly as reviewed and leaves every employee account at zero', () => {
    const fees = [425, 240, 370, 175, 145, 190].map(syp)
    const orders: ShiftOrder[] = fees.map((fee, i) => ({ orderNo: `T-${i + 1}`, payMode: 'cash', fee }))
    const split = splitFixedDriverShare(fees)
    const deductions: CashDeduction[] = [{ amount: syp(50), sharePortion: syp(50), occurrenceKey: 'deduction-1' }]
    const input = {
      driverId: DRIVER,
      branchId: BRANCH,
      floatTranches: [syp(3_000)],
      topupTranches: [syp(500)],
      orders,
      cashDeductions: deductions,
    }
    const expected = closingBalances(input)
    expect(expected).toEqual({ endCash: syp(4_495), endWallet: syp(191) })

    const settlement = planFixedShareSettlement({
      deliveryFeeTotal: sum(fees),
      fixedDriverShare: split.driverShare,
      manualDriverShare: ZERO,
      cashDeductionTotal: syp(50),
      expectedCash: expected.endCash,
      expectedWallet: expected.endWallet,
      actualCash: syp(4_935),
      actualWallet: minor(27_950n),
    })
    const all = [
      ...postingsForOpen(input),
      ...postingsForCashSettledApproval(input, split, settlement),
    ]

    for (const posting of all) expect(debitsOf(posting)).toBe(creditsOf(posting))
    expect(fundBalance(all, 'driver_cash')).toBe(ZERO)
    expect(fundBalance(all, 'driver_wallet')).toBe(ZERO)
    expect(fundBalance(all, 'driver_share_payable')).toBe(ZERO)
    expect(fundBalance(all, 'driver_receivable_cash')).toBe(ZERO)
    expect(all.flatMap((posting) => posting.lines).some((line) => line.fund.kind === 'cost_center')).toBe(false)

    const walletReturn = all.find((posting) => posting.eventType === 'wallet_return')!
    const fullWalletLine = walletReturn.lines.find((line) => line.role === 'wallet_settlement')!
    expect(fullWalletLine).toMatchObject({ fund: { kind: 'office_wallet' }, side: 'D', amount: minor(27_950n) })
    const cashReturn = all.find((posting) => posting.eventType === 'float_return')!
    expect(cashReturn.lines.find((line) => line.role === 'cash_settlement')).toMatchObject({
      fund: { kind: 'office_cash' },
      side: 'D',
      amount: minor(383_850n),
    })
  })

  it('nets a deduction overflow against a later surplus instead of leaving debt and payout together', () => {
    const fee = syp(100)
    const orders: ShiftOrder[] = [{ orderNo: 'D-1', payMode: 'cash', fee }]
    const split = splitFixedDriverShare([fee])
    const input = {
      driverId: DRIVER,
      branchId: BRANCH,
      floatTranches: [syp(100)],
      topupTranches: [syp(20)],
      orders,
      cashDeductions: [{ amount: syp(50), sharePortion: syp(40), occurrenceKey: 'deduction-overflow' }],
    }
    const expected = closingBalances(input)
    const settlement = planFixedShareSettlement({
      deliveryFeeTotal: fee,
      fixedDriverShare: split.driverShare,
      manualDriverShare: ZERO,
      cashDeductionTotal: syp(50),
      expectedCash: expected.endCash,
      expectedWallet: expected.endWallet,
      actualCash: syp(210),
      actualWallet: ZERO,
    })
    expect(settlement.baseDriverShare).toBe(-syp(10))
    expect(settlement.finalEmployeeCash).toBe(syp(50))

    const all = [
      ...postingsForOpen(input),
      ...postingsForCashSettledApproval(input, split, settlement),
    ]
    expect(fundBalance(all, 'driver_share_payable')).toBe(ZERO)
    expect(fundBalance(all, 'driver_receivable_cash')).toBe(ZERO)
    expect(fundBalance(all, 'driver_cash')).toBe(ZERO)
    expect(fundBalance(all, 'driver_wallet')).toBe(ZERO)
  })

  it('settles a shortage beyond the whole share by collecting extra cash immediately', () => {
    const fee = syp(100)
    const orders: ShiftOrder[] = [{ orderNo: 'S-1', payMode: 'cash', fee }]
    const split = splitFixedDriverShare([fee])
    const input = {
      driverId: DRIVER,
      branchId: BRANCH,
      floatTranches: [syp(100)],
      topupTranches: [syp(20)],
      orders,
    }
    const expected = closingBalances(input)
    const settlement = planFixedShareSettlement({
      deliveryFeeTotal: fee,
      fixedDriverShare: split.driverShare,
      manualDriverShare: ZERO,
      cashDeductionTotal: ZERO,
      expectedCash: expected.endCash,
      expectedWallet: expected.endWallet,
      actualCash: syp(140),
      actualWallet: ZERO,
    })
    expect(settlement.variance).toBe(-syp(60))
    expect(settlement.finalEmployeeCash).toBe(-syp(20))
    expect(settlement.cash).toEqual({ action: 'collect', amount: syp(160) })

    const all = [
      ...postingsForOpen(input),
      ...postingsForCashSettledApproval(input, split, settlement),
    ]
    expect(fundBalance(all, 'driver_cash')).toBe(ZERO)
    expect(fundBalance(all, 'driver_wallet')).toBe(ZERO)
    expect(fundBalance(all, 'driver_share_payable')).toBe(ZERO)
    expect(fundBalance(all, 'driver_receivable_cash')).toBe(ZERO)
  })

  it('clears custody once and preserves an unpaid shortage in the ordinary cash receivable', () => {
    const fee = syp(100)
    const orders: ShiftOrder[] = [{ orderNo: 'SR-1', payMode: 'cash', fee }]
    const split = splitFixedDriverShare([fee])
    const input = {
      driverId: DRIVER,
      branchId: BRANCH,
      floatTranches: [syp(100)],
      topupTranches: [syp(20)],
      orders,
    }
    const expected = closingBalances(input)
    const settlement = planFixedShareSettlement({
      deliveryFeeTotal: fee,
      fixedDriverShare: split.driverShare,
      manualDriverShare: ZERO,
      cashDeductionTotal: ZERO,
      expectedCash: expected.endCash,
      expectedWallet: expected.endWallet,
      actualCash: syp(140),
      actualWallet: ZERO,
      cashShortageReceivable: syp(20),
    })
    const all = [
      ...postingsForOpen(input),
      ...postingsForCashSettledApproval(input, split, settlement),
    ]

    expect(settlement.finalEmployeeCash).toBe(-syp(20))
    expect(settlement.cashToOffice).toBe(settlement.actualCash)
    expect(fundBalance(all, 'office_cash')).toBe(syp(40))
    expect(fundBalance(all, 'driver_receivable_cash')).toBe(syp(20))
    expect(fundBalance(all, 'driver_shift_funding_cash')).toBe(ZERO)
    expect(fundBalance(all, 'driver_cash')).toBe(ZERO)
    expect(fundBalance(all, 'driver_wallet')).toBe(ZERO)
    const shortageLine = all
      .flatMap((posting) => posting.lines)
      .find((line) => line.role === 'cash_shortage_receivable')
    expect(shortageLine).toMatchObject({
      fund: { kind: 'driver_receivable_cash', driverId: DRIVER },
      side: 'D',
      amount: syp(20),
    })
  })

  it('settles a negative base receivable before adding exactly the reviewed shortage debt', () => {
    const input = {
      driverId: DRIVER,
      branchId: BRANCH,
      floatTranches: [syp(100)],
      topupTranches: [],
      orders: [],
      cashDeductions: [{ amount: syp(10), sharePortion: ZERO, occurrenceKey: 'negative-base' }],
    }
    const expected = closingBalances(input)
    expect(expected).toEqual({ endCash: syp(90), endWallet: ZERO })
    const settlement = planFixedShareSettlement({
      deliveryFeeTotal: ZERO,
      fixedDriverShare: ZERO,
      manualDriverShare: ZERO,
      cashDeductionTotal: syp(10),
      expectedCash: expected.endCash,
      expectedWallet: ZERO,
      actualCash: syp(80),
      actualWallet: ZERO,
      cashShortageReceivable: syp(20),
    })
    const all = [
      ...postingsForOpen(input),
      ...postingsForCashSettledApproval(
        input,
        { driverShare: ZERO, companyShare: ZERO, yalagoShare: ZERO },
        settlement,
      ),
    ]

    expect(settlement.baseDriverShare).toBe(-syp(10))
    expect(settlement.finalEmployeeCash).toBe(-syp(20))
    // The deduction creates 10 temporarily, the return clears that 10, then creates the reviewed
    // final 20. The resulting balance is exactly 20, never 30; operational custody is flat.
    expect(fundBalance(all, 'driver_receivable_cash')).toBe(syp(20))
    expect(fundBalance(all, 'driver_cash')).toBe(ZERO)
    expect(fundBalance(all, 'driver_wallet')).toBe(ZERO)
  })

  it('refuses stale expected balances, shares, deduction totals and incomplete allocation', () => {
    const fee = syp(100)
    const split = splitFixedDriverShare([fee])
    const base = {
      driverId: DRIVER,
      branchId: BRANCH,
      floatTranches: [syp(100)],
      topupTranches: [syp(20)],
      orders: [{ orderNo: 'V-1', payMode: 'cash' as const, fee }],
      cashDeductions: [{ amount: syp(10), sharePortion: syp(10), occurrenceKey: 'd-1' }],
    }
    const expected = closingBalances(base)
    const plan = planFixedShareSettlement({
      deliveryFeeTotal: fee,
      fixedDriverShare: split.driverShare,
      manualDriverShare: ZERO,
      cashDeductionTotal: syp(10),
      expectedCash: expected.endCash,
      expectedWallet: expected.endWallet,
      actualCash: expected.endCash,
      actualWallet: expected.endWallet,
    })

    expect(() => postingsForCashSettledApproval(
      { ...base, floatTranches: [syp(101)] },
      split,
      plan,
    )).toThrow(/expected balances/)
    expect(() => postingsForCashSettledApproval(
      base,
      { ...split, driverShare: syp(39), companyShare: syp(41) },
      plan,
    )).toThrow(/gross driver share/)
    expect(() => postingsForCashSettledApproval(
      {
        ...base,
        // Keep the expected cash unchanged so this exercises the deduction-snapshot check rather
        // than correctly failing earlier on the expected-balance check.
        floatTranches: [syp(101)],
        cashDeductions: [{ ...base.cashDeductions[0]!, amount: syp(11), sharePortion: syp(11) }],
      },
      split,
      plan,
    )).toThrow(/cash deductions/)
    expect(() => postingsForCashSettledApproval(
      { ...base, cashDeductions: [{ ...base.cashDeductions[0]!, sharePortion: syp(9) }] },
      split,
      plan,
    )).toThrow(/share allocation/)
    expect(() => postingsForCashSettledApproval(
      base,
      split,
      // 100.01 has the same floored 40% as 100.00, so only an explicit source-order check can
      // detect this otherwise plausible stale snapshot.
      { ...plan, deliveryFeeTotal: minor(plan.deliveryFeeTotal + 1n) },
    )).toThrow(/delivery fee total/)
    expect(() => cashSettledReturnPostings({
      driverId: DRIVER,
      settlement: { ...plan, variance: minor(plan.variance + 1n) },
    })).toThrow(/non-canonical fixed-share settlement variance/)
  })
})

describe('cash-settled return properties', () => {
  const nonNegative = fc.bigInt({ min: 0n, max: 2_000_000_00n }).map(minor)
  const signed = fc.bigInt({ min: -500_000_00n, max: 2_000_000_00n }).map(minor)

  it('zeros both driver assets and both employee settlement accounts for every signed split', () => {
    fc.assert(
      fc.property(
        nonNegative,
        nonNegative,
        signed,
        signed,
        nonNegative,
        signed,
        (grossShare, deductions, expectedCash, expectedWallet, actualCash, actualWallet) => {
          // A zero Yallago total plus a manual share lets the generator cover every signed base
          // share without weakening the fixed-40 validation.
          const settlement = planFixedShareSettlement({
            deliveryFeeTotal: ZERO,
            fixedDriverShare: ZERO,
            manualDriverShare: grossShare,
            cashDeductionTotal: deductions,
            expectedCash,
            expectedWallet,
            actualCash,
            actualWallet,
          })
          const returns = cashSettledReturnPostings({ driverId: DRIVER, settlement })
          for (const posting of returns) expect(debitsOf(posting)).toBe(creditsOf(posting))

          const payableBefore = settlement.baseDriverShare > ZERO ? settlement.baseDriverShare : ZERO
          const receivableBefore = settlement.baseDriverShare < ZERO ? abs(settlement.baseDriverShare) : ZERO
          expect(fundBalance(returns, 'driver_cash')).toBe(-expectedCash)
          expect(fundBalance(returns, 'driver_wallet')).toBe(-expectedWallet)
          expect(fundBalance(returns, 'driver_share_payable')).toBe(payableBefore)
          expect(fundBalance(returns, 'driver_receivable_cash')).toBe(-receivableBefore)
          expect(fundBalance(returns, 'office_wallet')).toBe(actualWallet)
          expect(fundBalance(returns, 'office_cash')).toBe(settlement.cashToOffice)
        },
      ),
      { numRuns: 1_000 },
    )
  })

  /**
   * A deferred collection is money the driver KEEPS. It must therefore land in the shift-funding
   * funds, which `postingsForOpen` consumes at his next open as a carried tranche BR1 then expects.
   * Booked to the ordinary receivable — which is cleared only by an explicit collection command —
   * the carried money is invisible at the next open, so BR1 reads it as a surplus and decision 13
   * pays the driver his own debt. Before this test the deferral had no domain coverage at all.
   */
  it('books a deferred collection as next-shift funding, never as an ordinary debt', () => {
    const fee = syp(5_000)
    const orders: ShiftOrder[] = [{ orderNo: 'defer-1', payMode: 'cash', fee }]
    const split = splitFixedDriverShare([fee])
    const input = {
      driverId: DRIVER,
      branchId: BRANCH,
      floatTranches: [syp(10_000)],
      topupTranches: [syp(5_000)],
      orders,
    }
    const expected = closingBalances(input)
    const cashDeferred = syp(3_000)
    const walletDeferred = syp(1_000)
    const settlement = planFixedShareSettlement({
      deliveryFeeTotal: fee,
      fixedDriverShare: split.driverShare,
      manualDriverShare: ZERO,
      cashDeductionTotal: ZERO,
      expectedCash: expected.endCash,
      expectedWallet: expected.endWallet,
      actualCash: expected.endCash,
      actualWallet: expected.endWallet,
      cashReceivableDeferred: cashDeferred,
      walletReceivableDeferred: walletDeferred,
    })
    const returns = cashSettledReturnPostings({ driverId: DRIVER, settlement })
    for (const posting of returns) expect(debitsOf(posting)).toBe(creditsOf(posting))

    expect(fundBalance(returns, 'driver_shift_funding_cash')).toBe(cashDeferred)
    expect(fundBalance(returns, 'driver_shift_funding_wallet')).toBe(walletDeferred)
    // The share here is positive, so the only ordinary-cash movement would be a settle-down.
    expect(fundBalance(returns, 'driver_receivable_cash')).toBe(ZERO)
    expect(fundBalance(returns, 'driver_receivable_wallet')).toBe(ZERO)

    // The office receives only what physically moved; the deferral is the difference.
    expect(fundBalance(returns, 'office_cash')).toBe(settlement.cashToOffice)
    expect(fundBalance(returns, 'office_wallet')).toBe(settlement.walletToOffice)
    expect(settlement.walletToOffice).toBe(minor(settlement.actualWallet - walletDeferred))

    // And the driver's operational funds still finish flat: value moved, none was invented.
    expect(fundBalance(returns, 'driver_cash')).toBe(-expected.endCash)
    expect(fundBalance(returns, 'driver_wallet')).toBe(-expected.endWallet)
  })
})
