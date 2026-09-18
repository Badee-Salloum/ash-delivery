import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { addDays, dayOfWeek } from '../../src/time/civil.ts'
import {
  RANGE_PRESETS,
  type RangeSelection,
  type SimpleRangePreset,
  bucketFor,
  bucketKey,
  bucketKeys,
  canGoNextWeek,
  isRangePreset,
  isWeekStart,
  resolveRange,
  shiftWeek,
  validateCustom,
} from '../../src/time/range.ts'

// 2026-09-17 is a Thursday; its financial week began on Sunday 2026-09-13.
const ctx = { today: '2026-09-17', epoch: '2026-08-11' }

const anyDate = fc.integer({ min: 0, max: 40_000 }).map((offset) => addDays('1970-01-01', offset))

describe('resolveRange — the presets', () => {
  it('«الكل منذ البدء» runs from the epoch to today', () => {
    expect(resolveRange({ preset: 'all' }, ctx)).toEqual({ from: '2026-08-11', to: '2026-09-17' })
  })

  it('an epoch in the future never inverts the range', () => {
    expect(resolveRange({ preset: 'all' }, { today: '2026-09-17', epoch: '2026-10-01' })).toEqual({
      from: '2026-09-17',
      to: '2026-09-17',
    })
  })

  it('today and yesterday are single business days', () => {
    expect(resolveRange({ preset: 'today' }, ctx)).toEqual({ from: '2026-09-17', to: '2026-09-17' })
    expect(resolveRange({ preset: 'yesterday' }, ctx)).toEqual({ from: '2026-09-16', to: '2026-09-16' })
  })

  it('weeks start on SUNDAY, not Saturday and not Monday', () => {
    expect(resolveRange({ preset: 'this_week' }, ctx)).toEqual({ from: '2026-09-13', to: '2026-09-17' })
    expect(resolveRange({ preset: 'last_week' }, ctx)).toEqual({ from: '2026-09-06', to: '2026-09-12' })
    expect(dayOfWeek('2026-09-13')).toBe(0)
    expect(dayOfWeek('2026-09-12')).toBe(6)
  })

  it('on a Sunday «this week» is that Sunday alone', () => {
    const sunday = { today: '2026-09-13', epoch: '2026-08-11' }
    expect(resolveRange({ preset: 'this_week' }, sunday)).toEqual({ from: '2026-09-13', to: '2026-09-13' })
    expect(resolveRange({ preset: 'last_week' }, sunday)).toEqual({ from: '2026-09-06', to: '2026-09-12' })
  })

  it('this month runs to today; last month is the whole previous calendar month', () => {
    expect(resolveRange({ preset: 'this_month' }, ctx)).toEqual({ from: '2026-09-01', to: '2026-09-17' })
    expect(resolveRange({ preset: 'last_month' }, ctx)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    // March 31st: the previous month is February, including a leap day.
    expect(resolveRange({ preset: 'last_month' }, { today: '2028-03-31', epoch: '2028-01-01' })).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    })
    // January reaches back across the year.
    expect(resolveRange({ preset: 'last_month' }, { today: '2027-01-05', epoch: '2026-01-01' })).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    })
  })

  it('a named week is Sunday → Saturday, cut at today, and any date names its week', () => {
    expect(resolveRange({ preset: 'week', week: '2026-09-06' }, ctx)).toEqual({ from: '2026-09-06', to: '2026-09-12' })
    expect(resolveRange({ preset: 'week', week: '2026-09-09' }, ctx)).toEqual({ from: '2026-09-06', to: '2026-09-12' })
    expect(resolveRange({ preset: 'week', week: '2026-09-13' }, ctx)).toEqual({ from: '2026-09-13', to: '2026-09-17' })
    // A future week collapses onto the current one rather than inverting.
    expect(resolveRange({ preset: 'week', week: '2026-10-04' }, ctx)).toEqual({ from: '2026-09-13', to: '2026-09-17' })
  })

  it('a custom range is returned as given once valid, and refused otherwise', () => {
    expect(resolveRange({ preset: 'custom', from: '2026-09-01', to: '2026-09-17' }, ctx)).toEqual({
      from: '2026-09-01',
      to: '2026-09-17',
    })
    expect(() => resolveRange({ preset: 'custom', from: '2026-09-17', to: '2026-09-01' }, ctx)).toThrow(RangeError)
    expect(() => resolveRange({ preset: 'custom', from: '2026-02-31', to: '2026-03-01' }, ctx)).toThrow(RangeError)
  })
})

describe('the week navigator', () => {
  it('steps whole financial weeks from any date', () => {
    expect(shiftWeek('2026-09-17', -1)).toBe('2026-09-06')
    expect(shiftWeek('2026-09-13', 1)).toBe('2026-09-20')
    expect(shiftWeek('2026-09-13', 0)).toBe('2026-09-13')
    expect(() => shiftWeek('2026-09-13', 0.5)).toThrow(RangeError)
  })

  it('«التالي» is disabled at the current week', () => {
    expect(canGoNextWeek('2026-09-06', '2026-09-17')).toBe(true)
    expect(canGoNextWeek('2026-09-13', '2026-09-17')).toBe(false)
    expect(canGoNextWeek('2026-09-20', '2026-09-17')).toBe(false)
    // Saturday night is still the old week (the 04:00 rule already lives in `today`).
    expect(canGoNextWeek('2026-09-06', '2026-09-12')).toBe(false)
  })

  it('knows a Sunday', () => {
    expect(isWeekStart('2026-09-13')).toBe(true)
    expect(isWeekStart('2026-09-14')).toBe(false)
  })
})

