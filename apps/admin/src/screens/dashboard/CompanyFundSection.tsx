import type { ReactNode } from 'react'
import { useApp } from '../../app-context.tsx'
import { explainError } from '../../errors.ts'
import { Card, FOCUS_RING, Money, Pending, Stat, Table } from '../../ui.tsx'
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
        <div id="dashboard-company-fund" className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat lead label={t.companyFinance.sypPocket} value={<Money value={data.total} currency="SYP_NEW" />} />
            <Stat label={t.companyFinance.usdPocket} value={<Money value={data.usd} currency="USD" />} />
            <Stat label={t.companyFinance.sypReserve} value={<Money value={data.reserve.SYP_NEW} currency="SYP_NEW" />} />
            <Stat label={t.companyFinance.usdReserve} value={<Money value={data.reserve.USD} currency="USD" />} />
          </div>
          <Card title={t.dashboard.branchCompanyAccounts}>
            <Table
              head={[t.accounts.branch, t.financeReview.companyInBranch, t.companyFinance.clearing, t.dashboard.matchDifference, t.dashboard.unexplainedBalance, t.dashboard.pendingRestorationCount, t.dashboard.matchingState]}
              isEmpty={data.branches.length === 0}
              empty={t.dashboard.noCompanyAccounts}
            >
              {data.branches.map((branch) => (
                <tr key={branch.branchId}>
                  <td className="px-3 py-2">{branch.nameAr} · <span className="num text-ink-muted">{branch.code}</span></td>
                  <td className="px-3 py-2 text-end"><Money value={branch.balance} currency="SYP_NEW" /></td>
                  <td className="px-3 py-2 text-end"><Money value={branch.clearing} currency="SYP_NEW" /></td>
                  <td className="px-3 py-2 text-end">{branch.totalDifference === undefined ? '—' : <Money value={branch.totalDifference} currency="SYP_NEW" />}</td>
                  <td className="px-3 py-2 text-end">{branch.unexplainedDifference === undefined ? '—' : <Money value={branch.unexplainedDifference} currency="SYP_NEW" />}{branch.historicalSettlementDifference !== undefined ? <details className="mt-2 text-start"><summary className={`cursor-pointer text-label text-brand ${FOCUS_RING}`}>{t.financeReview.historicalSettlementDifference}</summary><p className="mt-2"><Money value={branch.historicalSettlementDifference} currency="SYP_NEW" /></p><p className="mt-2 text-label text-ink-muted">{t.financeReview.historicalSettlementDifferenceHint}</p></details> : null}</td>
                  <td className="px-3 py-2"><div className="flex flex-col gap-1">
                    {branch.pendingReviewCount === undefined ? '—' : <><a className={`text-brand underline ${FOCUS_RING}`} href="#companyFund?tab=review"><bdi>{branch.pendingReviewCount}</bdi></a>{branch.pendingToCompany !== undefined && branch.pendingFromCompany !== undefined && branch.pendingReviewCount > 0 ? <details className="mt-1"><summary className={`cursor-pointer text-label text-brand ${FOCUS_RING}`}>{t.audit.details}</summary><p className="mt-2 text-label">{t.financeReview.toCompany}: <Money value={branch.pendingToCompany} currency="SYP_NEW" /></p><p className="text-label">{t.financeReview.fromCompany}: <Money value={branch.pendingFromCompany} currency="SYP_NEW" /></p></details> : null}</>}
                    {branch.unlinkedHistoricalCount !== undefined && branch.unlinkedHistoricalCount > 0 ? <a data-unlinked-historical className={`text-label text-warning-ink underline ${FOCUS_RING}`} href="#companyFund?tab=review">{t.financeReview.unlinkedRestorations}: <bdi>{branch.unlinkedHistoricalCount}</bdi></a> : null}
                  </div></td>
                  <td className="px-3 py-2">{branch.settlementStatus === undefined ? '—' : <span className={branch.settlementStatus === 'matched' ? 'text-success-ink' : 'text-warning-ink'}>{branch.settlementStatus === 'matched' ? t.companyFinance.balanced : branch.settlementStatus === 'waiting_review' ? t.financeReview.pending : branch.settlementStatus === 'not_linked' ? t.financeReview.branchNotLinked : t.financeReview.branchDifference}</span>}</td>
                </tr>
              ))}
            </Table>
            <a className={`mt-3 inline-block text-label text-brand underline ${FOCUS_RING}`} href="#companyFund?tab=review">{t.dashboard.reviewMatching} ›</a>
          </Card>
          <details data-dashboard-assets className="rounded-xl border border-line bg-surface-card p-4">
            <summary className={`cursor-pointer text-body font-semibold text-brand ${FOCUS_RING}`}>
              <span>{t.companyFinance.assetsTitle}</span>
              {data.assetSummary ? <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-label font-normal"><span><span>{t.dashboard.registeredAssetCards}</span>: <bdi>{data.assetSummary.registeredCards}</bdi></span><span className={data.assetSummary.pendingRecognitionCards > 0 ? 'text-warning-ink' : 'text-ink-muted'}><span>{t.dashboard.pendingAssetRecognition}</span>: <bdi>{data.assetSummary.pendingRecognitionCards}</bdi></span></span> : null}
            </summary>
            <p className="my-3 text-label text-ink-muted">{t.dashboard.assetBookValueHint}</p>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Stat label={t.companyFinance.bookValue} value={<Money value={data.assets.SYP_NEW} currency="SYP_NEW" />} />
              <Stat label={t.companyFinance.bookValue} value={<Money value={data.assets.USD} currency="USD" />} />
              <Stat label={t.companyFinance.depreciationDue} value={<Money value={data.depreciationDue.SYP_NEW} currency="SYP_NEW" />} />
              <Stat label={t.companyFinance.depreciationDue} value={<Money value={data.depreciationDue.USD} currency="USD" />} />
            </div>
            {data.assetSummary ? <div className="mt-3"><p className="text-label text-ink-muted">{t.dashboard.cardPriceNotBookValue}</p><p className="mt-2 text-body"><Money value={data.assetSummary.cardPrice.SYP_NEW} currency="SYP_NEW" /> · <Money value={data.assetSummary.cardPrice.USD} currency="USD" /></p></div> : null}
            <a className={`mt-3 inline-block text-label text-brand underline ${FOCUS_RING}`} href="#companyFund?tab=assets">{t.companyFinance.assetsTitle} ›</a>
          </details>
        </div>
      )}
    </section>
  )
}
