/**
 * The theme choice, stored and applied.
 *
 * Three states, not two. «System» is a real answer — it is what most people want and it is the
 * default — but the stylesheet matches on a concrete `data-theme` attribute, so `resolve()` turns
 * it into `light` or `dark` at the moment of application. That keeps the CSS free of
 * `prefers-color-scheme` entirely: one selector, one source of truth.
 *
 * The same shape as the language preference in `app-context.tsx`, deliberately: same storage
 * convention (`ash.*`), same try/catch around storage, same "the default is the right answer
 * anyway" fallback. A second preference that behaved differently from the first would be a trap.
 */

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'ash.theme'

/** What is stored. Never assume it is valid — a user can edit it, and old builds wrote other things. */
export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    return saved === 'dark' || saved === 'light' || saved === 'system' ? saved : 'system'
  } catch {
    return 'system' // private mode, or storage disabled
  }
}

/** The concrete theme to paint. `system` asks the OS; everything else is already an answer. */
export function resolve(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * Write the choice and paint it.
 *
 * The attribute goes on `<html>` because that is where `theme-boot.js` puts it before first paint;
 * if these two disagreed the page would flash on every load.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', resolve(theme))
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* storage disabled — the choice still holds for this session */
  }
}

/**
 * Follow the OS while the choice is «system».
 *
 * Without this, a manager on `system` whose laptop flips to dark at sunset keeps the light theme
 * until he reloads. Returns an unsubscribe so the caller can drop it when the choice changes.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  try {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  } catch {
    return () => {}
  }
}
