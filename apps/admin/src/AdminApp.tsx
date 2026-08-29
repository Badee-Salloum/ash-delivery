import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from './app-context.tsx'
import { Badge, Wordmark } from './ui.tsx'
import { type Notif, NotificationBell } from './NotificationBell.tsx'
import { Login } from './screens/Login.tsx'
import { Dashboard } from './screens/Dashboard.tsx'
import { AWAITING_STATES, Queue } from './screens/Queue.tsx'
import { LiveShifts } from './screens/LiveShifts.tsx'
import { CompletedShifts } from './screens/CompletedShifts.tsx'
import { PreapprovedShifts } from './screens/PreapprovedShifts.tsx'
import { GpsLive } from './screens/GpsLive.tsx'
import { Approval } from './screens/Approval.tsx'
import { Fleet } from './screens/Fleet.tsx'
import { FleetConfig } from './screens/FleetConfig.tsx'
import { Treasury } from './screens/Treasury.tsx'
import { Expenses } from './screens/Expenses.tsx'
import { CheckIn } from './screens/CheckIn.tsx'
import { Accounts } from './screens/Accounts.tsx'
import { Audit } from './screens/Audit.tsx'
import { Permissions } from './screens/Permissions.tsx'
import { Settings } from './screens/Settings.tsx'
import { canManagePreapprovedShifts } from './preapproved-shifts.ts'

const SECTIONS = [
  'dashboard',
  'queue',
  'liveShifts',
  'completedShifts',
  'preapprovedShifts',
  'gpsLive',
  'fleet',
  'fleetConfig',
  'treasury',
  'expenses',
  'checkin',
  'accounts',
  'audit',
  'permissions',
  'settings',
] as const
type Section = (typeof SECTIONS)[number]

/** The view encoded in the URL hash: a section, or `shift:<id>` for the review overlay. */
function viewFromHash(): { section: Section; openShift: string | null } {
  const raw = decodeURIComponent(location.hash.slice(1))
  if (raw.startsWith('shift:')) return { section: 'dashboard', openShift: raw.slice('shift:'.length) }
  return { section: (SECTIONS as readonly string[]).includes(raw) ? (raw as Section) : 'dashboard', openShift: null }
}

/**
 * The admin console shell: a side rail of sections and a main pane. The approval review takes over
 * the main pane when a queue item is opened, then returns.
 */
