import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { exchangeRate, formatMinor, money, minor, parseMinor, sypToUsdMinor, type Currency, usdToSypMinor } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { useConfirm, useTextPrompt } from '../feedback.tsx'
import type { RouteParams } from '../route.ts'
import { Button, Card, DateField, Field, Money, MoneyInput, Pending, Select, Stat, Table, TextInput } from '../ui.tsx'
import { AssetInstallmentPanel, InstallmentPlanFields, installmentPlanPayload, newInstallmentPlanDraft, type InstallmentPlanDraft } from './AssetInstallments.tsx'

type Tab = 'overview' | 'movements' | 'debts' | 'assets' | 'depreciation' | 'recurring'

interface Overview {
  pockets: Record<Currency, string>
  reserves: Record<Currency, string>
  period: Record<Currency, { income: string; expense: string; deposits: string; withdrawals: string; net: string }>
  branches: Array<{ branchId: string; companyBox: string; clearing: string; balanced: boolean }>
}

interface Movement {
  entry: { id: number; businessDate: string; eventType: string; reason: string | null; sypMinorPerUsd: string | null }
  command: null | {
    id: string
    kind: string
    currency?: Currency
    amount?: string
    fromCurrency?: Currency
    fromAmount?: string
    toCurrency?: Currency
    toAmount?: string
    sypMinorPerUsd?: string | null
    reason?: string
  }
}

interface Debt {
  id: string
  direction: 'payable' | 'receivable'
  partyName: string
  currency: Currency
  principal: string
  outstanding: string
  openedOn: string
  dueOn: string | null
}

export interface Asset {
  id: string
  kind: 'vehicle' | 'equipment' | 'property' | 'other'
  name: string
  currency: Currency
  price: string
  purchasedOn: string
  bookValue: string
  outstanding: string
  depreciationDue: string
  debtId: string | null
  installmentPlans: AssetInstallmentPlan[]
  activeInstallmentPlan: AssetInstallmentPlan | null
}

type InstallmentPaidFrom = 'pocket' | 'reserve' | 'owner_outside'
type InstallmentScheduleKind = 'weekly' | 'monthly_first' | 'every_n_days'

export interface AssetInstallmentPlan {
  id: string
  assetId: string
  debtId: string
  currency: Currency
  amount: string
  paidFrom: InstallmentPaidFrom
  scheduleKind: InstallmentScheduleKind
  weekday: number | null
  intervalDays: number | null
  startsOn: string
  active: boolean
  deactivatedOn: string | null
  deactivationReason: string | null
}

export interface AssetInstallmentDue extends AssetInstallmentPlan {
  assetName: string
  dueDate: string
  status: 'overdue' | 'today' | 'upcoming' | 'later'
  amountDue: string
}

export interface AssetInstallmentDueFeed {
  today: string
  from: string
  to: string
  olderUnresolved: number
  due: AssetInstallmentDue[]
}

interface DepreciationPlan {
  asOfMonth: string
  currencies: Record<Currency, {
    totalDue: string
    transferAmount: string
    remainingDue: string
    allocations: Array<{ assetId: string; period: number; amount: string }>
  }>
}

interface RecurringTemplate {
  id: string
  title: string
  categoryId: string
  currency: Currency
  paidFrom: 'pocket' | 'reserve' | 'owner_outside'
  amount: string
  scheduleKind: 'weekly' | 'monthly_first' | 'every_n_days'
  weekday: number | null
  intervalDays: number | null
  startsOn: string
  endsOn: string | null
  active: boolean
}

interface RecurringDue extends RecurringTemplate {
  dueDate: string
  status: 'overdue' | 'today' | 'upcoming' | 'later'
}

interface VehicleOption {
  id: string
  code: string
  groundNo?: string | null
}

interface VehicleTypeOption {
  id: string
  nameAr: string
  nameEn: string
  typeNo: number
  active: boolean
}

interface CompanyData {
  overview: Overview
  movements: Movement[]
  debts: Debt[]
  assets: Asset[]
  depreciation: DepreciationPlan
  vehicles: VehicleOption[]
  recurring: RecurringTemplate[]
  recurringDue: RecurringDue[]
  installmentDue: AssetInstallmentDueFeed
  categories: Array<{ id: string; nameAr: string; code: string }>
}

const tabs: readonly Tab[] = ['overview', 'movements', 'debts', 'assets', 'depreciation', 'recurring']

type ExchangeField = 'fromAmount' | 'toAmount' | 'rate'

export interface ExchangeFormValues {
  fromCurrency: Currency
  toCurrency: Currency
  fromAmount: string
  toAmount: string
  /** Ordinary SYP per USD, rendered from the stored minor-unit rate. */
  rate: string
}

const exchangeFields: readonly ExchangeField[] = ['fromAmount', 'toAmount', 'rate']

interface ExchangeCalculation {
  sourceA: ExchangeField
  sourceB: ExchangeField
  derived: ExchangeField
}

function positiveExchangeMoney(value: string): ReturnType<typeof parseMinor> | null {
  try {
    const amount = parseMinor(value)
    return amount > 0n ? amount : null
  } catch {
    return null
  }
}

function previewFxDay(rate: bigint) {
  return { businessDate: '2000-01-01', sypMinorPerUsd: rate, provisional: false }
}

/**
 * Derive exactly one of the three exchange values using integer minor units. This is a preview
 * only: the server still freezes the rate it derives from the two actual amounts it posts.
 */
