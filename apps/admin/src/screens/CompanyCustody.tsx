import { useState, type ReactNode } from 'react'
import type { Currency } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Button, Card, Money, Pending, Stat, Table } from '../ui.tsx'
import { FinanceActionForm, FinanceDialog, useResource } from './CompanyFinanceReview.tsx'
import type { Mutate } from './CompanyFund.tsx'

export function CompanyCustody({ today, revision, mutate }: { today: string; revision: number; mutate: Mutate }): ReactNode {
  const { t } = useApp(), w = t.financeWorkspace
  const [direction, setDirection] = useState<'to_custody' | 'to_company' | null>(null)
  const feed = useResource<{ balances: Record<Currency, string>; transfers: Array<{
    id: string; occurredOn: string; direction: 'to_custody' | 'to_company'; currency: Currency; amount: string; reason: string
  }> }>('/company/custody', revision)
  return <Card title={w.ownerCustody} subtitle={w.custodyHint}>
    {!feed.data ? <Pending error={feed.error} loadingLabel={t.common.loading} errorLabel={explainError(feed.error, t)} onRetry={feed.load} retryLabel={t.common.retry} /> : <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{(['SYP_NEW', 'USD'] as const).map(currency => <Stat key={currency} label={t.currency[currency]} value={<Money value={feed.data!.balances[currency]} currency={currency} />} />)}</div>
      <div className="my-3 flex flex-wrap gap-2"><Button variant="ghost" onClick={() => setDirection('to_custody')}>{w.transferToCustody}</Button><Button variant="ghost" onClick={() => setDirection('to_company')}>{w.returnFromCustody}</Button></div>
      <details><summary className="cursor-pointer text-brand">{w.custodyHistory}</summary><Table head={[t.companyFinance.date, t.companyFinance.direction, t.companyFinance.amount, t.companyFinance.description]} isEmpty={!feed.data.transfers.length} empty={t.companyFinance.emptyMovements}>{feed.data.transfers.map(row => <tr key={row.id}><td className="px-3 py-2"><bdi>{row.occurredOn}</bdi></td><td className="px-3 py-2">{row.direction === 'to_custody' ? w.transferToCustody : w.returnFromCustody}</td><td className="px-3 py-2"><Money value={row.amount} currency={row.currency} /></td><td className="px-3 py-2">{row.reason}</td></tr>)}</Table></details>
    </>}
    {direction ? <FinanceDialog title={direction === 'to_custody' ? w.transferToCustody : w.returnFromCustody} onClose={() => setDirection(null)}><FinanceActionForm
      path="/company/custody/transfers" storageScope={direction} title={t.companyFinance.submit} mutate={mutate} onSaved={() => setDirection(null)} fields={[
        { key: 'currency', label: t.companyFinance.currency, value: 'SYP_NEW', options: [{ value: 'SYP_NEW', label: t.currency.SYP_NEW }, { value: 'USD', label: t.currency.USD }] },
        { key: 'amount', label: t.companyFinance.amount, type: 'money' },
        { key: 'occurredOn', label: t.companyFinance.occurredOn, type: 'date', value: today },
        { key: 'historicalRate', label: t.companyFinance.historicalRate, type: 'money', optional: true, visibleWhen: { key: 'currency', value: 'USD' } },
        { key: 'reason', label: t.companyFinance.reason },
      ]} build={values => ({ direction, ...values, historicalRate: values.currency === 'USD' && values.historicalRate ? values.historicalRate : undefined })}
      preview={values => <><p>{w.custodyHint}</p><p>{direction === 'to_custody' ? w.transferToCustody : w.returnFromCustody}</p><Money value={values.amount ?? ''} currency={values.currency as Currency} /><p>{values.occurredOn} · {values.reason}</p></>} />
    </FinanceDialog> : null}
  </Card>
}
