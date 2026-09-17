import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ABANDONED_AFTER_MINUTES,
  DAMASCUS_OFFSET_MINUTES,
  DOUBLE_SHIFT_MIN_MINUTES,
  EVENING_START_MINUTES,
  OWNER_SHIFT_HOURS,
  SHIFT_TARGET_MINUTES,
  SLOT_SPLIT_MINUTES,
  shiftTargetMinutes,
  shortfallMinutes,
  slotOfStart,
  workedTime,
} from '../../src/index.ts'
import * as domain from '../../src/index.ts'

/**
 * Damascus local time as an epoch. The domain never touches a timezone database, so the tests
 * build their instants the same way the adapter does: a UTC instant minus the injected offset.
 */
function damascus(date: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return Date.parse(`${date}T00:00:00.000Z`) + (h! * 60 + m! - DAMASCUS_OFFSET_MINUTES) * 60_000
}

const pattern = (start: [string, string], end: [string, string]): string =>
  workedTime(damascus(...start), damascus(...end)).pattern

describe('the owner’s schedule (2026-09-17): morning 09–17, evening 18–02, double 12 h', () => {
  it('reads the three published shapes', () => {
    expect(pattern(['2026-09-06', '09:00'], ['2026-09-06', '17:00'])).toBe('day')
    // The evening slot crosses midnight and lands on the next calendar date.
    expect(pattern(['2026-09-06', '18:00'], ['2026-09-07', '02:00'])).toBe('evening')
    // THE BUG THIS REWRITE FIXES. A 09:00 → 21:00 double came back the same day before 22:00, so
    // the old boundaries read twelve hours of work as one long morning.
    expect(pattern(['2026-09-06', '09:00'], ['2026-09-06', '21:00'])).toBe('full')
  })

  it('makes a double of any closed shift of ten hours or more, and of nothing shorter', () => {
    // 599 minutes: one slot worked long. 600: a double worked short.
    expect(pattern(['2026-09-06', '11:00'], ['2026-09-06', '20:59'])).toBe('day')
    expect(pattern(['2026-09-06', '11:00'], ['2026-09-06', '21:00'])).toBe('full')
    // The start time does not matter once the length is there — an evening start can be a double.
    expect(pattern(['2026-09-06', '15:00'], ['2026-09-07', '03:00'])).toBe('full')
    expect(pattern(['2026-09-06', '18:00'], ['2026-09-07', '04:00'])).toBe('full')
    // …nor the calendar. Crossing midnight used to make a morning start a double on its own; now a
    // 14:30 → 00:15 (9 h 45 m) is one morning-slot shift, and 12:22 → 01:25 (13 h) is still a double.
    expect(pattern(['2026-09-06', '14:30'], ['2026-09-07', '00:15'])).toBe('day')
    expect(pattern(['2026-09-06', '12:22'], ['2026-09-07', '01:25'])).toBe('full')
    expect(DOUBLE_SHIFT_MIN_MINUTES).toBe(600)
  })

  it('keeps the slot as the pattern for anything under ten hours', () => {
    expect(pattern(['2026-09-06', '11:00'], ['2026-09-06', '18:15'])).toBe('day')
    expect(pattern(['2026-09-06', '18:34'], ['2026-09-07', '01:29'])).toBe('evening')
    // A short morning is still one slot — never promoted to a double for its end time.
    expect(pattern(['2026-09-06', '08:00'], ['2026-09-06', '14:00'])).toBe('day')
    expect(pattern(['2026-09-06', '05:00'], ['2026-09-06', '07:30'])).toBe('day')
    // Ending late is not what makes a double; length is. 14:59 → 23:00 is eight hours of morning slot.
    expect(pattern(['2026-09-06', '14:59'], ['2026-09-06', '23:00'])).toBe('day')
  })
})