export function deriveExchangeField(values: ExchangeFormValues, derived: ExchangeField): string | null {
  if (values.fromCurrency === values.toCurrency) return null
  const from = positiveExchangeMoney(values.fromAmount)
  const to = positiveExchangeMoney(values.toAmount)
  const rate = positiveExchangeMoney(values.rate)

  try {
    if (derived === 'fromAmount') {
      if (to === null || rate === null) return null
      return formatMinor(values.fromCurrency === 'SYP_NEW'
        ? usdToSypMinor(to, rate)
        : sypToUsdMinor(to, previewFxDay(rate)))
    }
    if (derived === 'toAmount') {
      if (from === null || rate === null) return null
      return formatMinor(values.toCurrency === 'SYP_NEW'
        ? usdToSypMinor(from, rate)
        : sypToUsdMinor(from, previewFxDay(rate)))
    }
    if (from === null || to === null) return null
    return formatMinor(minor(exchangeRate(money(values.fromCurrency, from), money(values.toCurrency, to))))
  } catch {
    return null
  }
}

function thirdExchangeField(first: ExchangeField, second: ExchangeField): ExchangeField | null {
  return exchangeFields.find((field) => field !== first && field !== second) ?? null
}

function nextExchangeCalculation(
  current: ExchangeCalculation | null,
  changed: ExchangeField,
  values: ExchangeFormValues,
): ExchangeCalculation | null {
  if (positiveExchangeMoney(values[changed]) === null) return null
  if (current !== null) {
    if (changed === current.derived && positiveExchangeMoney(values[current.sourceA]) !== null) {
      const derived = thirdExchangeField(current.sourceA, changed)
      if (derived !== null) return { sourceA: current.sourceA, sourceB: changed, derived }
    }
    if (
      (changed === current.sourceA || changed === current.sourceB) &&
      positiveExchangeMoney(values[current.sourceA]) !== null &&
      positiveExchangeMoney(values[current.sourceB]) !== null
    ) return current
  }
  const other = exchangeFields.find((field) => field !== changed && positiveExchangeMoney(values[field]) !== null)
  const derived = other === undefined ? null : thirdExchangeField(other, changed)
  return other === undefined || derived === null ? null : { sourceA: other, sourceB: changed, derived }
}

function normalizedFrozenRate(rate: string | null | undefined): string | null {
  if (rate === null || rate === undefined) return null
  try {
    return /^\d+$/.test(rate) ? formatMinor(minor(BigInt(rate))) : null
  } catch {
    return null
  }
}

export function CompanyFund({ initial = {} }: { initial?: RouteParams }): ReactNode {
  const { api, session, t, branchId } = useApp()
  const today = session?.businessDate ?? ''
  const month = today === '' ? '' : `${today.slice(0, 7)}-01`
  const [tab, setTab] = useState<Tab>(() => tabs.includes(initial.tab as Tab) ? initial.tab as Tab : 'overview')
  const [data, setData] = useState<CompanyData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    if (branchId === null) return
    setError(null)
    const range = `from=2000-01-01&to=${encodeURIComponent(today)}`
    void Promise.all([
      api.get<Overview>(`/company/overview?${range}`),
      api.get<{ movements: Movement[] }>(`/company/movements?${range}`),
      api.get<{ debts: Debt[] }>('/company/debts'),
      api.get<{ assets: Asset[] }>('/company/assets'),
      api.get<DepreciationPlan>(`/company/depreciation?asOfMonth=${encodeURIComponent(month)}`),
      api.get<{ vehicles: VehicleOption[] }>('/vehicles'),
      api.get<{ templates: RecurringTemplate[] }>('/company/recurring-expenses?includeInactive=true'),
      api.get<{ due: RecurringDue[] }>('/company/recurring-expenses/due'),
      api.get<AssetInstallmentDueFeed>('/company/assets/installment-plans/due'),
      api.get<{ categories: Array<{ id: string; nameAr: string; code: string }> }>('/expense-categories'),
    ]).then(([overview, movements, debts, assets, depreciation, vehicles, recurring, recurringDue, installmentDue, categories]) => {
      setData({
        overview, movements: movements.movements, debts: debts.debts, assets: assets.assets,
        depreciation, vehicles: vehicles.vehicles, recurring: recurring.templates,
        recurringDue: recurringDue.due, installmentDue, categories: categories.categories,
      })
    }).catch((cause: { error?: string }) => {
      setData(null)
      setError(cause.error ?? 'error')
    })
  }, [api, branchId, month, today])

  useEffect(() => {
    // Company finance is global, but its vehicle picker is branch-scoped. Blank the prior branch
    // while the next read is in flight so an old vehicle can never be submitted under a new branch.
    setData(null)
    setNotice(null)
    load()
  }, [load])

  const mutate = async (operation: () => Promise<unknown>, success: string): Promise<boolean> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await operation()
      setNotice(success)
      load()
      return true
    } catch (cause) {
      setError((cause as { error?: string }).error ?? 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  if (data === null) {
    return <Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error, t)} onRetry={load} retryLabel={t.common.retry} />
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-ink-muted">{t.companyFinance.subtitle}</p>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t.companyFinance.title}>
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            onClick={() => setTab(item)}
            className={`min-h-10 rounded-lg border px-3 text-body font-semibold ${
              tab === item ? 'border-brand bg-brand text-on-brand' : 'border-line-strong bg-surface-card text-ink hover:bg-surface-muted'
            }`}
          >
            {t.companyFinance.tabs[item]}
          </button>
        ))}
      </div>
      {error ? <p role="alert" className="text-body font-medium text-danger-ink">{explainError(error, t)}</p> : null}
      {notice ? <p role="status" className="text-body font-medium text-success-ink">{notice}</p> : null}
      {tab === 'overview' ? <OverviewTab data={data.overview} busy={busy} mutate={mutate} /> : null}
      {tab === 'movements' ? <MovementsTab rows={data.movements} /> : null}
      {tab === 'debts' ? <DebtsTab rows={data.debts} today={today} busy={busy} mutate={mutate} /> : null}
      {tab === 'assets' ? <AssetsTab rows={data.assets} due={data.installmentDue} vehicles={data.vehicles} today={today} busy={busy} mutate={mutate} /> : null}
      {tab === 'depreciation' ? <DepreciationTab plan={data.depreciation} busy={busy} mutate={mutate} /> : null}
      {tab === 'recurring' ? <RecurringTab rows={data.recurring} due={data.recurringDue} categories={data.categories} today={today} busy={busy} mutate={mutate} /> : null}
    </div>
  )
}

