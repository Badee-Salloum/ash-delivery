import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  FIXED_DRIVER_BPS,
  allocate,
  splitFixedDriverShare,
} from '../../src/money/allocate.ts'
import { type Minor, abs, add, minor, sub, sum } from '../../src/money/minor.ts'
import { planFixedShareSettlement } from '../../src/settlement/statement.ts'

const syp = (whole: number): Minor => minor(BigInt(whole) * 100n)

describe('fixed 40% settlement', () => {
  it('settles the measured Thaer shift through a full wallet return and one cash collection', () => {
    const plan = planFixedShareSettlement({
      deliveryFeeTotal: syp(1_545),
      fixedDriverShare: syp(618),
      manualDriverShare: syp(0),
      cashDeductionTotal: syp(50),
      expectedCash: syp(4_495),
      expectedWallet: syp(191),
      actualCash: syp(4_935),
      actualWallet: minor(27_950n),
    })

    expect(plan).toMatchObject({
      grossDriverShare: syp(618),
      baseDriverShare: syp(568),
      expectedTotal: syp(4_686),
      actualTotal: minor(521_450n),
      variance: minor(52_850n),
      finalEmployeeCash: minor(109_650n),
      officeEntitlement: syp(4_118),
      cashToOffice: minor(383_850n),
      walletToOffice: minor(27_950n),
      wallet: { action: 'collect', amount: minor(27_950n) },
      cash: { action: 'collect', amount: minor(383_850n) },
    })
  })

  it('adds the manager-agreed manual share after the fixed Yallago share', () => {
    const plan = planFixedShareSettlement({
      deliveryFeeTotal: syp(100),
      fixedDriverShare: syp(40),
      manualDriverShare: syp(17),
      cashDeductionTotal: syp(5),
      expectedCash: syp(90),
      expectedWallet: syp(20),
      actualCash: syp(90),
      actualWallet: syp(20),
    })
    expect(plan.grossDriverShare).toBe(syp(57))
    expect(plan.baseDriverShare).toBe(syp(52))
    expect(plan.finalEmployeeCash).toBe(syp(52))
  })

  it('uses the scalar variance, so moving the same surplus between cash and wallet changes no earnings', () => {
    const common = {
      deliveryFeeTotal: syp(100),
      fixedDriverShare: syp(40),
      manualDriverShare: syp(0),
      cashDeductionTotal: syp(0),
      expectedCash: syp(80),
      expectedWallet: syp(20),
    }
    const cashHeavy = planFixedShareSettlement({ ...common, actualCash: syp(95), actualWallet: syp(10) })
    const walletHeavy = planFixedShareSettlement({ ...common, actualCash: syp(45), actualWallet: syp(60) })

    expect(cashHeavy.variance).toBe(syp(5))
    expect(walletHeavy.variance).toBe(syp(5))
    expect(cashHeavy.finalEmployeeCash).toBe(syp(45))
    expect(walletHeavy.finalEmployeeCash).toBe(syp(45))
    expect(cashHeavy.cashToOffice).toBe(syp(50))
    expect(walletHeavy.cashToOffice).toBe(syp(0))
    expect(walletHeavy.wallet).toEqual({ action: 'collect', amount: syp(60) })
  })

  it('nets deductions and surplus once, clearing an apparent deduction overflow before paying cash', () => {
    const plan = planFixedShareSettlement({
      deliveryFeeTotal: syp(100),
      fixedDriverShare: syp(40),
      manualDriverShare: syp(0),
      cashDeductionTotal: syp(50),
      expectedCash: syp(130),
      expectedWallet: syp(20),
      actualCash: syp(190),
      actualWallet: syp(20),
    })
    // Signed base = -10; the +60 variance clears it and leaves +50 to the employee. There must not
    // be a simultaneous 10 receivable and 60 payout.
    expect(plan.baseDriverShare).toBe(-syp(10))
    expect(plan.variance).toBe(syp(60))
    expect(plan.finalEmployeeCash).toBe(syp(50))
  })

  it('turns a shortage beyond the whole share into extra cash collected now, not a receivable', () => {
    const plan = planFixedShareSettlement({
      deliveryFeeTotal: syp(100),
      fixedDriverShare: syp(40),
      manualDriverShare: syp(0),
      cashDeductionTotal: syp(0),
      expectedCash: syp(80),
      expectedWallet: syp(20),
      actualCash: syp(20),
      actualWallet: syp(20),
    })
    expect(plan.variance).toBe(-syp(60))
    expect(plan.finalEmployeeCash).toBe(-syp(20))
    expect(plan.cash).toEqual({ action: 'collect', amount: syp(40) })
    expect(plan.cashToOffice).toBeGreaterThan(plan.actualCash)
  })

  it('expresses office funding and payment as directions with absolute amounts', () => {
    const walletFunding = planFixedShareSettlement({
      deliveryFeeTotal: syp(0),
      fixedDriverShare: syp(0),
      manualDriverShare: syp(0),
      cashDeductionTotal: syp(0),
      expectedCash: syp(0),
      expectedWallet: minor(-syp(5)),
      actualCash: syp(0),
      actualWallet: minor(-syp(5)),
    })
    expect(walletFunding.wallet).toEqual({ action: 'fund', amount: syp(5) })

    const cashPayment = planFixedShareSettlement({
      deliveryFeeTotal: syp(100),
      fixedDriverShare: syp(40),
      manualDriverShare: syp(0),
      cashDeductionTotal: syp(0),
      expectedCash: syp(20),
      expectedWallet: syp(80),
      actualCash: syp(0),
      actualWallet: syp(80),
    })
    expect(cashPayment.cash).toEqual({ action: 'pay', amount: syp(20) })
    expect(cashPayment.finalEmployeeCash).toBe(syp(20))
  })

  it('emits explicit none actions at exact zero', () => {
    const plan = planFixedShareSettlement({
      deliveryFeeTotal: syp(0),
      fixedDriverShare: syp(0),
      manualDriverShare: syp(0),
      cashDeductionTotal: syp(0),
      expectedCash: syp(0),
      expectedWallet: syp(0),
      actualCash: syp(0),
      actualWallet: syp(0),
    })
    expect(plan.wallet).toEqual({ action: 'none', amount: syp(0) })
    expect(plan.cash).toEqual({ action: 'none', amount: syp(0) })
  })

  it('rejects a caller-supplied share that is not exactly floor(40% of Yallago fees)', () => {
    expect(() => planFixedShareSettlement({
      deliveryFeeTotal: minor(101n),
      fixedDriverShare: minor(41n),
      manualDriverShare: minor(0n),
      cashDeductionTotal: minor(0n),
      expectedCash: minor(0n),
      expectedWallet: minor(0n),
      actualCash: minor(0n),
      actualWallet: minor(0n),
    })).toThrow(/fixed driver share/)
  })

  it('rejects negative fees, shares, deductions and declared cash', () => {
    const valid = {
      deliveryFeeTotal: minor(0n),
      fixedDriverShare: minor(0n),
      manualDriverShare: minor(0n),
      cashDeductionTotal: minor(0n),
      expectedCash: minor(0n),
      expectedWallet: minor(0n),
      actualCash: minor(0n),
      actualWallet: minor(0n),
    }
    for (const key of ['deliveryFeeTotal', 'fixedDriverShare', 'manualDriverShare', 'cashDeductionTotal', 'actualCash'] as const) {
      expect(() => planFixedShareSettlement({ ...valid, [key]: minor(-1n) })).toThrow(/non-negative/)
    }
  })
})

