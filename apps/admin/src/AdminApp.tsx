import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from './app-context.tsx'
import { Badge, FOCUS_RING, Wordmark } from './ui.tsx'
import { Icon, type IconName } from './icons.tsx'
import { type Notif, NotificationBell } from './NotificationBell.tsx'
import { Login } from './screens/Login.tsx'
import { Dashboard } from './screens/Dashboard.tsx'
import { AWAITING_STATES, Queue } from './screens/Queue.tsx'
import { LiveShifts } from './screens/LiveShifts.tsx'
import { CompletedShifts } from './screens/CompletedShifts.tsx'
import { PreapprovedShifts } from './screens/PreapprovedShifts.tsx'
import { GpsLive } from './screens/GpsLive.tsx'
import { Approval } from './screens/Approval.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { Fleet } from './screens/Fleet.tsx'
import { FleetConfig } from './screens/FleetConfig.tsx'
import { Treasury } from './screens/Treasury.tsx'
import { Expenses } from './screens/Expenses.tsx'
import { CheckIn } from './screens/CheckIn.tsx'
import { Accounts } from './screens/Accounts.tsx'
import { Audit } from './screens/Audit.tsx'
import { Removals } from './screens/Removals.tsx'
import { Permissions } from './screens/Permissions.tsx'
import { Settings } from './screens/Settings.tsx'
import { canManagePreapprovedShifts } from './preapproved-shifts.ts'
import { type RouteParams, type RouteView, type Section, formatHash, paramsKey, parseHash } from './route.ts'
import { HashParamsContext, replaceHashParams } from './use-hash-params.ts'

/**
 * The view encoded in the URL hash: a section with its filter params, or `shift:<id>` for the
 * review overlay. Parsing and validation live in `route.ts` (pure, unit-tested).
 */
function viewFromHash(): RouteView {
  return parseHash(location.hash)
}

/**
 * The admin console shell: a side rail of sections and a main pane. The approval review takes over
 * the main pane when a queue item is opened, then returns.
 */
