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

export interface Branch {
  id: string
  code: string
  nameAr: string
  nameEn: string
}

interface AppContextValue {
  api: ApiClient
  lang: Lang
  t: Catalog
  setLang(lang: Lang): void
  session: Session | null
  setSession(session: Session | null): void
  refreshSession(): Promise<void>
  /** The session lapsed mid-use — the login screen says so instead of appearing from nowhere. */
  sessionExpired: boolean
  /** Branches an organisation-wide role may choose between. Empty for a branch-scoped role. */
  branches: Branch[]
  /** The branch every branch-scoped read is currently pointed at. */
  branchId: string | null
  setBranchId(branchId: string): void
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
  const [branches, setBranches] = useState<Branch[]>([])
  const [branchId, setBranchIdState] = useState<string | null>(null)

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

  const setBranchId = useCallback(
    (next: string) => {
      api.setBranch(next)
      setBranchIdState(next)
    },
    [api],
  )

  /**
   * Point the client at a branch.
   *
   * A branch-scoped role (branch_manager) already carries his branch on the session, so the client
   * stays in session scope and sends nothing. An ORGANISATION-WIDE role (GM, system admin) has
   * `branchId === null` by design — the §3 matrix gives him scope 'all' — so until he picks one,
   * every branch-scoped read answers 422 and every screen sits on a spinner. He gets the list and
   * lands on the first branch, which for a single-branch install means it just works.
   */
  useEffect(() => {
    if (!session) {
      setBranches([])
      setBranchIdState(null)
      api.setBranch(null)
      return
    }
    if (session.branchId) {
      setBranches([])
      setBranchIdState(session.branchId)
      api.setBranch(null) // his session says it; naming it again would only be refusable
      return
    }
    void api
      .branches()
      .then((r) => {
        setBranches(r.branches)
        const first = r.branches[0]
        if (first) {
          api.setBranch(first.id)
          setBranchIdState(first.id)
        }
      })
      .catch(() => setBranches([]))
  }, [api, session])

  const value: AppContextValue = {
    api,
    lang,
    t: catalogs[lang],
    setLang,
    session,
    setSession,
    refreshSession,
    sessionExpired,
    branches,
    branchId,
    setBranchId,
  }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>')
  return ctx
}
