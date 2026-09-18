import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { GPS_FRESH_MS, GPS_RECENT_MS, gpsAgeMinutes, gpsFreshness } from './gps-freshness.ts'

const screenSource = readFileSync(new URL('./screens/GpsLive.tsx', import.meta.url), 'utf8')

/**
 * A stale map lies, and it lies with the authority of a system the manager trusts.
 *
 * Measured in production on 2026-09-08: the one driver broadcasting had a fix captured at 12:31:59Z
 * that reached the server at 13:04:13Z — and the screen printed 13:04 beside his pin. Sampled again
 * four minutes later it was byte-identical, so the pin was not merely late; it was frozen, and the
 * console was presenting it as a current position.
 */
describe('a pin is labelled with when the driver was there, not when we heard', () => {
  const now = 1_700_000_000_000

  it('calls a just-taken fix fresh, and a half-hour-old one stale', () => {
    expect(gpsFreshness(now - 5_000, now)).toBe('fresh')
    expect(gpsFreshness(now - 32 * 60_000, now)).toBe('stale') // the measured case
  })

  it('is exact at both boundaries — a rule that is nearly exact is one people argue about', () => {
    expect(gpsFreshness(now - GPS_FRESH_MS, now)).toBe('fresh')
    expect(gpsFreshness(now - GPS_FRESH_MS - 1, now)).toBe('recent')
    expect(gpsFreshness(now - GPS_RECENT_MS, now)).toBe('recent')
    expect(gpsFreshness(now - GPS_RECENT_MS - 1, now)).toBe('stale')
  })

  it('never reports a negative age from a phone whose clock runs ahead', () => {
    // Otherwise the console shows «قبل ‑٣ دقائق», which reads as a bug in the office rather than
    // on the handset — and the office is the one place the reader trusts.
    expect(gpsAgeMinutes(now + 3 * 60_000, now)).toBe(0)
    expect(gpsFreshness(now + 3 * 60_000, now)).toBe('fresh')
  })

  it('floors the age, so a fix is never aged up into a worse category', () => {
    expect(gpsAgeMinutes(now - 119_000, now)).toBe(1)
    expect(gpsAgeMinutes(now - 120_000, now)).toBe(2)
  })
})

describe('the screen reads the capture time everywhere it draws one', () => {
  it('labels the pin and the row from capturedAt, never receivedAt', () => {
    /*
     * The assertion is negative on purpose. `receivedAt` is still on the wire and still useful for
     * diagnosing a phone — it just may never be what a position is labelled with, and a positive
     * test would pass with both present.
     */
    expect(screenSource).toContain('Date.parse(d.capturedAt)')
    expect(screenSource).toContain('new Date(d.capturedAt).toLocaleTimeString()')
    expect(screenSource).not.toContain('d.receivedAt')
  })

  it('says the age in words, in both languages', () => {
    expect(screenSource).toContain('t.gpsLive.lastSeen')
    expect(ar.gpsLive.lastSeen).toContain('{n}')
    expect(en.gpsLive.lastSeen).toContain('{n}')
  })
})