export type Mutate = (operation: () => Promise<unknown>, success: string) => Promise<boolean>

function OverviewTab({ data, busy, mutate }: { data: Overview; busy: boolean; mutate: Mutate }): ReactNode {
  const { api, t } = useApp()
  const [direction, setDirection] = useState<'deposit' | 'withdraw'>('deposit')
  const [currency, setCurrency] = useState<Currency>('SYP_NEW')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const path = direction === 'deposit' ? '/company/deposits' : '/company/withdrawals'
    void mutate(
      () => api.post(path, { idempotencyKey: crypto.randomUUID(), currency, amount, reason }),
      t.companyFinance.saved,
    ).then(() => { setAmount(''); setReason('') })
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat lead label={t.companyFinance.sypPocket} value={<Money value={data.pockets.SYP_NEW} currency="SYP_NEW" />} />
        <Stat label={t.companyFinance.usdPocket} value={<Money value={data.pockets.USD} currency="USD" />} />
        <Stat label={t.companyFinance.sypReserve} value={<Money value={data.reserves.SYP_NEW} currency="SYP_NEW" />} />
        <Stat label={t.companyFinance.usdReserve} value={<Money value={data.reserves.USD} currency="USD" />} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title={t.companyFinance.quickMove}>
          <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={submit}>
            <Field label={t.companyFinance.kind}>
              <Select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)} aria-label={t.companyFinance.kind}>
                <option value="deposit">{t.companyFinance.deposit}</option>
                <option value="withdraw">{t.companyFinance.withdraw}</option>
              </Select>
            </Field>
            <Field label={t.companyFinance.currency}>
              <Select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} aria-label={t.companyFinance.currency}>
                <option value="SYP_NEW">{t.currency.SYP_NEW}</option>
                <option value="USD">{t.currency.USD}</option>
              </Select>
            </Field>
            <Field label={t.companyFinance.amount}><MoneyInput required value={amount} onChange={(event) => setAmount(event.target.value)} aria-label={t.companyFinance.amount} /></Field>
            <Field label={t.companyFinance.reason}><TextInput required value={reason} onChange={(event) => setReason(event.target.value)} aria-label={t.companyFinance.reason} /></Field>
            <Button type="submit" disabled={busy}>{t.companyFinance.submit}</Button>
          </form>
        </Card>
        <ExchangeCard busy={busy} mutate={mutate} />
        <Card title={t.companyFinance.branches} className="xl:col-span-2">
          <Table head={[t.accounts.branch, t.dashboard.balance, t.companyFinance.clearing, t.accounts.status]} isEmpty={data.branches.length === 0} empty={t.companyFinance.noBranches}>
            {data.branches.map((branch) => (
              <tr key={branch.branchId}>
                <td className="num px-3 py-2">{branch.branchId}</td>
                <td className="px-3 py-2 text-end"><Money value={branch.companyBox} currency="SYP_NEW" /></td>
                <td className="px-3 py-2 text-end"><Money value={branch.clearing} currency="SYP_NEW" /></td>
                <td className={`px-3 py-2 font-medium ${branch.balanced ? 'text-success-ink' : 'text-danger-ink'}`}>{branch.balanced ? t.companyFinance.balanced : t.companyFinance.unbalanced}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  )
}

function ExchangeCard({ busy, mutate }: { busy: boolean; mutate: Mutate }): ReactNode {
  const { api, t } = useApp()
  const confirm = useConfirm()
  const [fromCurrency, setFromCurrency] = useState<Currency>('USD')
  const [toCurrency, setToCurrency] = useState<Currency>('SYP_NEW')
  const [exchange, setExchange] = useState<ExchangeFormValues>({
    fromCurrency: 'USD', toCurrency: 'SYP_NEW', fromAmount: '', toAmount: '', rate: '',
  })
  const [calculation, setCalculation] = useState<ExchangeCalculation | null>(null)
  const [reason, setReason] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const reset = (): void => {
    setExchange({ fromCurrency, toCurrency, fromAmount: '', toAmount: '', rate: '' })
    setCalculation(null)
    setReason('')
    setFormError(null)
  }

  const changeCurrency = (side: 'from' | 'to', currency: Currency): void => {
    const nextFrom = side === 'from' ? currency : fromCurrency
    const nextTo = side === 'to' ? currency : toCurrency
    const normalizedFrom = nextFrom === nextTo && side === 'to'
      ? (nextTo === 'USD' ? 'SYP_NEW' : 'USD')
      : nextFrom
    const normalizedTo = normalizedFrom === nextTo
      ? (normalizedFrom === 'USD' ? 'SYP_NEW' : 'USD')
      : nextTo
    setFromCurrency(normalizedFrom)
    setToCurrency(normalizedTo)
    setExchange({ fromCurrency: normalizedFrom, toCurrency: normalizedTo, fromAmount: '', toAmount: '', rate: '' })
    setCalculation(null)
    setFormError(null)
  }

  const changeValue = (field: ExchangeField, value: string): void => {
    const next = { ...exchange, fromCurrency, toCurrency, [field]: value }
    const nextCalculation = nextExchangeCalculation(calculation, field, next)
    if (nextCalculation !== null) {
      const derived = deriveExchangeField(next, nextCalculation.derived)
      if (derived !== null) next[nextCalculation.derived] = derived
    }
    setExchange(next)
    setCalculation(nextCalculation)
    setFormError(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const values = { ...exchange, fromCurrency, toCurrency }
    const from = positiveExchangeMoney(values.fromAmount)
    const to = positiveExchangeMoney(values.toAmount)
    const frozenRate = deriveExchangeField(values, 'rate')
    if (from === null || to === null || frozenRate === null || reason.trim() === '') {
      setFormError(t.companyFinance.exchangeInvalid)
      return
    }
    const fromText = `${formatMinor(from)} ${t.currency[fromCurrency]}`
    const toText = `${formatMinor(to)} ${t.currency[toCurrency]}`
    const rateText = `${frozenRate} ${t.companyFinance.ratePerUsd}`
    void (async () => {
      const accepted = await confirm({
        title: t.companyFinance.exchangeConfirmTitle,
        body: t.companyFinance.exchangeConfirmBody
          .replace('{from}', fromText)
          .replace('{to}', toText)
          .replace('{rate}', rateText),
        confirmLabel: t.companyFinance.exchangeSubmit,
      })
      if (!accepted) return
      const saved = await mutate(
        () => api.post('/company/exchanges', {
          idempotencyKey: crypto.randomUUID(), fromCurrency, fromAmount: formatMinor(from),
          toCurrency, toAmount: formatMinor(to), reason: reason.trim(),
        }),
        t.companyFinance.exchangeSaved,
      )
      if (saved) reset()
    })()
  }

  return (
    <Card title={t.companyFinance.exchange} subtitle={t.companyFinance.exchangeHint}>
      <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={submit}>
        <Field label={t.companyFinance.fromCurrency}>
          <Select value={fromCurrency} disabled={busy} onChange={(event) => changeCurrency('from', event.target.value as Currency)} aria-label={t.companyFinance.fromCurrency}>
            <option value="SYP_NEW" disabled={toCurrency === 'SYP_NEW'}>{t.currency.SYP_NEW}</option>
            <option value="USD" disabled={toCurrency === 'USD'}>{t.currency.USD}</option>
          </Select>
        </Field>
        <Field label={t.companyFinance.toCurrency}>
          <Select value={toCurrency} disabled={busy} onChange={(event) => changeCurrency('to', event.target.value as Currency)} aria-label={t.companyFinance.toCurrency}>
            <option value="SYP_NEW" disabled={fromCurrency === 'SYP_NEW'}>{t.currency.SYP_NEW}</option>
            <option value="USD" disabled={fromCurrency === 'USD'}>{t.currency.USD}</option>
          </Select>
        </Field>
        <Field label={t.companyFinance.fromAmount}>
          <MoneyInput required value={exchange.fromAmount} disabled={busy} onChange={(event) => changeValue('fromAmount', event.target.value)} aria-label={t.companyFinance.fromAmount} />
        </Field>
        <Field label={t.companyFinance.toAmount}>
          <MoneyInput required value={exchange.toAmount} disabled={busy} onChange={(event) => changeValue('toAmount', event.target.value)} aria-label={t.companyFinance.toAmount} />
        </Field>
        <Field label={t.companyFinance.exchangeRate} hint={t.companyFinance.ratePerUsd}>
          <MoneyInput required value={exchange.rate} disabled={busy} onChange={(event) => changeValue('rate', event.target.value)} aria-label={t.companyFinance.exchangeRate} />
        </Field>
        <Field label={t.companyFinance.reason}>
          <TextInput required value={reason} disabled={busy} onChange={(event) => { setReason(event.target.value); setFormError(null) }} aria-label={t.companyFinance.reason} />
        </Field>
        {formError ? <p role="alert" className="sm:col-span-2 text-label font-medium text-danger-ink">{formError}</p> : null}
        <Button type="submit" disabled={busy} className="sm:col-span-2">{t.companyFinance.exchangeSubmit}</Button>
      </form>
    </Card>
  )
}

function MovementsTab({ rows }: { rows: Movement[] }): ReactNode {
  const { t } = useApp()
  return (
    <Card title={t.companyFinance.tabs.movements}>
      <Table head={[t.companyFinance.date, t.companyFinance.kind, t.companyFinance.amount, t.companyFinance.description, t.companyFinance.rate]} isEmpty={rows.length === 0} empty={t.companyFinance.emptyMovements}>
        {rows.map((row) => {
          const command = row.command
          const exchange = command?.kind === 'exchange' &&
            command.fromCurrency !== undefined && command.fromAmount !== undefined &&
            command.toCurrency !== undefined && command.toAmount !== undefined
            ? {
              fromCurrency: command.fromCurrency,
              fromAmount: command.fromAmount,
              toCurrency: command.toCurrency,
              toAmount: command.toAmount,
            }
            : null
          const amount = command?.amount ?? command?.fromAmount ?? command?.toAmount ?? null
          const frozenRate = normalizedFrozenRate(command?.sypMinorPerUsd ?? row.entry.sypMinorPerUsd)
          return (
            <tr key={row.entry.id}>
              <td className="num px-3 py-2">{row.entry.businessDate}</td>
              <td className="px-3 py-2">{command?.kind ?? row.entry.eventType}</td>
              <td className="px-3 py-2 text-end">
                {exchange ? (
                  <span className="inline-flex flex-wrap items-center justify-end gap-1">
                    <Money value={exchange.fromAmount} currency={exchange.fromCurrency} />
                    <span aria-hidden="true" className="text-ink-muted">→</span>
                    <Money value={exchange.toAmount} currency={exchange.toCurrency} />
                  </span>
                ) : amount === null ? '—' : <Money value={amount} currency={command?.currency ?? 'SYP_NEW'} />}
              </td>
              <td className="px-3 py-2">{command?.reason ?? row.entry.reason ?? '—'}</td>
              <td className="px-3 py-2 text-end">
                {frozenRate === null ? '—' : <span className="inline-flex items-center gap-1"><Money value={frozenRate} currency="SYP_NEW" /><span className="text-ink-muted">/ {t.currency.USD}</span></span>}
              </td>
            </tr>
          )
        })}
      </Table>
    </Card>
  )
}

function DebtsTab({ rows, today, busy, mutate }: { rows: Debt[]; today: string; busy: boolean; mutate: Mutate }): ReactNode {
  const { api, t } = useApp()
  const [partyName, setPartyName] = useState('')
  const [direction, setDirection] = useState<'payable' | 'receivable'>('payable')
  const [currency, setCurrency] = useState<Currency>('SYP_NEW')
  const [principal, setPrincipal] = useState('')
  const [openedOn, setOpenedOn] = useState(today)
  const [dueOn, setDueOn] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void mutate(() => api.post('/company/debts', {
      idempotencyKey: crypto.randomUUID(), direction, partyName, currency, principal, openedOn,
      dueOn: dueOn === '' ? null : dueOn, note: null, origin: 'opening',
    }), t.companyFinance.saved).then(() => { setPartyName(''); setPrincipal(''); setDueOn('') })
  }
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(20rem,1fr)_2fr]">
      <Card title={t.companyFinance.addDebt}>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Field label={t.companyFinance.party}><TextInput required value={partyName} onChange={(event) => setPartyName(event.target.value)} aria-label={t.companyFinance.party} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.companyFinance.direction}><Select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)} aria-label={t.companyFinance.direction}><option value="payable">{t.companyFinance.payable}</option><option value="receivable">{t.companyFinance.receivable}</option></Select></Field>
            <Field label={t.companyFinance.currency}><Select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} aria-label={t.companyFinance.currency}><option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option></Select></Field>
          </div>
          <Field label={t.companyFinance.principal}><MoneyInput required value={principal} onChange={(event) => setPrincipal(event.target.value)} aria-label={t.companyFinance.principal} /></Field>
          <DateField label={t.companyFinance.openedOn} value={openedOn} onChange={setOpenedOn} />
          <DateField label={t.companyFinance.dueOn} value={dueOn} onChange={setDueOn} />
          <Button type="submit" disabled={busy}>{t.companyFinance.addDebt}</Button>
        </form>
      </Card>
      <Card title={t.companyFinance.debtsTitle}>
        <Table head={[t.companyFinance.party, t.companyFinance.direction, t.companyFinance.principal, t.companyFinance.outstanding, t.companyFinance.dueOn]} isEmpty={rows.length === 0} empty={t.companyFinance.noDebts}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-3 py-2">{row.partyName}</td>
              <td className="px-3 py-2">{row.direction === 'payable' ? t.companyFinance.payable : t.companyFinance.receivable}</td>
              <td className="px-3 py-2 text-end"><Money value={row.principal} currency={row.currency} /></td>
              <td className="px-3 py-2 text-end"><Money value={row.outstanding} currency={row.currency} /></td>
              <td className="num px-3 py-2">{row.dueOn ?? '—'}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  )
}

