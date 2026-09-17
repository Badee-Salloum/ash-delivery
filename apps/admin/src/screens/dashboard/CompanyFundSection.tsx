import type { ReactNode } from 'react'
import { useApp } from '../../app-context.tsx'
import { explainError } from '../../errors.ts'
import { Card, Money, Pending, Stat, Table } from '../../ui.tsx'
import { SectionHeading } from './SectionHeading.tsx'
import type { CompanyFundLegacyDigest } from './types.ts'
import { useDashboardRead } from './use-dashboard-read.ts'

/** Transitional P3 view: C2 replaces this branch `company_box` aggregate with HQ currency pockets. */
export function CompanyFundSection(): ReactNode {
  const { t } = useApp()
  const { data, error, retry } = useDashboardRead<CompanyFundLegacyDigest>('/company-fund')

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-company-fund">
      <SectionHeading
        title={t.dashboard.companyFundTitle}
        subtitle={t.dashboard.companyFundLegacyHint}
        action={<a className="text-label font-semibold text-brand underline" href="#treasury">{t.dashboard.openCompanyFund} ›</a>}
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
        <div id="dashboard-company-fund" className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(14rem,1fr)_2fr]">
          <Stat lead label={t.treasury.companyFund} value={<Money value={data.total} currency="SYP_NEW" />} />
          <Card title={t.dashboard.branchCompanyAccounts}>
            <Table
              head={[t.accounts.branch, t.dashboard.balance]}
              isEmpty={data.branches.length === 0}
              empty={t.dashboard.noCompanyAccounts}
            >
              {data.branches.map((branch) => (
                <tr key={branch.branchId}>
                  <td className="px-3 py-2">{branch.nameAr} · <span className="num text-ink-muted">{branch.code}</span></td>
                  <td className="px-3 py-2 text-end"><Money value={branch.balance} currency="SYP_NEW" /></td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </section>
  )
}
