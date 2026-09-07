import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { type RoleKey, type ShiftPattern, can, minor, parseMinor, shortfallMinutes } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Card, Figure, Money, Pending, Stat } from '../ui.tsx'
import { LatestRequestGuard } from '../latest-request.ts'
import { differenceView } from '../treasury-view.ts'
import { type WorkingNowSnapshot, startWorkingNowPolling } from '../working-now.ts'

interface ExpiringDoc {
  id: string
  kind: string
  ownerKind: 'driver' | 'vehicle'
  ownerName: string | null
  driverId: string | null
  vehicleId: string | null
  expiresOn: string | null
  status: string
}
const statusTone: Record<string, 'amber' | 'red' | 'green' | 'slate'> = {
  expiring_soon: 'amber',
  expires_today: 'red',
  expired: 'red',
  valid: 'green',
  no_expiry: 'slate',
}

interface Attendee {
  userId: string
  name: string
  firstSeenAt: string
  lastSeenAt: string
}
/** «HH:MM» in the viewer's locale — attendance is a time of day, not a full timestamp. */
const hhmm = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * The same per-pattern targets the completed-shifts screen applies.
 *
 * Duplicated deliberately and briefly: both belong in `settings` beside the FX rate, and until they
 * are there a shared constant in a third module would be a home for a rule that has no home yet.
 * `unknown` is null — a shift with no pattern cannot be short of anything.
 */
const DASHBOARD_TARGET_MINUTES: Record<ShiftPattern, number | null> = {
  day: 8 * 60,
  evening: 8 * 60,
  full: 16 * 60,
  unknown: null,
}

interface WorkedTime {
  minutes: number | null
  pattern: ShiftPattern
  abandoned: boolean
}

interface DashboardData {
  businessDate: string
  revenue: { feesSyp: string; feesUsd: string | null; fxProvisional: boolean }
  orders: { total: number; perDriver: Array<{ driverId: string; name: string; code: string | null; orders: number; feesSyp: string }> }
  companyShareSinceSunday: string
  fleet: { ready: number; charging: number; maintenance: number; stopped: number }
  completeness: { openShifts: number; awaitingApproval: number; missingEndPackage: number; suspended: number }
}

/** The owner's own sheet — «راس المال المدور · ربح الشركة · دخل وخرج الصندوق». */
interface TreasuryDigest {
  from: string
  to: string
  capital: {
    officeCash: string
    officeWallet: string
    receivablesCash: string
    // «السلف» — money out on loan, still office capital. Optional for a rolling deploy.
    advancesCash?: string
    advancesWallet?: string
    advancesTotal?: string
    receivablesWallet: string
    officePosition: string
    cashPosition: string
    walletPosition: string
    cashTarget: string
    walletTarget: string
    cashDelta: string
    walletDelta: string
    activeCustodyCash: string
    activeCustodyWallet: string
    activeCustodyTotal: string
    /** True while a shift is open: the position is mid-sentence, so a surplus is not yet a fact. */
    deltaProvisional: boolean
    activeShiftCount: number
    workingCapitalTotal: string
    workingCapitalDelta: string
    restorationDelta: string
    total: string
    target: string
    delta: string
  }
  companyProfit: string
  companyFund: string
  fundIn: string
  fundOut: string
  fundNet: string
  days: Array<{ businessDate: string; in: string; out: string; net: string }>
}

interface ProfitDay {
  businessDate: string
  companyShareSyp: string
  otherIncomeSyp: string
  expenseSyp: string
  netProfitSyp: string
}

interface ProfitDigest {
  from: string
  to: string
  weekStart: string
  companyShareSyp: string
  driverShareSyp: string
  yalagoShareSyp: string
  otherIncomeSyp: string
  expenseSyp: string
  netProfitSyp: string
  days: ProfitDay[]
}