export function AdminApp(): ReactNode {
  const { session, t, lang, setLang, api, setSession, branches, branchId, setBranchId } = useApp()
  // Initialise from the URL hash so a refresh or a shared link restores the view immediately —
  // before the reflect effect runs, so a deep link is never overwritten by the default.
  const [section, setSection] = useState<Section>(() => viewFromHash().section)
  const [openShift, setOpenShift] = useState<string | null>(() => viewFromHash().openShift)
  const [notifs, setNotifs] = useState<Notif[]>([])
  const [queueCount, setQueueCount] = useState(0)
  const [navOpen, setNavOpen] = useState(false) // the rail is a drawer below lg

  /**
   * Client routing via the URL hash. `view` is the single source of truth (`section`, or
   * `shift:<id>` for the review overlay); the hash mirrors it, so a refresh or a shared link
   * restores the view — not always the dashboard — and Back/forward still walk the console instead
   * of leaving the app. No router dependency: the SPA's catch-all `index.html` fallback is enough.
   */
  const view = openShift ? `shift:${openShift}` : section
  useEffect(() => {
    if (!session) return
    if (decodeURIComponent(location.hash.slice(1)) !== view) location.hash = view
  }, [session, view])
  useEffect(() => {
    if (!session) return
    // Back/forward and manual hash edits fire `hashchange`; apply it to state. A `shift:` hash only
    // toggles the overlay — the section behind it is left as-is, so closing the review returns to
    // wherever it was opened from (the queue), not the dashboard.
    const apply = (): void => {
      const raw = decodeURIComponent(location.hash.slice(1))
      if (raw.startsWith('shift:')) {
        setOpenShift(raw.slice('shift:'.length))
      } else {
        setOpenShift(null)
        setSection((SECTIONS as readonly string[]).includes(raw) ? (raw as Section) : 'dashboard')
      }
    }
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [session])

  const refreshNotifs = useCallback(() => {
    void api.notifications().then((n) => setNotifs(n.notifications)).catch(() => undefined)
  }, [api])
  useEffect(() => {
    if (!session) return
    refreshNotifs()
    const timer = setInterval(refreshNotifs, 8000)
    return () => clearInterval(timer)
  }, [session, refreshNotifs])

  // The Queue badge counts the shifts the Queue list actually shows — the ones really waiting for a
  // signature — NOT unread bell rows. A bell row is pushed once and never cleared, so counting them
  // left the badge stuck at yesterday's number long after every shift was approved, and left an
  // upper-level manager (who receives no branch bell at all) on a permanent zero. Same source as
  // the list means the two can never disagree.
  const refreshQueue = useCallback(() => {
    void api
      .get<{ shifts: Array<{ state: string }> }>('/shifts')
      .then((r) => setQueueCount(r.shifts.filter((s) => AWAITING_STATES.has(s.state)).length))
      .catch(() => setQueueCount(0))
  }, [api])
  useEffect(() => {
    if (!session) return
    refreshQueue()
    const timer = setInterval(refreshQueue, 8000)
    return () => clearInterval(timer)
  }, [session, refreshQueue, branchId])
  const markRead = (id: number): void => {
    void api.markNotificationRead(id).then(refreshNotifs).catch(() => undefined)
  }
  const openNotif = (n: Notif): void => {
    if (n.kind.startsWith('shift_awaiting') && typeof n.payload.shiftId === 'string') {
      setOpenShift(n.payload.shiftId)
    } else if (n.kind.startsWith('shift_awaiting')) {
      setSection('queue')
      setOpenShift(null)
    } else if (n.kind === 'manual_order_requested' && typeof n.payload.shiftId === 'string') {
      // The driver proposed an order — open his shift so the manager can add it (or decline).
      setOpenShift(n.payload.shiftId)
    } else if (n.kind === 'shift_incident_reported') {
      // A mid-shift incident (C-1): the manager acts from the live-shifts panel.
      setSection('liveShifts')
      setOpenShift(null)
    } else {
      // document_expiring — the expiry board lives on the dashboard.
      setSection('dashboard')
      setOpenShift(null)
    }
    setNavOpen(false)
  }

  if (!session) return <Login />

  // Account management is a sysadmin/GM permission (user.manage), so the tab only shows for them.
  const canManageUsers = session.roleKey === 'system_admin' || session.roleKey === 'general_manager'
  const canManagePreapproved = canManagePreapprovedShifts(session.roleKey)
  // gps.view — the same two roles; the branch manager no longer has it.
  const canSeeMap = canManageUsers
  const nav: Array<{ key: Section; label: string; badge?: number | undefined }> = [
    { key: 'dashboard', label: t.dashboard.title },
    { key: 'queue', label: t.approval.queue, badge: queueCount || undefined },
    { key: 'liveShifts', label: t.liveShifts.title },
    { key: 'completedShifts', label: t.completedShifts.title },
    ...(canManagePreapproved
      ? [{ key: 'preapprovedShifts' as const, label: t.preapprovedShifts.title }]
      : []),
    // The live map is gps.view — the GM and the system admin only. The branch manager runs his
    // branch from the shift screens. (The API enforces it too; this only stops offering a 403.)
    ...(canSeeMap ? [{ key: 'gpsLive' as const, label: t.gpsLive.title }] : []),
    { key: 'fleet', label: `${t.fleet.drivers} / ${t.fleet.vehicles}` },
    { key: 'treasury', label: t.treasury.branchTreasury },
    { key: 'expenses', label: t.expenses.title },
    // «التفقّد» — the branch manager's own rounds. Drivers never see it; they are out on the road
    // and their whereabouts already ride on their shift.
    ...(session.roleKey !== 'driver' ? [{ key: 'checkin' as const, label: t.checkin.title }] : []),
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
      {/* On a phone/tablet the rail is an off-canvas drawer; a dim overlay closes it. On lg+ it is
          a normal static column and the overlay/hamburger never show. */}
      {navOpen ? (
        <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setNavOpen(false)} aria-hidden="true" />
      ) : null}
      <aside
        className={`fixed inset-y-0 start-0 z-40 flex w-60 flex-col gap-1 overflow-y-auto border-e border-slate-200 bg-white p-3 transition-transform lg:static lg:z-auto lg:translate-x-0 ${
          navOpen ? 'translate-x-0' : 'ltr:-translate-x-full rtl:translate-x-full lg:ltr:translate-x-0 lg:rtl:translate-x-0'
        }`}
      >
        <div className="mb-5 border-b border-slate-100 px-2 pb-4 pt-1">
          <div className="flex items-start justify-between">
            <Wordmark size={32} />
            <NotificationBell notifications={notifs} onMarkRead={markRead} onNavigate={openNotif} />
          </div>
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
              setNavOpen(false)
            }}
            className={`flex items-center justify-between rounded-lg px-3 py-2 text-start text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/40 ${
              section === n.key && !openShift ? 'bg-brand text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>{n.label}</span>
            {n.badge ? <Badge tone="red">{n.badge}</Badge> : null}
          </button>
        ))}
        <div className="mt-auto flex flex-col gap-1 border-t border-slate-100 pt-2">
          <button
            onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
            className="rounded-lg px-3 py-2 text-start text-sm text-slate-600 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand/40"
          >
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
            className="rounded-lg px-3 py-2 text-start text-sm font-medium text-red-600 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            {t.common.logout}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar: a hamburger to open the rail. Hidden on lg where the rail is static. */}
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white p-3 lg:hidden">
          <button
            aria-label={t.common.menu}
            onClick={() => setNavOpen(true)}
            className="rounded-lg p-2 text-slate-600 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
            </svg>
          </button>
          <Wordmark size={26} />
          <div className="ms-auto">
            <NotificationBell notifications={notifs} onMarkRead={markRead} onNavigate={openNotif} />
          </div>
        </div>
        <main className="flex-1 overflow-y-auto p-3 lg:p-6">
        {openShift ? (
          /* A notification can replace `openShift` while a review is already mounted. Keying the
             workspace prevents typed cash/top-up or confirmations from one driver surviving into
             another driver's shift. */
          <Approval key={openShift} shiftId={openShift} onDone={() => setOpenShift(null)} />
        ) : section === 'dashboard' ? (
          <Dashboard />
        ) : section === 'queue' ? (
          <Queue onOpen={setOpenShift} />
        ) : section === 'liveShifts' ? (
          <LiveShifts onOpen={setOpenShift} />
        ) : section === 'completedShifts' ? (
          <CompletedShifts onOpen={setOpenShift} />
        ) : section === 'preapprovedShifts' && canManagePreapproved ? (
          <PreapprovedShifts />
        ) : section === 'gpsLive' ? (
          <GpsLive />
        ) : section === 'fleet' ? (
          <Fleet />
        ) : section === 'fleetConfig' ? (
          <FleetConfig />
        ) : section === 'expenses' ? (
          <Expenses />
        ) : section === 'checkin' ? (
          <CheckIn />
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
    </div>
  )
}
