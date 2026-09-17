import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  isCalendarDate,
  monthEndFor,
  monthKey,
  monthStartFor,
  monthsBetween,
} from '../../src/time/civil.ts'

/** Any date from 1970 to ~2080, built through the domain's own arithmetic. */
const anyDate = fc.integer({ min: 0, max: 40_000 }).map((offset) => addDays('1970-01-01', offset))

describe('calendar months', () => {
  it('knows the length of every month, leap years included', () => {
    expect(daysInMonth(2026, 1)).toBe(31)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
    expect(daysInMonth(2100, 2)).toBe(28) // divisible by 100, not by 400
    expect(daysInMonth(2000, 2)).toBe(29) // divisible by 400
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(() => daysInMonth(2026, 13)).toThrow(RangeError)
    expect(() => daysInMonth(2026, 0)).toThrow(RangeError)
  })

  it('finds the first and last day of a month', () => {
    expect(monthStartFor('2026-09-17')).toBe('2026-09-01')
    expect(monthEndFor('2026-09-17')).toBe('2026-09-30')
    expect(monthEndFor('2028-02-03')).toBe('2028-02-29')
    expect(monthEndFor('2027-02-03')).toBe('2027-02-28')
    expect(monthKey('2028-02-29')).toBe('2028-02')
  })

  it('adds months and CLAMPS to the target month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28')
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28')
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMonths('2026-05-10', 0)).toBe('2026-05-10')
    expect(() => addMonths('2026-05-10', 0.5)).toThrow(RangeError)
  })

  it('counts month boundaries and days, signed', () => {
    expect(monthsBetween('2026-01-31', '2026-02-01')).toBe(1)
    expect(monthsBetween('2026-02-01', '2026-02-28')).toBe(0)
    expect(monthsBetween('2026-09-17', '2025-09-17')).toBe(-12)
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2)
    expect(daysBetween('2027-02-28', '2027-03-01')).toBe(1)
    expect(daysBetween('2026-09-17', '2026-09-10')).toBe(-7)
  })

  it('validates calendar dates with the same parser as everything else', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true)
    expect(isCalendarDate('2027-02-29')).toBe(false)
    expect(isCalendarDate('2026-02-31')).toBe(false)
    expect(isCalendarDate('2026-9-1')).toBe(false)
    expect(isCalendarDate('')).toBe(false)
    expect(isCalendarDate(undefined)).toBe(false)
    expect(isCalendarDate(20260917)).toBe(false)
  })

  it('property: a date lies inside its own month', () => {
    fc.assert(
      fc.property(anyDate, (date) => {
        expect(monthStartFor(date) <= date).toBe(true)
        expect(date <= monthEndFor(date)).toBe(true)
        expect(monthStartFor(date).endsWith('-01')).toBe(true)
        expect(monthKey(date)).toBe(date.slice(0, 7))
      }),
    )
  })

  it('property: the day after a month end is the next month start', () => {
    fc.assert(
      fc.property(anyDate, (date) => {
        expect(addDays(monthEndFor(date), 1)).toBe(monthStartFor(addMonths(date, 1)))
      }),
    )
  })

  it('property: addMonths moves exactly n month boundaries and never overflows the month', () => {
    fc.assert(
      fc.property(anyDate, fc.integer({ min: -240, max: 240 }), (date, n) => {
        const moved = addMonths(date, n)
        expect(monthsBetween(date, moved)).toBe(n)
        expect(Number(moved.slice(8))).toBeLessThanOrEqual(Number(date.slice(8)))
      }),
    )
  })

  it('property: daysBetween inverts addDays', () => {
    fc.assert(
      fc.property(anyDate, fc.integer({ min: -5_000, max: 5_000 }), (date, delta) => {
        expect(daysBetween(date, addDays(date, delta))).toBe(delta)
      }),
    )
  })
})
