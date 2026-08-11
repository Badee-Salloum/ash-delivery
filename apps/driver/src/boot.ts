/**
 * Getting out of a bundle that will not run.
 *
 * This app is a PWA with `registerType: 'prompt'`, chosen so a money app never swaps its code
 * mid-shift. The cost of that choice is that a driver can keep a service worker which serves a
 * bundle he cannot boot — and then RELOADING DOES NOT HELP, because the reload is answered from the
 * same cache. The page stays on `#root:empty::after`, which paints «ASH», so it reads as a slow
 * connection rather than a fault, and there is no gesture that fixes it from inside the app.
 *
 * Clearing the worker and its caches is the only exit. It is safe: everything the driver has done
 * lives on the server — photos upload immediately and each package is a `PUT` — so a clean reload
 * comes back to the same shift in the same state.
 */

/** Marks that the bundle actually executed. `index.html`'s watchdog reads it. */
export const BOOTED_FLAG = '__ashBooted'

/**
 * Unregister every service worker, drop every cache, then reload.
 *
 * Never hangs: cleanup is raced against a timeout, because a wedged worker is exactly the situation
 * where `getRegistrations()` may not settle, and the one thing worse than a broken app is a broken
 * app whose repair button does nothing.
 */
export async function hardReset(): Promise<void> {
  const jobs: Promise<unknown>[] = []
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.getRegistrations) {
      jobs.push(
        navigator.serviceWorker.getRegistrations().then((regs) => Promise.all(regs.map((r) => r.unregister()))),
      )
    }
    if (typeof caches !== 'undefined') {
      jobs.push(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))))
    }
  } catch {
    // Private-mode browsers throw on `caches`. Reloading is still worth doing.
  }
  const timeout = new Promise((resolve) => setTimeout(resolve, 3_000))
  await Promise.race([Promise.all(jobs).catch(() => undefined), timeout])
  // `reload()` after unregistering goes to the network, which is the entire point.
  window.location.reload()
}
