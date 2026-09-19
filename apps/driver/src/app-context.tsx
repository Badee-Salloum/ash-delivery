import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ApiClient } from '@ash/client'
import { type Catalog, type Lang, catalogs, dir } from '@ash/client/i18n'
import { type Theme, applyTheme, readTheme, watchSystemTheme } from './theme.ts'

/**
 * The app-wide context: the API client, the current language (ar default, RTL-first), and the
 * signed-in session. Kept deliberately small — this is a single-driver phone app, not a
 * dashboard, so there is no global store beyond this.
 */

export interface Session {
  userId: string
  roleKey: string
  branchId: string | null
  driverId: string | null
  businessDate: string
}

interface AppContextValue {
  api: ApiClient
  lang: Lang
  t: Catalog
  setLang(lang: Lang): void
  /** The saved preference; `system` follows the device's current appearance. */
  theme: Theme
  setTheme(theme: Theme): void
  session: Session | null
  setSession(session: Session | null): void
  refreshSession(): Promise<void>
  /** The session lapsed mid-use — the login screen says so instead of appearing from nowhere. */
  sessionExpired: boolean
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const api = useMemo(() => new ApiClient('/api'), [])
  /**
   * REMEMBERED. A single mis-tap on the 12px header control flipped the whole app to English
   * mid-shift, and because nothing persisted the choice, reloading silently undid it — so the
   * driver could neither keep the change nor understand why it went away.
   */
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const saved = localStorage.getItem('ash.lang')
      return saved === 'en' || saved === 'ar' ? saved : 'ar'
    } catch {
      return 'ar' // private mode, or storage disabled — the default is the right answer anyway
    }
  })
  const [session, setSession] = useState<Session | null>(null)
  // `theme-boot.js` has already painted the concrete value before React mounts. Keep the saved
  // preference here so “automatic” remains distinguishable from an explicit light/dark choice.
  const [theme, setThemeState] = useState<Theme>(() => readTheme())

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    applyTheme(next)
  }, [])

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      localStorage.setItem('ash.lang', next)
    } catch {
      /* storage disabled — the choice still holds for this session */
    }
    document.documentElement.lang = next
    document.documentElement.dir = dir(next)
  }, [])


  /**
   * The session lapsed while the app was open.
   *
   * Set by the API client's 401 hook, cleared the moment a fresh sign-in succeeds. It exists so
   * the login screen can say WHY it is being shown: without it a driver mid-shift, or a manager
   * mid-approval, is dropped onto a sign-in form with no explanation and no idea whether he lost
   * his work.
   */
  const [sessionExpired, setSessionExpired] = useState(false)

  useEffect(() => {
    api.onUnauthorized = (): void => {
      // Guard on the CURRENT session via the setter: a 401 on a page that was already signed out
      // (a stale poll, a race on load) must not raise the expiry notice.
      setSession((current) => {
        if (current) setSessionExpired(true)
        return null
      })
    }
    return () => {
      api.onUnauthorized = null
    }
  }, [api])

  useEffect(() => {
    if (theme !== 'system') return
    // `theme-boot.js` normally handles first paint. Apply here too when storage was unavailable
    // before React mounted, so Auto still follows a dark operating system for this visit.
    applyTheme('system')
    return watchSystemTheme(() => applyTheme('system'))
  }, [theme])

  // Keep <html dir/lang> in step with the chosen language — the whole layout is RTL by default.
  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = dir(lang)
  }, [lang])

  const refreshSession = useCallback(async () => {
    try {
      const me = await api.me()
      setSession(me)
      setSessionExpired(false)
    } catch {
      setSession(null)
    }
  }, [api])

  // Resume an existing session on load — the cookie may still be valid from a prior visit.
  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

  const value: AppContextValue = {
    api,
    lang,
    t: catalogs[lang],
    setLang,
    theme,
    setTheme,
    session,
    setSession,
    refreshSession,
    sessionExpired,
  }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>')
  return ctx
}
