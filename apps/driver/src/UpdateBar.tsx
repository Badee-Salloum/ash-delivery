import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from './app-context.tsx'

/**
 * The "new version" bar the PWA config has always promised.
 *
 * `vite.config.ts` uses `registerType: 'prompt'` precisely so a money app never silently swaps its
 * code mid-shift — and the comment there says the app shows an Arabic bar instead. It did not:
 * nothing in the app ever looked at the service worker. So a new worker installed, sat in
 * `waiting`, and a driver with the app open kept running the old bundle indefinitely, with no way
 * to know and no way to act. That is the failure mode `prompt` was chosen to avoid.
 *
 * Deliberately the plain `navigator.serviceWorker` API rather than `virtual:pwa-register`: this
 * package builds with `"types": []`, and a build-time virtual module would need ambient
 * declarations to earn its keep. The generated worker already answers `SKIP_WAITING`.
 */
export function UpdateBar(): ReactNode {
  const { t } = useApp()
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    let cancelled = false

    const watch = (registration: ServiceWorkerRegistration): void => {
      // Already waiting when the app opened — the common case for a driver who closed it earlier.
      if (registration.waiting) setWaiting(registration.waiting)

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          // `controller` distinguishes an UPDATE from the very first install. On a first install
          // there is nothing to interrupt and nothing worth telling the driver about.
          if (installing.state === 'installed' && navigator.serviceWorker.controller && !cancelled) {
            setWaiting(installing)
          }
        })
      })
    }

    void navigator.serviceWorker.getRegistration().then((registration) => {
      if (!registration || cancelled) return
      watch(registration)
      // A driver keeps this app open for a whole shift, so an update published at 10am would
      // otherwise not be noticed until he closes it. Check whenever he comes back to the tab.
      const recheck = (): void => {
        if (document.visibilityState === 'visible') void registration.update().catch(() => undefined)
      }
      document.addEventListener('visibilitychange', recheck)
      return () => document.removeEventListener('visibilitychange', recheck)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const apply = useCallback((): void => {
    if (!waiting) return
    // The page reloads once the new worker takes control, not before — reloading first would just
    // reload the old bundle.
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true })
    waiting.postMessage({ type: 'SKIP_WAITING' })
  }, [waiting])

  if (!waiting) return null

  return (
    <div className="flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-white">
      <span>{t.app.updateAvailable}</span>
      <button onClick={apply} className="rounded-lg bg-white/20 px-3 py-1 font-semibold">
        {t.app.updateNow}
      </button>
    </div>
  )
}
