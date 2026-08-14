import { describe, expect, it } from 'vitest'
import { normalizeDecimalDigits, odometerFromCloudFields, parseNonNegativeInteger } from '../src/numerals.ts'

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
