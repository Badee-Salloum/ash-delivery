import { describe, expect, it } from 'vitest'
import {
  isUsableMoneyText,
  normalizeDecimalDigits,
  odometerFromCloudFields,
  parseNonNegativeInteger,
} from '../src/numerals.ts'

describe('decimal digit normalization', () => {
  it('accepts Arabic-Indic and Persian digits without changing other text', () => {
    expect(normalizeDecimalDigits('١٢٣ / ۴۵۶ km')).toBe('123 / 456 km')
  })

  it('parses only safe non-negative whole readings', () => {
    expect(parseNonNegativeInteger(' ۶۹۴۸ ')).toBe(6948)
    expect(parseNonNegativeInteger('١٢.٥')).toBeNull()
    expect(parseNonNegativeInteger('-1')).toBeNull()
    expect(parseNonNegativeInteger('')).toBeNull()
  })
})

describe('cloud odometer fields', () => {
  it('recognises aliases and labelled Arabic-digit values', () => {
    expect(odometerFromCloudFields({ ODO: 'ODO ٠٢٦١١ km' })).toBe(2611)
    expect(odometerFromCloudFields({ mileage: '۱۲۳۴۵' })).toBe(12345)
  })

  it('refuses absent or unsafe readings', () => {
    expect(odometerFromCloudFields({ voltage: '83.4' })).toBeNull()
    expect(odometerFromCloudFields({ odometer: null })).toBeNull()
    expect(odometerFromCloudFields({ odometer: 'not visible' })).toBeNull()
  })
})

/**
 * The close screen used to ask nothing of the cash and wallet boxes but `!== ''`.
 *
 * «٧٠٠٠٠» is what an Arabic keyboard produces and the wire's money schema is ASCII-only
 * (`/^-?\d+(\.\d{1,2})?$/`, packages/contracts/src/wire.ts:49), so the figure passed the gate,
 * 400'd every autosave PATCH, and left the draft permanently unsaved — which on the night of
 * 2026-08-24 meant a dead submit button with no field named.
 */
describe('money text the wire can actually accept', () => {
  it('accepts an Arabic-keyboard figure once normalised — the honest case is usable, not just named', () => {
    expect(isUsableMoneyText('٧٠٠٠٠')).toBe(true)
    expect(isUsableMoneyText('۴۵۶.۷۸')).toBe(true)
    expect(normalizeDecimalDigits('٧٠٠٠٠')).toBe('70000')
  })

  it('accepts what the server accepts', () => {
    expect(isUsableMoneyText('160000')).toBe(true)
    expect(isUsableMoneyText('160000.00')).toBe(true)
    expect(isUsableMoneyText('-20.5')).toBe(true)
    expect(isUsableMoneyText(' 42 ')).toBe(true)
  })

  it('refuses what no normalisation can rescue, so the field can name itself', () => {
    expect(isUsableMoneyText('')).toBe(false)
    expect(isUsableMoneyText('160,000')).toBe(false)
    expect(isUsableMoneyText('1.234')).toBe(false)
    expect(isUsableMoneyText('abc')).toBe(false)
    expect(isUsableMoneyText('١٦٠٫٥')).toBe(false) // Arabic decimal separator U+066B, not a dot
  })
})