function AssetVehicleCreator({ onCreated }: { onCreated(vehicle: VehicleOption): void }): ReactNode {
  const { api, t, lang } = useApp()
  const [types, setTypes] = useState<VehicleTypeOption[] | null>(null)
  const [typeId, setTypeId] = useState('')
  const [groundNo, setGroundNo] = useState('')
  const [plateNo, setPlateNo] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setError(null)
    void api.vehicleTypes()
      .then(({ vehicleTypes }) => {
        if (!current) return
        const active = vehicleTypes.filter((type) => type.active)
        setTypes(active)
        if (active.length === 1) setTypeId(active[0]!.id)
      })
      .catch((cause: { error?: string }) => {
        if (!current) return
        setTypes([])
        setError(cause.error ?? 'error')
      })
    return () => { current = false }
  }, [api])

  useEffect(() => {
    let current = true
    setPreview(null)
    if (typeId !== '') {
      void api.nextVehicleNumber(typeId)
        .then((result) => { if (current) setPreview(result.code) })
        .catch(() => { if (current) setPreview(null) })
    }
    return () => { current = false }
  }, [api, typeId])

  const create = async (): Promise<void> => {
    if (typeId === '') return
    setBusy(true)
    setError(null)
    try {
      const vehicle = await api.createVehicle({
        vehicleTypeId: typeId,
        groundNo: groundNo.trim() === '' ? null : groundNo.trim(),
        plateNo: plateNo.trim() === '' ? null : plateNo.trim(),
      })
      onCreated({ id: vehicle.id, code: vehicle.code, groundNo: vehicle.groundNo })
    } catch (cause) {
      setError((cause as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line-strong bg-surface-muted p-3" role="region" aria-label={t.companyFinance.addNewVehicle}>
      <p className="text-sm text-ink-muted">{t.companyFinance.vehicleOnlyHint}</p>
      <Field label={t.fleet.vehicleType}>
        <Select value={typeId} disabled={busy || types === null} onChange={(event) => setTypeId(event.target.value)} aria-label={t.fleet.vehicleType}>
          <option value="">—</option>
          {(types ?? []).map((type) => (
            <option key={type.id} value={type.id}>{type.typeNo} — {lang === 'ar' ? type.nameAr : type.nameEn}</option>
          ))}
        </Select>
      </Field>
      {types?.length === 0 && error === null ? <p className="text-sm text-warning-ink">{t.companyFinance.noActiveVehicleTypes}</p> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t.fleet.groundNo} hint={t.fleet.groundNoHint}>
          <TextInput value={groundNo} disabled={busy} onChange={(event) => setGroundNo(event.target.value)} aria-label={t.fleet.groundNo} />
        </Field>
        <Field label={t.fleet.plateNo}>
          <TextInput value={plateNo} disabled={busy} onChange={(event) => setPlateNo(event.target.value)} aria-label={t.fleet.plateNo} />
        </Field>
      </div>
      {preview ? <p className="text-sm text-ink-muted">{t.fleet.numberPreview}: <span className="num font-semibold text-brand">{preview}</span></p> : null}
      {error ? <p role="alert" className="text-sm text-danger-ink">{explainError(error, t)}</p> : null}
      <Button type="button" className="self-start" disabled={busy || typeId === '' || types === null} onClick={() => void create()}>
        {busy ? t.common.loading : t.companyFinance.createVehicleOnly}
      </Button>
    </div>
  )
}

function AssetsTab({ rows, due, vehicles, today, busy, mutate }: {
  rows: Asset[]
  due: AssetInstallmentDueFeed
  vehicles: CompanyData['vehicles']
  today: string
  busy: boolean
  mutate: Mutate
}): ReactNode {
  const { api, t, branchId } = useApp()
  const [kind, setKind] = useState<Asset['kind']>('equipment')
  const [vehicleId, setVehicleId] = useState('')
  const [createdVehicles, setCreatedVehicles] = useState<VehicleOption[]>([])
  const [showVehicleCreator, setShowVehicleCreator] = useState(false)
  const [vehicleNotice, setVehicleNotice] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState<Currency>('SYP_NEW')
  const [price, setPrice] = useState('')
  const [purchasedOn, setPurchasedOn] = useState(today)
  const [paidNow, setPaidNow] = useState('')
  const [paidFrom, setPaidFrom] = useState<'pocket' | 'reserve' | 'owner_outside' | 'opening'>('pocket')
  const [financedPartyName, setFinancedPartyName] = useState('')
  const [financedDueOn, setFinancedDueOn] = useState('')
  const [scheduleNewAsset, setScheduleNewAsset] = useState(false)
  const [newPlan, setNewPlan] = useState<InstallmentPlanDraft>(() => newInstallmentPlanDraft(due.today || today))
  const availableVehicles = useMemo(() => {
    const byId = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]))
    for (const vehicle of createdVehicles) byId.set(vehicle.id, vehicle)
    return [...byId.values()]
  }, [createdVehicles, vehicles])
  const selectedVehicle = useMemo(
    () => availableVehicles.find((vehicle) => vehicle.id === vehicleId),
    [availableVehicles, vehicleId],
  )

  useEffect(() => {
    setVehicleId('')
    setCreatedVehicles([])
    setShowVehicleCreator(false)
    setVehicleNotice(null)
  }, [branchId])

  const vehicleCreated = (vehicle: VehicleOption): void => {
    setCreatedVehicles((current) => [...current.filter((row) => row.id !== vehicle.id), vehicle])
    setVehicleId(vehicle.id)
    setShowVehicleCreator(false)
    setVehicleNotice(t.companyFinance.vehicleCreatedAndSelected)
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void mutate(() => api.post('/company/assets', {
      idempotencyKey: crypto.randomUUID(), kind, vehicleId: kind === 'vehicle' ? vehicleId : null,
      name: kind === 'vehicle' && selectedVehicle ? selectedVehicle.groundNo ?? selectedVehicle.code : name,
      currency, price, purchasedOn, paidNow, paidFrom,
      description: name || selectedVehicle?.code || t.companyFinance.assetsTitle,
      financedPartyName: financedPartyName === '' ? null : financedPartyName,
      financedDueOn: financedDueOn === '' ? null : financedDueOn,
      financedNote: null,
      ...(scheduleNewAsset ? { installmentPlan: installmentPlanPayload(newPlan) } : {}),
    }), t.companyFinance.saved).then((saved) => {
      if (!saved) return
      setName(''); setPrice(''); setPaidNow(''); setFinancedPartyName(''); setFinancedDueOn('')
      setScheduleNewAsset(false)
      setNewPlan(newInstallmentPlanDraft(due.today || purchasedOn))
    })
  }
  return (
    <div className="flex flex-col gap-4">
      <AssetInstallmentPanel rows={rows} due={due} today={due.today || today} busy={busy} mutate={mutate} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(20rem,1fr)_2fr]">
      <Card title={t.companyFinance.addAsset}>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Field label={t.companyFinance.assetKind}>
            <Select
              value={kind}
              onChange={(event) => {
                const next = event.target.value as Asset['kind']
                setKind(next)
                if (next !== 'vehicle') {
                  setShowVehicleCreator(false)
                  setVehicleNotice(null)
                }
              }}
              aria-label={t.companyFinance.assetKind}
            >
              <option value="equipment">{t.companyFinance.equipment}</option><option value="property">{t.companyFinance.property}</option><option value="other">{t.companyFinance.other}</option><option value="vehicle">{t.companyFinance.vehicle}</option>
            </Select>
          </Field>
          {kind === 'vehicle' ? (
            <div className="flex flex-col gap-2">
              <Field label={t.companyFinance.vehicle}>
                <Select required value={vehicleId} onChange={(event) => setVehicleId(event.target.value)} aria-label={t.companyFinance.vehicle}>
                  <option value="">—</option>
                  {availableVehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.groundNo ?? vehicle.code}</option>)}
                </Select>
              </Field>
              <Button
                type="button"
                variant="ghost"
                className="self-start"
                onClick={() => {
                  setShowVehicleCreator((current) => !current)
                  setVehicleNotice(null)
                }}
              >
                {showVehicleCreator ? t.common.cancel : t.companyFinance.addNewVehicle}
              </Button>
              {showVehicleCreator ? <AssetVehicleCreator key={branchId ?? 'no-branch'} onCreated={vehicleCreated} /> : null}
              {vehicleNotice ? <p role="status" className="text-sm font-medium text-success-ink">{vehicleNotice}</p> : null}
            </div>
          ) : <Field label={t.companyFinance.name}><TextInput required value={name} onChange={(event) => setName(event.target.value)} aria-label={t.companyFinance.name} /></Field>}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.companyFinance.currency}><Select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} aria-label={t.companyFinance.currency}><option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option></Select></Field>
            <Field label={t.companyFinance.price}><MoneyInput required value={price} onChange={(event) => setPrice(event.target.value)} aria-label={t.companyFinance.price} /></Field>
          </div>
          <DateField label={t.companyFinance.purchasedOn} value={purchasedOn} onChange={(next) => {
            if (newPlan.startsOn === purchasedOn) setNewPlan((current) => ({ ...current, startsOn: next }))
            setPurchasedOn(next)
          }} />
          <Field label={t.companyFinance.paidNow}><MoneyInput required value={paidNow} onChange={(event) => setPaidNow(event.target.value)} aria-label={t.companyFinance.paidNow} /></Field>
          <Field label={t.companyFinance.paidFrom}><Select value={paidFrom} onChange={(event) => setPaidFrom(event.target.value as typeof paidFrom)} aria-label={t.companyFinance.paidFrom}><option value="pocket">{t.companyFinance.pocket}</option><option value="reserve">{t.companyFinance.reserve}</option><option value="owner_outside">{t.companyFinance.ownerOutside}</option><option value="opening">{t.companyFinance.opening}</option></Select></Field>
          <Field label={t.companyFinance.financedParty}><TextInput required={scheduleNewAsset} value={financedPartyName} onChange={(event) => setFinancedPartyName(event.target.value)} aria-label={t.companyFinance.financedParty} /></Field>
          <DateField label={t.companyFinance.financedDue} value={financedDueOn} onChange={setFinancedDueOn} />
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line-strong bg-surface-muted p-3 text-body text-ink">
            <input type="checkbox" checked={scheduleNewAsset} onChange={(event) => setScheduleNewAsset(event.target.checked)} className="mt-0.5 size-4 accent-brand" />
            <span>{t.companyFinance.scheduleInstallments}</span>
          </label>
          {scheduleNewAsset ? <InstallmentPlanFields value={newPlan} onChange={setNewPlan} disabled={busy} /> : null}
          <Button type="submit" disabled={busy}>{t.companyFinance.addAsset}</Button>
        </form>
      </Card>
      <Card title={t.companyFinance.assetsTitle}>
        <Table head={[t.companyFinance.name, t.companyFinance.kind, t.companyFinance.price, t.companyFinance.bookValue, t.companyFinance.outstanding, t.companyFinance.depreciationDue]} isEmpty={rows.length === 0} empty={t.companyFinance.noAssets}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-3 py-2">{row.name}</td><td className="px-3 py-2">{t.companyFinance[row.kind]}</td>
              <td className="px-3 py-2 text-end"><Money value={row.price} currency={row.currency} /></td>
              <td className="px-3 py-2 text-end"><Money value={row.bookValue} currency={row.currency} /></td>
              <td className="px-3 py-2 text-end"><Money value={row.outstanding} currency={row.currency} /></td>
              <td className="px-3 py-2 text-end"><Money value={row.depreciationDue} currency={row.currency} /></td>
            </tr>
          ))}
        </Table>
      </Card>
      </div>
    </div>
  )
}