describe('fixed per-shift Yallago split', () => {
  it('floors the driver once, Yallago per order, and gives the company every remainder', () => {
    const fees = [minor(101n), minor(102n)]
    const split = splitFixedDriverShare(fees)
    expect(split.driverShare).toBe(allocate(sum(fees), FIXED_DRIVER_BPS, 'floor'))
    expect(split.driverShare + split.companyShare + split.yalagoShare).toBe(sum(fees))
    expect(split.yalagoShare).toBe(minor(40n)) // floor(20.2) + floor(20.4)
  })
})

describe('fixed settlement conservation properties', () => {
  const nonNegative = fc.bigInt({ min: 0n, max: 10_000_000_00n }).map(minor)
  const signed = fc.bigInt({ min: -1_000_000_00n, max: 10_000_000_00n }).map(minor)

  it('conserves every minor unit for arbitrary shares, deductions, balances and variances', () => {
    fc.assert(
      fc.property(
        nonNegative,
        nonNegative,
        nonNegative,
        signed,
        signed,
        nonNegative,
        signed,
        (deliveryFeeTotal, manualDriverShare, cashDeductionTotal, expectedCash, expectedWallet, actualCash, actualWallet) => {
          const fixedDriverShare = allocate(deliveryFeeTotal, FIXED_DRIVER_BPS, 'floor')
          const plan = planFixedShareSettlement({
            deliveryFeeTotal,
            fixedDriverShare,
            manualDriverShare,
            cashDeductionTotal,
            expectedCash,
            expectedWallet,
            actualCash,
            actualWallet,
          })

          expect(plan.grossDriverShare).toBe(add(fixedDriverShare, manualDriverShare))
          expect(plan.baseDriverShare).toBe(sub(plan.grossDriverShare, cashDeductionTotal))
          expect(plan.variance).toBe(sub(plan.actualTotal, plan.expectedTotal))
          expect(plan.finalEmployeeCash).toBe(add(plan.baseDriverShare, plan.variance))
          expect(sub(actualCash, plan.cashToOffice)).toBe(plan.finalEmployeeCash)
          expect(add(plan.walletToOffice, plan.cashToOffice)).toBe(plan.officeEntitlement)
          expect(plan.officeEntitlement).toBe(sub(plan.expectedTotal, plan.baseDriverShare))
          expect(plan.wallet.amount).toBe(abs(actualWallet))
          expect(plan.cash.amount).toBe(abs(plan.cashToOffice))
        },
      ),
      { numRuns: 1_000 },
    )
  })
})
