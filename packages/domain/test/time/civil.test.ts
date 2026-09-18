import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  DAMASCUS_OFFSET_MINUTES,
  addDays,
  businessDateFor,
  civilFromDays,
  dayOfWeek,
  daysFromCivil,
  weekClosedOn,
  weekEndFor,
  weekStartFor,
} from '../../src/time/civil.ts'

/** Build an epoch-ms for a wall-clock time in Damascus, without using Date. */
const damascus = (y: number, m: number, d: number, hh: number, mm: number): number =>
  (daysFromCivil(y, m, d) * 1440 + hh * 60 + mm - DAMASCUS_OFFSET_MINUTES) * 60_000

describe('civil date arithmetic', () => {
  it('round-trips through days-since-epoch', () => {
    fc.assert(
      fc.property(fc.integer({ min: -40_000, max: 40_000 }), (days) => {
        const { y, m, d } = civilFromDays(days)
        expect(daysFromCivil(y, m, d)).toBe(days)
      }),
    )
  })

  it('knows 1970-01-01 was a Thursday', () => {
    expect(dayOfWeek('1970-01-01')).toBe(4)
  })

  it('handles leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01')
    expect(addDays('2100-02-28', 1)).toBe('2100-03-01') // 2100 is not a leap year
  })
})

describe('business date — Asia/Damascus 04:00 boundary', () => {
  it('23:50 and 00:30 are the SAME business day — the fleet does not stop at midnight', () => {
    // The owner's own rule: «اليوم لا ينتهي على الساعة 12 بل على الساعة 4 صباحا».
    expect(businessDateFor(damascus(2026, 7, 21, 23, 50))).toBe('2026-07-21')
    expect(businessDateFor(damascus(2026, 7, 22, 0, 30))).toBe('2026-07-21')
  })

  it('rolls over at 04:00 exactly, not a minute before', () => {
    expect(businessDateFor(damascus(2026, 7, 22, 3, 59))).toBe('2026-07-21')
    expect(businessDateFor(damascus(2026, 7, 22, 4, 0))).toBe('2026-07-22')
  })

  it('the boundary is local, not UTC', () => {
    // 22:30 UTC on the 21st is 01:30 on the 22nd in Damascus (UTC+3) — still the 21st's workday.
    const utcLate = (daysFromCivil(2026, 7, 21) * 1440 + 22 * 60 + 30) * 60_000
    expect(businessDateFor(utcLate)).toBe('2026-07-21')
  })

  it('a shift opened 23:50 and closed 01:30 stays on ONE business date', () => {
    const open = businessDateFor(damascus(2026, 7, 21, 23, 50))
    const close = businessDateFor(damascus(2026, 7, 22, 1, 30))
    expect(open).toBe(close)
    expect(open).toBe('2026-07-21')
  })

  it('keeps a Saturday night out of the next FINANCIAL WEEK', () => {
    // The worst available failure. 2026-08-29 is a Saturday; under a midnight boundary a close at
    // 01:30 on Sunday the 30th would book into the week starting the 30th — a different week, and
    // BR7 makes a closed week immutable. The 04:00 rule keeps the night with the day it was worked.
    const saturdayNight = businessDateFor(damascus(2026, 8, 30, 1, 30))
    expect(saturdayNight).toBe('2026-08-29')
    expect(weekStartFor(saturdayNight)).toBe('2026-08-23')
    expect(weekStartFor(businessDateFor(damascus(2026, 8, 30, 4, 0)))).toBe('2026-08-30')
  })

  it('reproduces the old midnight rule when the boundary is injected as 0', () => {
    // `business_date` is a WRITTEN column. Rows stored under the previous boundary must stay
    // reproducible, which is why this is a value and not a constant.
    expect(businessDateFor(damascus(2026, 7, 22, 0, 30), DAMASCUS_OFFSET_MINUTES, 0)).toBe('2026-07-22')
    expect(businessDateFor(damascus(2026, 7, 21, 23, 50), DAMASCUS_OFFSET_MINUTES, 0)).toBe('2026-07-21')
  })

  it('honours an injected non-Damascus offset (pre-2022 Syrian DST, backfilled data)', () => {
    // Same instant, +2 instead of +3: still the 21st at 22:50 local.
    const instant = damascus(2026, 7, 21, 23, 50)
    expect(businessDateFor(instant, 120)).toBe('2026-07-21')
    // An instant 30 minutes past local midnight under +3 is still the 21st under +2.
    expect(businessDateFor(damascus(2026, 7, 22, 0, 30), 120)).toBe('2026-07-21')
  })
})

describe('financial week — Sunday → Saturday (BR7)', () => {
  it('a Sunday starts its own week', () => {
    expect(dayOfWeek('2026-07-19')).toBe(0)
    expect(weekStartFor('2026-07-19')).toBe('2026-07-19')
    expect(weekEndFor('2026-07-19')).toBe('2026-07-25')
  })

  it('every day Sunday 19th → Saturday 25th maps to the same week', () => {
    for (let i = 0; i < 7; i++) {
      expect(weekStartFor(addDays('2026-07-19', i))).toBe('2026-07-19')
    }
  })

  it('the next Sunday starts a NEW week — a shift worked on closing day is never frozen by it', () => {
    expect(weekStartFor('2026-07-26')).toBe('2026-07-26')
  })

  it('closing on Sunday the 26th freezes the week of the 19th–25th', () => {
    expect(weekClosedOn('2026-07-26')).toEqual({ start: '2026-07-19', end: '2026-07-25' })
  })

  it('refuses to close on any day that is not a Sunday', () => {
    expect(() => weekClosedOn('2026-07-25')).toThrow(RangeError)
    expect(() => weekClosedOn('2026-07-27')).toThrow(RangeError)
  })

  it('is NOT ISO/Monday-based — the trap date_trunc(week) would fall into', () => {
    // Monday the 20th: ISO would call this the start of a week. BR7 says it is mid-week.
    expect(dayOfWeek('2026-07-20')).toBe(1)
    expect(weekStartFor('2026-07-20')).toBe('2026-07-19')
    expect(weekStartFor('2026-07-20')).not.toBe('2026-07-20')
  })

  it('property: every date lands in a 7-day window starting on a Sunday', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30_000 }), (offset) => {
        const date = addDays('1970-01-01', offset)
        const start = weekStartFor(date)
        expect(dayOfWeek(start)).toBe(0)
        expect(date >= start && date <= weekEndFor(date)).toBe(true)
      }),
    )
  })
})
