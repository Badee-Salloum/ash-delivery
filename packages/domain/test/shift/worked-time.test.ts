import { describe, expect, it } from 'vitest'
import {
  ABANDONED_AFTER_MINUTES,
  DAMASCUS_OFFSET_MINUTES,
  shortfallMinutes,
  workedTime,
} from '../../src/index.ts'

/**
 * Damascus local time as an epoch. The domain never touches a timezone database, so the tests
 * build their instants the same way the adapter does: a UTC instant minus the injected offset.
 */
function damascus(date: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return Date.parse(`${date}T00:00:00.000Z`) + (h! * 60 + m! - DAMASCUS_OFFSET_MINUTES) * 60_000
}

describe('which of the three patterns a shift was', () => {
  /*
   * The patterns are not a taxonomy invented for the screen — they are what 155 production shifts
   * actually are. The start hour is bimodal with an almost empty gap from 15:00 to 17:00, and the
   * two clusters have visibly different lengths (day 7.40 h, evening 7.25 h, full 13.03 h).
   */

  it('reads the fleet’s three real patterns', () => {
    // The ordinary day shift: the single commonest shape in the data.
    expect(workedTime(damascus('2026-09-06', '11:00'), damascus('2026-09-06', '18:15')).pattern).toBe('day')
    // The evening shift, which crosses midnight and lands on the next calendar date.
    expect(workedTime(damascus('2026-09-06', '18:34'), damascus('2026-09-07', '01:29')).pattern).toBe('evening')
    // The full shift: noon to after midnight, fifteen times over in the measured window.
    expect(workedTime(damascus('2026-09-06', '12:22'), damascus('2026-09-07', '01:25')).pattern).toBe('full')
  })

  it('splits day from evening exactly at 15:00', () => {
    // The boundary is the middle of a measured three-hour gap, so a minute either side of it is
    // not a real case — but the rule must still be exact, because a rule that is nearly exact is
    // one somebody will argue about.
    expect(workedTime(damascus('2026-09-06', '14:59'), damascus('2026-09-06', '21:00')).pattern).toBe('day')
    expect(workedTime(damascus('2026-09-06', '15:00'), damascus('2026-09-06', '21:00')).pattern).toBe('evening')
  })

  it('does not call a SHORT morning shift a double', () => {
    /*
     * The bug this pins. The rule demanded an end at or after 15:00 to be a day shift, so an
     * ordinary 08:00 -> 14:00 fell through to `full`, took the sixteen-hour target, and was
     * presented as ten hours short under a driver's name. Six hours of work, read as dereliction.
     */
    expect(workedTime(damascus('2026-09-06', '08:00'), damascus('2026-09-06', '14:00')).pattern).toBe('day')
    expect(workedTime(damascus('2026-09-06', '06:00'), damascus('2026-09-06', '11:00')).pattern).toBe('day')
    // …including one that ends in the small hours of its OWN day, which is a very short shift and
    // still not a double.
    expect(workedTime(damascus('2026-09-06', '05:00'), damascus('2026-09-06', '07:30')).pattern).toBe('day')
  })

  it('separates the two slots by the day he came back on, not by a duration', () => {
    // The second half of the same bug: `minutes <= DAY_END_LIMIT_MINUTES` compared a DURATION
    // against a MINUTE-OF-DAY. Crossing midnight is what makes a morning start a double.
    expect(workedTime(damascus('2026-09-06', '12:00'), damascus('2026-09-07', '00:01')).pattern).toBe('full')
    expect(workedTime(damascus('2026-09-06', '12:00'), damascus('2026-09-06', '23:59')).pattern).toBe('full')
  })

  it('calls a morning start that ran past 22:00 a full shift, not a long day', () => {
    // This is the distinction the whole feature turns on. Both start in the morning; only the end
    // says whether the driver covered one slot or two, which is also why a live shift cannot be
    // classified.
    expect(workedTime(damascus('2026-09-06', '12:00'), damascus('2026-09-06', '21:59')).pattern).toBe('day')
    expect(workedTime(damascus('2026-09-06', '12:00'), damascus('2026-09-06', '22:01')).pattern).toBe('full')
  })

  it('treats a return in the small hours as the far side of a full shift', () => {
    expect(workedTime(damascus('2026-09-06', '12:00'), damascus('2026-09-07', '01:00')).pattern).toBe('full')
  })
})

