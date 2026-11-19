import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { isCalendarDate, type Currency } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Button, Card, DateField, Field, Money, Pending, Select, Stat, Table, TextInput } from '../ui.tsx'
import { useResource } from './CompanyFinanceReview.tsx'
import { newestFinancialRows, type ExpenseDeleteTarget } from '../company-expense-list.ts'

type ImportedKind = 'branch_receipt' | 'branch_payment' | 'expense' | 'asset_payment' | 'exchange' | 'refund'
type ImportedRow = {
  sourceReference: string; occurredOn: string; movementType: ImportedKind; paidFrom: 'pocket' | 'owner_outside'
  description: string; originalAmount: string; currency: Currency | null; amount: string | null
  fromCurrency: Currency | null; fromAmount: string | null; toCurrency: Currency | null; toAmount: string | null
  balanceAfter: Record<Currency,string>; financialStatus: 'posted_financial_day' | 'owner_direct_outside_company_books'
  restorationId: number | null; branchJournalEntryId: number | null
  excluded?: boolean; version?: number; correctionIds?: string[]
  sourcePosition?: number; deleteCommandId?: string | null
}
type ImportedFeed = { rows: ImportedRow[]; sourceClosing: Record<Currency,string>; balanceBasis: string }

export function CompanyHistoricalImportRegister({ today, revision = 0, onCorrect, onDelete, busy = false }: { today: string; revision?: number; onCorrect?: (reference: string) => void; onDelete?: (target: ExpenseDeleteTarget) => Promise<void>; busy?: boolean }): ReactNode {
  const { t } = useApp(), r = t.financeReview
  const { data, error, load } = useResource<ImportedFeed>('/company/historical-imports', revision)
  const [from, setFrom] = useState('2000-01-01'), [to, setTo] = useState(today)
  const [kind, setKind] = useState<ImportedKind | 'all'>('all'), [reference, setReference] = useState('')
  const [page, setPage] = useState(0)
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(width < 40rem)').matches)
  useEffect(() => {
    const query = window.matchMedia('(width < 40rem)')
    const update = () => setMobile(query.matches)
    update(); query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const valid = isCalendarDate(from) && isCalendarDate(to) && from <= to && from >= '2000-01-01' && to <= today
  const filtered = useMemo(() => valid ? newestFinancialRows((data?.rows ?? []).filter(row => !row.excluded && row.occurredOn >= from && row.occurredOn <= to &&
    (kind === 'all' || row.movementType === kind) && row.sourceReference.toLowerCase().includes(reference.trim().toLowerCase())), row => row.occurredOn, row => row.sourcePosition ?? (Number(row.sourceReference.split('-').at(-1)) || 0)) : [],
  [data, from, to, kind, reference, valid])
  useEffect(() => setPage(0), [from, to, kind, reference, revision])
  const visibleRows = filtered.slice(page * 20, page * 20 + 20)
  const label = (type: ImportedKind): string => type === 'branch_receipt' || type === 'branch_payment' ||
    type === 'asset_payment' || type === 'refund' ? r.historicalDraftKinds[type] :
      type === 'expense' ? t.companyFinance.historicalKinds.expense : t.companyFinance.historicalKinds.exchange
  const amount = (row: ImportedRow) => row.fromCurrency && row.toCurrency ?
    <bdi dir="ltr" className="inline-flex flex-wrap gap-1"><Money value={row.fromAmount ?? '0.00'} currency={row.fromCurrency} /> → <Money value={row.toAmount ?? '0.00'} currency={row.toCurrency} /></bdi> :
    row.currency && row.amount ? <Money value={row.amount} currency={row.currency} /> : row.originalAmount
  const actions = (row: ImportedRow): ReactNode => {
    const target: ExpenseDeleteTarget | null = row.movementType !== 'expense' ? null : row.deleteCommandId
      ? { kind: 'command', id: row.deleteCommandId, description: row.description }
      : row.financialStatus === 'owner_direct_outside_company_books' && row.branchJournalEntryId === null
        ? { kind: 'source', reference: row.sourceReference, description: row.description } : null
    return <div className="flex flex-wrap gap-2">{onCorrect ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => onCorrect(row.sourceReference)}>{r.edit}</Button> : null}
      {target && onDelete ? <Button variant="danger" size="sm" disabled={busy} onClick={() => void onDelete({ ...target, description: `${row.description} · ${row.amount ?? row.originalAmount} ${row.currency ? t.currency[row.currency] : ''} · ${row.occurredOn}` })}>{r.deleteExpense}</Button> : null}</div>
  }
  return <Card title={r.importRegisterTitle} subtitle={r.importRegisterHint}>
    {!data ? <Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error,t)} onRetry={load} retryLabel={t.common.retry} /> : <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Stat label={r.importRegisterBalanceSyp} value={<Money value={data.sourceClosing.SYP_NEW} currency="SYP_NEW" />} />
        <Stat label={r.importRegisterBalanceUsd} value={<Money value={data.sourceClosing.USD} currency="USD" />} />
      </div>
      {!valid ? <p role="alert" className="mb-3 text-danger-ink">{t.companyFinance.historicalInvalid}</p> : null}
      <div className="my-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DateField label={t.companyFinance.from} value={from} onChange={setFrom} />
        <DateField label={t.companyFinance.to} value={to} onChange={setTo} />
        <Field label={t.companyFinance.kind}><Select value={kind} onChange={event => setKind(event.target.value as ImportedKind | 'all')} aria-label={t.companyFinance.kind}>
          <option value="all">{t.companyFinance.allHistoricalKinds}</option>
          {(['branch_receipt','branch_payment','expense','asset_payment','exchange','refund'] as const).map(value =>
            <option key={value} value={value}>{label(value)}</option>)}
        </Select></Field>
        <Field label={t.companyFinance.auditReference}><TextInput value={reference} onChange={event => setReference(event.target.value)} aria-label={t.companyFinance.auditReference} /></Field>
      </div>
      <p className="mb-3 text-label text-ink-muted">{r.importRegisterCount}: <span className="num">{filtered.length} / {data.rows.filter(row => !row.excluded).length}</span> · {r.newestFirst}</p>
      {mobile ? <div className="flex flex-col gap-3">{filtered.length === 0 ? <p className="text-ink-muted">{r.importRegisterEmpty}</p> : visibleRows.map(row =>
        <article key={row.sourceReference} className="rounded-xl border border-line p-3">
          <div className="flex flex-wrap justify-between gap-2"><strong>{label(row.movementType)}</strong><span className="num">{row.occurredOn}</span></div>
          <p className="my-2 line-clamp-2 break-words">{row.description}</p><details><summary className="cursor-pointer text-label text-brand">{t.audit.details}</summary><p className="break-words">{row.description}</p></details><p>{amount(row)}</p>{row.excluded ? <p className="text-warning-ink">{r.excludedFromTotals}</p> : null}
          <p className="mt-2 text-label text-ink-muted">{row.sourceReference} · {row.financialStatus === 'posted_financial_day' ? r.importRegisterStatusPosted : r.importRegisterStatusOwner}</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-label"><p>{r.importRegisterBalanceSyp}<br /><Money value={row.balanceAfter.SYP_NEW} currency="SYP_NEW" /></p>
            <p>{r.importRegisterBalanceUsd}<br /><Money value={row.balanceAfter.USD} currency="USD" /></p></div>
          {row.restorationId || row.branchJournalEntryId ? <p className="mt-2 text-label text-ink-muted">{r.importRegisterLink}: <span className="num">{row.restorationId ?? row.branchJournalEntryId}</span></p> : null}
          <div className="mt-3">{actions(row)}</div>
        </article>)}</div> : <Table head={[t.companyFinance.occurredOn,t.companyFinance.kind,t.companyFinance.amount,
        t.companyFinance.description,r.importRegisterBalanceSyp,r.importRegisterBalanceUsd,t.accounts.status,t.companyFinance.action]}
        isEmpty={filtered.length===0} empty={r.importRegisterEmpty}>{visibleRows.map(row => <tr key={row.sourceReference}>
          <td className="px-3 py-2 num">{row.occurredOn}<p className="text-label text-ink-muted">{row.sourceReference}</p></td>
          <td className="px-3 py-2">{label(row.movementType)}</td><td className="px-3 py-2 text-end">{amount(row)}</td>
          <td className="px-3 py-2 break-words"><p className="line-clamp-2">{row.description}</p><details><summary className="cursor-pointer text-label text-brand">{t.audit.details}</summary><p className="mt-2">{row.description}</p></details>{row.restorationId || row.branchJournalEntryId ?
            <p className="text-label text-ink-muted">{r.importRegisterLink}: <span className="num">{row.restorationId ?? row.branchJournalEntryId}</span></p> : null}</td>
          <td className="px-3 py-2 text-end"><Money value={row.balanceAfter.SYP_NEW} currency="SYP_NEW" /></td>
          <td className="px-3 py-2 text-end"><Money value={row.balanceAfter.USD} currency="USD" /></td>
          <td className="px-3 py-2">{row.excluded ? r.excludedFromTotals : row.financialStatus === 'posted_financial_day' ? r.importRegisterStatusPosted : r.importRegisterStatusOwner}</td>
          <td className="px-3 py-2">{actions(row)}</td>
        </tr>)}</Table>}
      <div className="mt-3 flex items-center justify-between gap-3"><Button variant="ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{r.previousPage}</Button><bdi>{page + 1} / {Math.max(1, Math.ceil(filtered.length / 20))}</bdi><Button variant="ghost" disabled={(page + 1) * 20 >= filtered.length} onClick={() => setPage(value => value + 1)}>{r.nextPage}</Button></div>
    </>}
  </Card>
}
