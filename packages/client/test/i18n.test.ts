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
})
