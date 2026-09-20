import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { type RangeSelection, type RoleKey, can } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { TimeRangeBar, useRangeMeta } from '../components/TimeRangeBar.tsx'
import {
  browserStorage,
  initialSelection,
  paramsFromSelection,
  resolveSelection,
  writeStoredSelection,
} from '../time-range.ts'
import type { RouteParams } from '../route.ts'
import { useHashParams } from '../use-hash-params.ts'
import { AlertsSection } from './dashboard/AlertsSection.tsx'
import { CapitalSection } from './dashboard/CapitalSection.tsx'
import { CompanyFundSection } from './dashboard/CompanyFundSection.tsx'
import { DueSection } from './dashboard/DueSection.tsx'
import { FleetSection } from './dashboard/FleetSection.tsx'
import { NowSection } from './dashboard/NowSection.tsx'
import { OperationsSection } from './dashboard/OperationsSection.tsx'
import { ProfitSection } from './dashboard/ProfitSection.tsx'
import { SevenDaySection } from './dashboard/SevenDaySection.tsx'

/** P3 dashboard: one shared range, with each section owning its read/error boundary. */
export function Dashboard({ initial = {} }: { initial?: RouteParams }): ReactNode {
  const { session } = useApp()
  const replaceParams = useHashParams()
  const [selection, setSelection] = useState<RangeSelection>(() =>
    initialSelection({ params: initial, storage: browserStorage(), userId: session?.userId }),
  )
  const { meta, error: metaError, retry: retryMeta } = useRangeMeta()
  const actor = session
    ? { userId: session.userId, roleKey: session.roleKey as RoleKey, branchId: session.branchId }
    : null
  const canSeeProfit = actor ? can(actor, 'profit.view_total', {}).allowed : false
  const canSeeCompanyFund = actor ? can(actor, 'company_fund.manage', {}).allowed : false

  const changeSelection = useCallback(
    (next: RangeSelection): void => {
      setSelection(next)
      const params = paramsFromSelection(next)
      replaceParams({
        range: params.range,
        ...(params.from === undefined ? {} : { from: params.from }),
        ...(params.to === undefined ? {} : { to: params.to }),
      })
      if (session) writeStoredSelection(browserStorage(), session.userId, next)
    },
    [replaceParams, session],
  )
  const range = useMemo(() => (meta ? resolveSelection(selection, meta) : null), [meta, selection])

  return (
    <div className="flex flex-col gap-7">
      <TimeRangeBar
        selection={selection}
        onChange={changeSelection}
        meta={meta}
        metaError={metaError}
        onRetryMeta={retryMeta}
      />
      <NowSection />
      <SevenDaySection />
      {range ? (
        <>
          {canSeeProfit ? <ProfitSection range={range} /> : null}
          <OperationsSection range={range} />
          <FleetSection range={range} />
          {canSeeProfit ? <CapitalSection range={range} /> : null}
          {canSeeCompanyFund ? <CompanyFundSection /> : null}
          <DueSection />
          <AlertsSection />
        </>
      ) : null}
    </div>
  )
}
