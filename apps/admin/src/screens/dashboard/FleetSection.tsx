import type { ReactNode } from 'react'
import { minor, parseMinor, type DateRange } from '@ash/domain'
import { useApp } from '../../app-context.tsx'
import { drill } from '../../drill.ts'
import { explainError } from '../../errors.ts'
import { Card, Money, Pending, Stat, Table } from '../../ui.tsx'
import { SectionHeading } from './SectionHeading.tsx'
import type { FleetPerformance } from './types.ts'
import { useDashboardRead } from './use-dashboard-read.ts'

export function FleetSection({ range }: { range: DateRange }): ReactNode {
  const { t } = useApp()
  const query = `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
  const { data, error, retry } = useDashboardRead<FleetPerformance>(`/dashboard/fleet-performance${query}`)

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-fleet">
      <SectionHeading title={t.dashboard.fleetTitle} />
      {data === null ? (
        <Pending
          error={error}
          loadingLabel={t.common.loading}
          errorLabel={explainError(error, t)}
          onRetry={retry}
          retryLabel={t.common.retry}
        />
      ) : (
        <div id="dashboard-fleet" className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t.dashboard.completedCount} value={data.totals.shifts} />
            <Stat label={t.dashboard.kilometres} value={data.totals.km} sub={data.totals.kmUnrecorded > 0 ? t.dashboard.unrecordedKm.replace('{n}', String(data.totals.kmUnrecorded)) : undefined} />
            <Stat label={t.dashboard.orders} value={data.totals.orders} />
            <Stat label={t.dashboard.revenue} value={<Money value={data.totals.feesSyp} />} />
          </div>
          <Card title={t.dashboard.vehiclePerformance} subtitle={t.dashboard.vehicleRowHint}>
            <Table
              head={[
                t.fleet.vehicleNumber,
                { label: t.dashboard.completedCount, numeric: true },
                { label: t.dashboard.kilometres, numeric: true },
                { label: t.dashboard.orders, numeric: true },
                ...(data.financeVisible
                  ? [
                      { label: t.dashboard.companyShareLabel, numeric: true } as const,
                      { label: t.dashboard.vehicleCosts, numeric: true } as const,
                      { label: t.dashboard.contribution, numeric: true } as const,
                    ]
                  : []),
              ]}
              isEmpty={data.vehicles.length === 0}
              empty={t.dashboard.noFleetWork}
            >
              {data.vehicles.map((vehicle) => {
                const contribution = vehicle.contributionSyp ?? '0.00'
                return (
                  <tr key={vehicle.vehicleId}>
                    <td className="px-3 py-2 font-medium">
                      <a className="text-brand underline" href={drill.vehicle({ id: vehicle.vehicleId, from: range.from, to: range.to })}>
                        {vehicle.groundNo ? `${vehicle.groundNo} · ` : ''}{vehicle.code ?? vehicle.vehicleId.slice(0, 8)}
                      </a>
                    </td>
                    <td className="num px-3 py-2 text-end">
                      <a className="text-brand underline" href={drill.completedShifts({ from: range.from, to: range.to, vehicle: vehicle.vehicleId })}>
                        {vehicle.shifts}
                      </a>
                    </td>
                    <td className="num px-3 py-2 text-end">
                      {vehicle.km}
                      {vehicle.kmUnrecorded > 0 ? <span className="ms-1 text-label text-warning-ink">+?</span> : null}
                    </td>
                    <td className="num px-3 py-2 text-end">{vehicle.orders}</td>
                    {data.financeVisible ? (
                      <>
                        <td className="px-3 py-2 text-end"><Money value={vehicle.companyShareSyp ?? '0.00'} /></td>
                        <td className="px-3 py-2 text-end"><Money value={vehicle.vehicleCostSyp ?? '0.00'} /></td>
                        <td className={`px-3 py-2 text-end font-semibold ${parseMinor(contribution) < minor(0n) ? 'text-danger-ink' : 'text-success-ink'}`}>
                          <Money value={contribution} />
                        </td>
                      </>
                    ) : null}
                  </tr>
                )
              })}
            </Table>
            {data.financeVisible && data.unattributedVehicleCostSyp && parseMinor(data.unattributedVehicleCostSyp) !== minor(0n) ? (
              <p role="alert" className="mt-3 text-label text-warning-ink">
                {t.dashboard.unattributedVehicleCost}: <Money value={data.unattributedVehicleCostSyp} />
              </p>
            ) : null}
          </Card>
        </div>
      )}
    </section>
  )
}
