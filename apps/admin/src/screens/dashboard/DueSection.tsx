import type { ReactNode } from 'react'
import { useApp } from '../../app-context.tsx'
import { drill } from '../../drill.ts'
import { explainError } from '../../errors.ts'
import { Pending, Stat } from '../../ui.tsx'
import { SectionHeading } from './SectionHeading.tsx'
import type { DashboardSnapshot } from './types.ts'
import { useDashboardRead } from './use-dashboard-read.ts'

/** Actionable work today. P4 later adds recurring-expense dues to this same section. */
export function DueSection(): ReactNode {
  const { t } = useApp()
  const { data, error, retry } = useDashboardRead<DashboardSnapshot>('/dashboard')
  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-due">
      <SectionHeading title={t.dashboard.dueTitle} subtitle={t.dashboard.dueSubtitle} />
      {data === null ? (
        <Pending
          error={error}
          loadingLabel={t.common.loading}
          errorLabel={explainError(error, t)}
          onRetry={retry}
          retryLabel={t.common.retry}
        />
      ) : (
        <div id="dashboard-due" className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat
            label={t.dashboard.awaitingApproval}
            value={data.completeness.awaitingApproval}
            {...(data.completeness.awaitingApproval > 0 ? { tone: 'warning' as const } : {})}
            href="#queue"
          />
          <Stat
            label={t.dashboard.missingEndPackage}
            value={data.completeness.missingEndPackage}
            {...(data.completeness.missingEndPackage > 0 ? { tone: 'danger' as const } : {})}
            href={drill.liveShifts()}
          />
          <Stat label={t.dashboard.recurringDue} value="—" sub={t.dashboard.recurringDuePending} href={drill.expenses({ tab: 'due' })} />
        </div>
      )}
    </section>
  )
}
