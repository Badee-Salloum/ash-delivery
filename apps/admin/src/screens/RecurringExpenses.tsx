import { type ChangeEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type {
  ExpenseCategoryView,
  RecurringExpenseDueView,
  RecurringExpenseTemplateView,
} from '@ash/client'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { useToast } from '../feedback.tsx'
import { Button, Card, DateField, Field, Money, MoneyInput, Pending, Select, Table, TextInput } from '../ui.tsx'
import { uploadExpenseReceipt } from '../receipt-upload.ts'

interface VehicleLite { id: string; code: string }
type Kind = 'vehicle' | 'branch' | 'general'
type ScheduleKind = 'weekly' | 'monthly_first' | 'every_n_days'

export function RecurringExpenses({
  view,
  categories,
  vehicles,
  canWrite,
}: {
  view: 'due' | 'templates'
  categories: ExpenseCategoryView[]
  vehicles: VehicleLite[]
  canWrite: boolean
}): ReactNode {
  const { api, t, branchId } = useApp()
  const toast = useToast()
  const [templates, setTemplates] = useState<RecurringExpenseTemplateView[] | null>(null)
  const [due, setDue] = useState<RecurringExpenseDueView[] | null>(null)
  const [today, setToday] = useState('')
  const [olderUnresolved, setOlderUnresolved] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    void Promise.all([api.recurringExpenses(true), api.recurringExpensesDue()])
      .then(([templateResult, dueResult]) => {
        setTemplates(templateResult.templates)
        setDue(dueResult.due)
        setToday(dueResult.today)
        setOlderUnresolved(dueResult.olderUnresolved)
      })
      .catch((cause: { error?: string }) => {
        setTemplates([])
        setDue([])
        setError(cause.error ?? 'error')
      })
  }, [api])
  useEffect(load, [load, branchId])

  if (templates === null || due === null) {
    return <Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error, t)} onRetry={load} retryLabel={t.common.retry} />
  }

  return view === 'due' ? (
    <DuePanel
      rows={due}
      today={today}
      olderUnresolved={olderUnresolved}
      canWrite={canWrite}
      onChanged={load}
    />
  ) : (
    <TemplatesPanel
      rows={templates}
      today={today}
      categories={categories}
      vehicles={vehicles}
      canWrite={canWrite}
      onChanged={load}
    />
  )
}

function scheduleLabel(row: RecurringExpenseTemplateView, t: ReturnType<typeof useApp>['t']): string {
  if (row.scheduleKind === 'monthly_first') return t.expenses.monthlyFirst
  if (row.scheduleKind === 'weekly') return `${t.expenses.weekly} · ${t.expenses.weekdays[row.weekday ?? 0]}`
  return t.expenses.everyNDays.replace('N', String(row.intervalDays ?? ''))
}

