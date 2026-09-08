import { useEffect, useRef, useState } from 'react'
import { useApp } from './app-context.tsx'
import { dropFixes, dropShift, enqueueFix, peekFixes, sweepOutbox } from './gps-outbox.ts'
import { nativeTrackerAvailable } from './native-tracker.ts'

/**
 * Live GPS beacon (SRS K).
 *
 * Watch the phone's location and send what it sees to the driver's shift. Two things changed after
 * the 2026-09-08 measurement, which found ONE of seven open shifts broadcasting and that one fix
 * thirty-two minutes stale:
 *
 *   - every fix is BUFFERED before it is sent. A failed post used to be discarded outright, so a
 *     basement, a lift or a dead spot between districts was a permanent hole in the trail;
 *   - the buffer is flushed as a BATCH, which is what the server now accepts. One request carrying
 *     four fixes costs the API a fraction of four requests carrying one.
 *
 * WHAT THIS STILL CANNOT DO. The web platform stops `watchPosition` the moment the app is
 * backgrounded or the screen locks, and geolocation is not available to a service worker at all.
 * The Screen Wake Lock below is a mitigation, not a fix: it keeps the beacon alive while the driver
 * is actually looking at the app. Permanent, screen-off tracking is the Android foreground
 * service's job, and when it is running this hook stands down — see `nativeCaptureActive`.
 *
 * Permission-denied stays silent: the driver keeps working and the manager just doesn't see a pin.
 * `Date.now()`/`pos.timestamp` are fine here — the ban on wall-clock reads is the pure domain's,
 * not the driver app's; the server stamps its own `received_at` regardless.
 */

const INTERVAL_MS = 15_000

/** One request may carry this many buffered fixes — the server's own cap on a batch. */
const FLUSH_MAX = 500

export function useGpsBeacon(shiftId: string | null): { tracking: boolean } {
  const { api } = useApp()
  const [tracking, setTracking] = useState(false)
  const latest = useRef<GeolocationPosition | null>(null)
  const flushing = useRef(false)

  useEffect(() => {
    if (shiftId === null) return
    if (typeof navigator === 'undefined' || !navigator.geolocation) return
    // The Android shell captures and uploads from a foreground service that outlives this
    // WebView. Two layers writing the same shift would double the battery cost of a ride to
    // produce rows the server then discards on `(shift_id, captured_at)`.
    if (nativeTrackerAvailable()) return
    let stopped = false
    let wakeLock: WakeLockSentinel | null = null

    const requestWake = async (): Promise<void> => {
      try {
        // `wakeLock` may be absent on older browsers — optional-chain the runtime access.
        wakeLock = (await navigator.wakeLock?.request('screen')) ?? null
      } catch {
        /* unsupported or denied — tracking still works while the screen stays on */
      }
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        latest.current = pos
        setTracking(true)
      },
      () => setTracking(false),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    )
    void requestWake()
    void sweepOutbox(Date.now())

    /**
     * Buffer the newest fix, then send everything buffered for this shift.
     *
     * The order matters: the fix is durable BEFORE the network is touched, so a request that dies
     * mid-flight costs nothing. Fixes are deleted only once the server has acknowledged them.
     */
    const flush = async (): Promise<void> => {
      if (stopped || flushing.current) return
      flushing.current = true
      try {
        const pos = latest.current
        if (pos) {
          latest.current = null
          await enqueueFix({
            shiftId,
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyM: pos.coords.accuracy ?? null,
            capturedAtMs: pos.timestamp,
          })
        }

        const pending = await peekFixes(shiftId, FLUSH_MAX)
        if (pending.length === 0) return
        try {
          await api.sendGpsBatch(shiftId, {
            source: 'phone_fg',
            fixes: pending.map((fix) => ({
              lat: fix.lat,
              lng: fix.lng,
              accuracyM: fix.accuracyM,
              capturedAtMs: fix.capturedAtMs,
            })),
          })
          await dropFixes(pending.map((fix) => fix.key))
        } catch (err) {
          /*
           * THE CONTRACT, and getting it backwards is the expensive mistake.
           *
           * 409 means the shift is over — the server will never accept these fixes, so they are
           * dropped and the beacon stops. Anything else (offline, 5xx, a timeout) means "not yet":
           * the buffer is kept and the next tick tries again. Treat a 409 as retryable and a phone
           * hammers a closed shift every fifteen seconds for weeks with nobody watching.
           */
          if ((err as { status?: number }).status === 409) {
            await dropShift(shiftId)
            stopped = true
            setTracking(false)
          }
        }
      } catch {
        /* the buffer is intact; the next tick tries again */
      } finally {
        flushing.current = false
      }
    }

    const timer = setInterval(() => void flush(), INTERVAL_MS)

    // The wake lock drops when the app is backgrounded; re-take it when the driver returns — and
    // flush immediately, because the minutes he was away are exactly what the buffer is holding.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void requestWake()
        void flush()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    // A phone that regains signal should not wait out the interval to say where it has been.
    const onOnline = (): void => void flush()
    window.addEventListener('online', onOnline)

    return () => {
      stopped = true
      navigator.geolocation.clearWatch(watchId)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      void wakeLock?.release?.().catch(() => undefined)
    }
  }, [api, shiftId])

  return { tracking }
}
