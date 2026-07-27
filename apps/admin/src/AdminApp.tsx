import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from './app-context.tsx'
import { Badge, Wordmark } from './ui.tsx'
import { Login } from './screens/Login.tsx'
import { Dashboard } from './screens/Dashboard.tsx'
import { Queue } from './screens/Queue.tsx'
import { Approval } from './screens/Approval.tsx'
import { Fleet } from './screens/Fleet.tsx'
import { FleetConfig } from './screens/FleetConfig.tsx'
import { Treasury } from './screens/Treasury.tsx'
import { Accounts } from './screens/Accounts.tsx'
import { Audit } from './screens/Audit.tsx'
import { Permissions } from './screens/Permissions.tsx'
import { Settings } from './screens/Settings.tsx'

type Section = 'dashboard' | 'queue' | 'fleet' | 'fleetConfig' | 'treasury' | 'accounts' | 'audit' | 'permissions' | 'settings'

/**
 * The admin console shell: a side rail of sections and a main pane. The approval review takes over
 * the main pane when a queue item is opened, then returns.
 */
export function AdminApp(): ReactNode {
  const { session, t, lang, setLang, api, setSession, branches, branchId, setBranchId } = useApp()
  const [section, setSection] = useState<Section>('dashboard')
  const [openShift, setOpenShift] = useState<string | null>(null)
  const [unread, setUnread] = useState(0)

  /**
   * Mirror in-app navigation into browser history, so the Back button steps through the console
   * instead of leaving it.
   *
   * There is no router: navigation is `section` + the `openShift` review overlay. Without this a
   * single Back press exits the whole app — jarring on a tool a manager keeps open all day. Each
   * navigation pushes a history entry carrying the view; `popstate` restores it, so Back closes
   * the review first, then walks back through sections.
   */
  const view = openShift ? `shift:${openShift}` : section
  useEffect(() => {
    if (!session) return
    if (window.history.state?.view !== view) window.history.pushState({ view }, '')
  }, [session, view])
  useEffect(() => {
    if (!session) return
    const onPop = (e: PopStateEvent): void => {
      const target: string = e.state?.view ?? 'dashboard'
      if (target.startsWith('shift:')) {
        setOpenShift(target.slice('shift:'.length))
      } else {
        setOpenShift(null)
        setSection(target as Section)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [session])

  useEffect(() => {
    if (!session) return
    const poll = (): void => {
      // The Queue badge counts approval alerts only — the same events the Queue list shows.
      // Other kinds (e.g. document_expiring) ring the bell but surface on their own screens, so
      // folding them into this count would make the badge disagree with the list beneath it.
      void api
        .notifications()
        .then((n) => setUnread(n.notifications.filter((x) => !x.read && x.kind.startsWith('shift_awaiting')).length))
        .catch(() => undefined)
    }
    poll()
    const timer = setInterval(poll, 8000)
    return () => clearInterval(timer)
  }, [api, session])

  if (!session) return <Login />

  // Account management is a sysadmin/GM permission (user.manage), so the tab only shows for them.
  const canManageUsers = session.roleKey === 'system_admin' || session.roleKey === 'general_manager'
  const nav: Array<{ key: Section; label: string; badge?: number | undefined }> = [
    { key: 'dashboard', label: t.dashboard.title },
    { key: 'queue', label: t.approval.queue, badge: unread || undefined },
    { key: 'fleet', label: `${t.fleet.drivers} / ${t.fleet.vehicles}` },
    { key: 'treasury', label: t.treasury.branchTreasury },
    ...(canManageUsers ? [{ key: 'accounts' as const, label: t.accounts.title }] : []),
    // audit.view is granted to the sysadmin and the GM — the same two roles.
    ...(canManageUsers ? [{ key: 'audit' as const, label: t.audit.title }] : []),
    ...(canManageUsers ? [{ key: 'permissions' as const, label: t.permissions.title }] : []),
    // The numbering scheme is settings.write — the system admin alone. Renumbering a type or a
    // branch restates printed vehicle numbers, so it does not belong beside day-to-day fleet work.
    ...(session.roleKey === 'system_admin' ? [{ key: 'fleetConfig' as const, label: t.fleet.numberingTitle }] : []),
    // FX rate + general settings are settings.write / fx_rate.write — system admin only.
    ...(session.roleKey === 'system_admin' ? [{ key: 'settings' as const, label: t.settings.title }] : []),
  ]

  return (
    <div className="flex min-h-dvh">
      <aside className="flex w-60 flex-col gap-1 border-e border-slate-200 bg-white p-3">
        <div className="mb-5 border-b border-slate-100 px-2 pb-4 pt-1">
          <Wordmark size={32} />
          <div className="mt-3 inline-block rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
            {t.roles?.[session.roleKey as keyof typeof t.roles] ?? session.roleKey}
          </div>
          {/*
            An organisation-wide role (GM, system admin) has no branch on his session — the §3
            matrix gives him scope 'all'. Every branch-scoped screen therefore needs him to say
            which branch he is looking at; without this picker they all answer 422 and render an
            eternal spinner. A branch manager never sees it: his session already decides.
          */}
          {branches.length > 0 ? (
            <select
              className="mt-3 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              value={branchId ?? ''}
              onChange={(e) => setBranchId(e.target.value)}
              aria-label={t.accounts.branch}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {lang === 'ar' ? b.nameAr : b.nameEn}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {nav.map((n) => (
          <button
            key={n.key}
            onClick={() => {
              setSection(n.key)
              setOpenShift(null)
            }}
            className={`flex items-center justify-between rounded-lg px-3 py-2 text-start text-sm font-medium transition-colors ${
              section === n.key && !openShift ? 'bg-brand text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>{n.label}</span>
            {n.badge ? <Badge tone="red">{n.badge}</Badge> : null}
          </button>
        ))}
        <div className="mt-auto flex flex-col gap-1 border-t border-slate-100 pt-2">
          <button onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} className="rounded-lg px-3 py-2 text-start text-sm text-slate-600 hover:bg-slate-100">
            {lang === 'ar' ? 'English' : 'العربية'}
          </button>
          <button
            onClick={async () => {
              try {
                await api.logout()
              } finally {
                // Always clear the session, even if the network call fails — otherwise a hiccup
                // leaves the user stuck logged in with no way out.
                setSession(null)
                setSection('dashboard')
                setOpenShift(null)
              }
            }}
            className="rounded-lg px-3 py-2 text-start text-sm font-medium text-red-600 hover:bg-red-50"
          >
            {t.common.logout}
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-6">
        {openShift ? (
          <Approval shiftId={openShift} onDone={() => setOpenShift(null)} />
        ) : section === 'dashboard' ? (
          <Dashboard />
        ) : section === 'queue' ? (
          <Queue onOpen={setOpenShift} />
        ) : section === 'fleet' ? (
          <Fleet />
        ) : section === 'fleetConfig' ? (
          <FleetConfig />
        ) : section === 'accounts' ? (
          <Accounts />
        ) : section === 'audit' ? (
          <Audit />
        ) : section === 'permissions' ? (
          <Permissions />
        ) : section === 'settings' ? (
          <Settings />
        ) : (
          <Treasury />
        )}
      </main>
    </div>
  )
}