function DepreciationTab({ plan, busy, mutate }: { plan: DepreciationPlan; busy: boolean; mutate: Mutate }): ReactNode {
  const { api, t } = useApp()
  const transfer = (currency: Currency): void => {
    const amount = plan.currencies[currency].transferAmount
    void mutate(() => api.post('/company/depreciation/transfers', {
      idempotencyKey: crypto.randomUUID(), currency, asOfMonth: plan.asOfMonth,
      expectedAmount: amount, reason: t.companyFinance.depreciationTitle,
    }), t.companyFinance.transferred)
  }
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {(['SYP_NEW', 'USD'] as const).map((currency) => {
        const row = plan.currencies[currency]
        return (
          <Card key={currency} title={`${t.companyFinance.depreciationTitle} · ${t.currency[currency]}`}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label={t.companyFinance.totalDue} value={<Money value={row.totalDue} currency={currency} />} />
              <Stat lead label={t.companyFinance.transferAmount} value={<Money value={row.transferAmount} currency={currency} />} />
              <Stat label={t.companyFinance.remainingDue} value={<Money value={row.remainingDue} currency={currency} />} />
            </div>
            <Button className="mt-3" type="button" disabled={busy || row.transferAmount === '0.00'} onClick={() => transfer(currency)}>{t.companyFinance.transfer}</Button>
          </Card>
        )
      })}
    </div>
  )
}

