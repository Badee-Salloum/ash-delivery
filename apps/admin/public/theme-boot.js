/*
 * Sets the theme before the first paint, so a manager who chose dark never gets a white flash.
 *
 * WHY AN EXTERNAL FILE and not an inline <script>, which is the usual way to do this: the
 * production CSP at infra/caddy/Caddyfile declares `default-src 'self'` and no `script-src`, so
 * inline scripts are blocked. An inline version of this would work perfectly in dev and silently do
 * nothing in production — the flash would be back and nobody would know why. Served from our own
 * origin, this passes.
 *
 * It must stay synchronous and in <head>: the point is to run BEFORE the body is painted. It writes
 * a concrete 'light' or 'dark', never 'system', because the CSS matches on the attribute itself.
 */
;(function () {
  try {
    var saved = localStorage.getItem('ash.theme')
    var resolved =
      saved === 'dark' || saved === 'light'
        ? saved
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
    document.documentElement.setAttribute('data-theme', resolved)
  } catch (e) {
    /* private mode, storage disabled, or no matchMedia — light is the right default anyway, and it
       is what the stylesheet already assumes, so there is nothing to write. */
  }
})()