/**
 * Fourteen days of net, as bars on a zero baseline.
 *
 * BARS, NOT A LINE, and the reason is in the data: measured net swings from −13,543 to +8,479, and
 * the low day is not a slump — it is the day a month of salaries was paid. A polyline renders that
 * as a dip in a trend. A bar crossing a zero rule renders it as what it is: one day below the line
 * among days above it, which is a fact a manager can act on instead of an alarm.
 *
 * Drawn here rather than pulled from a chart library. `apps/admin` has four runtime dependencies and
 * its vite config says charts must be lazy-loaded per route; seven rectangles do not justify either.
 *
 * `fill="currentColor"` with a role-token class, so no palette literal ever reaches the SVG and the
 * bars follow the theme like everything else.
 */
function ProfitTrend({ days }: { days: ProfitDay[] }): ReactNode {
  const values = days.map((d) => Number(parseMinor(d.netProfitSyp)))
  const peak = Math.max(1, ...values.map((v) => Math.abs(v)))
  const width = 100
  const height = 40
  const zeroY = height / 2
  const slot = width / Math.max(1, days.length)
  const barWidth = Math.max(1, slot * 0.62)

  return (
    // Time reads left-to-right in both languages, exactly as every other figure in this console.
    <div dir="ltr">
      <svg
        role="img"
        aria-label={days.map((d) => `${d.businessDate}: ${d.netProfitSyp}`).join(', ')}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block h-24 w-full"
      >
        {/* A rect, not a stroked line: `preserveAspectRatio="none"` scales a stroke
            anisotropically and the baseline would come out wedge-shaped. */}
        <rect x="0" y={zeroY - 0.15} width={width} height="0.3" className="text-line-strong" fill="currentColor" />
        {days.map((d, i) => {
          const value = values[i] ?? 0
          const magnitude = (Math.abs(value) / peak) * (height / 2 - 1)
          return (
            <rect
              key={d.businessDate}
              x={i * slot + (slot - barWidth) / 2}
              y={value < 0 ? zeroY : zeroY - magnitude}
              width={barWidth}
              height={Math.max(0.4, magnitude)}
              className={value < 0 ? 'text-danger-ink' : 'text-success-ink'}
              fill="currentColor"
            />
          )
        })}
      </svg>
    </div>
  )
}

