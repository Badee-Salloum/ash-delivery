import { describe, expect, it } from 'vitest'
import { toText } from '../src/screens/BatteryPanel.tsx'

/**
 * The formatter that turns a stored scaled integer into what the driver sees in the field.
 *
 * This is where «100 read as 1» actually lived — for four rounds it was blamed on the OCR, but the
 * reader was handing 100 to a formatter whose trailing-zero trim was inverted: it stripped the
 * zeros off WHOLE numbers (100 → "1", 80 → "8", 20 → "2") and left decimals untouched. A correctly
 * recognised charge was corrupted on its way to the screen and to the server.
 */
describe('the field formatter no longer eats trailing zeros off whole numbers', () => {
  // percent and cycleCount: scale 1, decimals 0
  it('shows a full 100% charge as 100, not 1', () => {
    expect(toText(100, 1, 0)).toBe('100')
  })

  it('keeps every round-number charge intact', () => {
    expect(toText(80, 1, 0)).toBe('80')
    expect(toText(20, 1, 0)).toBe('20')
    expect(toText(10, 1, 0)).toBe('10')
    expect(toText(0, 1, 0)).toBe('0')
  })

  it('leaves a non-round charge alone, as it always did', () => {
    expect(toText(47, 1, 0)).toBe('47')
  })

  // voltage: scale 1000, decimals 2 — the decimal trim that was actually wanted
  it('still trims a decimal field: 50.0 Ah shows as 50', () => {
    expect(toText(500, 10, 1)).toBe('50') // 500 deci-Ah = 50.0 Ah
    expect(toText(5000, 10, 1)).toBe('500') // 5000 deci-Ah = 500.0 Ah
  })

  it('keeps a real decimal: 81.48 V and 33.6 °C', () => {
    expect(toText(81_480, 1000, 2)).toBe('81.48')
    expect(toText(336, 10, 1)).toBe('33.6')
  })

  it('a null reading is an empty field, never a zero', () => {
    expect(toText(null, 1, 0)).toBe('')
  })
})
