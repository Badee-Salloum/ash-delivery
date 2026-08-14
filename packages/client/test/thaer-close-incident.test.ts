import { describe, expect, it } from 'vitest'
import { type DraftCashDeduction, type DraftOrder, br1DifferencePresentation, previewBr1 } from '../src/order-entry.ts'

/** The six positive Recent Orders rows visible in the owner's incident screenshots. */
const orders: DraftOrder[] = ['190', '145', '175', '370', '240', '425'].map((feeText, index) => ({
  localId: `order-${index + 1}`,
  providerOrderNo: `YAL-incident-${index + 1}`,
  payMode: 'cash',
  feeText,
  feeOcrText: feeText,
  included: true,
}))

const deduction: DraftCashDeduction = {
  localId: 'deduction-minus-50',
  operationKey: 'recent-orders:minus-50',
  amountText: '50',
  amountOcrText: '50',
  timeText: '22:36',
  dateText: '2026-08-13',
  pointA: 'G777+4GP, Al Qanawat',
  pointB: 'G78P+J3M, Al Mouhajrin',
  source: 'ocr',
  included: true,
}

describe('Thaer close incident arithmetic', () => {
  it('counts one minus-50 and names the remaining positive difference as a surplus', () => {
    const preview = previewBr1({
      floatText: '3500',
      topupText: '0',
      orders,
      cashDeductions: [deduction],
      declaredCashText: '4935',
      declaredWalletText: '279.50',
    })

    expect(preview).not.toBeNull()
    expect(preview!.expectedTotalText).toBe('4686.00')
    expect(preview!.differenceText).toBe('528.50')
    expect(preview!.feeGapText).toBe('660.62')
    expect(br1DifferencePresentation(preview!.differenceText!)).toEqual({
      direction: 'surplus',
      amountText: '528.50',
    })
  })

  it('documents the exact wrong figures produced when minus-50 is counted twice', () => {
    const preview = previewBr1({
      floatText: '3500',
      topupText: '0',
      orders,
      cashDeductions: [deduction, { ...deduction, localId: 'duplicate', operationKey: 'duplicate' }],
      declaredCashText: '4935',
      declaredWalletText: '279.50',
    })

    expect(preview?.expectedTotalText).toBe('4636.00')
    expect(preview?.differenceText).toBe('578.50')
    expect(preview?.feeGapText).toBe('723.12')
  })
})
