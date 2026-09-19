import type { ReactNode } from 'react'
import type { DateRange } from '@ash/domain'
import { useApp } from '../../app-context.tsx'
import { explainError } from '../../errors.ts'
import { differenceView } from '../../treasury-view.ts'
import { Card, FOCUS_RING, Money, Pending, Stat } from '../../ui.tsx'
import { SectionHeading } from './SectionHeading.tsx'
import type { TreasuryDigest } from './types.ts'
import { useDashboardRead } from './use-dashboard-read.ts'

export function CapitalSection({ range }: { range: DateRange }): ReactNode {
  const { t } = useApp()
  const query = `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
  const { data, error, retry } = useDashboardRead<TreasuryDigest>(`/dashboard/treasury${query}`)

  if (data === null) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeading title={t.dashboard.capitalTitle} />
        <Pending
          error={error}
          loadingLabel={t.common.loading}
          errorLabel={explainError(error, t)}
          onRetry={retry}
          retryLabel={t.common.retry}
        />
      </section>
    )
  }

  const capitalDelta = differenceView(data.capital.delta)
  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-capital">
      <SectionHeading
        title={t.dashboard.capitalTitle}
        action={<a className={`text-label font-semibold text-brand underline ${FOCUS_RING}`} href="#treasury">{t.dashboard.openTreasury} ›</a>}
      />
      <Card title={t.dashboard.ownersSheet} subtitle={t.dashboard.periodRange.replace('{from}', data.from).replace('{to}', data.to)}>
        <section aria-labelledby="dashboard-operating-capital">
          <h3 id="dashboard-operating-capital" className="text-title font-semibold text-ink">
            {t.glossary.finance.operatingCapital}
          </h3>
          <div id="dashboard-capital" className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat
              lead
              label={t.dashboard.workingCapital}
              value={<Money value={data.capital.total} />}
              sub={
                capitalDelta.direction === 'none'
                  ? t.treasury.onTarget
                  : `${capitalDelta.direction === 'increase' ? t.treasury.capitalSurplus : t.treasury.capitalShortage}: ${capitalDelta.amount}`
              }
              {...(capitalDelta.direction === 'shortage'
                ? { tone: 'warning' as const }
                : capitalDelta.direction === 'increase'
                  ? { tone: 'success' as const }
                  : {})}
            />
            <Stat label={t.dashboard.officePosition} value={<Money value={data.capital.officePosition} />} />
            <Stat
              label={t.dashboard.activeShiftCustody.replace('{n}', String(data.capital.activeShiftCount))}
              value={<Money value={data.capital.activeCustodyTotal} />}
              sub={`${t.treasury.cashBox}: ${data.capital.activeCustodyCash} · ${t.treasury.wallet}: ${data.capital.activeCustodyWallet}`}
            />
          </div>
        </section>
        <section aria-labelledby="dashboard-daily-restoration" className="mt-4 rounded-xl border border-info-line bg-info-surface p-3">
          <h3 id="dashboard-daily-restoration" className="text-title font-semibold text-info-ink">
            {t.glossary.finance.dailyRestoration}
          </h3>
          <p className="mt-1 text-label text-info-ink">{t.treasury.restorationHint}</p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label={t.glossary.finance.surplusToCompany} value={<Money value={data.fundIn} />} />
            <Stat label={t.glossary.finance.shortfallFundingFromCompany} value={<Money value={data.fundOut} />} />
            <Stat label={t.treasury.netMovement} value={<Money value={data.fundNet} />} />
          </div>
        </section>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-body md:grid-cols-4">
          <dt className="text-ink-muted">{t.treasury.cashBox}</dt>
          <dd className="text-end"><Money value={data.capital.officeCash} /></dd>
          <dt className="text-ink-muted">{t.treasury.receivablesShort}</dt>
          <dd className="text-end"><Money value={data.capital.receivablesCash} /></dd>
          <dt className="text-ink-muted">{t.treasury.wallet}</dt>
          <dd className="text-end"><Money value={data.capital.officeWallet} /></dd>
          <dt className="text-ink-muted">{t.treasury.receivablesShort}</dt>
          <dd className="text-end"><Money value={data.capital.receivablesWallet} /></dd>
        </dl>
      </Card>
    </section>
  )
}