describe('which slot a start belongs to', () => {
  it('splits morning from evening exactly at 15:00', () => {
    expect(slotOfStart(damascus('2026-09-06', '14:59'))).toBe('day')
    expect(slotOfStart(damascus('2026-09-06', '15:00'))).toBe('evening')
    expect(pattern(['2026-09-06', '14:59'], ['2026-09-06', '21:00'])).toBe('day')
    expect(pattern(['2026-09-06', '15:00'], ['2026-09-06', '21:00'])).toBe('evening')
    expect(SLOT_SPLIT_MINUTES).toBe(900)
    expect(EVENING_START_MINUTES).toBe(SLOT_SPLIT_MINUTES)
  })

  it('counts a start in the small hours as the evening of the business day it belongs to', () => {
    // The business day runs 04:00 → 04:00, so 02:00 is the tail of an evening, not a morning.
    expect(slotOfStart(damascus('2026-09-07', '02:00'))).toBe('evening')
    expect(slotOfStart(damascus('2026-09-07', '00:00'))).toBe('evening')
    expect(slotOfStart(damascus('2026-09-07', '03:59'))).toBe('evening')
    expect(pattern(['2026-09-07', '02:00'], ['2026-09-07', '06:00'])).toBe('evening')
    // …and the business day turns at 04:00.
    expect(slotOfStart(damascus('2026-09-07', '04:00'))).toBe('day')
    expect(slotOfStart(damascus('2026-09-07', '05:00'))).toBe('day')
    expect(pattern(['2026-09-07', '05:00'], ['2026-09-07', '12:00'])).toBe('day')
  })

  it('takes the offset and the day start as values', () => {
    // With the day starting at midnight the small hours are simply before 15:00.
    const twoAm = damascus('2026-09-07', '02:00')
    expect(slotOfStart(twoAm, DAMASCUS_OFFSET_MINUTES, 0)).toBe('day')
    expect(workedTime(twoAm, null, DAMASCUS_OFFSET_MINUTES, 0).slot).toBe('day')
    // A pre-2022 winter row at UTC+2: the same instant is an hour earlier on the local clock.
    const fifteenHundredAtUtc3 = damascus('2026-09-06', '15:00')
    expect(slotOfStart(fifteenHundredAtUtc3, 120)).toBe('day')
    expect(slotOfStart(fifteenHundredAtUtc3, 180)).toBe('evening')
  })

  it('handles instants before 1970 without flipping the day', () => {
    const start = Date.parse('1969-12-31T13:00:00.000Z') // 16:00 at UTC+3
    expect(slotOfStart(start)).toBe('evening')
    expect(slotOfStart(Date.parse('1969-12-31T06:00:00.000Z'))).toBe('day') // 09:00
  })

  it('publishes the owner’s hours for display, and nothing classifies against them', () => {
    expect(OWNER_SHIFT_HOURS).toEqual({ day: { start: 540, end: 1020 }, evening: { start: 1080, end: 120 } })
    expect(Object.isFrozen(OWNER_SHIFT_HOURS)).toBe(true)
    expect(Object.isFrozen(OWNER_SHIFT_HOURS.day)).toBe(true)
    // A 10:30 start is still the morning slot, not "late".
    expect(slotOfStart(damascus('2026-09-06', '10:30'))).toBe('day')
  })

  it('no longer exports the old «came back before 22:00» limit', () => {
    expect('DAY_END_LIMIT_MINUTES' in domain).toBe(false)
  })
})

describe('a shift that has not ended yet', () => {
  it('knows its slot but not its pattern — morning', () => {
    // A 09:00 start is a morning or a double and nothing at 09:00 can tell them apart.
    expect(workedTime(damascus('2026-09-07', '09:00'), null)).toEqual({
      minutes: null,
      pattern: 'unknown',
      slot: 'day',
      abandoned: false,
    })
  })

  it('knows its slot but not its pattern — evening, which can also still become a double', () => {
    expect(workedTime(damascus('2026-09-07', '19:00'), null)).toEqual({
      minutes: null,
      pattern: 'unknown',
      slot: 'evening',
      abandoned: false,
    })
  })

  it('has no pattern, no slot and no duration without a start', () => {
    expect(workedTime(null, null)).toEqual({ minutes: null, pattern: 'unknown', slot: null, abandoned: false })
    expect(workedTime(null, damascus('2026-09-07', '19:00'))).toEqual({
      minutes: null,
      pattern: 'unknown',
      slot: null,
      abandoned: false,
    })
  })
})

describe('a close package nobody sent', () => {
  /*
   * Six of 113 measured shifts ran past sixteen hours, the longest 24.64. Every genuine double
   * measured came in under 14.5. There is nothing in between, which is what makes the threshold
   * safe: these are forgotten close packages, and reading them as devotion — or averaging them
   * into anyone's hours — would corrupt the only number on the screen.
   */
  it('marks a 22-hour shift abandoned, keeps its slot as its pattern, and judges nothing', () => {
    const forgotten = workedTime(damascus('2026-09-06', '12:56'), damascus('2026-09-07', '10:56'))
    expect(forgotten).toEqual({ minutes: 22 * 60, pattern: 'day', slot: 'day', abandoned: true })
    expect(shortfallMinutes(forgotten)).toBeNull()
    expect(shortfallMinutes(forgotten, 8 * 60)).toBeNull()

    const eveningForgotten = workedTime(damascus('2026-09-06', '19:00'), damascus('2026-09-07', '19:00'))
    expect(eveningForgotten).toEqual({ minutes: 24 * 60, pattern: 'evening', slot: 'evening', abandoned: true })
  })

  it('draws the line after sixteen hours exactly', () => {
    const sixteen = workedTime(damascus('2026-09-06', '09:00'), damascus('2026-09-07', '01:00'))
    expect(sixteen).toMatchObject({ minutes: ABANDONED_AFTER_MINUTES, pattern: 'full', abandoned: false })
    const past = workedTime(damascus('2026-09-06', '09:00'), damascus('2026-09-07', '01:01'))
    expect(past).toMatchObject({ pattern: 'day', abandoned: true })
  })

  it('leaves a genuine double alone', () => {
    const real = workedTime(damascus('2026-09-06', '12:22'), damascus('2026-09-07', '01:25'))
    expect(real.minutes).toBe(13 * 60 + 3)
    expect(real.abandoned).toBe(false)
    expect(real.minutes!).toBeLessThan(ABANDONED_AFTER_MINUTES)
  })
})

