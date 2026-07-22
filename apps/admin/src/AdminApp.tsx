import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from './app-context.tsx'
import { Badge, Wordmark } from './ui.tsx'
import { Login } from './screens/Login.tsx'
import { Dashboard } from './screens/Dashboard.tsx'
import { Queue } from './screens/Queue.tsx'
import { Approval } from './screens/Approval.tsx'
import { Fleet } from './screens/Fleet.tsx'
import { Treasury } from './screens/Treasury.tsx'
import { Accounts } from './screens/Accounts.tsx'
import { Audit } from './screens/Audit.tsx'
import { Permissions } from './screens/Permissions.tsx'

type Section = 'dashboard' | 'queue' | 'fleet' | 'treasury' | 'accounts' | 'audit' | 'permissions'

/**
 * The admin console shell: a side rail of sections and a main pane. The approval review takes over
 * the main pane when a queue item is opened, then returns.
 */
export function AdminApp(): ReactNode {
  const { session, t, lang, setLang, api, setSession } = useApp()
  const [section, setSection] = useState<Section>('dashboard')
  const [openShift, setOpenShift] = useState<string | null>(null)
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    if (!session) return
    const poll = (): void => {
      void api.notifications().then((n) => setUnread(n.unreadCount)).catch(() => undefined)
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
  ]

  return (
    <div className="flex min-h-dvh">
      <aside className="flex w-60 flex-col gap-1 border-e border-slate-200 bg-white p-3">
        <div className="mb-5 border-b border-slate-100 px-2 pb-4 pt-1">
          <Wordmark size={32} />
          <div className="mt-3 inline-block rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
            {t.roles?.[session.roleKey as keyof typeof t.roles] ?? session.roleKey}
          </div>
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
        ) : section === 'accounts' ? (
          <Accounts />
        ) : section === 'audit' ? (
          <Audit />
        ) : section === 'permissions' ? (
          <Permissions />
        ) : (
          <Treasury />
        )}
      </main>
    </div>
  )
}
