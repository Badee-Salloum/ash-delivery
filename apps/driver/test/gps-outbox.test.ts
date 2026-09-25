import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GPS_OUTBOX_MAX,
  GPS_OUTBOX_TTL_MS,
  type QueuedFix,
  dropFixes,
  dropShift,
  enqueueFix,
  fixKey,
  nextFlushBatch,
  outboxSweepPlan,
  peekFixes,
  sweepOutbox,
} from '../src/gps-outbox.ts'

/**
 * The GPS outbox.
 *
 * Measured in production on 2026-09-08: of seven open shifts exactly ONE was broadcasting, and its
 * single stored fix had been captured thirty-two minutes before it arrived. Every failed post was
 * being discarded outright — `.catch(() => undefined)` — so a basement, a lift, or a dead spot
 * between districts was a permanent hole in the trail.
 *
 * These tests are about the POLICY, which is the part that decides whether a trail is honest. The
 * storage itself follows `pending-evidence-storage.ts` and is proved here only in the way that
 * matters operationally: that its absence never stops a driver tracking.
 */

afterEach(async () => {
  vi.unstubAllGlobals()
  await dropShift('memory-test')
})

const fix = (shiftId: string, capturedAtMs: number): QueuedFix => ({
  key: fixKey(shiftId, capturedAtMs),
  shiftId,
  lat: 33.5138,
  lng: 36.2765,
  accuracyM: 10,
  capturedAtMs,
})

describe('what gets sent, and in what order', () => {
  it('flushes in CAPTURE order however the fixes were buffered', () => {
    // The reason the whole pipeline is keyed on capture time. A run flushed out of order would
    // zigzag the route on the map and inflate its measured distance — and that distance is checked
    // against the odometer, so the number ends up under a driver's name.
    const buffered = [fix('s1', 30_000), fix('s1', 10_000), fix('s1', 20_000)]
    expect(nextFlushBatch(buffered, 's1', 10).map((f) => f.capturedAtMs)).toEqual([
      10_000, 20_000, 30_000,
    ])
  })

  it('sends the OLDEST first when there is more than one request can carry', () => {
    // A backlog drains from the front, so a long outage is recovered in order rather than newest
    // first — which would leave a permanent hole at the start of the gap.
    const buffered = [fix('s1', 50), fix('s1', 10), fix('s1', 30), fix('s1', 20)]
    expect(nextFlushBatch(buffered, 's1', 2).map((f) => f.capturedAtMs)).toEqual([10, 20])
  })

  it('never mixes one shift’s fixes into another’s batch', () => {
    // A driver who closes one shift and opens another must not have the first shift's tail posted
    // to the second: the server would accept them, and the trail would start in the wrong place.
    const buffered = [fix('s1', 10), fix('s2', 20), fix('s1', 30)]
    expect(nextFlushBatch(buffered, 's2', 10)).toEqual([fix('s2', 20)])
  })
})

describe('what gets thrown away, and why', () => {
  const now = 1_700_000_000_000

  it('drops a fix too old to be worth a round trip', () => {
    const fresh = fix('s1', now - 60_000)
    const stale = fix('s1', now - GPS_OUTBOX_TTL_MS - 1)
    expect(outboxSweepPlan([fresh, stale], now)).toEqual([stale.key])
  })

  it('keeps the RECENT minutes when the buffer overflows, not the first ones', () => {
    /*
     * The direction matters. A phone that has been out of signal for a day holds more than it can
     * ever send; the minutes worth keeping are the ones nearest now, because a stale position is
     * exactly what the live map must not be handed. Dropping newest-first would leave the map
     * permanently an hour behind.
     */
    const buffered = Array.from({ length: GPS_OUTBOX_MAX + 3 }, (_, i) => fix('s1', now - (GPS_OUTBOX_MAX + 3 - i) * 1_000))
    const dropped = outboxSweepPlan(buffered, now)
    expect(dropped).toHaveLength(3)
    // The three oldest, and nothing else.
    expect(dropped).toEqual([buffered[0]!.key, buffered[1]!.key, buffered[2]!.key])
  })

  it('leaves a buffer inside both bounds completely alone', () => {
    const buffered = [fix('s1', now - 1_000), fix('s1', now - 2_000)]
    expect(outboxSweepPlan(buffered, now)).toEqual([])
  })

  it('counts an expired fix once, even when the buffer is also over the cap', () => {
    // Both rules fire together on a phone that has been offline for days; a key returned twice
    // would make `dropped` lie and, worse, delete a row that a later rule still expected to exist.
    const buffered = [
      ...Array.from({ length: GPS_OUTBOX_MAX + 2 }, (_, i) => fix('s1', now - (i + 1) * 1_000)),
      fix('s1', now - GPS_OUTBOX_TTL_MS - 5_000),
    ]
    const dropped = outboxSweepPlan(buffered, now)
    expect(new Set(dropped).size).toBe(dropped.length)
  })
})

describe('the key is the server’s own natural key', () => {
  it('is stable for one instant, so buffering the same fix twice costs nothing', () => {
    // `(shift_id, captured_at)` is what the ingest route dedupes on. Sharing it means a retry is
    // free at both ends rather than only at the server's.
    expect(fixKey('shift-1', 1_000)).toBe(fixKey('shift-1', 1_000))
    expect(fixKey('shift-1', 1_000)).not.toBe(fixKey('shift-1', 1_001))
    expect(fixKey('shift-1', 1_000)).not.toBe(fixKey('shift-2', 1_000))
  })

  it('escapes the shift id, so an id carrying the separator cannot collide', () => {
    expect(fixKey('a:b', 1)).not.toBe(fixKey('a', Number('b1') || 1))
    expect(fixKey('a:b', 1)).toContain('a%3Ab')
  })
})

describe('a phone with no usable IndexedDB still tracks', () => {
  /*
   * The store is crash survival, never a gate. A private window, a browser with site data blocked,
   * a quota that is already full — in every case the driver must keep working and the manager must
   * keep seeing pins. He simply loses the ability to survive a reload, which is strictly better
   * than not tracking at all.
   */
  it('keeps unsaved fixes in memory until upload acknowledges them', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const capturedAtMs = Date.now()
    await expect(enqueueFix({ shiftId: 'memory-test', lat: 1, lng: 2, accuracyM: 3, capturedAtMs })).resolves.toBeUndefined()
    await expect(peekFixes('memory-test', 10)).resolves.toEqual([
      { key: fixKey('memory-test', capturedAtMs), shiftId: 'memory-test', lat: 1, lng: 2, accuracyM: 3, capturedAtMs },
    ])
    await dropFixes([fixKey('memory-test', capturedAtMs)])
    await expect(peekFixes('memory-test', 10)).resolves.toEqual([])
  })

  it('survives a store that throws on open', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('quota')
      },
    } as unknown as IDBFactory)
    const capturedAtMs = Date.now()
    await enqueueFix({ shiftId: 'memory-test', lat: 1, lng: 2, accuracyM: null, capturedAtMs })
    await expect(peekFixes('memory-test', 10)).resolves.toHaveLength(1)
    await expect(sweepOutbox(capturedAtMs + GPS_OUTBOX_TTL_MS + 1)).resolves.toEqual({ dropped: 1 })
    await expect(peekFixes('memory-test', 10)).resolves.toEqual([])
  })
})
