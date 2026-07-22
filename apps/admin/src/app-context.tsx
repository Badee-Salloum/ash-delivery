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
  /** Branches an organisation-wide role may choose between. Empty for a branch-scoped role. */
  branches: Branch[]
  /** The branch every branch-scoped read is currently pointed at. */
  branchId: string | null
  setBranchId(branchId: string): void
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const api = useMemo(() => new ApiClient('/api'), [])
  const [lang, setLangState] = useState<Lang>('ar')
  const [session, setSession] = useState<Session | null>(null)
  const [branches, setBranches] = useState<Branch[]>([])
  const [branchId, setBranchIdState] = useState<string | null>(null)

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