describe('validateCustom', () => {
  it('returns codes, not sentences', () => {
    expect(validateCustom('', '2026-09-17')).toEqual({ ok: false, code: 'dates_required' })
    expect(validateCustom('2026-02-31', '2026-03-01')).toEqual({ ok: false, code: 'dates_required' })
    expect(validateCustom(undefined, null)).toEqual({ ok: false, code: 'dates_required' })
    expect(validateCustom('2026-09-17', '2026-09-16')).toEqual({ ok: false, code: 'date_order' })
    expect(validateCustom('2026-01-01', '2026-02-01', 31)).toEqual({ ok: false, code: 'range_too_large' })
    expect(validateCustom('2026-01-01', '2026-01-31', 31)).toEqual({
      ok: true,
      from: '2026-01-01',
      to: '2026-01-31',
      days: 31,
    })
    expect(validateCustom('2026-09-17', '2026-09-17')).toMatchObject({ ok: true, days: 1 })
  })
})

describe('trend buckets', () => {
  it('draws per day up to 62 days, per week up to 26 weeks, then per month', () => {
    expect(bucketFor('2026-09-17', '2026-09-17')).toBe('day')
    expect(bucketFor('2026-07-01', '2026-08-31')).toBe('day') // 62 days
    expect(bucketFor('2026-07-01', '2026-09-01')).toBe('week') // 63 days
    expect(bucketFor('2026-01-01', '2026-07-01')).toBe('week') // 182 days
    expect(bucketFor('2026-01-01', '2026-07-02')).toBe('month') // 183 days
  })

  it('names a bucket by its first day', () => {
    expect(bucketKey('2026-09-17', 'day')).toBe('2026-09-17')
    expect(bucketKey('2026-09-17', 'week')).toBe('2026-09-13')
    expect(bucketKey('2026-09-17', 'month')).toBe('2026-09-01')
    expect(() => bucketKey('2026-02-31', 'day')).toThrow(RangeError)
  })

  it('enumerates every bucket a range touches, gaps included', () => {
    expect(bucketKeys('2026-09-15', '2026-09-17', 'day')).toEqual(['2026-09-15', '2026-09-16', '2026-09-17'])
    expect(bucketKeys('2026-09-01', '2026-09-17', 'week')).toEqual([
      '2026-08-30',
      '2026-09-06',
      '2026-09-13',
    ])
    expect(bucketKeys('2026-01-31', '2026-04-01', 'month')).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
    ])
    expect(bucketKeys('2026-09-17', '2026-09-16', 'day')).toEqual([])
  })
})

describe('resolveRange — properties', () => {
  const simple = fc.constantFrom<SimpleRangePreset>('all', 'today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month')
  const selection: fc.Arbitrary<RangeSelection> = fc.oneof(
    simple.map((preset) => ({ preset }) as RangeSelection),
    anyDate.map((week) => ({ preset: 'week', week }) as RangeSelection),
    fc.tuple(anyDate, fc.integer({ min: 0, max: 800 })).map(
      ([from, span]) => ({ preset: 'custom', from, to: addDays(from, span) }) as RangeSelection,
    ),
  )

  it('every resolved range has from <= to', () => {
    fc.assert(
      fc.property(selection, anyDate, anyDate, (sel, today, epoch) => {
        const range = resolveRange(sel, { today, epoch })
        expect(range.from <= range.to).toBe(true)
      }),
    )
  })

  it('week presets start on a Sunday and span at most seven days, ending no later than today', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'this_week' | 'last_week' | 'week'>('this_week', 'last_week', 'week'),
        anyDate,
        anyDate,
        (preset, today, week) => {
          const sel: RangeSelection = preset === 'week' ? { preset, week } : { preset }
          const range = resolveRange(sel, { today, epoch: today })
          expect(dayOfWeek(range.from)).toBe(0)
          expect(range.to <= today).toBe(true)
          expect(addDays(range.from, 6) >= range.to).toBe(true)
        },
      ),
    )
  })

  it('«today» is always [today, today]', () => {
    fc.assert(
      fc.property(anyDate, anyDate, (today, epoch) => {
        expect(resolveRange({ preset: 'today' }, { today, epoch })).toEqual({ from: today, to: today })
      }),
    )
  })

  it('shiftWeek always lands on a Sunday, and next is allowed exactly before the current week', () => {
    fc.assert(
      fc.property(anyDate, fc.integer({ min: -60, max: 60 }), (date, delta) => {
        const sunday = shiftWeek(date, delta)
        expect(dayOfWeek(sunday)).toBe(0)
        expect(canGoNextWeek(sunday, date)).toBe(delta < 0)
      }),
    )
  })

  it('knows its own preset list', () => {
    for (const preset of RANGE_PRESETS) expect(isRangePreset(preset)).toBe(true)
    expect(isRangePreset('last_year')).toBe(false)
    expect(isRangePreset(undefined)).toBe(false)
  })
})