describe('a shift that has not ended yet', () => {
  it('refuses to guess a morning start’s pattern', () => {
    // A 12:00 start is a day shift or a full one and nothing at 12:00 can tell them apart. Guessing
    // `day` would mean the badge silently changed at midnight, which is worse than saying nothing.
    const live = workedTime(damascus('2026-09-07', '12:00'), null)
    expect(live).toEqual({ minutes: null, pattern: 'unknown', abandoned: false })
  })

  it('but an evening start is already unambiguous', () => {
    // Nothing an evening shift can still become is a day shift, so the badge is safe immediately.
    expect(workedTime(damascus('2026-09-07', '19:00'), null).pattern).toBe('evening')
  })

  it('has no pattern and no duration without a start', () => {
    expect(workedTime(null, null)).toEqual({ minutes: null, pattern: 'unknown', abandoned: false })
    expect(workedTime(null, damascus('2026-09-07', '19:00')).minutes).toBeNull()
  })
})

describe('a close package nobody sent', () => {
  /*
   * Six of 113 measured shifts ran past sixteen hours, the longest 24.64. Every genuine full shift
   * measured came in under 14.5. There is nothing in between, which is what makes the threshold
   * safe: these are forgotten close packages, and reading them as devotion — or averaging them
   * into anyone's hours — would corrupt the only number on the screen.
   */
  it('marks an impossibly long shift as abandoned rather than as diligence', () => {
    const forgotten = workedTime(damascus('2026-09-06', '12:56'), damascus('2026-09-07', '10:56'))
    expect(forgotten.minutes).toBe(22 * 60)
    expect(forgotten.abandoned).toBe(true)
  })

  it('leaves a genuine full shift alone', () => {
    const real = workedTime(damascus('2026-09-06', '12:22'), damascus('2026-09-07', '01:25'))
    expect(real.minutes).toBe(13 * 60 + 3)
    expect(real.abandoned).toBe(false)
    expect(real.minutes!).toBeLessThan(ABANDONED_AFTER_MINUTES)
  })
})

describe('how far short of the target', () => {
  it('measures the gap, and reports nothing when the target was met', () => {
    const short = workedTime(damascus('2026-09-06', '11:18'), damascus('2026-09-06', '18:04'))
    // 6 h 46 m against an eight-hour target.
    expect(shortfallMinutes(short, 8 * 60)).toBe(74)
    const met = workedTime(damascus('2026-09-06', '10:40'), damascus('2026-09-06', '18:50'))
    expect(shortfallMinutes(met, 8 * 60)).toBe(0)
  })

  it('judges nothing it cannot judge honestly', () => {
    // A live shift has no duration; an abandoned one has a meaningless duration. Reporting a
    // shortfall for either would put a driver's name under a number that is really about paperwork.
    expect(shortfallMinutes(workedTime(damascus('2026-09-07', '12:00'), null), 8 * 60)).toBeNull()
    const forgotten = workedTime(damascus('2026-09-06', '12:56'), damascus('2026-09-07', '10:56'))
    expect(shortfallMinutes(forgotten, 8 * 60)).toBeNull()
  })

  it('applies each pattern’s own target, which is why a full shift is not a hero', () => {
    // The measured full shift is 13.03 h. Against a single slot's eight hours it looks like five
    // hours of overtime; against the two slots it actually covers it is three hours short. The
    // target is per pattern precisely so the screen cannot tell the first story.
    const full = workedTime(damascus('2026-09-06', '12:22'), damascus('2026-09-07', '01:25'))
    expect(shortfallMinutes(full, 8 * 60)).toBe(0)
    expect(shortfallMinutes(full, 16 * 60)).toBe(177)
  })
})
