import { useEffect, useRef, useState } from 'react'
import { useApp } from './app-context.tsx'

/**
 * Live GPS beacon (SRS K), foreground-only.
 *
 * While mounted, watch the phone's location and POST the latest fix every 15 s to the driver's open
 * shift. A PWA cannot track in the background — the moment the app is backgrounded or the screen
 * locks, `watchPosition` stops — so we hold a Screen Wake Lock to keep it alive while the driver is
 * using the app, and re-take it when he returns to the tab. Permission-denied is silent: the driver
 * keeps working, the manager just doesn't see a pin.
 *
 * Mount this from a component that only exists while the shift is open, so mount/unmount is
 * start/stop. `Date.now()`/`pos.timestamp` are fine here — the ban on wall-clock reads is the pure
 * domain's, not the driver app's; the server stamps its own `received_at` regardless.
 */

const INTERVAL_MS = 15_000

export function useGpsBeacon(shiftId: string): { tracking: boolean } {
  const { api } = useApp()
  const [tracking, setTracking] = useState(false)
  const latest = useRef<GeolocationPosition | null>(null)

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return
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

    const send = (): void => {
      const pos = latest.current
      if (!pos) return
      void api
        .sendGps(shiftId, {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy ?? null,
          capturedAtMs: pos.timestamp,
        })
        .catch(() => undefined)
    }
    const timer = setInterval(send, INTERVAL_MS)

    // The wake lock drops when the app is backgrounded; re-take it when the driver returns.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void requestWake()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      navigator.geolocation.clearWatch(watchId)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      void wakeLock?.release?.().catch(() => undefined)
    }
  }, [api, shiftId])

  return { tracking }
}
