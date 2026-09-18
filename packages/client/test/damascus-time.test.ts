import { describe, expect, it } from 'vitest'
import { damascusParts, formatDateTime } from '../src/index.ts'

/**
 * Every timestamp in this console is the BRANCH's wall clock, never the reader's.
 *
 * The console is used from Damascus, but it is also opened from laptops that are not — and the
 * failure mode is silent. Before this, `formatDateTime` used `getHours()`: a close confirmed at
 * 01:30 Damascus rendered as `22:30` on the PREVIOUS DAY for anyone on UTC, sitting directly
 * beside a business-date column that said otherwise. Nobody would have questioned it; they would
 * have questioned the business date.
 *
 * These tests pass instants that fall on the wrong side of midnight in most other zones, so a
 * regression to local-time getters cannot survive them wherever CI happens to run.
 */
describe('timestamps are the branch’s wall clock, not the reader’s', () => {
  it('reads 01:30 in Damascus as the small hours of that date', () => {
    // 2026-09-07T22:30Z is 2026-09-08 01:30 in Damascus (UTC+3).
    expect(formatDateTime('2026-09-07T22:30:00.000Z', 'ar')).toBe('2026-09-08 01:30')
    // The trap: on a UTC machine the old implementation produced 2026-09-07 22:30 — a different day.
    expect(formatDateTime('2026-09-07T22:30:00.000Z', 'ar')).not.toContain('2026-09-07')
  })

  it('reads an ordinary evening close as the same date', () => {
    // 15:15Z is 18:15 in Damascus — the commonest day-shift close in the data.
    expect(formatDateTime('2026-09-06T15:15:00.000Z', 'en')).toBe('2026-09-06 18:15')
  })

  it('gives both languages the same shape', () => {
    const iso = '2026-09-06T15:15:00.000Z'
    expect(formatDateTime(iso, 'ar')).toBe(formatDateTime(iso, 'en'))
  })

  it('returns the input unchanged when it is not a date at all', () => {
    expect(formatDateTime('not-a-date', 'ar')).toBe('not-a-date')
  })

  it('normalises midnight to 00:00 rather than 24:00', () => {
    // 21:00Z is exactly midnight in Damascus. Some engines format that hour as «24» under
    // `hour12: false`, which would render a timestamp no clock has ever shown.
    expect(damascusParts(new Date('2026-09-06T21:00:00.000Z')).time).toBe('00:00')
    expect(damascusParts(new Date('2026-09-06T21:00:00.000Z')).date).toBe('2026-09-07')
  })

  it('names the weekday, which is how a manager recalls a shift', () => {
    // 2026-09-06 was a Sunday — the first day of the financial week under BR7.
    expect(damascusParts(new Date('2026-09-06T12:00:00.000Z')).weekday).toBe(0)
    expect(damascusParts(new Date('2026-09-07T12:00:00.000Z')).weekday).toBe(1)
  })
})
