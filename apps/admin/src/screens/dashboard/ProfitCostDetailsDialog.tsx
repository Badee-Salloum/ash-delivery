import { type ReactNode, useEffect, useState } from 'react'
import { parseMinor } from '@ash/domain'
import { useApp } from '../../app-context.tsx'
import { drill } from '../../drill.ts'
import { explainError } from '../../errors.ts'
import { Button, FOCUS_RING, Money, Pending, Stat, Table } from '../../ui.tsx'
import { FinanceDialog } from '../CompanyFinanceReview.tsx'
import type { ProfitCostDetails, ProfitCostKind } from './types.ts'
import { useDashboardRead } from './use-dashboard-read.ts'

/** The ledger net behind profit is not the gross sum of editable expense records. */
export function ProfitCostDetailsDialog({ from, to, kind, vehicleId, vehicleLabel, onClose }: {
  from: string; to: string; kind: ProfitCostKind; vehicleId?: string; vehicleLabel?: string; onClose: () => void
}): ReactNode {
  const { t } = useApp()
  const [page, setPage] = useState(0)
  const query = new URLSearchParams({ from, to, kind, limit: '50', offset: String(page * 50), ...(vehicleId ? { vehicleId } : {}) })
  const { data, error, retry } = useDashboardRead<ProfitCostDetails>(`/dashboard/profit-costs?${query}`)
  useEffect(() => { if (data) setPage(current => Math.min(current, Math.max(0, Math.ceil(data.count / 50) - 1))) }, [data])
  const label = kind === 'operating_cost' ? t.dashboard.operatingCosts : kind === 'vehicle_cost' ? t.dashboard.vehicleCosts : kind === 'loss' ? t.dashboard.losses : t.dashboard.costDetailsTitle
  const pagination = data ? <div className="my-4 flex items-center justify-between gap-3"><Button variant="ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t.financeReview.previousPage}</Button><bdi>{page + 1} / {Math.max(1, Math.ceil(data.count / 50))}</bdi><Button variant="ghost" disabled={(page + 1) * 50 >= data.count} onClick={() => setPage(value => value + 1)}>{t.financeReview.nextPage}</Button></div> : null
  return <FinanceDialog title={`${t.dashboard.costDetailsTitle} · ${label}${vehicleLabel ? ` · ${vehicleLabel}` : ''}`} onClose={onClose}>
    <p className="mb-3 text-body text-ink-muted">{t.dashboard.costDetailsHint}</p>
    {!data ? <Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error, t)} onRetry={retry} retryLabel={t.common.retry} /> : <>
      <p className="mb-3 text-label text-ink-muted"><bdi>{data.from}</bdi> — <bdi>{data.to}</bdi> · {t.currency.SYP_NEW}</p>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2"><Stat lead label={t.dashboard.ledgerCostNet} value={<Money value={data.total} currency="SYP_NEW" />} /><Stat label={t.dashboard.costEntriesCount} value={data.count} /></div>
      {pagination}
      <Table head={[t.companyFinance.date, t.companyFinance.description, t.companyFinance.amount, t.financeReview.postingDates, t.treasury.entryId]} isEmpty={data.rows.length === 0} empty={t.companyFinance.emptyMovements}>
        {data.rows.map(row => <tr key={row.id}><td className="whitespace-nowrap px-3 py-2"><bdi>{row.businessDate}</bdi></td><td className="px-3 py-2"><p className="break-words">{row.description || '—'}</p><span className="mt-1 block text-label text-ink-muted">{row.kind === 'operating_cost' ? t.dashboard.operatingCosts : row.kind === 'vehicle_cost' ? t.dashboard.vehicleCosts : t.dashboard.losses}{row.vehicleCode ? <> · <bdi>{row.vehicleCode}</bdi></> : null}</span></td><td className={`px-3 py-2 text-end ${parseMinor(row.amount) < 0n ? 'text-success-ink' : 'text-danger-ink'}`}><bdi><Money value={row.amount} currency="SYP_NEW" /></bdi></td><td className="whitespace-nowrap px-3 py-2"><bdi>{row.postingDate}</bdi></td><td className="px-3 py-2"><bdi>{row.entryId}</bdi></td></tr>)}
      </Table>
      {pagination}
      {kind === 'operating_cost' || kind === 'vehicle_cost' ? <div className="border-t border-line pt-3"><a className={`text-brand underline ${FOCUS_RING}`} href={drill.expenses({ from: data.from, to: data.to, costCenterKind: kind === 'operating_cost' ? 'operating' : 'vehicle', ...(vehicleId ? { vehicle: vehicleId } : {}) })}>{t.dashboard.costsRecordedAction} ›</a><p className="mt-2 text-label text-ink-muted">{t.dashboard.recordedExpenseRowsHint}</p></div> : null}
    </>}
  </FinanceDialog>
}
