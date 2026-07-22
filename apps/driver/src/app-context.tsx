import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ApiClient } from '@ash/client'
import { type Catalog, type Lang, catalogs, dir } from '@ash/client/i18n'

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
  session: Session | null
  setSession(session: Session | null): void
  refreshSession(): Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const api = useMemo(() => new ApiClient('/api'), [])
  const [lang, setLangState] = useState<Lang>('ar')
  const [session, setSession] = useState<Session | null>(null)

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    document.documentElement.lang = next
    document.documentElement.dir = dir(next)
  }, [])

  // Keep <html dir/lang> in step with the chosen language — the whole layout is RTL by default.
  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = dir(lang)
  }, [lang])

  const refreshSession = useCallback(async () => {
    try {
      const me = await api.me()
      setSession(me)
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
    session,
    setSession,
    refreshSession,
  }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>')
  return ctx
}
