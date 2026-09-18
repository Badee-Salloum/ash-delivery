/**
 * How old a pin is, and whether the map may still call it a position.
 *
 * Measured in production on 2026-09-08: the one driver broadcasting had a fix captured at 12:31:59Z
 * that arrived at 13:04:13Z, and the map printed 13:04 beside it. The manager was told, in effect,
 * that he knew where his driver was standing thirty seconds ago. He did not — the fix was half an
 * hour old and the pin was drawn from it anyway.
 *
 * The two timestamps answer different questions and the screen had been showing the wrong one:
 *
 *   receivedAt  — when the OFFICE learned it. Useful for diagnosing a phone; it is not a position.
 *   capturedAt  — when the driver was actually there. This is the only one a map may label a pin.
 *
 * An empty map is silent. A stale map lies, and it lies with the full authority of a system the
 * manager trusts, so the freshness has to be part of the pin rather than a footnote beside it.
 */

/** A fix newer than this is a position. */
export const GPS_FRESH_MS = 90_000

/** Between fresh and this it is a recent position, drawn but visibly qualified. */
export const GPS_RECENT_MS = 10 * 60_000

export type GpsFreshness = 'fresh' | 'recent' | 'stale'

export function gpsFreshness(capturedAtMs: number, nowMs: number): GpsFreshness {
  const age = nowMs - capturedAtMs
  if (age <= GPS_FRESH_MS) return 'fresh'
  if (age <= GPS_RECENT_MS) return 'recent'
  return 'stale'
}

/**
 * Whole minutes since the fix, floored, never negative.
 *
 * A phone clock running ahead of the server would otherwise produce «آخر إشارة قبل ‑٣ دقائق»,
 * which reads as a bug in the console rather than a bug on the phone.
 */
export function gpsAgeMinutes(capturedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - capturedAtMs) / 60_000))
}
