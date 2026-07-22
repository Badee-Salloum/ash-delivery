import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { Card, Money, Stat } from '../ui.tsx'

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
  const { api, t, session } = useApp()
  const [data, setData] = useState<DashboardData | null>(null)
  const [profit, setProfit] = useState<{ companyShareSyp: string; driverShareSyp: string; yalagoShareSyp: string } | null>(null)

  useEffect(() => {
    void api.get<DashboardData>('/dashboard').then(setData).catch(() => setData(null))
    // Only the GM may see total profit (BR8); a 403 for anyone else simply leaves the tile absent.
    if (session?.roleKey === 'general_manager') {
      void api.get<typeof profit>('/dashboard/profit').then(setProfit).catch(() => setProfit(null))
    }
  }, [api, session])

  if (!data) return <Card>{t.common.loading}</Card>

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
    </div>
  )
}