export function AdminApp(): ReactNode {
  const { session, t, lang, setLang, theme, setTheme, api, setSession, branches, branchId, setBranchId } =
    useApp()
  // Initialise from the URL hash so a refresh or a shared link restores the view immediately —
  // before the reflect effect runs, so a deep link is never overwritten by the default.
  const [section, setSectionState] = useState<Section>(() => viewFromHash().section)
  const [openShift, setOpenShift] = useState<string | null>(() => viewFromHash().openShift)
  /*
   * P2 — the filters a screen was MOUNTED with (its `key` and `initial`), and the filters it holds
   * NOW. A screen narrowing its list replaces the URL without a history step and reports here, so
   * closing a shift overlay returns to the filtered view rather than the one first opened, while
   * the screen itself is not remounted by its own typing.
   */
  const [mountedParams, setMountedParams] = useState<RouteParams>(() => viewFromHash().params)
  // Every navigation mounts afresh — even the rail item already on screen, which must drop the
  // filters it holds rather than keep them under a bare URL.
  const [mountNonce, setMountNonce] = useState(0)
  const mountKey = `${mountNonce}:${paramsKey(mountedParams)}`
  const liveParams = useRef<RouteParams>(mountedParams)
  // The section as the hashchange handler must see it: synchronously, not from a stale closure.
  const sectionRef = useRef<Section>(section)
  sectionRef.current = section
  /** Navigate to a section, with the params a link carries (none from the rail). */
  const setSection = useCallback((next: Section, params: RouteParams = {}) => {
    sectionRef.current = next
    setSectionState(next)
    setMountedParams(params)
    setMountNonce((n) => n + 1)
    liveParams.current = params
  }, [])
  const replaceParams = useCallback(
    (params: RouteParams) => {
      liveParams.current = params
      replaceHashParams(section, params, window)
    },
    [section],
  )
  const [notifs, setNotifs] = useState<Notif[]>([])
  const [queueCount, setQueueCount] = useState(0)
  const [navOpen, setNavOpen] = useState(false) // the rail is a drawer below lg

  /**
   * Client routing via the URL hash. `view` is the single source of truth (`section`, or
   * `shift:<id>` for the review overlay); the hash mirrors it, so a refresh or a shared link
   * restores the view — not always the dashboard — and Back/forward still walk the console instead
   * of leaving the app. No router dependency: the SPA's catch-all `index.html` fallback is enough.
   */
  // `formatHash`, not the bare section: the filters survive the reflect, which used to strip them.
  const view = formatHash({ section, openShift, params: liveParams.current })
  useEffect(() => {
    if (!session) return
    // Compared NORMALISED, so an equivalent spelling (or one carrying dropped junk) is rewritten
    // once and never fought over.
    if (formatHash(viewFromHash()) !== view) location.hash = view
  }, [session, view])
  useEffect(() => {
    if (!session) return
    // Back/forward and manual hash edits fire `hashchange`; apply it to state. A `shift:` hash only
    // toggles the overlay — the section behind it is left as-is, so closing the review returns to
    // wherever it was opened from (the queue, or a filtered list), not the dashboard.
    const apply = (): void => {
      const next = viewFromHash()
      if (next.openShift !== null) {
        setOpenShift(next.openShift)
        return
      }
      setOpenShift(null)
      // Arriving back at the view the screen already shows (closing the overlay with Back) keeps
      // the mounted screen; any other section or filter set mounts it afresh.
      if (sectionRef.current === next.section && paramsKey(next.params) === paramsKey(liveParams.current)) return
      setSection(next.section, next.params)
    }
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [session, setSection])

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
  /*
   * Grouped by FUNCTION, and every item carries a glyph.
   *
   * It was a flat list of sixteen text lines in which «الإعدادات» and «مصفوفة الصلاحيات» — touched
   * a few times a year — sat in the same undifferentiated run as «قائمة الاعتماد», which is opened
   * every shift. Daily work keeps the unlabelled first group because it is the default; the rest
   * are named, and an empty group disappears with the role that could not see it.
   */
  const nav: Array<{
    key: Section
    label: string
    icon: IconName
    group?: 'money' | 'fleet' | 'system'
    badge?: number | undefined
  }> = [
    { key: 'dashboard', label: t.dashboard.title, icon: 'dashboard' },
    { key: 'queue', label: t.approval.queue, icon: 'queue', badge: queueCount || undefined },
    { key: 'liveShifts', label: t.liveShifts.title, icon: 'live' },
    { key: 'completedShifts', label: t.completedShifts.title, icon: 'completed' },
    ...(canManagePreapproved
      ? [{ key: 'preapprovedShifts' as const, label: t.preapprovedShifts.title, icon: 'calendar' as const }]
      : []),
    // The live map is gps.view — the GM and the system admin only. The branch manager runs his
    // branch from the shift screens. (The API enforces it too; this only stops offering a 403.)
    ...(canSeeMap ? [{ key: 'gpsLive' as const, label: t.gpsLive.title, icon: 'map' as const }] : []),
    { key: 'fleet', label: `${t.fleet.drivers} / ${t.fleet.vehicles}`, icon: 'bike', group: 'fleet' },
    { key: 'treasury', label: t.treasury.branchTreasury, icon: 'treasury', group: 'money' },
    { key: 'expenses', label: t.expenses.title, icon: 'expenses', group: 'money' },
    // «التفقّد» — the branch manager's own rounds. Drivers never see it; they are out on the road
    // and their whereabouts already ride on their shift.
    ...(session.roleKey !== 'driver' ? [{ key: 'checkin' as const, label: t.checkin.title, icon: 'checkin' as const }] : []),
    ...(canManageUsers ? [{ key: 'accounts' as const, label: t.accounts.title, icon: 'accounts' as const, group: 'system' as const }] : []),
    // audit.view is granted to the sysadmin and the GM — the same two roles.
    ...(canManageUsers ? [{ key: 'audit' as const, label: t.audit.title, icon: 'audit' as const, group: 'system' as const }] : []),
    // «سجلّ الحذف» — same permission, and beside the audit trail because it is the readable
    // half of it: the audit log needs a table name and a UUID before it answers anything.
    ...(canManageUsers ? [{ key: 'removals' as const, label: t.removals.title, icon: 'removals' as const, group: 'system' as const }] : []),
    ...(canManageUsers ? [{ key: 'permissions' as const, label: t.permissions.title, icon: 'permissions' as const, group: 'system' as const }] : []),
    // The numbering scheme is settings.write — the system admin alone. Renumbering a type or a
    // branch restates printed vehicle numbers, so it does not belong beside day-to-day fleet work.
    ...(session.roleKey === 'system_admin' ? [{ key: 'fleetConfig' as const, label: t.fleet.numberingTitle, icon: 'hash' as const, group: 'fleet' as const }] : []),
    // FX rate + general settings are settings.write / fx_rate.write — system admin only.
    ...(session.roleKey === 'system_admin' ? [{ key: 'settings' as const, label: t.settings.title, icon: 'settings' as const, group: 'system' as const }] : []),
  ]

  return (
    <div className="flex min-h-dvh">
      {/* On a phone/tablet the rail is an off-canvas drawer; a dim overlay closes it. On lg+ it is
          a normal static column and the overlay/hamburger never show. */}
      {navOpen ? (
        <div className="fixed inset-0 z-30 bg-scrim/40 lg:hidden" onClick={() => setNavOpen(false)} aria-hidden="true" />
      ) : null}
      <aside
        className={`fixed inset-y-0 start-0 z-40 flex w-60 flex-col gap-1 overflow-y-auto border-e border-slate-200 bg-surface-card p-3 transition-transform lg:static lg:z-auto lg:translate-x-0 ${
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
        {([undefined, 'money', 'fleet', 'system'] as const).map((group) => {
          const items = nav.filter((n) => n.group === group)
          // A group whose every item was filtered out by role disappears with them, rather than
          // leaving a heading over nothing.
          if (items.length === 0) return null
          const heading =
            group === 'money'
              ? t.common.navMoney
              : group === 'fleet'
                ? t.common.navFleet
                : group === 'system'
                  ? t.common.navSystem
                  : null
          return (
            <div key={group ?? 'daily'} className="flex flex-col gap-1">
              {heading ? (
                // No `uppercase`, no `tracking-wider`: Arabic has no letter case, and extra tracking
                // pulls apart the joins that make the script legible. Weight and colour do the work.
                <div className="mt-3 px-3 pb-0.5 text-label font-semibold text-ink-faint">{heading}</div>
              ) : null}
              {items.map((n) => (
                <button
                  key={n.key}
                  onClick={() => {
                    setSection(n.key)
                    setOpenShift(null)
                    setNavOpen(false)
                  }}
                  aria-current={section === n.key && !openShift ? 'page' : undefined}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-start text-body font-medium outline-none transition-colors ${FOCUS_RING} ${
                    section === n.key && !openShift
                      ? 'bg-brand text-ink-inverse shadow-sm'
                      : 'text-ink-secondary hover:bg-surface-raised'
                  }`}
                >
                  <Icon name={n.icon} />
                  <span className="min-w-0 flex-1 truncate">{n.label}</span>
                  {n.badge ? <Badge tone="danger">{n.badge}</Badge> : null}
                </button>
              ))}
            </div>
          )
        })}
        <div className="mt-auto flex flex-col gap-1 border-t border-line-subtle pt-2">
          {/*
            Three states, not a switch. «Auto» is the default and follows the device, so a manager
            who never thinks about this still gets the right thing at night; the other two are a
            deliberate override that survives reloads. A two-way toggle would have forced everyone
            to make a choice they mostly do not have.
          */}
          <div className="px-3 pb-1 pt-1 text-label font-medium text-ink-muted">{t.common.theme}</div>
          <div role="group" aria-label={t.common.theme} className="flex gap-1 px-2 pb-1">
            {([
              ['system', t.common.themeSystem],
              ['light', t.common.themeLight],
              ['dark', t.common.themeDark],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                aria-pressed={theme === value}
                className={`flex-1 rounded-lg px-2 py-1.5 text-label font-medium outline-none transition-colors ${FOCUS_RING} ${
                  theme === value
                    ? 'bg-brand text-ink-inverse'
                    : 'text-ink-secondary hover:bg-surface-raised'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
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
        <div className="flex items-center gap-3 border-b border-slate-200 bg-surface-card p-3 lg:hidden">
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
        {/*
          * `max-w-[110rem]` and a page title, neither of which existed.
          *
          * The frame was `p-3 lg:p-6` with no width bound, so on a 27-inch monitor the treasury
          * tables ran to two thousand pixels and a seven-column row became a horizon. And the name
          * of the screen you were on appeared nowhere except the highlighted pill in the rail — on
          * a phone, where the rail is a closed drawer, it appeared nowhere at all.
          *
          * The shift review is exempt: it carries its own header, and a second one above it would
          * be two titles for one screen.
          */}
        <main className="flex-1 overflow-y-auto p-3 lg:p-6">
        <HashParamsContext.Provider value={replaceParams}>
        <div className="mx-auto w-full max-w-[110rem]">
        {!openShift ? (
          <h1 className="mb-4 text-page font-bold text-ink">
            {nav.find((n) => n.key === section)?.label ?? t.dashboard.title}
          </h1>
        ) : null}
        {openShift ? (
          /* A notification can replace `openShift` while a review is already mounted. Keying the
             workspace prevents typed cash/top-up or confirmations from one driver surviving into
             another driver's shift.

             ITS OWN BOUNDARY. The root one in `main.tsx` catches everything, but a throw here takes
             the whole console down with it — the rail, the queue, the treasury. This screen is the
             one under active rebuild and the one a manager is standing at a counter using, so a
             throw should cost him this shift's review and nothing else. */
          <ErrorBoundary key={`boundary:${openShift}`}>
            <Approval key={openShift} shiftId={openShift} onDone={() => setOpenShift(null)} />
          </ErrorBoundary>
        ) : section === 'dashboard' ? (
          <Dashboard key={mountKey} initial={liveParams.current} />
        ) : section === 'queue' ? (
          <Queue onOpen={setOpenShift} />
        ) : section === 'liveShifts' ? (
          <LiveShifts key={mountKey} initial={liveParams.current} onOpen={setOpenShift} />
        ) : section === 'completedShifts' ? (
          <CompletedShifts key={mountKey} initial={liveParams.current} onOpen={setOpenShift} />
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
        ) : section === 'removals' ? (
          <Removals />
        ) : section === 'permissions' ? (
          <Permissions />
        ) : section === 'settings' ? (
          <Settings />
        ) : (
          <Treasury />
        )}
        </div>
        </HashParamsContext.Provider>
        </main>
      </div>
    </div>
  )
}
