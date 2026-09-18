import type { ReactNode } from 'react'
import type { DateRange } from '@ash/domain'
import { minor, parseMinor } from '@ash/domain'
import { TrendBars } from '../../components/TrendBars.tsx'
import { drill } from '../../drill.ts'
import { explainError } from '../../errors.ts'
import { useApp } from '../../app-context.tsx'
import { Card, Figure, Money, Pending, Stat } from '../../ui.tsx'
import { SectionHeading } from './SectionHeading.tsx'
import type { ProfitDigest } from './types.ts'
import { useDashboardRead } from './use-dashboard-read.ts'

export function ProfitSection({ range }: { range: DateRange }): ReactNode {
  const { t } = useApp()
  const query = `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
  const { data, error, retry } = useDashboardRead<ProfitDigest>(`/dashboard/profit${query}`)

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-profit">
      <SectionHeading
        title={t.dashboard.profitTitle}
        subtitle={t.dashboard.profitSubtitle}
        action={
          <a className="text-label font-semibold text-brand underline" href={drill.expenses({ from: range.from, to: range.to })}>
            {t.dashboard.openExpenses} ›
          </a>
        }
      />
      {data === null ? (
        <Pending
          error={error}
          loadingLabel={t.common.loading}
          errorLabel={explainError(error, t)}
          onRetry={retry}
          retryLabel={t.common.retry}
        />
      ) : (
        <div id="dashboard-profit" className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <Card className="xl:col-span-2" title={t.dashboard.netProfit} subtitle={t.dashboard.periodRange.replace('{from}', data.from).replace('{to}', data.to)}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_2fr]">
              <div className="grid grid-cols-1 gap-3">
                <Stat lead label={t.dashboard.combinedNetProfit} value={<Money value={data.combinedNetProfitSyp} />} tone={parseMinor(data.combinedNetProfitSyp) < minor(0n) ? 'danger' : 'success'} />
                <Stat label={t.dashboard.branchNetProfit} value={<Money value={data.branchNetProfitSyp} />} tone={parseMinor(data.branchNetProfitSyp) < minor(0n) ? 'danger' : 'success'} />
                <Stat label={t.dashboard.companyNetProfit} value={<Money value={data.companyNetProfitSyp} />} tone={parseMinor(data.companyNetProfitSyp) < minor(0n) ? 'danger' : 'success'} />
              </div>
              <TrendBars
                from={range.from}
                to={range.to}
                points={data.days.map((day) => ({ date: day.businessDate, value: day.combinedNetProfitSyp }))}
                label={t.dashboard.profitTrend}
              />
            </div>
          </Card>
          <Card title={t.dashboard.branchProfitBridge}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Figure label={t.dashboard.companyShareLabel} value={<Money value={data.companyShareSyp} />} />
              <Figure label={t.dashboard.otherIncome} value={<Money value={data.otherIncomeSyp} />} />
              <Figure label={t.dashboard.operatingCosts} value={<Money value={data.operatingCostSyp} />} tone="danger" />
              <Figure label={t.dashboard.vehicleCosts} value={<Money value={data.vehicleCostSyp} />} tone="danger" />
              <Figure label={t.dashboard.losses} value={<Money value={data.lossSyp} />} tone="danger" />
              <Figure
                label={t.dashboard.netProfit}
                value={<Money value={data.netProfitSyp} />}
                tone={parseMinor(data.netProfitSyp) < minor(0n) ? 'danger' : 'success'}
                size="lg"
              />
            </dl>
          </Card>
        </div>
      )}
    </section>
  )
}
