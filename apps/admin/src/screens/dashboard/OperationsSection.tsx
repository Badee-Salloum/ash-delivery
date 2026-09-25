import type { ReactNode } from 'react'
import type { DateRange } from '@ash/domain'
import { useApp } from '../../app-context.tsx'
import { drill } from '../../drill.ts'
import { explainError } from '../../errors.ts'
import { Card, Money, Pending, Stat, Table } from '../../ui.tsx'
import { SectionHeading } from './SectionHeading.tsx'
import type { ShiftsSummary } from './types.ts'
import { useDashboardRead } from './use-dashboard-read.ts'

function duration(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

export function OperationsSection({ range }: { range: DateRange }): ReactNode {
  const { t } = useApp()
  const query = `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
  const { data, error, retry } = useDashboardRead<ShiftsSummary>(`/dashboard/shifts-summary${query}`)
  const completedRange = { from: range.from, to: range.to }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-operations">
      <SectionHeading title={t.dashboard.operationsTitle} subtitle={t.dashboard.selectedPeriod} />
      {data === null ? (
        <Pending
          error={error}
          loadingLabel={t.common.loading}
          errorLabel={explainError(error, t)}
          onRetry={retry}
          retryLabel={t.common.retry}
        />
      ) : (
        <div id="dashboard-operations" className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label={t.dashboard.revenue} value={<Money value={data.totals.feesSyp} />} sub={data.totals.feesUsd ? `≈ $${data.totals.feesUsd}${data.totals.fxProvisional ? ' ~' : ''}` : undefined} />
            <Stat label={t.dashboard.orders} value={data.totals.orders} />
            <Stat label={t.dashboard.completedCount} value={data.completed} href={drill.completedShifts(completedRange)} />
            <Stat label={t.dashboard.doubleCount} value={data.doubles.total} href={drill.completedShifts({ ...completedRange, pattern: 'full' })} />
            <Stat
              label={t.dashboard.shiftsUnderTarget}
              value={data.short.count}
              sub={t.dashboard.shiftsUnderTargetSub.replace('{t}', duration(data.short.minutes))}
              {...(data.short.count > 0 ? { tone: 'warning' as const } : {})}
              href={drill.completedShifts({ ...completedRange, short: true })}
            />
            <Stat
              label={t.dashboard.abandonedCount}
              value={data.abandoned}
              {...(data.abandoned > 0 ? { tone: 'danger' as const } : {})}
              href={drill.completedShifts({ ...completedRange, abandoned: true })}
            />
          </div>
          <Card title={t.dashboard.byDriver} subtitle={t.dashboard.driverRowHint}>
            <Table
              head={[
                t.fleet.driver,
                { label: t.dashboard.completedCount, numeric: true },
                { label: t.dashboard.doubleCount, numeric: true },
                { label: t.dashboard.shiftsUnderTarget, numeric: true },
                { label: t.dashboard.orders, numeric: true },
                { label: t.dashboard.gpsWorkDistance, numeric: true },
                { label: t.dashboard.revenue, numeric: true },
                ...(data.companyShareVisible ? [{ label: t.dashboard.companyShareLabel, numeric: true } as const] : []),
              ]}
              isEmpty={data.byDriver.length === 0}
              empty={t.dashboard.noShifts}
            >
              {data.byDriver.map((driver) => (
                <tr key={driver.driverId}>
                  <td className="px-3 py-2 font-medium">
                    <a className="text-brand underline" href={drill.completedShifts({ ...completedRange, driver: driver.driverId })}>
                      {driver.name}
                    </a>
                  </td>
                  <td className="num px-3 py-2 text-end">{driver.shifts}</td>
                  <td className="num px-3 py-2 text-end">{driver.doubles}</td>
                  <td className="num px-3 py-2 text-end">{driver.short.count}</td>
                  <td className="num px-3 py-2 text-end">{driver.orders}</td>
                  <td className="num px-3 py-2 text-end">
                    {driver.workDistanceMetres === null ? t.shiftPath.unavailable : (driver.workDistanceMetres / 1000).toFixed(1)}
                    <span className={`block text-xs ${driver.gpsIncompleteShifts > 0 ? 'text-warning-ink' : 'text-ink-muted'}`}>
                      {t.dashboard.gpsCoverage.replace('{n}', driver.gpsCoveragePercent === null ? t.shiftPath.unavailable : `${driver.gpsCoveragePercent}%`)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-end"><Money value={driver.feesSyp} /></td>
                  {data.companyShareVisible ? <td className="px-3 py-2 text-end"><Money value={driver.companyShareSyp ?? '0.00'} /></td> : null}
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </section>
  )
}
