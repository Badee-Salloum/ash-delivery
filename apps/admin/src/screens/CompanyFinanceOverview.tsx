import { useState, type ReactNode } from 'react'
import { isCalendarDate } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import type { CompanyReport } from '../company-report.ts'
import { companyTransferRegister, signedTransfer, transferPeriodTotals, type RestorationFeed, type TransferGroup } from '../company-transfer-register.ts'
import { Button, Card, DateField, Field, FinancePagination, Money, Pending, Select, Stat, Table } from '../ui.tsx'
import { CompanyOwnerPanel, FinanceDialog, RestorationReviewPanel, useResource } from './CompanyFinanceReview.tsx'
import type { Mutate, Overview } from './CompanyFund.tsx'
import { CompanyCustody } from './CompanyCustody.tsx'
import { CompanyOwnerWithdrawals } from './CompanyOwnerWithdrawals.tsx'

export function CompanyFinanceOverview({ today, revision, mutate, matching }: {
  today: string; revision: number; mutate: Mutate; matching: (data: Overview) => ReactNode
}): ReactNode {
  const { t, branches, lang } = useApp(), w = t.financeWorkspace, r = t.financeReview
  const cash = useResource<Overview>(`/company/overview?from=2000-01-01&to=${today}`, revision)
  // One complete corrected read is needed to preserve links spanning different occurrence days.
  const report = useResource<CompanyReport>('/company/reports?all=true&view=current_corrected&dateBasis=occurrence', revision + Number(today.replaceAll('-', '')))
  const reviews = useResource<RestorationFeed>('/company/restoration-reviews', revision)
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`), [to, setTo] = useState(today), [branch, setBranch] = useState('')
  const [status, setStatus] = useState('all'), [page, setPage] = useState(0), [focus, setFocus] = useState<TransferGroup | null>(null)
  const valid = isCalendarDate(from) && isCalendarDate(to) && from >= '2000-01-01' && from <= to && to <= today
  const groups = report.data && reviews.data ? companyTransferRegister(report.data.rows, reviews.data) : null
  const selectedGroups = groups?.filter(group => !branch || group.branchId === branch) ?? []
  const rows = valid ? selectedGroups.filter(group =>
    (group.company.some(leg => leg.date >= from && leg.date <= to) || !group.company.length && (group.confirmedOn ?? group.branchDate) !== null && (group.confirmedOn ?? group.branchDate)! >= from && (group.confirmedOn ?? group.branchDate)! <= to) &&
    (status === 'all' || status === 'confirmed' ? status === 'all' || !['pending', 'deferred', 'unlinked'].includes(group.status) : group.status === status)) : []
  const totals = groups && valid ? transferPeriodTotals(groups, from, to, branch) : null
  const name = (id: string) => { const found = branches.find(item => item.id === id); return found ? lang === 'ar' ? found.nameAr : found.nameEn : r.unknown }
  const statusLabel = (group: TransferGroup) => group.status === 'pending' ? r.pending : group.status === 'deferred' ? r.deferred : group.status === 'unlinked' ? w.unlinked : group.status === 'variance' ? w.linkedVariance : group.status === 'matched' ? w.matched : group.status === 'corrected' ? r.corrected : w.linked
  const directionLabel = (group: TransferGroup) => {
    const legs = group.company.length ? group.company : group.branch ?? []
    const directions = new Set(legs.map(leg => leg.direction))
    return directions.size > 1 ? w.bothDirections : directions.has('to_company') ? w.received : directions.has('from_company') ? w.paid : r.unknown
  }
  const reviewButton = (group: TransferGroup) => <Button variant="ghost" onClick={() => setFocus(group)}>{w.openReview}</Button>
  const feedState = !report.data ? <Pending error={report.error} loadingLabel={t.common.loading} errorLabel={explainError(report.error, t)} onRetry={report.load} retryLabel={t.common.retry} /> : !reviews.data ? <Pending error={reviews.error} loadingLabel={t.common.loading} errorLabel={explainError(reviews.error, t)} onRetry={reviews.load} retryLabel={t.common.retry} /> : null
  return <div className="flex flex-col gap-4" data-company-workspace>
    <Card title={w.currentCash} subtitle={`${w.currentCashHint} ${today}`}>
      {!cash.data ? <Pending error={cash.error} loadingLabel={t.common.loading} errorLabel={explainError(cash.error, t)} onRetry={cash.load} retryLabel={t.common.retry} /> : <>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Stat lead label={t.companyFinance.sypPocket} value={<Money value={cash.data.pockets.SYP_NEW} currency="SYP_NEW" />} /><Stat label={t.companyFinance.usdPocket} value={<Money value={cash.data.pockets.USD} currency="USD" />} /></div>
        <details className="mt-3"><summary className="cursor-pointer text-brand">{t.companyFinance.reserve}</summary><div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{(['SYP_NEW', 'USD'] as const).map(currency => <Stat key={currency} label={t.currency[currency]} value={<Money value={cash.data!.reserves[currency]} currency={currency} />} />)}</div></details>
      </>}
    </Card>
    <CompanyCustody today={today} revision={revision} mutate={mutate} />
    <Card title={w.transfers} subtitle={w.transfersHint}>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field label={t.accounts.branch}><Select aria-label={t.accounts.branch} value={branch} onChange={event => { setBranch(event.target.value); setPage(0) }}><option value="">{w.allBranches}</option>{branches.filter(item => item.code !== 'HQ').map(item => <option key={item.id} value={item.id}>{name(item.id)}</option>)}</Select></Field>
        <DateField label={t.companyFinance.from} value={from} onChange={value => { setFrom(value); setPage(0) }} /><DateField label={t.companyFinance.to} value={to} onChange={value => { setTo(value); setPage(0) }} />
        <div className="self-end"><Button variant="ghost" onClick={() => { setFrom(report.data?.availableFrom ?? '2000-01-01'); setTo(today); setPage(0) }}>{r.allPeriod}</Button></div>
      </div>
      {!valid ? <p role="alert" className="text-danger-ink">{t.companyFinance.historicalInvalid}</p> : feedState ?? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{(['SYP_NEW', 'USD'] as const).map(currency => <div key={currency} className="rounded-lg border border-line p-3" data-transfer-summary={currency}><h3 className="mb-3 font-semibold">{t.currency[currency]}</h3><dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">{(['receipts', 'payments', 'net'] as const).map(key => <div key={key}><dt className="text-label text-ink-muted">{key === 'receipts' ? w.received : key === 'payments' ? w.paid : w.net}</dt><dd className="font-bold"><bdi><Money value={totals![currency][key]} currency={currency} /></bdi></dd></div>)}</dl></div>)}</div>}
    </Card>
    <Card title={w.transfers} subtitle={w.notCash}>
      <Field label={w.statusFilter}><Select value={status} aria-label={w.statusFilter} onChange={event => { setStatus(event.target.value); setPage(0) }}><option value="all">{r.allStatuses}</option><option value="confirmed">{w.confirmedOnly}</option><option value="pending">{r.pending}</option><option value="unlinked">{w.unlinked}</option><option value="variance">{w.linkedVariance}</option><option value="corrected">{r.corrected}</option></Select></Field>
      <p className="my-3 text-label text-ink-muted">{r.resultCount}: <bdi>{rows.length}</bdi> · {w.transfersHint}</p>
      {feedState ?? <Table head={[w.companyDate, w.branchDate, t.accounts.branch, t.companyFinance.direction, w.companyAmount, w.branchAmount, t.accounts.status, t.companyFinance.action]} isEmpty={!rows.length} empty={valid ? w.noTransfers : t.companyFinance.historicalInvalid}>{rows.slice(page * 15, page * 15 + 15).map(group => <tr key={group.id} data-transfer-row>
        <td className="px-3 py-2"><bdi>{[...new Set(group.company.map(leg => leg.date))].join(' · ') || group.confirmedOn || '—'}</bdi></td><td className="px-3 py-2"><bdi>{group.branchDate ?? '—'}</bdi></td><td className="px-3 py-2">{name(group.branchId)}</td><td className="px-3 py-2">{directionLabel(group)}</td>
        <td className="px-3 py-2">{group.company.length ? (['SYP_NEW', 'USD'] as const).filter(currency => group.company.some(leg => leg.currency === currency)).map(currency => <p key={currency}><Money value={signedTransfer(group.company.filter(leg => leg.date >= from && leg.date <= to), currency)} currency={currency} /></p>) : ['pending', 'deferred', 'unlinked'].includes(group.status) ? r.notPosted : <Money value="0.00" currency="SYP_NEW" />}</td>
        <td className="px-3 py-2">{group.branch ? <Money value={signedTransfer(group.branch, 'SYP_NEW')} currency="SYP_NEW" /> : r.unavailable}</td><td className="px-3 py-2">{statusLabel(group)}</td><td className="px-3 py-2">{reviewButton(group)}<details className="mt-2"><summary className="cursor-pointer text-brand">{w.transferDetails}</summary><p className="my-2 text-label text-ink-muted">{w.groupDatesHint}</p>{group.company.map(leg => <p key={leg.id} className="my-2"><bdi>{leg.date}</bdi> · {leg.direction === 'to_company' ? w.received : w.paid} · <Money value={leg.amount} currency={leg.currency} /><span className="block line-clamp-2 text-label">{leg.description}</span></p>)}{group.branch?.length ? <div className="my-3"><p className="font-semibold">{w.branchAmount}</p>{group.branch.map(leg => <p key={leg.id}><bdi>{leg.date}</bdi> · {leg.direction === 'to_company' ? w.received : w.paid} · <Money value={leg.amount} currency={leg.currency} /></p>)}</div> : null}{group.variance !== null ? <p>{r.difference}: <Money value={group.variance} currency="SYP_NEW" /></p> : null}</details></td>
      </tr>)}</Table>}
      <FinancePagination page={page} total={rows.length} pageSize={15} onChange={setPage} />
    </Card>
    <details><summary className="cursor-pointer text-brand">{w.matchingDetails}</summary><div className="mt-3">{cash.data ? matching(cash.data) : null}</div></details>
    {/* Transfer dates never hide or reset the complete owner summary or its independent detail filters. */}
    <CompanyOwnerPanel from={`${today.slice(0, 7)}-01`} to={today} revision={revision} latest />
    <CompanyOwnerWithdrawals today={today} revision={revision} />
    {focus ? focus.proposalId || focus.status === 'unlinked' ? <RestorationReviewPanel key={focus.id} mutate={mutate} revision={revision} branchId={focus.branchId} focusId={focus.proposalId} focusHistoricalId={focus.status === 'unlinked' ? Number(focus.id.split(':').at(-1)) : undefined} onFocusClose={() => setFocus(null)} /> : <FinanceDialog title={w.transferDetails} onClose={() => setFocus(null)}><p className="mb-3 font-semibold">{name(focus.branchId)} · {statusLabel(focus)}</p><p className="mb-3 text-label text-ink-muted">{w.notCash}</p><Table head={[w.companyDate, t.companyFinance.kind, t.companyFinance.amount, t.companyFinance.description]} isEmpty={!focus.company.length} empty={w.noTransfers}>{focus.company.map(leg => <tr key={leg.id}><td className="px-3 py-2"><bdi>{leg.date}</bdi></td><td className="px-3 py-2">{leg.direction === 'to_company' ? w.received : w.paid}</td><td className="px-3 py-2"><Money value={leg.amount} currency={leg.currency} /></td><td className="px-3 py-2">{leg.description}</td></tr>)}</Table>{focus.branch ? <><p className="my-3">{w.branchDate}: <bdi>{focus.branchDate}</bdi></p><p>{w.branchAmount}: <Money value={signedTransfer(focus.branch, 'SYP_NEW')} currency="SYP_NEW" /></p></> : null}{focus.variance !== null ? <p className="my-3">{r.difference}: <Money value={focus.variance} currency="SYP_NEW" /></p> : null}</FinanceDialog> : null}
  </div>
}
