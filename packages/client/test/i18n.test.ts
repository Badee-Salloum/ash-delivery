import { describe, expect, it } from 'vitest'
import { ar } from '../src/i18n/ar.ts'
import { en } from '../src/i18n/en.ts'

/** ar is the source of truth; en must mirror it key-for-key, including nested objects. */
function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === 'object'
      ? keyPaths(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  )
}

describe('i18n parity', () => {
  it('en has exactly the same keys as ar', () => {
    expect(keyPaths(en).sort()).toEqual(keyPaths(ar).sort())
  })

  it('every BR1 cause code from the domain has a translation', () => {
    // These codes come out of diagnoseBr1; a missing one would render as a raw code to a manager.
    const codes = [
      'balanced', 'pay_mode_misclassified', 'missing_order', 'extra_order',
      'unrecorded_float_tranche', 'unrecorded_topup_tranche',
      'cash_handover_mismatch', 'wallet_reading_mismatch', 'unexplained',
    ]
    for (const code of codes) {
      expect(ar.br1.cause[code as keyof typeof ar.br1.cause], code).toBeTruthy()
      expect(en.br1.cause[code as keyof typeof en.br1.cause], code).toBeTruthy()
    }
  })

  it('labels the 80% fee equivalent as a comparison, not proof of a missing order', () => {
    expect(ar.br1.feeGap).toContain('للمقارنة فقط')
    expect(ar.br1.feeGap).toContain('لا يثبت')
    expect(en.br1.feeGap).toContain('For comparison only')
    expect(en.br1.feeGap).toContain('does not prove')
  })

  it('labels a deferred close collection as auto-consumed next-shift funding', () => {
    expect(ar.settlement.receivableDeferralTitle).toContain('تمويل للنوبة القادمة')
    expect(ar.settlement.receivableDeferralHint).toContain('يُستهلك تلقائياً')
    expect(ar.settlement.cashReceivableDeferred).toBe('تمويل النوبة القادمة من الكاش')
    expect(ar.settlement.walletReceivableDeferred).toBe('تمويل النوبة القادمة من المحفظة')
    expect(ar.settlement.walletConfirmed).toContain('سيُستهلك تلقائياً')
    expect(ar.settlement.cashConfirmed).toContain('سيُستهلك تلقائياً')
    expect(ar.errors.invalid_receivable_amount).toContain('تمويل النوبة القادمة')
    expect(ar.errors.receivable_amount_conflict).toContain('تمويل النوبة القادمة')

    expect(en.settlement.receivableDeferralTitle).toContain('next-shift funding')
    expect(en.settlement.receivableDeferralHint).toContain('consumed automatically')
    expect(en.settlement.cashReceivableDeferred).toBe('Next-shift cash funding')
    expect(en.settlement.walletReceivableDeferred).toBe('Next-shift wallet funding')
    expect(en.settlement.walletConfirmed).toContain('consumed automatically')
    expect(en.settlement.cashConfirmed).toContain('consumed automatically')
    expect(en.errors.invalid_receivable_amount).toContain('next-shift funding')
    expect(en.errors.receivable_amount_conflict).toContain('next-shift funding')
  })

  it('uses the same funding language in historical shift details', () => {
    expect(ar.settlement.keptAsReceivable).toBe('يبقى كتمويل للنوبة القادمة')
    expect(ar.settlement.line.opening_receivable).toBe('تمويل مرحّل من النوبة السابقة')
    expect(ar.settlement.line.kept_as_receivable).toBe('يبقى كتمويل للنوبة القادمة')
    expect(ar.settlement.line.residual_receivable).toContain('ذمة')

    expect(en.settlement.keptAsReceivable).toBe('Kept as next-shift funding')
    expect(en.settlement.line.opening_receivable).toBe('Funding carried from the previous shift')
    expect(en.settlement.line.kept_as_receivable).toBe('Kept as next-shift funding')
    expect(en.settlement.line.residual_receivable).toContain('receivable')
  })

  it('distinguishes a loss write-off from collection and warns that correction moves the office ledger', () => {
    expect(ar.treasury.receivableDirections.writeoff).toContain('دون تحصيل')
    expect(ar.treasury.receivableWriteoffHint).toContain('لا يدخل')
    expect(ar.treasury.writeoffIntent).toContain('المكتب لم يستلم')
    expect(ar.treasury.correctionHint).toContain('ينعكس على رصيد المكتب')

    expect(en.treasury.receivableDirections.writeoff).toContain('without collection')
    expect(en.treasury.receivableWriteoffHint).toContain('No cash or wallet')
    expect(en.treasury.writeoffIntent).toContain('received no money')
    expect(en.treasury.correctionHint).toContain('office balance')
  })

  it('keeps ordinary receivables distinct in the independent treasury screen', () => {
    expect(ar.treasury.receivableKinds.ordinary).toBe('ذمة عادية')
    expect(ar.treasury.receivableKinds.shift_funding).toBe('تمويل النوبة القادمة')
    expect(en.treasury.receivableKinds.ordinary).toBe('Ordinary receivable')
    expect(en.treasury.receivableKinds.shift_funding).toBe('Next-shift funding')
  })
})
