import { describe, expect, it } from 'vitest'
import { plural, pluralCategory } from '../src/i18n/index.ts'

/**
 * Arabic counts in six categories and the app was using one, so it said «1 صفوف» and
 * «تمت قراءة 2 حقول» — which reads to a native speaker exactly as "1 rows" reads in English.
 */
describe('Arabic plural categories', () => {
  it('separates the singular, the DUAL and the small plural', () => {
    expect(pluralCategory(0, 'ar')).toBe('zero')
    expect(pluralCategory(1, 'ar')).toBe('one')
    expect(pluralCategory(2, 'ar')).toBe('two')
    expect(pluralCategory(3, 'ar')).toBe('few')
    expect(pluralCategory(10, 'ar')).toBe('few')
    expect(pluralCategory(11, 'ar')).toBe('many')
    expect(pluralCategory(99, 'ar')).toBe('many')
    expect(pluralCategory(100, 'ar')).toBe('other')
  })

  it('follows the hundreds, not the raw magnitude', () => {
    // 103 is «few» because 3 is; 111 is «many» because 11 is. A rule on n alone gets both wrong.
    expect(pluralCategory(103, 'ar')).toBe('few')
    expect(pluralCategory(111, 'ar')).toBe('many')
  })

  it('collapses to one/other for English', () => {
    expect(pluralCategory(1, 'en')).toBe('one')
    for (const n of [0, 2, 3, 11, 100]) expect(pluralCategory(n, 'en')).toBe('other')
  })
})

describe('choosing a form', () => {
  const forms = { zero: 'لا صفوف', one: 'صف واحد', two: 'صفّان', few: '{n} صفوف', many: '{n} صفاً', other: '{n} صف' }

  it('picks the form and substitutes the count', () => {
    expect(plural(0, forms, 'ar')).toBe('لا صفوف')
    expect(plural(1, forms, 'ar')).toBe('صف واحد')
    expect(plural(2, forms, 'ar')).toBe('صفّان')
    expect(plural(5, forms, 'ar')).toBe('5 صفوف')
    expect(plural(20, forms, 'ar')).toBe('20 صفاً')
  })

  it('falls back rather than throwing when a form is missing', () => {
    // An English catalogue defines only one/other; asking it for the dual must still read.
    expect(plural(2, { one: 'one row', other: '{n} rows' }, 'en')).toBe('2 rows')
    expect(plural(2, { other: '{n} صف' }, 'ar')).toBe('2 صف')
  })
})
