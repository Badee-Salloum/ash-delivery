/**
 * The driver's appearance preference deliberately uses the same storage contract as the admin
 * console. A shared phone may open either app, and “dark” must mean the same thing in both places.
 */
export type Theme = 'light' | 'dark' | 'system'

const KEY = 'ash.theme'

/** Read only the three values the product understands; old or hand-edited values fall back safely. */
export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    return saved === 'dark' || saved === 'light' || saved === 'system' ? saved : 'system'
  } catch {
    return 'system'
  }
}

/** `system` is a choice, while the document needs a concrete theme to paint. */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** Persist the preference and keep browser chrome in step with the currently painted surface. */
export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme)
  document.documentElement.setAttribute('data-theme', resolved)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#0b1220' : '#1b2a5c')
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Private mode may reject storage; the chosen appearance still applies for this visit.
  }
}

/** Follow OS changes only while the user has explicitly left the choice on automatic. */
export function watchSystemTheme(onChange: () => void): () => void {
  try {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  } catch {
    return () => {}
  }
}
