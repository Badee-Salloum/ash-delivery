import type { ReactNode } from 'react'
import { formatMinor, minor, type Currency } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { Money } from '../ui.tsx'
import type { Movement, Mutate } from './CompanyFund.tsx'
import { FinanceActionForm, type FormField } from './CompanyFinanceReview.tsx'

/** The entry id is an optimistic concurrency token, not a hidden overwrite of old evidence. */
export function CompanyOperationEditor({ movement, mutate, onSaved }: { movement: Movement; mutate: Mutate; onSaved: () => void }): ReactNode {
  const { t } = useApp(), command = movement.command!, r = t.financeReview
  const exchange = command.kind === 'exchange'
  const currencies = [{ value: 'SYP_NEW', label: t.currency.SYP_NEW }, { value: 'USD', label: t.currency.USD }]
  const fields: FormField[] = [
    ...(exchange ? [
      { key: 'fromCurrency', label: t.companyFinance.fromCurrency, value: command.fromCurrency ?? 'USD', options: currencies },
      { key: 'fromAmount', label: t.companyFinance.fromAmount, value: command.fromAmount ?? '', type: 'money' as const },
      { key: 'toCurrency', label: t.companyFinance.toCurrency, value: command.toCurrency ?? 'SYP_NEW', options: currencies },
      { key: 'toAmount', label: t.companyFinance.toAmount, value: command.toAmount ?? '', type: 'money' as const },
    ] : [
      { key: 'currency', label: t.companyFinance.currency, value: command.currency ?? 'SYP_NEW', options: currencies },
      { key: 'amount', label: t.companyFinance.amount, value: command.amount ?? '', type: 'money' as const },
      { key: 'historicalRate', label: t.companyFinance.historicalRate, type: 'money' as const,
        value: command.sypMinorPerUsd ? formatMinor(minor(BigInt(command.sypMinorPerUsd))) : '', visibleWhen: { key: 'currency', value: 'USD' } },
    ]),
    { key: 'occurredOn', label: t.companyFinance.occurredOn, type: 'date', value: command.occurredOn ?? movement.entry.businessDate },
    { key: 'description', label: t.companyFinance.description, value: command.description ?? command.reason ?? '' },
    { key: 'reason', label: t.companyFinance.reason },
  ]
  return <div><p className="mb-3 text-body text-ink-muted">{r.operationEditHint}</p>
    <p className="mb-3">{r.before}: {exchange ? <><Money value={command.fromAmount ?? '0.00'} currency={command.fromCurrency ?? 'SYP_NEW'} /> → <Money value={command.toAmount ?? '0.00'} currency={command.toCurrency ?? 'USD'} /></> : <Money value={command.amount ?? '0.00'} currency={command.currency ?? 'SYP_NEW'} />}</p>
    <FinanceActionForm path={`/company/operations/${command.id}/actions`} storageScope={String(movement.entry.id)}
      title={r.saveOperation} fields={fields} mutate={mutate} onSaved={onSaved}
      build={values => ({ action: 'edit', expectedEntryId: movement.entry.id, reason: values.reason,
        values: { description: values.description, occurredOn: values.occurredOn,
          ...(exchange ? { fromCurrency: values.fromCurrency, fromAmount: values.fromAmount, toCurrency: values.toCurrency, toAmount: values.toAmount }
            : { currency: values.currency, amount: values.amount, ...(values.currency === 'USD' ? { historicalRate: values.historicalRate } : {}) }) } })}
      preview={values => <><p>{r.operationEditHint}</p><p>{values.description} · <bdi>{values.occurredOn}</bdi></p><p>{exchange
        ? <><Money value={values.fromAmount!} currency={values.fromCurrency as Currency} /> → <Money value={values.toAmount!} currency={values.toCurrency as Currency} /></>
        : <Money value={values.amount!} currency={values.currency as Currency} />}</p><p>{values.reason}</p></>} />
  </div>
}
