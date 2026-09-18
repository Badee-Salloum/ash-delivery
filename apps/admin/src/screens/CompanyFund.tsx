import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import type { Currency } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import type { RouteParams } from '../route.ts'
import { Button, Card, DateField, Field, Money, MoneyInput, Pending, Select, Stat, Table, TextInput } from '../ui.tsx'

type Tab = 'overview' | 'movements' | 'debts' | 'assets' | 'depreciation' | 'recurring'

interface Overview {
  pockets: Record<Currency, string>
  reserves: Record<Currency, string>
  period: Record<Currency, { income: string; expense: string; deposits: string; withdrawals: string; net: string }>
  branches: Array<{ branchId: string; companyBox: string; clearing: string; balanced: boolean }>
}

interface Movement {
  entry: { id: number; businessDate: string; eventType: string; reason: string | null; sypMinorPerUsd: string | null }
  command: null | { id: string; kind: string; currency?: Currency; amount?: string; fromAmount?: string; toAmount?: string }
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

interface Asset {
  id: string
  kind: 'vehicle' | 'equipment' | 'property' | 'other'
  name: string
  currency: Currency
  price: string
  purchasedOn: string
  bookValue: string
  outstanding: string
  depreciationDue: string
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

interface CompanyData {
  overview: Overview
  movements: Movement[]
  debts: Debt[]
  assets: Asset[]
  depreciation: DepreciationPlan
  vehicles: Array<{ id: string; code: string; groundNo?: string | null }>
  recurring: RecurringTemplate[]
  recurringDue: RecurringDue[]
  categories: Array<{ id: string; nameAr: string; code: string }>
}

const tabs: readonly Tab[] = ['overview', 'movements', 'debts', 'assets', 'depreciation', 'recurring']

export function CompanyFund({ initial = {} }: { initial?: RouteParams }): ReactNode {
  const { api, session, t } = useApp()
  const today = session?.businessDate ?? ''
  const month = today === '' ? '' : `${today.slice(0, 7)}-01`
  const [tab, setTab] = useState<Tab>(() => tabs.includes(initial.tab as Tab) ? initial.tab as Tab : 'overview')
  const [data, setData] = useState<CompanyData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    const range = `from=2000-01-01&to=${encodeURIComponent(today)}`
    void Promise.all([
      api.get<Overview>(`/company/overview?${range}`),
      api.get<{ movements: Movement[] }>(`/company/movements?${range}`),
      api.get<{ debts: Debt[] }>('/company/debts'),
      api.get<{ assets: Asset[] }>('/company/assets'),
      api.get<DepreciationPlan>(`/company/depreciation?asOfMonth=${encodeURIComponent(month)}`),
      api.get<{ vehicles: Array<{ id: string; code: string; groundNo?: string | null }> }>('/vehicles'),
      api.get<{ templates: RecurringTemplate[] }>('/company/recurring-expenses?includeInactive=true'),
      api.get<{ due: RecurringDue[] }>('/company/recurring-expenses/due'),
      api.get<{ categories: Array<{ id: string; nameAr: string; code: string }> }>('/expense-categories'),
    ]).then(([overview, movements, debts, assets, depreciation, vehicles, recurring, recurringDue, categories]) => {
      setData({
        overview, movements: movements.movements, debts: debts.debts, assets: assets.assets,
        depreciation, vehicles: vehicles.vehicles, recurring: recurring.templates,
        recurringDue: recurringDue.due, categories: categories.categories,
      })
    }).catch((cause: { error?: string }) => {
      setData(null)
      setError(cause.error ?? 'error')
    })
  }, [api, month, today])

  useEffect(load, [load])

  const mutate = async (operation: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await operation()
      setNotice(success)
      load()
    } catch (cause) {
      setError((cause as { error?: string }).error ?? 'error')
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
              tab === item ? 'border-brand bg-brand text-ink-inverse' : 'border-line-strong bg-surface-card text-ink hover:bg-surface-muted'
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
      {tab === 'assets' ? <AssetsTab rows={data.assets} vehicles={data.vehicles} today={today} busy={busy} mutate={mutate} /> : null}
      {tab === 'depreciation' ? <DepreciationTab plan={data.depreciation} busy={busy} mutate={mutate} /> : null}
      {tab === 'recurring' ? <RecurringTab rows={data.recurring} due={data.recurringDue} categories={data.categories} today={today} busy={busy} mutate={mutate} /> : null}
    </div>
  )
}

type Mutate = (operation: () => Promise<unknown>, success: string) => Promise<void>

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
        <Card title={t.companyFinance.branches}>
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