function DuePanel({
  rows,
  today,
  olderUnresolved,
  canWrite,
  onChanged,
}: {
  rows: RecurringExpenseDueView[]
  today: string
  olderUnresolved: number
  canWrite: boolean
  onChanged(): void
}): ReactNode {
  const { api, t } = useApp()
  const toast = useToast()
  const [selected, setSelected] = useState<RecurringExpenseDueView | null>(null)
  const [action, setAction] = useState<'pay' | 'skip'>('pay')
  const [amount, setAmount] = useState('')
  const [businessDate, setBusinessDate] = useState(today)
  const [reason, setReason] = useState('')
  const [receiptMediaId, setReceiptMediaId] = useState<string | null>(null)
  const [receiptBusy, setReceiptBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const pendingPayKey = useRef<string | null>(null)

  const choose = (row: RecurringExpenseDueView, nextAction: 'pay' | 'skip') => {
    setSelected(row)
    setAction(nextAction)
    setAmount(row.amount)
    setBusinessDate(today)
    setReason('')
    setReceiptMediaId(null)
    setFormError(null)
    pendingPayKey.current = null
  }

  const upload = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    if (!file) return
    setReceiptBusy(true)
    setFormError(null)
    try {
      setReceiptMediaId(await uploadExpenseReceipt(api, file))
    } catch (cause) {
      setFormError((cause as { error?: string }).error ?? 'error')
    } finally {
      setReceiptBusy(false)
      event.target.value = ''
    }
  }

  const submit = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setFormError(null)
    try {
      if (action === 'skip') {
        await api.skipRecurringExpense(selected.id, selected.dueDate, reason)
        toast.success(t.expenses.skipped)
      } else {
        const key = pendingPayKey.current ?? crypto.randomUUID()
        pendingPayKey.current = key
        await api.payRecurringExpense(selected.id, selected.dueDate, {
          idempotencyKey: key,
          amount,
          businessDate,
          reason: reason.trim() === '' ? null : reason,
          receiptMediaId,
        })
        pendingPayKey.current = null
        toast.success(t.expenses.paid)
      }
      setSelected(null)
      onChanged()
    } catch (cause) {
      const code = (cause as { error?: string }).error ?? 'error'
      if (code === 'idempotency_key_conflict' || code === 'recurring_expense_already_resolved') {
        pendingPayKey.current = null
      }
      setFormError(code)
    } finally {
      setBusy(false)
    }
  }

  const groups: Array<{ status: RecurringExpenseDueView['status']; title: string }> = [
    { status: 'overdue', title: t.expenses.overdue },
    { status: 'today', title: t.expenses.dueToday },
    { status: 'upcoming', title: t.expenses.upcoming },
  ]

  return (
    <div className="flex flex-col gap-3">
      {olderUnresolved > 0 ? (
        <p className="rounded-lg border border-warning-line bg-warning-surface p-3 text-sm text-warning-ink">
          {t.expenses.olderUnresolved.replace('{n}', String(olderUnresolved))}
        </p>
      ) : null}
      {groups.map((group) => {
        const grouped = rows.filter((row) => row.status === group.status)
        return (
          <Card key={group.status} title={`${group.title} · ${grouped.length}`}>
            {grouped.length === 0 ? <p className="text-sm text-ink-muted">{t.expenses.nothingDue}</p> : (
              <div className="divide-y divide-line">
                {grouped.map((row) => (
                  <div key={`${row.id}:${row.dueDate}`} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-52 flex-1">
                      <p className="font-semibold text-ink">{row.title}</p>
                      <p className="text-label text-ink-muted">
                        {scheduleLabel(row, t)} · {t.expenses.dueOn.replace('{date}', row.dueDate)}
                      </p>
                    </div>
                    <Money value={row.amount} className="font-semibold" />
                    {canWrite && row.dueDate <= today ? (
                      <div className="flex gap-2">
                        <Button size="sm" variant="success" onClick={() => choose(row, 'pay')}>{t.expenses.pay}</Button>
                        <Button size="sm" variant="ghost" onClick={() => choose(row, 'skip')}>{t.expenses.skip}</Button>
                      </div>
                    ) : <span className="text-label text-ink-muted">{t.expenses.payableAtDue}</span>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )
      })}

      {selected ? (
        <Card title={t.expenses.payTitle.replace('{name}', selected.title).replace('{date}', selected.dueDate)}>
          <div className="flex flex-col gap-3">
            {action === 'pay' ? (
              <div className="flex flex-wrap gap-3">
                <Field label={t.expenses.amount}>
                  <MoneyInput value={amount} onChange={(event) => setAmount(event.target.value)} className="w-36" />
                </Field>
                <DateField label={t.expenses.paymentDate} value={businessDate} onChange={setBusinessDate} />
                <Field label={t.expenses.receipt}>
                  <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void upload(event)} className="max-w-64 text-sm" />
                  <span className="text-label text-ink-muted">
                    {receiptBusy ? t.expenses.receiptUploading : receiptMediaId ? t.expenses.receiptUploaded : t.expenses.chooseReceipt}
                  </span>
                </Field>
              </div>
            ) : null}
            <Field label={action === 'pay' ? t.expenses.adjustmentReason : t.expenses.skipReason}>
              <TextInput value={reason} onChange={(event) => setReason(event.target.value)} />
            </Field>
            {formError ? <p className="text-sm text-danger-ink">{explainError(formError, t)}</p> : null}
            <div className="flex gap-2">
              <Button
                variant={action === 'pay' ? 'primary' : 'ghost'}
                disabled={busy || receiptBusy || (action === 'skip' && reason.trim() === '') || amount.trim() === ''}
                onClick={() => void submit()}
              >
                {action === 'pay' ? t.expenses.confirmPay : t.expenses.confirmSkip}
              </Button>
              <Button variant="ghost" onClick={() => setSelected(null)}>{t.common.cancel}</Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  )
}

function TemplatesPanel({
  rows,
  today,
  categories,
  vehicles,
  canWrite,
  onChanged,
}: {
  rows: RecurringExpenseTemplateView[]
  today: string
  categories: ExpenseCategoryView[]
  vehicles: VehicleLite[]
  canWrite: boolean
  onChanged(): void
}): ReactNode {
  const { api, t } = useApp()
  const toast = useToast()
  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [kind, setKind] = useState<Kind>('general')
  const [vehicleId, setVehicleId] = useState('')
  const [channel, setChannel] = useState<'office_cash' | 'office_wallet'>('office_cash')
  const [amount, setAmount] = useState('')
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>('monthly_first')
  const [weekday, setWeekday] = useState(0)
  const [intervalDays, setIntervalDays] = useState('30')
  const [startsOn, setStartsOn] = useState(today)
  const [endsOn, setEndsOn] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deactivateId, setDeactivateId] = useState<string | null>(null)
  const [deactivationReason, setDeactivationReason] = useState('')
  const pendingCreateKey = useRef<string | null>(null)

  useEffect(() => { if (!startsOn && today) setStartsOn(today) }, [startsOn, today])

  const save = async (): Promise<void> => {
    const key = pendingCreateKey.current ?? crypto.randomUUID()
    pendingCreateKey.current = key
    setBusy(true)
    setFormError(null)
    try {
      await api.createRecurringExpense({
        idempotencyKey: key,
        title,
        categoryId,
        costCenterKind: kind,
        vehicleId: kind === 'vehicle' ? vehicleId : null,
        channel,
        amount,
        scheduleKind,
        weekday: scheduleKind === 'weekly' ? weekday : null,
        intervalDays: scheduleKind === 'every_n_days' ? Number(intervalDays) : null,
        startsOn,
        endsOn: endsOn || null,
      })
      pendingCreateKey.current = null
      toast.success(t.expenses.fixedSaved)
      setTitle('')
      setAmount('')
      setShowForm(false)
      onChanged()
    } catch (cause) {
      const code = (cause as { error?: string }).error ?? 'error'
      if (code === 'idempotency_key_conflict') pendingCreateKey.current = null
      setFormError(code)
    } finally {
      setBusy(false)
    }
  }

  const deactivate = async (): Promise<void> => {
    if (!deactivateId) return
    setBusy(true)
    setFormError(null)
    try {
      await api.deactivateRecurringExpense(deactivateId, deactivationReason)
      toast.success(t.expenses.deactivated)
      setDeactivateId(null)
      setDeactivationReason('')
      onChanged()
    } catch (cause) {
      setFormError((cause as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  const catName = (id: string) => categories.find((category) => category.id === id)?.nameAr ?? id.slice(0, 8)
  const centreName = (row: RecurringExpenseTemplateView) =>
    row.costCenterKind === 'vehicle'
      ? vehicles.find((vehicle) => vehicle.id === row.vehicleId)?.code ?? row.vehicleId?.slice(0, 8)
      : row.costCenterKind === 'branch' ? t.expenses.kindBranch : t.expenses.kindGeneral

  return (
    <Card
      title={t.expenses.fixedTitle}
      actions={canWrite ? <Button size="sm" onClick={() => setShowForm((shown) => !shown)}>{t.expenses.newFixed}</Button> : undefined}
    >
      <div className="flex flex-col gap-4">
        <Table
          head={[t.expenses.name, t.expenses.category, t.expenses.costCenter, t.expenses.channel, t.expenses.amount, t.expenses.recurrence, t.expenses.statusLabel, t.expenses.actionLabel]}
          isEmpty={rows.length === 0}
          empty={t.expenses.noneFixed}
        >
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-3 py-2 font-medium">{row.title}</td>
              <td className="px-3 py-2">{catName(row.categoryId)}</td>
              <td className="px-3 py-2">{centreName(row)}</td>
              <td className="px-3 py-2">{row.channel === 'office_cash' ? t.movements.channelCash : t.movements.channelWallet}</td>
              <td className="px-3 py-2"><Money value={row.amount} /></td>
              <td className="px-3 py-2">{scheduleLabel(row, t)}</td>
              <td className="px-3 py-2">{row.active ? t.expenses.active : t.expenses.inactive}</td>
              <td className="px-3 py-2">
                {canWrite && row.active ? (
                  <Button size="sm" variant="ghost" onClick={() => { setDeactivateId(row.id); setDeactivationReason('') }}>
                    {t.expenses.deactivate}
                  </Button>
                ) : '—'}
              </td>
            </tr>
          ))}
        </Table>

        {deactivateId ? (
          <div className="rounded-lg border border-line bg-surface-muted p-3">
            <Field label={t.expenses.deactivationReason}>
              <TextInput value={deactivationReason} onChange={(event) => setDeactivationReason(event.target.value)} />
            </Field>
            <div className="mt-3 flex gap-2">
              <Button variant="danger" disabled={busy || !deactivationReason.trim()} onClick={() => void deactivate()}>
                {t.expenses.confirmDeactivate}
              </Button>
              <Button variant="ghost" onClick={() => setDeactivateId(null)}>{t.common.cancel}</Button>
            </div>
          </div>
        ) : null}

        {showForm ? (
          <div className="rounded-lg border border-line bg-surface-muted p-3">
            <div className="flex flex-wrap gap-3">
              <Field label={t.expenses.name}><TextInput value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
              <Field label={t.expenses.category}>
                <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                  <option value="">—</option>
                  {categories.map((category) => <option key={category.id} value={category.id}>{category.nameAr}</option>)}
                </Select>
              </Field>
              <Field label={t.expenses.costCenter}>
                <Select value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                  <option value="general">{t.expenses.kindGeneral}</option>
                  <option value="branch">{t.expenses.kindBranch}</option>
                  <option value="vehicle">{t.expenses.kindVehicle}</option>
                </Select>
              </Field>
              {kind === 'vehicle' ? (
                <Field label={t.expenses.vehicle}>
                  <Select value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}>
                    <option value="">—</option>
                    {vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.code}</option>)}
                  </Select>
                </Field>
              ) : null}
              <Field label={t.expenses.channel}>
                <Select value={channel} onChange={(event) => setChannel(event.target.value as typeof channel)}>
                  <option value="office_cash">{t.movements.channelCash}</option>
                  <option value="office_wallet">{t.movements.channelWallet}</option>
                </Select>
              </Field>
              <Field label={t.expenses.amount}><MoneyInput value={amount} onChange={(event) => setAmount(event.target.value)} className="w-36" /></Field>
              <Field label={t.expenses.recurrence}>
                <Select value={scheduleKind} onChange={(event) => setScheduleKind(event.target.value as ScheduleKind)}>
                  <option value="weekly">{t.expenses.weekly}</option>
                  <option value="monthly_first">{t.expenses.monthlyFirst}</option>
                  <option value="every_n_days">{t.expenses.everyNDays}</option>
                </Select>
              </Field>
              {scheduleKind === 'weekly' ? (
                <Field label={t.expenses.weekday}>
                  <Select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
                    {t.expenses.weekdays.map((name, index) => <option key={name} value={index}>{name}</option>)}
                  </Select>
                </Field>
              ) : null}
              {scheduleKind === 'every_n_days' ? (
                <Field label={t.expenses.intervalDays}>
                  <TextInput type="number" min={1} max={366} value={intervalDays} onChange={(event) => setIntervalDays(event.target.value)} className="w-24" />
                </Field>
              ) : null}
              <DateField label={t.expenses.startsOn} value={startsOn} onChange={setStartsOn} />
              <DateField label={t.expenses.endsOn} value={endsOn} onChange={setEndsOn} />
            </div>
            {formError ? <p className="mt-3 text-sm text-danger-ink">{explainError(formError, t)}</p> : null}
            <div className="mt-3 flex gap-2">
              <Button
                disabled={busy || !title.trim() || !categoryId || !amount.trim() || !startsOn ||
                  (kind === 'vehicle' && !vehicleId) || (scheduleKind === 'every_n_days' && !intervalDays)}
                onClick={() => void save()}
              >
                {t.expenses.saveFixed}
              </Button>
              <Button variant="ghost" onClick={() => setShowForm(false)}>{t.common.cancel}</Button>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  )
}
