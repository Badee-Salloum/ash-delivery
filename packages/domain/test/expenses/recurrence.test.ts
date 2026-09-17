import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type RecurrenceSchedule,
  DUE_LOOKAHEAD_DAYS,
  MAX_RECURRENCE_INTERVAL_DAYS,
  OVERDUE_LOOKBACK_DAYS,
  countOccurrencesBetween,
  defaultDueWindow,
  defaultPayDate,
  dueStatus,
  nextOccurrenceOnOrAfter,
  occurrencesBetween,
  payDateInRange,
  recurrenceIssue,
  recurrenceMatches,
} from '../../src/expenses/recurrence.ts'
import { addDays, dayOfWeek, daysBetween, parseCalendarDate } from '../../src/time/civil.ts'

const weekly = (weekday: number, startsOn = '2026-09-01', endsOn: string | null = null): RecurrenceSchedule => ({
  kind: 'weekly',
  startsOn,
  endsOn,
  weekday,
  intervalDays: null,
})
const monthly = (startsOn = '2026-01-15', endsOn: string | null = null): RecurrenceSchedule => ({
  kind: 'monthly_first',
  startsOn,
  endsOn,
  weekday: null,
  intervalDays: null,
})
const everyN = (intervalDays: number, startsOn = '2026-08-22', endsOn: string | null = null): RecurrenceSchedule => ({
  kind: 'every_n_days',
  startsOn,
  endsOn,
  weekday: null,
  intervalDays,
})

/** Any date from 2000 to ~2060, built through the domain's own arithmetic. */
const anyDate = fc.integer({ min: 0, max: 22_000 }).map((offset) => addDays('2000-01-01', offset))

const anySchedule: fc.Arbitrary<RecurrenceSchedule> = fc
  .tuple(
    fc.constantFrom('weekly', 'monthly_first', 'every_n_days'),
    anyDate,
    fc.option(fc.integer({ min: 0, max: 800 }), { nil: null }),
    fc.integer({ min: 0, max: 6 }),
    fc.integer({ min: 1, max: MAX_RECURRENCE_INTERVAL_DAYS }),
  )
  .map(([kind, startsOn, endOffset, weekday, interval]) => ({
    kind,
    startsOn,
    endsOn: endOffset === null ? null : addDays(startsOn, endOffset),
    weekday: kind === 'weekly' ? weekday : null,
    intervalDays: kind === 'every_n_days' ? interval : null,
  }))

/** Brute force: every day in the range the predicate accepts. The reference the fast paths must match. */
const bruteForce = (s: RecurrenceSchedule, from: string, to: string): string[] => {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) if (recurrenceMatches(s, d)) out.push(d)
  return out
}

describe('schedule validation', () => {
  it('accepts the three shapes the owner asked for', () => {
    expect(recurrenceIssue(weekly(3))).toBeNull()
    expect(recurrenceIssue(monthly())).toBeNull()
    expect(recurrenceIssue(everyN(30))).toBeNull()
    expect(recurrenceIssue(everyN(1, '2026-01-01', '2026-01-01'))).toBeNull()
  })

  it('names every malformed shape', () => {
    expect(recurrenceIssue({ ...weekly(3), kind: 'yearly' as never })).toBe('unknown_kind')
    expect(recurrenceIssue({ ...weekly(3), startsOn: '2026-02-30' })).toBe('invalid_starts_on')
    expect(recurrenceIssue({ ...weekly(3), endsOn: 'soon' })).toBe('invalid_ends_on')
    expect(recurrenceIssue(weekly(3, '2026-09-10', '2026-09-09'))).toBe('ends_before_start')
    expect(recurrenceIssue({ ...weekly(3), weekday: null })).toBe('weekday_required')
    expect(recurrenceIssue(weekly(7))).toBe('weekday_out_of_range')
    expect(recurrenceIssue(weekly(-1))).toBe('weekday_out_of_range')
    expect(recurrenceIssue(weekly(2.5))).toBe('weekday_out_of_range')
    expect(recurrenceIssue({ ...monthly(), weekday: 1 })).toBe('weekday_not_allowed')
    expect(recurrenceIssue({ ...everyN(3), intervalDays: null })).toBe('interval_required')
    expect(recurrenceIssue(everyN(0))).toBe('interval_out_of_range')
    expect(recurrenceIssue(everyN(MAX_RECURRENCE_INTERVAL_DAYS + 1))).toBe('interval_out_of_range')
    expect(recurrenceIssue({ ...weekly(1), intervalDays: 7 })).toBe('interval_not_allowed')
  })

  it('refuses to compute over an invalid schedule rather than guessing', () => {
    expect(() => recurrenceMatches(weekly(9), '2026-09-01')).toThrow(RangeError)
    expect(() => nextOccurrenceOnOrAfter(everyN(0), '2026-09-01')).toThrow(RangeError)
    expect(() => occurrencesBetween(monthly('nope'), '2026-09-01', '2026-09-30')).toThrow(RangeError)
  })
})