function MovementsTab({ rows }: { rows: Movement[] }): ReactNode {
  const { t } = useApp()
  return (
    <Card title={t.companyFinance.tabs.movements}>
      <Table head={[t.companyFinance.date, t.companyFinance.kind, t.companyFinance.amount, t.companyFinance.description, t.companyFinance.rate]} isEmpty={rows.length === 0} empty={t.companyFinance.emptyMovements}>
        {rows.map((row) => {
          const amount = row.command?.amount ?? row.command?.fromAmount ?? row.command?.toAmount ?? null
          return (
            <tr key={row.entry.id}>
              <td className="num px-3 py-2">{row.entry.businessDate}</td>
              <td className="px-3 py-2">{row.command?.kind ?? row.entry.eventType}</td>
              <td className="px-3 py-2 text-end">{amount === null ? '—' : <Money value={amount} currency={row.command?.currency ?? 'SYP_NEW'} />}</td>
              <td className="px-3 py-2">{row.entry.reason ?? '—'}</td>
              <td className="num px-3 py-2">{row.entry.sypMinorPerUsd ?? '—'}</td>
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

function AssetsTab({ rows, vehicles, today, busy, mutate }: { rows: Asset[]; vehicles: CompanyData['vehicles']; today: string; busy: boolean; mutate: Mutate }): ReactNode {
  const { api, t } = useApp()
  const [kind, setKind] = useState<Asset['kind']>('equipment')
  const [vehicleId, setVehicleId] = useState('')
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState<Currency>('SYP_NEW')
  const [price, setPrice] = useState('')
  const [purchasedOn, setPurchasedOn] = useState(today)
  const [paidNow, setPaidNow] = useState('')
  const [paidFrom, setPaidFrom] = useState<'pocket' | 'reserve' | 'owner_outside' | 'opening'>('pocket')
  const [financedPartyName, setFinancedPartyName] = useState('')
  const [financedDueOn, setFinancedDueOn] = useState('')
  const selectedVehicle = useMemo(() => vehicles.find((vehicle) => vehicle.id === vehicleId), [vehicleId, vehicles])
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
    }), t.companyFinance.saved).then(() => { setName(''); setPrice(''); setPaidNow(''); setFinancedPartyName(''); setFinancedDueOn('') })
  }
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(20rem,1fr)_2fr]">
      <Card title={t.companyFinance.addAsset}>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Field label={t.companyFinance.assetKind}><Select value={kind} onChange={(event) => setKind(event.target.value as Asset['kind'])} aria-label={t.companyFinance.assetKind}><option value="equipment">{t.companyFinance.equipment}</option><option value="property">{t.companyFinance.property}</option><option value="other">{t.companyFinance.other}</option><option value="vehicle">{t.companyFinance.vehicle}</option></Select></Field>
          {kind === 'vehicle' ? <Field label={t.companyFinance.vehicle}><Select required value={vehicleId} onChange={(event) => setVehicleId(event.target.value)} aria-label={t.companyFinance.vehicle}><option value="">—</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.groundNo ?? vehicle.code}</option>)}</Select></Field> : <Field label={t.companyFinance.name}><TextInput required value={name} onChange={(event) => setName(event.target.value)} aria-label={t.companyFinance.name} /></Field>}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.companyFinance.currency}><Select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} aria-label={t.companyFinance.currency}><option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option></Select></Field>
            <Field label={t.companyFinance.price}><MoneyInput required value={price} onChange={(event) => setPrice(event.target.value)} aria-label={t.companyFinance.price} /></Field>
          </div>
          <DateField label={t.companyFinance.purchasedOn} value={purchasedOn} onChange={setPurchasedOn} />
          <Field label={t.companyFinance.paidNow}><MoneyInput required value={paidNow} onChange={(event) => setPaidNow(event.target.value)} aria-label={t.companyFinance.paidNow} /></Field>
          <Field label={t.companyFinance.paidFrom}><Select value={paidFrom} onChange={(event) => setPaidFrom(event.target.value as typeof paidFrom)} aria-label={t.companyFinance.paidFrom}><option value="pocket">{t.companyFinance.pocket}</option><option value="reserve">{t.companyFinance.reserve}</option><option value="owner_outside">{t.companyFinance.ownerOutside}</option><option value="opening">{t.companyFinance.opening}</option></Select></Field>
          <Field label={t.companyFinance.financedParty}><TextInput value={financedPartyName} onChange={(event) => setFinancedPartyName(event.target.value)} aria-label={t.companyFinance.financedParty} /></Field>
          <DateField label={t.companyFinance.financedDue} value={financedDueOn} onChange={setFinancedDueOn} />
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
    const reason = window.prompt(t.expenses.skipReason)?.trim() ?? ''
    if (reason === '') return
    void mutate(() => api.post(`/company/recurring-expenses/${row.id}/occurrences/${row.dueDate}/skip`, { reason }), t.expenses.skipped)
  }
  const deactivate = (row: RecurringTemplate): void => {
    const reason = window.prompt(t.expenses.deactivationReason)?.trim() ?? ''
    if (reason === '') return
    void mutate(() => api.post(`/company/recurring-expenses/${row.id}/deactivate`, { reason }), t.expenses.deactivated)
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
