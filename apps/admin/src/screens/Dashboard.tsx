import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Card, Money, Pending, Stat } from '../ui.tsx'

interface ExpiringDoc {
  id: string
  kind: string
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
  orders: { total: number; perDriver: Array<{ driverId: string; orders: number; feesSyp: string }> }
  companyShareSinceSunday: string
  fleet: { ready: number; charging: number; maintenance: number; stopped: number }
  completeness: { openShifts: number; awaitingApproval: number; missingEndPackage: number; suspended: number }
}

/** The five-indicator ops dashboard (SRS I-1). Total profit is a GM-only tile, fetched separately. */
export function Dashboard(): ReactNode {
  const { api, t, session, branchId } = useApp()
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [profit, setProfit] = useState<{ companyShareSyp: string; driverShareSyp: string; yalagoShareSyp: string } | null>(null)
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
    // Only the GM may see total profit (BR8); a 403 for anyone else simply leaves the tile absent.
    if (session?.roleKey === 'general_manager') {
      void api.get<typeof profit>('/dashboard/profit').then(setProfit).catch(() => setProfit(null))
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
        />
      </div>

      {profit ? (
        <Card title={t.dashboard.totalProfit}>
          <div className="grid grid-cols-3 gap-4">
            <Stat label={t.tiers.driverShare} value={<Money value={profit.driverShareSyp} />} />
            <Stat label="الشركة" value={<Money value={profit.companyShareSyp} />} />
            <Stat label="يلاغو" value={<Money value={profit.yalagoShareSyp} />} />
          </div>
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

        <Card title={t.dashboard.orders}>
          <ul className="flex flex-col gap-1 text-sm">
            {data.orders.perDriver.map((d) => (
              <li key={d.driverId} className="flex items-center justify-between">
                <span className="text-slate-500">{d.driverId}</span>
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
              const owner = d.driverId ? t.fleet.ownerKinds.driver : t.fleet.ownerKinds.vehicle
              const kind = t.fleet.docKinds[d.kind as keyof typeof t.fleet.docKinds] ?? d.kind
              return (
                <li key={d.id} className="flex items-center justify-between gap-2 border-b border-slate-100 py-1 last:border-0">
                  <span>
                    <span className="text-slate-400">{owner}</span> · {kind}
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
