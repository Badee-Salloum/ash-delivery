import { useEffect, useState, type ReactNode } from 'react'
import type { OwnerWithdrawal, OwnerWithdrawalsView } from '@ash/client'
import { formatDateTimeSeconds } from '@ash/client'
import { formatMinor, minor } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { filterOwnerWithdrawals, validWithdrawalFilters, withdrawalSourceKey, type OwnerWithdrawalFilters } from '../owner-withdrawals.ts'
import { Button, Card, DateField, Field, FinancePagination, Money, Pending, Select, Stat, Table } from '../ui.tsx'
import { FinanceDialog, useResource } from './CompanyFinanceReview.tsx'

export function CompanyOwnerWithdrawals({ today, revision }: { today: string; revision: number }): ReactNode {
  const { t, lang } = useApp(), labels = t.ownerWithdrawals
  const feed = useResource<OwnerWithdrawalsView>(`/company/owner-withdrawals?from=2000-01-01&to=${encodeURIComponent(today)}`, revision)
  const initial = (): OwnerWithdrawalFilters => ({ from: '2000-01-01', to: today, currency: 'all', source: 'all' })
  const [filters, setFilters] = useState<OwnerWithdrawalFilters>(initial), [page, setPage] = useState(0)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  useEffect(() => { setFilters(initial()); setPage(0) }, [today])
  useEffect(() => setPage(0), [revision])
  const set = <K extends keyof OwnerWithdrawalFilters>(key: K, value: OwnerWithdrawalFilters[K]) => {
    setFilters(current => ({ ...current, [key]: value })); setPage(0)
  }
  const sourceLabel = (row: OwnerWithdrawal) => row.source === 'company' ? t.companyFinance.pocket
    : (row.source === 'branch_cash' ? labels.branchCash : labels.branchWallet)
      .replace('{branch}', lang === 'ar' ? row.branchNameAr : row.branchNameEn)
  const sources = [...new Map((feed.data?.withdrawals ?? []).map(row => [withdrawalSourceKey(row), sourceLabel(row)])).entries()]
  const valid = validWithdrawalFilters(filters, today)
  const rows = filterOwnerWithdrawals(feed.data?.withdrawals ?? [], filters, today)
  const focus = feed.data?.withdrawals.find(row => row.id === focusedId) ?? null
  return <section data-owner-withdrawals>
    <Card title={labels.title} subtitle={labels.hint}>
      {!feed.data || feed.error ? <Pending error={feed.error} loadingLabel={t.common.loading} errorLabel={explainError(feed.error, t)} onRetry={feed.load} retryLabel={t.common.retry} /> : <>
        <h3 className="mb-2 font-semibold">{labels.allTime}</h3>
        <p className="mb-3 text-label text-ink-muted">{labels.summaryHint} · <bdi>{feed.data.asOf}</bdi></p>
        <div data-owner-withdrawals-summary className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Stat lead label={t.currency.SYP_NEW} value={<Money value={feed.data.totals.SYP_NEW} currency="SYP_NEW" />} />
          <Stat label={t.currency.USD} value={<Money value={feed.data.totals.USD} currency="USD" />} />
        </div>
        <div data-owner-withdrawals-filters className="mt-4 border-t border-line pt-4">
          <h3 className="mb-2 font-semibold">{labels.details}</h3>
          <p className="mb-3 text-label text-ink-muted">{labels.filterHint}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <DateField label={t.companyFinance.from} value={filters.from} onChange={value => set('from', value)} />
            <DateField label={t.companyFinance.to} value={filters.to} onChange={value => set('to', value)} />
            <Field label={t.companyFinance.currency}><Select value={filters.currency} onChange={event => set('currency', event.target.value as OwnerWithdrawalFilters['currency'])}>
              <option value="all">{t.financeReview.allCurrencies}</option><option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option>
            </Select></Field>
            <Field label={labels.source}><Select value={filters.source} onChange={event => set('source', event.target.value)}>
              <option value="all">{t.financeReview.allSources}</option>{sources.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </Select></Field>
          </div>
          <Button variant="ghost" className="mt-3" onClick={() => { setFilters(initial()); setPage(0) }}>{t.financeReview.resetFilters}</Button>
        </div>
        {!valid ? <p role="alert" className="mt-3 text-danger-ink">{t.financeReview.invalidFilters}</p> : <>
          <p className="my-3 text-label text-ink-muted">{t.financeReview.resultCount}: <bdi>{rows.length}</bdi> · {labels.newestFirst}</p>
          <Table head={[t.companyFinance.date, { label: t.companyFinance.amount, numeric: true }, labels.source, t.companyFinance.description, t.companyFinance.action]}
            isEmpty={!rows.length} empty={feed.data.withdrawals.length ? labels.emptyPeriod : labels.empty}>
            {rows.slice(page * 10, page * 10 + 10).map(row => <tr key={row.id} data-owner-withdrawal-row>
              <td className="whitespace-nowrap px-3 py-2"><bdi>{row.occurredOn}</bdi></td>
              <td className="px-3 py-2"><Money value={row.amount} currency={row.currency} /></td>
              <td className="px-3 py-2">{sourceLabel(row)}</td>
              <td className="px-3 py-2"><p className="line-clamp-2">{row.description || '—'}</p></td>
              <td className="px-3 py-2"><Button variant="ghost" onClick={() => setFocusedId(row.id)}>{labels.originalDetails}</Button></td>
            </tr>)}
          </Table>
          <FinancePagination page={page} total={rows.length} pageSize={10} onChange={setPage} />
        </>}
      </>}
    </Card>
    {focus ? <FinanceDialog title={labels.originalDetails} onClose={() => setFocusedId(null)}>
      <p className="mb-4 text-label text-ink-muted">{labels.readOnly}</p>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div><dt>{t.companyFinance.date}</dt><dd><bdi>{focus.occurredOn}</bdi></dd></div>
        <div><dt>{t.companyFinance.amount}</dt><dd><Money value={focus.amount} currency={focus.currency} /></dd></div>
        <div><dt>{labels.source}</dt><dd>{sourceLabel(focus)}</dd></div>
        <div><dt>{t.companyFinance.postedOn}</dt><dd><bdi>{focus.postingDate}</bdi></dd></div>
        <div><dt>{t.glossary.time.recordedAt}</dt><dd><bdi>{formatDateTimeSeconds(focus.recordedAt, lang)}</bdi></dd></div>
        <div><dt>{labels.reference}</dt><dd className="break-words"><bdi>{focus.reference ?? '—'}</bdi></dd></div>
      </dl>
      <p className="my-4 break-words">{focus.description || '—'}</p>
      {focus.sypMinorPerUsd ? <p className="mb-3">{labels.frozenRate}: <Money value={formatMinor(minor(BigInt(focus.sypMinorPerUsd)))} currency="SYP_NEW" /> / {t.currency.USD}</p> : null}
      <p className="mb-3">{labels.references}: <bdi>{focus.journalEntryIds.join(' · ')}</bdi></p>
      {focus.entries.map(entry => <details key={entry.id} className="my-3 rounded-lg border border-line p-3">
        <summary className="cursor-pointer text-brand">{labels.entry} <bdi>{entry.id}</bdi> · <bdi>{entry.businessDate}</bdi></summary>
        <p className="my-2">{entry.reason || '—'}</p>
        <Table head={[labels.account, labels.side, t.companyFinance.amount]}>
          {entry.lines.map((line, index) => <tr key={`${line.fundCode}:${index}`}><td className="break-all px-3 py-2"><bdi>{line.fundCode}</bdi></td><td className="px-3 py-2">{line.side === 'D' ? labels.debit : labels.credit}</td><td className="px-3 py-2"><Money value={line.amount} currency={line.currency} /></td></tr>)}
        </Table>
      </details>)}
    </FinanceDialog> : null}
  </section>
}
