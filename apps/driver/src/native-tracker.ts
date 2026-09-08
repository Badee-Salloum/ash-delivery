/**
 * The web side of the Android tracker, and the only place that knows the shell exists.
 *
 * The same deployed web app runs in three places: a phone browser, an installed PWA, and the
 * Android shell. Only the third has a native tracker, so every access is guarded and the absence of
 * the plugin is the ordinary case rather than an error.
 *
 * The bridge is deliberately one-way for data: fixes never travel through JavaScript. The native
 * service uploads them itself, because a plugin that hands positions to a callback is only as alive
 * as the WebView — and the WebView being asleep is the entire problem the shell exists to solve.
 * So all this module does is say WHICH SHIFT IS LIVE, which the screen already knows.
 */

interface AshTrackerPlugin {
  start(options: { shiftId: string; origin: string }): Promise<{ started: boolean; reason?: string }>
  stop(): Promise<void>
  status(): Promise<{ available: boolean; permission: boolean }>
}

interface CapacitorGlobal {
  Capacitor?: { Plugins?: { AshTracker?: AshTrackerPlugin } }
}

function plugin(): AshTrackerPlugin | null {
  try {
    return (globalThis as CapacitorGlobal).Capacitor?.Plugins?.AshTracker ?? null
  } catch {
    return null
  }
}

/**
 * Whether a native capture layer exists in this runtime.
 *
 * The web beacon reads this to stand down. Two layers writing the same shift would double the
 * battery cost of a ride to produce rows the server then discards on `(shift_id, captured_at)`.
 */
export function nativeTrackerAvailable(): boolean {
  return plugin() !== null
}

/**
 * State what should be true: this shift is being tracked, or nothing is.
 *
 * Safe to call on every poll tick. `startForegroundService` on an already-running service just
 * re-delivers the intent, so the caller states the desired state rather than tracking what it has
 * already asked for — which is what keeps the screen's side of this to two lines.
 *
 * Failures are swallowed on purpose. A driver mid-ride cannot act on «the tracker did not start»,
 * and the shift itself must never be blocked by telemetry; the manager simply sees no pin, and the
 * coverage figure on the finished shift is where that shows up honestly.
 */
export async function syncNativeTracking(shiftId: string | null): Promise<void> {
  const tracker = plugin()
  if (!tracker) return
  try {
    if (shiftId === null) await tracker.stop()
    else await tracker.start({ shiftId, origin: globalThis.location?.origin ?? '' })
  } catch {
    /* the web beacon is still running; see `use-gps-beacon.ts` */
  }
}
