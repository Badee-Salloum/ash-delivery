import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from '../../app-context.tsx'
import { drill } from '../../drill.ts'
import { explainError } from '../../errors.ts'
import { Stat, Pending } from '../../ui.tsx'
import { type WorkingNowSnapshot, startWorkingNowPolling } from '../../working-now.ts'
import { SectionHeading } from './SectionHeading.tsx'
import type { DashboardSnapshot } from './types.ts'
import { useDashboardRead } from './use-dashboard-read.ts'

/** Live facts only. This section deliberately ignores the period filter above it. */
export function NowSection(): ReactNode {
  const { api, branchId, t } = useApp()
  const { data, error, retry } = useDashboardRead<DashboardSnapshot>('/dashboard')
  const [workingNow, setWorkingNow] = useState<WorkingNowSnapshot | null>(null)
  const [workingNowUnavailable, setWorkingNowUnavailable] = useState(false)

  // This poll intentionally calls only the lightweight count endpoint. Changing branch tears down
  // the old poll, clears its snapshot, and starts an immediate read for the new branch.
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

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-now">
      <SectionHeading title={t.dashboard.nowTitle} subtitle={t.dashboard.nowSubtitle} />
      {data === null ? (
        <Pending
          error={error}
          loadingLabel={t.common.loading}
          errorLabel={explainError(error, t)}
          onRetry={retry}
          retryLabel={t.common.retry}
        />
      ) : (
        <div id="dashboard-now" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <Stat
            label={t.dashboard.workingDrivers}
            value={workingNow?.drivers ?? '—'}
            sub={workingNowUnavailable ? (workingNow ? t.dashboard.workingCountsStale : t.dashboard.workingCountsUnavailable) : undefined}
            href={drill.liveShifts()}
          />
          <Stat
            label={t.dashboard.awaitingApproval}
            value={data.completeness.awaitingApproval}
            {...(data.completeness.awaitingApproval > 0 ? { tone: 'warning' as const } : {})}
            href="#queue"
          />
          <Stat
            label={t.dashboard.suspendedNow}
            value={data.completeness.suspended}
            {...(data.completeness.suspended > 0 ? { tone: 'warning' as const } : {})}
            href={drill.liveShifts({ state: 'suspended' })}
          />
          <Stat
            label={t.dashboard.workingVehicles}
            value={workingNow?.vehicles ?? '—'}
            sub={workingNowUnavailable ? (workingNow ? t.dashboard.workingCountsStale : t.dashboard.workingCountsUnavailable) : undefined}
            href={drill.liveShifts()}
          />
          <Stat
            label={t.dashboard.fleetReadiness}
            value={`${data.fleet.ready}/${data.fleet.ready + data.fleet.charging + data.fleet.maintenance + data.fleet.stopped}`}
            sub={t.dashboard.maintenanceCount.replace('{n}', String(data.fleet.maintenance))}
          />
        </div>
      )}
    </section>
  )
}
