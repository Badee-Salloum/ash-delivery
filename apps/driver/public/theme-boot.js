/*
 * Paint a concrete theme before the driver bundle loads. This is intentionally a small external
 * script: production CSP allows same-origin scripts but rejects inline code, and a phone should not
 * flash a bright screen before honouring a saved dark preference.
 */
;(function () {
  var saved = null
  try {
    saved = localStorage.getItem('ash.theme')
  } catch (e) {
    /* Private mode can deny storage. It must not also deny the system-theme preference. */
  }
  var resolved = saved === 'dark' || saved === 'light' ? saved : 'light'
  if (saved !== 'dark' && saved !== 'light') {
    try {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } catch (e) {
      /* Old webviews without matchMedia retain the explicit light fallback. */
    }
  }
  document.documentElement.setAttribute('data-theme', resolved)
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b1220' : '#1b2a5c')
})()
