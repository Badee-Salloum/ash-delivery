import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from './app-context.tsx'
import { Badge } from './ui.tsx'
import { Login } from './screens/Login.tsx'
import { Dashboard } from './screens/Dashboard.tsx'
import { Queue } from './screens/Queue.tsx'
import { Approval } from './screens/Approval.tsx'
import { Fleet } from './screens/Fleet.tsx'
import { Treasury } from './screens/Treasury.tsx'

type Section = 'dashboard' | 'queue' | 'fleet' | 'treasury'

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

  const nav: Array<{ key: Section; label: string; badge?: number | undefined }> = [
    { key: 'dashboard', label: t.dashboard.title },
    { key: 'queue', label: t.approval.queue, badge: unread || undefined },
    { key: 'fleet', label: `${t.fleet.drivers} / ${t.fleet.vehicles}` },
    { key: 'treasury', label: t.treasury.cashCount },
  ]

  return (
    <div className="flex min-h-dvh">
      <aside className="flex w-56 flex-col gap-1 border-e border-slate-200 bg-white p-3">
        <div className="mb-4 px-2">
          <div className="text-lg font-bold">{t.app.title}</div>
          <div className="text-xs text-slate-400">{session.roleKey}</div>
        </div>
        {nav.map((n) => (
          <button
            key={n.key}
            onClick={() => {
              setSection(n.key)
              setOpenShift(null)
            }}
            className={`flex items-center justify-between rounded-lg px-3 py-2 text-start text-sm ${
              section === n.key && !openShift ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'
            }`}
          >
            <span>{n.label}</span>
            {n.badge ? <Badge tone="red">{n.badge}</Badge> : null}
          </button>
        ))}
        <div className="mt-auto flex flex-col gap-1">
          <button onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} className="rounded-lg px-3 py-2 text-start text-sm hover:bg-slate-100">
            {lang === 'ar' ? 'English' : 'العربية'}
          </button>
          <button
            onClick={async () => {
              await api.logout()
              setSession(null)
            }}
            className="rounded-lg px-3 py-2 text-start text-sm text-red-600 hover:bg-red-50"
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
        ) : (
          <Treasury />
        )}
      </main>
    </div>
  )
}
