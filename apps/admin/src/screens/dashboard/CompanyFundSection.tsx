import type { ReactNode } from 'react'
import { useApp } from '../../app-context.tsx'
import { explainError } from '../../errors.ts'
import { Card, Money, Pending, Stat, Table } from '../../ui.tsx'
import { SectionHeading } from './SectionHeading.tsx'
import type { CompanyFundLegacyDigest } from './types.ts'
import { useDashboardRead } from './use-dashboard-read.ts'

/** HQ company pockets and the branch clearing evidence behind them. */
export function CompanyFundSection(): ReactNode {
  const { t } = useApp()
  const { data, error, retry } = useDashboardRead<CompanyFundLegacyDigest>('/company-fund')

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-company-fund">
      <SectionHeading
        title={t.dashboard.companyFundTitle}
        subtitle={t.dashboard.companyFundLegacyHint}
        action={<a className="text-label font-semibold text-brand underline" href="#companyFund">{t.dashboard.openCompanyFund} ›</a>}
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
        <div id="dashboard-company-fund" className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(18rem,1fr)_2fr]">
          <div className="grid grid-cols-2 gap-3">
            <Stat lead label={t.companyFinance.sypPocket} value={<Money value={data.total} currency="SYP_NEW" />} />
            <Stat label={t.companyFinance.usdPocket} value={<Money value={data.usd} currency="USD" />} />
            <Stat label={t.companyFinance.sypReserve} value={<Money value={data.reserve.SYP_NEW} currency="SYP_NEW" />} />
            <Stat label={t.companyFinance.usdReserve} value={<Money value={data.reserve.USD} currency="USD" />} />
            <Stat label={t.companyFinance.depreciationDue} value={<Money value={data.depreciationDue.SYP_NEW} currency="SYP_NEW" />} />
            <Stat label={t.companyFinance.depreciationDue} value={<Money value={data.depreciationDue.USD} currency="USD" />} />
            <Stat label={t.companyFinance.bookValue} value={<Money value={data.assets.SYP_NEW} currency="SYP_NEW" />} />
            <Stat label={t.companyFinance.bookValue} value={<Money value={data.assets.USD} currency="USD" />} />
          </div>
          <Card title={t.dashboard.branchCompanyAccounts}>
            <Table
              head={[t.accounts.branch, t.dashboard.balance, t.companyFinance.clearing]}
              isEmpty={data.branches.length === 0}
              empty={t.dashboard.noCompanyAccounts}
            >
              {data.branches.map((branch) => (
                <tr key={branch.branchId}>
                  <td className="px-3 py-2">{branch.nameAr} · <span className="num text-ink-muted">{branch.code}</span></td>
                  <td className="px-3 py-2 text-end"><Money value={branch.balance} currency="SYP_NEW" /></td>
                  <td className="px-3 py-2 text-end"><Money value={branch.clearing} currency="SYP_NEW" /></td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </section>
  )
}