describe('the mockup’s three examples', () => {
  it('office rent, first of every month', () => {
    // «إيجار المكتب · أول كل شهر» — the next one after 17 September is 1 October.
    const rent = monthly('2026-06-01')
    expect(nextOccurrenceOnOrAfter(rent, '2026-09-17')).toBe('2026-10-01')
    expect(nextOccurrenceOnOrAfter(rent, '2026-09-01')).toBe('2026-09-01')
    expect(occurrencesBetween(rent, '2026-06-17', '2026-09-24')).toEqual(['2026-07-01', '2026-08-01', '2026-09-01'])
  })

  it('a weekly wage on Wednesday', () => {
    // 2026-09-17 is a Thursday in the calendar; the mockup's «الأربعاء» is weekday 3.
    expect(dayOfWeek('2026-09-16')).toBe(3)
    const wage = weekly(3, '2026-09-01')
    expect(occurrencesBetween(wage, '2026-09-01', '2026-09-30')).toEqual([
      '2026-09-02',
      '2026-09-09',
      '2026-09-16',
      '2026-09-23',
      '2026-09-30',
    ])
  })

  it('an internet bundle every 30 days from 22 August', () => {
    const internet = everyN(30, '2026-08-22')
    expect(nextOccurrenceOnOrAfter(internet, '2026-09-17')).toBe('2026-09-21')
    expect(nextOccurrenceOnOrAfter(internet, '2026-01-01')).toBe('2026-08-22')
    expect(recurrenceMatches(internet, '2026-09-21')).toBe(true)
    expect(recurrenceMatches(internet, '2026-09-22')).toBe(false)
  })
})

describe('edges', () => {
  it('never produces a date before the start, even on the right weekday', () => {
    const s = weekly(0, '2026-09-15') // a Tuesday start, Sunday payments
    expect(recurrenceMatches(s, '2026-09-13')).toBe(false)
    expect(nextOccurrenceOnOrAfter(s, '2026-09-01')).toBe('2026-09-20')
  })

  it('stops after the end date, inclusive', () => {
    const s = everyN(10, '2026-01-01', '2026-01-21')
    expect(occurrencesBetween(s, '2025-01-01', '2027-01-01')).toEqual(['2026-01-01', '2026-01-11', '2026-01-21'])
    expect(nextOccurrenceOnOrAfter(s, '2026-01-22')).toBeNull()
    expect(recurrenceMatches(s, '2026-01-31')).toBe(false)
  })

  it('crosses a leap day and a year boundary', () => {
    expect(occurrencesBetween(monthly('2027-12-02'), '2027-12-01', '2028-03-01')).toEqual([
      '2028-01-01',
      '2028-02-01',
      '2028-03-01',
    ])
    expect(occurrencesBetween(everyN(1, '2028-02-28'), '2028-02-28', '2028-03-01')).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ])
  })

  it('returns nothing for an empty or reversed range', () => {
    expect(occurrencesBetween(everyN(1), '2026-09-02', '2026-09-01')).toEqual([])
    expect(countOccurrencesBetween(everyN(1), '2026-09-02', '2026-09-01')).toBe(0)
  })

  it('throws instead of truncating when the caller forgot to bound the range', () => {
    expect(() => occurrencesBetween(everyN(1, '2000-01-01'), '2000-01-01', '2030-01-01', 100)).toThrow(RangeError)
  })
})

