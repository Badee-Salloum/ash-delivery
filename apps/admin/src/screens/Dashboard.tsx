import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { type RoleKey, can, minor, parseMinor } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Card, Money, Pending, Stat } from '../ui.tsx'
import { differenceView } from '../treasury-view.ts'

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
    receivablesWallet: string
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

/** The five-indicator ops dashboard (SRS I-1). Total profit is a GM-only tile, fetched separately. */
export function Dashboard(): ReactNode {
  const { api, t, session, branchId } = useApp()
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [profit, setProfit] = useState<{ companyShareSyp: string; driverShareSyp: string; yalagoShareSyp: string } | null>(null)
  const [treasury, setTreasury] = useState<TreasuryDigest | null>(null)
  const [expiring, setExpiring] = useState<ExpiringDoc[]>([])
  const [attendance, setAttendance] = useState<Attendee[]>([])

  // `branchId` is a dependency: an organisation-wide role picks his branch AFTER the first render,
  // and switching branches must refetch rather than leave last branch's figures on screen.
  const load = useCallback(() => {
    setError(null)
    void api
      .get<DashboardData>('/dashboard')
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e: { error?: string }) => {
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
      void api.get<typeof profit>('/dashboard/profit').then(setProfit).catch(() => setProfit(null))
      void api.get<TreasuryDigest>('/dashboard/treasury').then(setTreasury).catch(() => setTreasury(null))
    }
    // The expiry board (س37). Reading it also raises the bell for anything crossing a threshold,
    // so the alert fires automatically on the default landing screen — no scheduler needed.
    void api.expiringDocuments().then((r) => setExpiring(r.documents)).catch(() => setExpiring([]))
    // Today's admin-staff attendance (B-4).
    void api.attendance().then((r) => setAttendance(r.attendance)).catch(() => setAttendance([]))
  }, [api, session])

  useEffect(load, [load, branchId])

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

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label={t.dashboard.revenue}
          value={<Money value={data.revenue.feesSyp} />}
          sub={data.revenue.feesUsd ? <>${data.revenue.feesUsd}{data.revenue.fxProvisional ? ' ~' : ''}</> : undefined}
        />
        <Stat label={t.dashboard.orders} value={data.orders.total} />
        <Stat label={t.dashboard.companyShare} value={<Money value={data.companyShareSinceSunday} />} />
        <Stat
          label={t.dashboard.awaitingApproval}
          value={data.completeness.awaitingApproval}
          sub={`${t.dashboard.openShifts}: ${data.completeness.openShifts}`}
          href="#queue"
        />
      </div>

      {profit ? (
        <Card title={t.dashboard.totalProfit}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label={t.tiers.driverShare} value={<Money value={profit.driverShareSyp} />} />
            <Stat label={t.dashboard.companyShareLabel} value={<Money value={profit.companyShareSyp} />} />
            <Stat label={t.dashboard.yalagoShareLabel} value={<Money value={profit.yalagoShareSyp} />} />
          </div>
        </Card>
      ) : null}

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
                  {capitalDelta ? (
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
            </dd>
            <dt className="text-slate-600">{t.treasury.wallet}</dt>
            <dd className="text-end sm:col-span-2">
              <Money value={treasury.capital.officeWallet} />
              <span className="text-slate-500">
                {' + '}
                {t.treasury.receivablesShort} <Money value={treasury.capital.receivablesWallet} />
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
