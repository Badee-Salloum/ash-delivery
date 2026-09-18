import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The Android shell for the driver PWA.
 *
 * It is a THIN shell, and that is the whole design. Its only job is to run a location foreground
 * service; the app it shows is the same deployed web app the drivers already use.
 *
 *
 * WHY `server.url` RATHER THAN BUNDLED ASSETS.
 *
 * Three things depend on the WebView being on the site's real origin, and all three break if the
 * assets are bundled (the origin then becomes `https://localhost`):
 *
 *   1. THE SESSION. The cookie is `httpOnly, sameSite: 'lax', secure` with no `Domain` — host-only,
 *      attributed to the front-end origin. The tracker service reads it from `CookieManager` to
 *      upload while the app is closed. Bundled, that cookie is simply not there.
 *   2. THE API CALLS. `ApiClient` is constructed as `new ApiClient('/api')` — a RELATIVE path that
 *      the front-end's own Vercel project rewrites to the API. Bundled, every call becomes
 *      cross-origin to a money API that registers no CORS plugin at all.
 *   3. THE UPDATE PATH. `registerType: 'prompt'` and the whole `UpdateBar` deferral machinery exist
 *      so code never swaps mid-shift. Bundling would add a SECOND update channel — an APK
 *      reinstall — on top of it, and the two would disagree about which version a driver is on.
 *
 * With the remote URL none of that changes: same origin, same cookie, same `/api` proxy, same
 * service worker, same «تحديث» tap. A UI fix still ships by web deploy; the APK is reinstalled only
 * when the native shell itself changes, which should be rarely.
 *
 *
 * WHAT THIS IS NOT. Not a Play Store app — Google's minimum-functionality policy would reject a
 * thin WebView wrapper, and it does not matter: this is sideloaded onto company handsets. Which
 * also disposes of the developer fee and the sanctions friction around paying it from Damascus.
 */
const config: CapacitorConfig = {
  appId: 'com.ashdelivery.driver',
  appName: 'ASH Delivery — السائق',
  /*
   * Almost nothing: the app itself is loaded from `server.url`. This directory exists so the CLI
   * has something to copy, and so `errorPath` below resolves against a real bundled file — the one
   * page that must work when the network does not.
   */
  webDir: 'shell',
  android: {
    // The driver PWA is served over HTTPS; there is no reason to permit cleartext anywhere.
    allowMixedContent: false,
  },
  server: {
    url: process.env.ASH_DRIVER_URL ?? 'https://ash-driver.vercel.app',
    // A hard failure to load must not be a white screen on a motorbike.
    errorPath: 'offline.html',
  },
}

export default config