function RecurringTab({
  rows,
  due,
  categories,
  today,
  busy,
  mutate,
}: {
  rows: RecurringTemplate[]
  due: RecurringDue[]
  categories: CompanyData['categories']
  today: string
  busy: boolean
  mutate: Mutate
}): ReactNode {
  const { api, t } = useApp()
  const requestText = useTextPrompt()
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '')
  const [currency, setCurrency] = useState<Currency>('SYP_NEW')
  const [paidFrom, setPaidFrom] = useState<'pocket' | 'reserve' | 'owner_outside'>('pocket')
  const [amount, setAmount] = useState('')
  const [scheduleKind, setScheduleKind] = useState<'weekly' | 'monthly_first' | 'every_n_days'>('monthly_first')
  const [weekday, setWeekday] = useState(0)
  const [intervalDays, setIntervalDays] = useState('30')
  const [startsOn, setStartsOn] = useState(today)
  const [endsOn, setEndsOn] = useState('')

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void mutate(() => api.post('/company/recurring-expenses', {
      idempotencyKey: crypto.randomUUID(), title, categoryId, costCenterKind: 'general',
      vehicleId: null, assetId: null, currency, paidFrom, amount, scheduleKind,
      weekday: scheduleKind === 'weekly' ? weekday : null,
      intervalDays: scheduleKind === 'every_n_days' ? Number(intervalDays) : null,
      startsOn, endsOn: endsOn === '' ? null : endsOn,
    }), t.expenses.fixedSaved).then(() => { setTitle(''); setAmount('') })
  }
  const pay = (row: RecurringDue): void => {
    void mutate(() => api.post(`/company/recurring-expenses/${row.id}/occurrences/${row.dueDate}/pay`, {
      idempotencyKey: crypto.randomUUID(), amount: row.amount, receiptMediaId: null, reason: null,
    }), t.expenses.paid)
  }
  const skip = (row: RecurringDue): void => {
    void (async () => {
      const reason = await requestText({
        title: t.expenses.skip,
        label: t.expenses.skipReason,
        confirmLabel: t.expenses.skip,
      })
      if (reason === null) return
      await mutate(
        () => api.post(`/company/recurring-expenses/${row.id}/occurrences/${row.dueDate}/skip`, { reason }),
        t.expenses.skipped,
      )
    })()
  }
  const deactivate = (row: RecurringTemplate): void => {
    void (async () => {
      const reason = await requestText({
        title: t.expenses.deactivate,
        label: t.expenses.deactivationReason,
        confirmLabel: t.expenses.deactivate,
        danger: true,
      })
      if (reason === null) return
      await mutate(
        () => api.post(`/company/recurring-expenses/${row.id}/deactivate`, { reason }),
        t.expenses.deactivated,
      )
    })()
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(20rem,1fr)_2fr]">
      <Card title={t.expenses.newFixed}>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Field label={t.expenses.name}><TextInput required value={title} onChange={(event) => setTitle(event.target.value)} aria-label={t.expenses.name} /></Field>
          <Field label={t.expenses.category}><Select required value={categoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label={t.expenses.category}>{categories.map((category) => <option key={category.id} value={category.id}>{category.nameAr} · {category.code}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.companyFinance.currency}><Select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} aria-label={t.companyFinance.currency}><option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option></Select></Field>
            <Field label={t.companyFinance.paidFrom}><Select value={paidFrom} onChange={(event) => setPaidFrom(event.target.value as typeof paidFrom)} aria-label={t.companyFinance.paidFrom}><option value="pocket">{t.companyFinance.pocket}</option><option value="reserve">{t.companyFinance.reserve}</option><option value="owner_outside">{t.companyFinance.ownerOutside}</option></Select></Field>
          </div>
          <Field label={t.companyFinance.amount}><MoneyInput required value={amount} onChange={(event) => setAmount(event.target.value)} aria-label={t.companyFinance.amount} /></Field>
          <Field label={t.expenses.recurrence}><Select value={scheduleKind} onChange={(event) => setScheduleKind(event.target.value as typeof scheduleKind)} aria-label={t.expenses.recurrence}><option value="monthly_first">{t.expenses.monthlyFirst}</option><option value="weekly">{t.expenses.weekly}</option><option value="every_n_days">{t.expenses.everyNDays}</option></Select></Field>
          {scheduleKind === 'weekly' ? <Field label={t.expenses.weekday}><Select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))} aria-label={t.expenses.weekday}>{t.expenses.weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}</Select></Field> : null}
          {scheduleKind === 'every_n_days' ? <Field label={t.expenses.intervalDays}><TextInput type="number" min="1" max="366" value={intervalDays} onChange={(event) => setIntervalDays(event.target.value)} aria-label={t.expenses.intervalDays} /></Field> : null}
          <DateField label={t.expenses.startsOn} value={startsOn} onChange={setStartsOn} />
          <DateField label={t.expenses.endsOn} value={endsOn} onChange={setEndsOn} />
          <Button type="submit" disabled={busy || categoryId === ''}>{t.expenses.saveFixed}</Button>
        </form>
      </Card>
      <div className="flex flex-col gap-4">
        <Card title={t.expenses.tabDue}>
          <Table head={[t.expenses.name, t.companyFinance.date, t.companyFinance.amount, t.expenses.actionLabel]} isEmpty={due.length === 0} empty={t.expenses.nothingDue}>
            {due.map((row) => (
              <tr key={`${row.id}:${row.dueDate}`}>
                <td className="px-3 py-2">{row.title}</td>
                <td className="num px-3 py-2">{row.dueDate}</td>
                <td className="px-3 py-2 text-end"><Money value={row.amount} currency={row.currency} /></td>
                <td className="px-3 py-2"><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || row.dueDate > today} onClick={() => pay(row)}>{t.expenses.pay}</Button><Button size="sm" variant="ghost" disabled={busy || row.dueDate > today} onClick={() => skip(row)}>{t.expenses.skip}</Button></div></td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title={t.expenses.fixedTitle}>
          <Table head={[t.expenses.name, t.expenses.recurrence, t.companyFinance.amount, t.expenses.statusLabel]} isEmpty={rows.length === 0} empty={t.expenses.noneFixed}>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="px-3 py-2">{row.title}</td>
                <td className="px-3 py-2">{row.scheduleKind === 'monthly_first' ? t.expenses.monthlyFirst : row.scheduleKind === 'weekly' ? t.expenses.weekly : t.expenses.everyNDays}</td>
                <td className="px-3 py-2 text-end"><Money value={row.amount} currency={row.currency} /></td>
                <td className="px-3 py-2">{row.active ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => deactivate(row)}>{t.expenses.deactivate}</Button> : t.expenses.inactive}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  )
}