describe('targets and how far short', () => {
  it('holds a morning and an evening to eight hours and a double to twelve', () => {
    expect(SHIFT_TARGET_MINUTES).toEqual({ day: 480, evening: 480, full: 720, unknown: null })
    expect(Object.isFrozen(SHIFT_TARGET_MINUTES)).toBe(true)
    expect(shiftTargetMinutes('day')).toBe(480)
    expect(shiftTargetMinutes('evening')).toBe(480)
    expect(shiftTargetMinutes('full')).toBe(720)
    expect(shiftTargetMinutes('unknown')).toBeNull()
  })

  it('measures the gap against the pattern’s own target by default', () => {
    const short = workedTime(damascus('2026-09-06', '11:18'), damascus('2026-09-06', '18:04'))
    // 6 h 46 m against an eight-hour target.
    expect(shortfallMinutes(short)).toBe(74)
    const met = workedTime(damascus('2026-09-06', '10:40'), damascus('2026-09-06', '18:50'))
    expect(shortfallMinutes(met)).toBe(0)
    // A double worked short is a double, judged against twelve: 10 h 30 m is ninety minutes short,
    // not two and a half hours of overtime against one slot.
    const shortDouble = workedTime(damascus('2026-09-06', '09:00'), damascus('2026-09-06', '19:30'))
    expect(shortDouble.pattern).toBe('full')
    expect(shortfallMinutes(shortDouble)).toBe(90)
    const fullDouble = workedTime(damascus('2026-09-06', '09:00'), damascus('2026-09-06', '21:00'))
    expect(shortfallMinutes(fullDouble)).toBe(0)
  })

  it('still accepts an explicit target', () => {
    const full = workedTime(damascus('2026-09-06', '12:22'), damascus('2026-09-07', '01:25'))
    expect(shortfallMinutes(full)).toBe(0)
    expect(shortfallMinutes(full, 16 * 60)).toBe(177)
    expect(shortfallMinutes(full, null)).toBeNull()
  })

  it('judges nothing it cannot judge honestly', () => {
    // A live shift has no duration; an abandoned one has a meaningless duration. Reporting a
    // shortfall for either would put a driver's name under a number that is really about paperwork.
    expect(shortfallMinutes(workedTime(damascus('2026-09-07', '09:00'), null))).toBeNull()
    expect(shortfallMinutes(workedTime(damascus('2026-09-07', '19:00'), null), 8 * 60)).toBeNull()
    expect(shortfallMinutes(workedTime(null, null))).toBeNull()
    // A row from an API that predates `slot` is still judged.
    expect(shortfallMinutes({ minutes: 400, pattern: 'evening', abandoned: false })).toBe(80)
  })
})

describe('properties', () => {
  // 2000-01-01 … 2040-01-01, any millisecond; durations up to 30 hours, any millisecond.
  const instant = fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2040, 0, 1) })
  const duration = fc.integer({ min: 0, max: 30 * 3_600_000 })

  it('a closed, non-abandoned shift is a double exactly when it ran ten hours or more', () => {
    fc.assert(
      fc.property(instant, duration, (start, length) => {
        const worked = workedTime(start, start + length)
        expect(worked.minutes).not.toBeNull()
        expect(worked.slot).not.toBeNull()
        if (worked.abandoned) {
          // A forgotten close is never promoted to a double and never judged.
          expect(worked.minutes!).toBeGreaterThan(ABANDONED_AFTER_MINUTES)
          expect(worked.pattern).toBe(worked.slot)
          expect(shortfallMinutes(worked)).toBeNull()
          return
        }
        expect(['day', 'evening', 'full']).toContain(worked.pattern)
        expect(worked.minutes! >= DOUBLE_SHIFT_MIN_MINUTES).toBe(worked.pattern === 'full')
        if (worked.pattern !== 'full') expect(worked.pattern).toBe(worked.slot)
        const short = shortfallMinutes(worked)
        expect(short).toBe(Math.max(0, SHIFT_TARGET_MINUTES[worked.pattern]! - worked.minutes!))
      }),
    )
  })

  it('a live shift is always `unknown`, with the slot its start says', () => {
    fc.assert(
      fc.property(instant, (start) => {
        const worked = workedTime(start, null)
        expect(worked).toEqual({ minutes: null, pattern: 'unknown', slot: slotOfStart(start), abandoned: false })
        expect(shortfallMinutes(worked)).toBeNull()
      }),
    )
  })

  it('the slot is evening exactly for local starts from 15:00 to 03:59', () => {
    fc.assert(
      fc.property(instant, (start) => {
        // An independent oracle: the UTC clock of the shifted instant is the local clock.
        const local = new Date(start + DAMASCUS_OFFSET_MINUTES * 60_000)
        const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
        const evening = minute >= 15 * 60 || minute < 4 * 60
        expect(slotOfStart(start)).toBe(evening ? 'evening' : 'day')
      }),
    )
  })
})