/** The operations dashboard (SRS I-1). Total profit is a GM-only tile, fetched separately. */
export function Dashboard(): ReactNode {
  const { api, t, session, branchId } = useApp()
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  /*
   * `from`/`to` are declared because the card MUST say which period it is showing.
   *
   * They were always on the wire and always discarded, and that is how «الأرباح الإجمالية» came to
   * sit beside a date input showing today while reporting the whole financial week: with no range
   * sent, the server defaults `from` to the Sunday. Reading a day and being handed a week is the
   * kind of quiet wrongness a manager only catches by doing the arithmetic himself.
   */
  const [profit, setProfit] = useState<ProfitDigest | null>(null)
  const [treasury, setTreasury] = useState<TreasuryDigest | null>(null)
  const [expiring, setExpiring] = useState<ExpiringDoc[]>([])
  const [attendance, setAttendance] = useState<Attendee[]>([])
  const [workingNow, setWorkingNow] = useState<WorkingNowSnapshot | null>(null)
  const [workingNowUnavailable, setWorkingNowUnavailable] = useState(false)
  /** How many of the day's finished shifts fell short of their own pattern's target, and by how much. */
  const [underTarget, setUnderTarget] = useState<{ count: number; minutes: number } | null>(null)
  /**
   * Which business day the financial panels describe. `null` means "whatever the server calls
   * today", and the first response fills it in from its own `to`.
   *
   * Deliberately NOT computed here. The business day rolls at 04:00, not midnight, so at 01:30
   * «today» is still yesterday's date — and that rule lives in `businessDateFor` on the server.
   * Re-deriving it in the browser would be a second copy free to drift, and the four hours either
   * side of the boundary are exactly when a manager is closing shifts.
   *
   * The picker DISPLAYS `day ?? data.to` rather than adopting the server's date into this state:
   * writing it back here would change `load`, refetch, and show the manager a flicker for nothing.
   */
  const [day, setDay] = useState<string | null>(null)
  const dashboardRequests = useRef(new LatestRequestGuard())

  // `branchId` is a dependency: an organisation-wide role picks his branch AFTER the first render,
  // and switching branches must refetch rather than leave last branch's figures on screen.
  const load = useCallback(() => {
    const request = dashboardRequests.current.next()
    // Clear every branch-bound panel together. Otherwise the fast working-count read can show the
    // new branch beside financial cards left over from the previous one while their requests race.
    setData(null)
    setError(null)
    setProfit(null)
    setTreasury(null)
    setExpiring([])
    setAttendance([])
    // One day, not a range: `from` and `to` are the same date. Omitted entirely until the user
    // picks one, so the server's own «today» stays the default.
    const range = day === null ? '' : `?from=${encodeURIComponent(day)}&to=${encodeURIComponent(day)}`
    const dayQuery = day === null ? '' : `?day=${encodeURIComponent(day)}`
    void api
      .get<DashboardData>(`/dashboard${dayQuery}`, { cache: 'no-store', signal: request.signal })
      .then((d) => {
        if (!request.isCurrent()) return
        setData(d)
        setError(null)
      })
      .catch((e: { error?: string }) => {
        if (!request.isCurrent()) return
        setData(null)
        setError(e.error ?? 'error')
      })
    /*
     * BR8's «رؤية الأرباح والحصص الإجمالية». This read `roleKey === 'general_manager'`, which owner
     * decision 9 made wrong on 2026-08-12: the system admin holds `profit.view_total` too and was
     * shown a dashboard silently missing the two cards he is entitled to. Ask the rule.
     */
    if (
      session != null &&
      can({ userId: session.userId, roleKey: session.roleKey as RoleKey, branchId: session.branchId }, 'profit.view_total', {}).allowed
    ) {
      void api
        .get<NonNullable<typeof profit>>(`/dashboard/profit${range}`, { cache: 'no-store', signal: request.signal })
        .then((next) => {
          if (request.isCurrent()) setProfit(next)
        })
        .catch(() => {
          if (request.isCurrent()) setProfit(null)
        })
      void api
        // The same range as the profit card. It used to be called bare, so «كشف الصندوق ورأس المال»
        // answered for the week no matter which day was picked — disclosed, since it prints its own
        // from → to, but never actually responsive.
        .get<TreasuryDigest>(`/dashboard/treasury${range}`, { cache: 'no-store', signal: request.signal })
        .then((next) => {
          if (request.isCurrent()) setTreasury(next)
        })
        .catch(() => {
          if (request.isCurrent()) setTreasury(null)
        })
    }
    // The expiry board (س37). Reading it also raises the bell for anything crossing a threshold,
    // so the alert fires automatically on the default landing screen — no scheduler needed.
    void api
      .get<{ documents: ExpiringDoc[] }>('/documents/expiring', { cache: 'no-store', signal: request.signal })
      .then((r) => {
        if (request.isCurrent()) setExpiring(r.documents)
      })
      .catch(() => {
        if (request.isCurrent()) setExpiring([])
      })
    // Today's admin-staff attendance (B-4).
    void api
      .get<{ attendance: Attendee[] }>('/attendance', { cache: 'no-store', signal: request.signal })
      .then((r) => {
        if (request.isCurrent()) setAttendance(r.attendance)
      })
      .catch(() => {
        if (request.isCurrent()) setAttendance([])
      })
  }, [api, session, day])

  useEffect(() => {
    load()
    return () => dashboardRequests.current.cancel()
  }, [load, branchId])

  /*
   * WHO DID NOT MAKE THE HOURS, on the day this screen is showing.
   *
   * Keyed on the RESOLVED business date rather than on `day`, because `day` is null until the
   * manager picks one and the server's own «today» is the default — reading the wrong date here
   * would put yesterday's shortfall beside today's profit.
   *
   * Each shift is judged against its own pattern's target: a `full` shift covers both slots, so
   * against one slot's eight hours a 13-hour shift would read as five hours of overtime when it is
   * three hours short of the two it replaced. A live shift, an unclassified one and one whose close
   * was simply forgotten all return null and are counted as neither short nor met.
   */
  useEffect(() => {
    const businessDate = data?.businessDate
    if (!businessDate) return
    let cancelled = false
    void api
      .get<{ shifts: Array<{ worked?: WorkedTime }> }>(
        `/shifts?from=${encodeURIComponent(businessDate)}&to=${encodeURIComponent(businessDate)}`,
        { cache: 'no-store' },
      )
      .then((page) => {
        if (cancelled) return
        let count = 0
        let minutes = 0
        for (const shift of page.shifts) {
          if (!shift.worked) continue
          const target = DASHBOARD_TARGET_MINUTES[shift.worked.pattern]
          if (target === null) continue
          const short = shortfallMinutes(shift.worked, target)
          if (short !== null && short > 0) {
            count += 1
            minutes += short
          }
        }
        setUnderTarget({ count, minutes })
      })
      .catch(() => {
        // An older API serves no `worked`, and a failed read is not a claim that nobody was short.
        if (!cancelled) setUnderTarget(null)
      })
    return () => {
      cancelled = true
    }
  }, [api, branchId, data?.businessDate])

  // This poll intentionally calls only the lightweight count endpoint. On a transient failure the
  // last valid values stay on screen and are marked stale; a branch change clears the old branch's
  // values and starts a new read immediately. Cleanup ignores any late response from that branch.
  useEffect(() => {
    setWorkingNow(null)
    setWorkingNowUnavailable(false)
    return startWorkingNowPolling({
      load: (signal) => api.get<WorkingNowSnapshot>('/dashboard/working-now', { cache: 'no-store', signal }),
      onSnapshot: (snapshot) => {
        setWorkingNow(snapshot)
        setWorkingNowUnavailable(false)
      },
      onUnavailable: () => setWorkingNowUnavailable(true),
    })
  }, [api, branchId])

  if (!data) {
    return (
      <Pending
        error={error}
        loadingLabel={t.common.loading}
        errorLabel={explainError(error, t)}
        onRetry={load}
        retryLabel={t.common.retry}
      />
    )
  }

  const capitalDelta = treasury ? differenceView(treasury.capital.delta) : null
  // `data.businessDate` is the server's own answer, already past the 04:00 rule.
  const shownDay = day ?? data.businessDate

  /*
   * The day's own row out of the period, so one call answers both tiles.
   *
   * Falls back to the last day that moved: on a quiet morning the current business date has no
   * ledger entry yet, and «—» is a truer answer than someone else's day dressed as today.
   */
  const profitToday = profit?.days.find((d) => d.businessDate === shownDay) ?? null

  /** Margin on what the company actually took in — share plus other income, not delivery fees. */
  const profitMargin = ((): number | null => {
    if (!profit) return null
    const revenue = parseMinor(profit.companyShareSyp) + parseMinor(profit.otherIncomeSyp)
    if (revenue <= minor(0n)) return null
    return Math.round((Number(parseMinor(profit.netProfitSyp)) / Number(revenue)) * 100)
  })()

  /*
   * Why today's net may not mean what it looks like.
   *
   * Measured on this branch: fifteen of twenty-four business days carry no expense row at all, so
   * on most days a «net» is silently the gross. And approval postings are stamped with the SHIFT's
   * business date, not the approval date, so a day keeps changing while its shifts are unapproved.
   * Both are stated rather than left for the reader to discover.
   */
  const dayProfitCaveat = ((): ReactNode => {
    if (!profitToday) return undefined
    if (parseMinor(profitToday.expenseSyp) === minor(0n)) {
      return <span className="text-warning-ink">{t.dashboard.noExpensesYet}</span>
    }
    if (data.completeness.awaitingApproval > 0) {
      return (
        <span className="text-warning-ink">
          {t.dashboard.notFinalYet.replace('{n}', String(data.completeness.awaitingApproval))}
        </span>
      )
    }
    return undefined
  })()
  const workingCountsStatusText = workingNowUnavailable
    ? workingNow
      ? t.dashboard.workingCountsStale
      : t.dashboard.workingCountsUnavailable
    : null
  const workingCountsStatus = workingCountsStatusText ? (
    <span className="font-medium text-amber-700">{workingCountsStatusText}</span>
  ) : undefined
  const workingCountsAnnouncement = workingCountsStatusText ?? (
    workingNow
      ? `${t.dashboard.workingDrivers}: ${workingNow.drivers}; ${t.dashboard.workingVehicles}: ${workingNow.vehicles}`
      : ''
  )

  return (
    <div className="flex flex-col gap-4">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {workingCountsAnnouncement}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm font-medium text-slate-700" htmlFor="dashboard-day">
          {t.dashboard.day}
        </label>
        <input
          id="dashboard-day"
          type="date"
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={shownDay}
          onChange={(e) => setDay(e.target.value === '' ? null : e.target.value)}
        />
        <button
          type="button"
          className="rounded-md border border-slate-300 px-2 py-1 text-sm disabled:opacity-50"
          onClick={() => setDay(null)}
          disabled={day === null}
        >
          {t.dashboard.today}
        </button>
        <span className="text-xs text-slate-500">{t.dashboard.dayEndsAtFour}</span>
      </div>
      {/*
        PROFIT FIRST. The screen used to open with six equally weighted tiles — revenue, orders,
        drivers, vehicles, company share, awaiting approval — and not one of them was profit. The
        general manager opens this screen for one question, so it is answered before anything else.
      */}
      {profit ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat
              lead
              className="sm:col-span-2"
              label={t.dashboard.netProfit}
              value={<Money value={profit.netProfitSyp} />}
              tone={parseMinor(profit.netProfitSyp) < minor(0n) ? 'danger' : 'success'}
              sub={
                <span className="flex flex-wrap items-center gap-x-2">
                  {profitMargin === null ? null : <span>{t.dashboard.margin} {profitMargin}%</span>}
                  {/* The period, stated. Without it this tile silently reported the whole financial
                      week while the date input beside it showed today. */}
                  <span className="num" dir="ltr">
                    {profit.from} → {profit.to}
                  </span>
                </span>
              }
            />
            <Stat
              label={t.dashboard.netToday}
              value={profitToday ? <Money value={profitToday.netProfitSyp} /> : '—'}
              {...(profitToday && parseMinor(profitToday.netProfitSyp) < minor(0n)
                ? { tone: 'danger' as const }
                : {})}
              sub={dayProfitCaveat}
            />
          </div>

          {/*
            The bridge, and it is built ENTIRELY from ledger figures so it adds up on screen.
            Building it downward from delivery fees was the obvious shape and it does not reconcile:
            fees 206,745 at a 20% Yallago cut and a 40% driver share leaves 82,698, but the ledger
            holds 81,108.50 — a manual journal entry can move `company_revenue` with no shift behind
            it. A bridge whose own rows do not sum costs the reader his trust in every other number
            on the page, so the fee split is shown as CONTEXT in the subtitle instead.
          */}
          <Card
            title={t.dashboard.profitBridge}
            subtitle={`${t.dashboard.feeSplit}: ${t.dashboard.companyShareLabel} ${profit.companyShareSyp} · ${t.orders.driverShare} ${profit.driverShareSyp} · ${t.dashboard.yalagoShareLabel} ${profit.yalagoShareSyp}`}
          >
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              <Figure
                label={t.dashboard.companyShareLabel}
                value={<Money value={profit.companyShareSyp} />}
              />
              <Figure
                label={t.dashboard.otherIncome}
                value={<Money value={profit.otherIncomeSyp} />}
              />
              <Figure
                label={t.dashboard.expensesLabel}
                value={<Money value={profit.expenseSyp} />}
                {...(parseMinor(profit.expenseSyp) > minor(0n) ? { tone: 'danger' as const } : {})}
              />
              <Figure
                label={t.dashboard.netProfit}
                value={<Money value={profit.netProfitSyp} />}
                size="lg"
                tone={parseMinor(profit.netProfitSyp) < minor(0n) ? 'danger' : 'success'}
              />
            </dl>
          </Card>

          {profit.days.length > 1 ? (
            <Card title={t.dashboard.last14Days}>
              <ProfitTrend days={profit.days.slice(-14)} />
            </Card>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label={t.dashboard.revenue}
          value={<Money value={data.revenue.feesSyp} />}
          sub={data.revenue.feesUsd ? <>${data.revenue.feesUsd}{data.revenue.fxProvisional ? ' ~' : ''}</> : undefined}
        />
        <Stat label={t.dashboard.orders} value={data.orders.total} />
        <Stat label={t.dashboard.workingDrivers} value={workingNow?.drivers ?? '—'} sub={workingCountsStatus} />
        <Stat label={t.dashboard.workingVehicles} value={workingNow?.vehicles ?? '—'} sub={workingCountsStatus} />
        <Stat label={t.dashboard.companyShare} value={<Money value={data.companyShareSinceSunday} />} />
        <Stat
          label={t.dashboard.awaitingApproval}
          value={data.completeness.awaitingApproval}
          href="#queue"
        />
        {/* Only when there is something to say. A standing «0» in a six-tile row is noise. */}
        {underTarget && underTarget.count > 0 ? (
          <Stat
            label={t.dashboard.shiftsUnderTarget}
            value={<span className="num">{underTarget.count}</span>}
            sub={t.dashboard.shiftsUnderTargetSub.replace(
              '{t}',
              `${Math.floor(underTarget.minutes / 60)}:${String(underTarget.minutes % 60).padStart(2, '0')}`,
            )}
            tone="warning"
            href="#completedShifts"
          />
        ) : null}
      </div>

      {/*
        The owner's own sheet, in his own words. «راس المال المدور» is a position — both boxes plus
        everything out on ذمم — and the two flow figures are his «كييش» and «شحن من الصندوق»
        SUMIFs, derived from the ledger event rather than from a hand-typed Arabic word.
      */}
      {treasury ? (
        <Card title={t.dashboard.ownersSheet}>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat
              label={t.dashboard.workingCapital}
              value={<Money value={treasury.capital.total} />}
              sub={
                <span className="flex flex-col gap-1">
                  <span>{t.treasury.capitalTarget}: <Money value={treasury.capital.target} /></span>
                  {/*
                    A SURPLUS IS NOT ASSERTED WHILE A SHIFT IS OPEN.

                    An open shift has posted nothing since its float left the box — its orders, its
                    share and its variance all land at approval — so any «زيادة» read off the
                    position now is money the day has not earned. On 2026-08-29 this said
                    «زيادة عن رأس المال: 6,502.00» with five shifts open, while the ledger showed
                    today had moved working capital by exactly 0.00: every lira of it had
                    accumulated before the epoch. True about the balance, false about the day, and
                    the day is what a reader takes from it.

                    A SHORTFALL still shows. Holding back premature good news protects the reader;
                    holding back bad news hides the one direction that means money is missing.
                  */}
                  {capitalDelta && capitalDelta.direction === 'increase' && treasury.capital.deltaProvisional ? (
                    <span className="text-slate-500">
                      {t.dashboard.surplusPending.replace('{n}', String(treasury.capital.activeShiftCount))}
                    </span>
                  ) : capitalDelta ? (
                    <span
                      className={
                        capitalDelta.direction === 'increase'
                          ? 'text-emerald-700'
                          : capitalDelta.direction === 'shortage'
                            ? 'text-amber-700'
                            : 'text-slate-600'
                      }
                    >
                      {capitalDelta.direction === 'increase'
                        ? t.treasury.capitalSurplus
                        : capitalDelta.direction === 'shortage'
                          ? t.treasury.capitalShortage
                          : t.treasury.onTarget}
                      {capitalDelta.direction === 'none' ? null : <>: <Money value={capitalDelta.amount} /></>}
                    </span>
                  ) : null}
                </span>
              }
            />
            <Stat label={t.dashboard.companyProfitLabel} value={<Money value={treasury.companyProfit} />} />
            <Stat label={t.dashboard.fundIn} value={<Money value={treasury.fundIn} />} />
            <Stat label={t.dashboard.fundOut} value={<Money value={treasury.fundOut} />} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <dt className="text-slate-600">{t.treasury.cashBox}</dt>
            <dd className="text-end sm:col-span-2">
              <Money value={treasury.capital.officeCash} />
              <span className="text-slate-500">
                {' + '}
                {t.treasury.receivablesShort} <Money value={treasury.capital.receivablesCash} />
              </span>
              {treasury.capital.advancesCash && treasury.capital.advancesCash !== '0.00' ? (
                <span className="text-slate-500">
                  {' + '}
                  {t.treasury.advances} <Money value={treasury.capital.advancesCash} />
                </span>
              ) : null}
            </dd>
            <dt className="text-slate-600">{t.treasury.wallet}</dt>
            <dd className="text-end sm:col-span-2">
              <Money value={treasury.capital.officeWallet} />
              <span className="text-slate-500">
                {' + '}
                {t.treasury.receivablesShort} <Money value={treasury.capital.receivablesWallet} />
              </span>
              {treasury.capital.advancesWallet && treasury.capital.advancesWallet !== '0.00' ? (
                <span className="text-slate-500">
                  {' + '}
                  {t.treasury.advances} <Money value={treasury.capital.advancesWallet} />
                </span>
              ) : null}
            </dd>
            <dt className="text-slate-600">{t.dashboard.officePosition}</dt>
            <dd className="text-end font-semibold sm:col-span-2">
              <Money value={treasury.capital.officePosition} />
            </dd>

            {/*
              The surplus, split by BOX. The two are restored against separate targets, so a
              surplus on one side and a shortfall on the other can cancel to a reassuring total
              while both boxes are wrong. Each side carries its own custody and receivables.
            */}
            <dt className="col-span-full mt-2 text-xs font-semibold text-slate-500">
              {t.dashboard.capitalByBox}
            </dt>
            {([
              ['cash', t.treasury.cashBox, treasury.capital.cashPosition, treasury.capital.cashTarget, treasury.capital.cashDelta],
              ['wallet', t.treasury.wallet, treasury.capital.walletPosition, treasury.capital.walletTarget, treasury.capital.walletDelta],
            ] as const).map(([key, label, position, target, delta]) => {
              const view = differenceView(delta)
              return (
                <Fragment key={key}>
                  <dt className="text-slate-600">{label}</dt>
                  <dd className="text-end sm:col-span-2">
                    <Money value={position} />
                    <span className="text-slate-500">
                      {' / '}
                      <Money value={target} />
                    </span>
                    <span
                      className={
                        view.direction === 'increase'
                          ? 'ms-2 font-semibold text-emerald-700'
                          : view.direction === 'shortage'
                            ? 'ms-2 font-semibold text-amber-700'
                            : 'ms-2 text-slate-500'
                      }
                    >
                      {view.direction === 'none' ? (
                        t.treasury.onTarget
                      ) : (
                        <>
                          {view.direction === 'increase' ? '+' : '−'}
                          <Money value={view.amount} />
                        </>
                      )}
                    </span>
                  </dd>
                </Fragment>
              )
            })}
            <dt className="text-slate-600">
              {t.dashboard.activeShiftCustody.replace('{n}', String(treasury.capital.activeShiftCount))}
            </dt>
            <dd className="text-end font-semibold text-sky-700 sm:col-span-2">
              <Money value={treasury.capital.activeCustodyTotal} />
              <span className="ms-2 text-xs font-normal text-slate-500">
                ({t.treasury.cashBox}: <Money value={treasury.capital.activeCustodyCash} />
                {' · '}{t.treasury.wallet}: <Money value={treasury.capital.activeCustodyWallet} />)
              </span>
            </dd>
            <dt className="text-slate-600">{t.treasury.companyFund}</dt>
            <dd className="text-end font-semibold sm:col-span-2">
              <Money value={treasury.companyFund} />
            </dd>
            <dt className="text-slate-600">{t.dashboard.fundNet}</dt>
            <dd
              className={`text-end font-semibold sm:col-span-2 ${
                parseMinor(treasury.fundNet) < minor(0n) ? 'text-amber-700' : 'text-emerald-700'
              }`}
            >
              <Money value={treasury.fundNet} />
            </dd>
          </dl>
          <p className="mt-2 text-xs text-slate-500">
            {t.dashboard.sincePeriod} {treasury.from} → {treasury.to}
          </p>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title={t.dashboard.fleetReadiness}>
          <div className="grid grid-cols-4 gap-2 text-center">
            <div><div className="text-2xl font-bold text-emerald-600">{data.fleet.ready}</div><div className="text-xs">{t.fleet.vehicleStates.ready}</div></div>
            <div><div className="text-2xl font-bold text-sky-600">{data.fleet.charging}</div><div className="text-xs">{t.fleet.vehicleStates.charging}</div></div>
            <div><div className="text-2xl font-bold text-amber-600">{data.fleet.maintenance}</div><div className="text-xs">{t.fleet.vehicleStates.maintenance}</div></div>
            <div><div className="text-2xl font-bold text-slate-500">{data.fleet.stopped}</div><div className="text-xs">{t.fleet.vehicleStates.stopped}</div></div>
          </div>
        </Card>

        <Card title={t.dashboard.ordersPerDriver}>
          <ul className="flex flex-col gap-1 text-sm">
            {data.orders.perDriver.map((d) => (
              <li key={d.driverId} className="flex items-center justify-between">
                <span className="text-slate-600">{d.name}</span>
                <span>
                  {d.orders} — <Money value={d.feesSyp} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {expiring.length > 0 ? (
        <Card title={t.dashboard.expiringDocuments}>
          <ul className="flex flex-col gap-1 text-sm">
            {expiring.map((d) => {
              const ownerKindLabel = t.fleet.ownerKinds[d.ownerKind]
              const kind = t.fleet.docKinds[d.kind as keyof typeof t.fleet.docKinds] ?? d.kind
              return (
                <li key={d.id} className="flex items-center justify-between gap-2 border-b border-slate-100 py-1 last:border-0">
                  <span>
                    <span className="font-medium">{d.ownerName ?? ownerKindLabel}</span>
                    <span className="text-slate-600"> · {kind}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="num text-slate-500">{d.expiresOn}</span>
                    <Badge tone={statusTone[d.status] ?? 'slate'}>
                      {t.fleet.docStatus[d.status as keyof typeof t.fleet.docStatus] ?? d.status}
                    </Badge>
                  </span>
                </li>
              )
            })}
          </ul>
        </Card>
      ) : null}

      {attendance.length > 0 ? (
        <Card title={t.dashboard.attendanceToday}>
          <ul className="flex flex-col gap-1 text-sm">
            {attendance.map((a) => (
              <li key={a.userId} className="flex items-center justify-between gap-2 border-b border-slate-100 py-1 last:border-0">
                <span>{a.name}</span>
                <span className="num text-slate-500">
                  {hhmm(a.firstSeenAt)} – {hhmm(a.lastSeenAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}