describe('properties', () => {
  const range = fc.tuple(anyDate, fc.integer({ min: 0, max: 120 })).map(([from, span]) => ({
    from,
    to: addDays(from, span),
  }))

  it('occurrencesBetween is exactly the brute-force set, in order', () => {
    fc.assert(
      fc.property(anySchedule, range, (s, { from, to }) => {
        expect(occurrencesBetween(s, from, to)).toEqual(bruteForce(s, from, to))
      }),
      { numRuns: 300 },
    )
  })

  it('countOccurrencesBetween agrees with the list it does not build', () => {
    fc.assert(
      fc.property(anySchedule, fc.tuple(anyDate, fc.integer({ min: -5, max: 2_000 })), (s, [from, span]) => {
        const to = addDays(from, span)
        expect(countOccurrencesBetween(s, from, to)).toBe(occurrencesBetween(s, from, to, 10_000).length)
      }),
      { numRuns: 300 },
    )
  })

  it('the next occurrence is the smallest produced date on or after the query', () => {
    fc.assert(
      fc.property(anySchedule, anyDate, (s, date) => {
        const next = nextOccurrenceOnOrAfter(s, date)
        if (next === null) {
          // Nothing is produced from `date` onward — which only an end date can cause.
          expect(s.endsOn).not.toBeNull()
          const probe = date > s.startsOn ? date : s.startsOn
          expect(bruteForce(s, probe, s.endsOn as string)).toEqual([])
          return
        }
        expect(next >= date).toBe(true)
        expect(recurrenceMatches(s, next)).toBe(true)
        // Nothing between the query and the answer. The widest gap is 366 days (the interval cap),
        // plus the distance to the start when the query precedes it.
        const probeFrom = date > s.startsOn ? date : s.startsOn
        expect(bruteForce(s, probeFrom, addDays(next, -1))).toEqual([])
      }),
      { numRuns: 200 },
    )
  })

  it('every produced date has the schedule’s shape and consecutive gaps are exact', () => {
    fc.assert(
      fc.property(anySchedule, range, (s, { from, to }) => {
        const dates = occurrencesBetween(s, from, to)
        for (const d of dates) {
          expect(d >= s.startsOn).toBe(true)
          if (s.endsOn !== null) expect(d <= s.endsOn).toBe(true)
          if (s.kind === 'weekly') expect(dayOfWeek(d)).toBe(s.weekday)
          if (s.kind === 'monthly_first') expect(parseCalendarDate(d).d).toBe(1)
          if (s.kind === 'every_n_days') expect(daysBetween(s.startsOn, d) % (s.intervalDays as number)).toBe(0)
        }
        for (let i = 1; i < dates.length; i++) {
          const gap = daysBetween(dates[i - 1]!, dates[i]!)
          if (s.kind === 'weekly') expect(gap).toBe(7)
          if (s.kind === 'every_n_days') expect(gap).toBe(s.intervalDays)
          if (s.kind === 'monthly_first') expect([28, 29, 30, 31]).toContain(gap)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('dueStatus partitions the calendar around today', () => {
    fc.assert(
      fc.property(anyDate, fc.integer({ min: -400, max: 400 }), (today, offset) => {
        const due = addDays(today, offset)
        const status = dueStatus(due, today)
        if (offset < 0) expect(status).toBe('overdue')
        else if (offset === 0) expect(status).toBe('today')
        else if (offset <= DUE_LOOKAHEAD_DAYS) expect(status).toBe('upcoming')
        else expect(status).toBe('later')
      }),
    )
  })

  it('the default pay date is never in the future and never before the due date', () => {
    fc.assert(
      fc.property(anyDate, fc.integer({ min: -60, max: 0 }), fc.boolean(), (today, offset, open) => {
        const due = addDays(today, offset)
        const paid = defaultPayDate(due, today, () => open)
        expect(payDateInRange(paid, due, today)).toBe(true)
        expect(paid).toBe(open ? due : today)
      }),
    )
  })
})

describe('the due window', () => {
  it('looks back three months and ahead one week', () => {
    expect(OVERDUE_LOOKBACK_DAYS).toBeGreaterThanOrEqual(92)
    expect(defaultDueWindow('2026-09-17')).toEqual({ from: '2026-06-17', to: '2026-09-24' })
  })

  it('buckets the mockup’s items', () => {
    expect(dueStatus('2026-09-01', '2026-09-17')).toBe('overdue')
    expect(dueStatus('2026-09-17', '2026-09-17')).toBe('today')
    expect(dueStatus('2026-09-21', '2026-09-17')).toBe('upcoming')
    expect(dueStatus('2026-09-24', '2026-09-17')).toBe('upcoming')
    expect(dueStatus('2026-09-25', '2026-09-17')).toBe('later')
  })

  it('books a payment on the due day while its week is open, otherwise today', () => {
    const sealed = new Set(['2026-08-30'])
    const open = (d: string) => !sealed.has(addDays(d, -dayOfWeek(d)))
    expect(defaultPayDate('2026-09-01', '2026-09-17', open)).toBe('2026-09-17')
    expect(defaultPayDate('2026-09-14', '2026-09-17', open)).toBe('2026-09-14')
    expect(defaultPayDate('2026-09-18', '2026-09-17', open)).toBe('2026-09-17')
  })

  it('accepts a chosen pay date only between the due date and today', () => {
    expect(payDateInRange('2026-09-01', '2026-09-01', '2026-09-17')).toBe(true)
    expect(payDateInRange('2026-09-17', '2026-09-01', '2026-09-17')).toBe(true)
    expect(payDateInRange('2026-08-31', '2026-09-01', '2026-09-17')).toBe(false)
    expect(payDateInRange('2026-09-18', '2026-09-01', '2026-09-17')).toBe(false)
    expect(payDateInRange('2026-02-30', '2026-02-01', '2026-03-17')).toBe(false)
  })
})
