import { type FormEvent, type ReactNode, useMemo, useState } from 'react'
import { formatBusinessDate, groupThousands } from '@ash/client'
import { parseMinor } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { useConfirm, useTextPrompt } from '../feedback.tsx'
import { Button, Card, DateField, Field, Money, MoneyInput, Select, Table, TextInput } from '../ui.tsx'
import type { Asset, AssetInstallmentDue, AssetInstallmentDueFeed, AssetInstallmentPlan, Mutate } from './CompanyFund.tsx'

type InstallmentPaidFrom = 'pocket' | 'reserve' | 'owner_outside'
type InstallmentScheduleKind = 'weekly' | 'monthly_first' | 'every_n_days'

export interface InstallmentPlanDraft {
  amount: string
  paidFrom: InstallmentPaidFrom
  scheduleKind: InstallmentScheduleKind
  weekday: number
  intervalDays: string
  startsOn: string
}

export function newInstallmentPlanDraft(startsOn: string): InstallmentPlanDraft {
  return { amount: '', paidFrom: 'pocket', scheduleKind: 'monthly_first', weekday: 0, intervalDays: '30', startsOn }
}

export function installmentPlanPayload(draft: InstallmentPlanDraft): Record<string, unknown> {
  return {
    idempotencyKey: crypto.randomUUID(),
    amount: draft.amount,
    paidFrom: draft.paidFrom,
    scheduleKind: draft.scheduleKind,
    weekday: draft.scheduleKind === 'weekly' ? draft.weekday : null,
    intervalDays: draft.scheduleKind === 'every_n_days' ? Number(draft.intervalDays) : null,
    startsOn: draft.startsOn,
  }
}

export function InstallmentPlanFields({
  value,
  onChange,
  disabled,
}: {
  value: InstallmentPlanDraft
  onChange: (next: InstallmentPlanDraft) => void
  disabled: boolean
}): ReactNode {
  const { t } = useApp()
  const change = <Key extends keyof InstallmentPlanDraft>(key: Key, next: InstallmentPlanDraft[Key]): void => {
    onChange({ ...value, [key]: next })
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line-strong bg-surface-muted p-3">
      <p className="text-label text-ink-muted">{t.companyFinance.installmentHint}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t.companyFinance.installmentAmount}>
          <MoneyInput required value={value.amount} disabled={disabled} onChange={(event) => change('amount', event.target.value)} aria-label={t.companyFinance.installmentAmount} />
        </Field>
        <Field label={t.companyFinance.paidFrom} hint={t.companyFinance.installmentSourceHint}>
          <Select value={value.paidFrom} disabled={disabled} onChange={(event) => change('paidFrom', event.target.value as InstallmentPaidFrom)} aria-label={t.companyFinance.paidFrom}>
            <option value="pocket">{t.companyFinance.pocket}</option>
            <option value="reserve">{t.companyFinance.reserve}</option>
            <option value="owner_outside">{t.companyFinance.ownerOutside}</option>
          </Select>
        </Field>
      </div>
      <Field label={t.expenses.recurrence}>
        <Select value={value.scheduleKind} disabled={disabled} onChange={(event) => change('scheduleKind', event.target.value as InstallmentScheduleKind)} aria-label={t.expenses.recurrence}>
          <option value="monthly_first">{t.expenses.monthlyFirst}</option>
          <option value="weekly">{t.expenses.weekly}</option>
          <option value="every_n_days">{t.expenses.everyNDays}</option>
        </Select>
      </Field>
      {value.scheduleKind === 'weekly' ? (
        <Field label={t.expenses.weekday}>
          <Select value={value.weekday} disabled={disabled} onChange={(event) => change('weekday', Number(event.target.value))} aria-label={t.expenses.weekday}>
            {t.expenses.weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
          </Select>
        </Field>
      ) : null}
      {value.scheduleKind === 'every_n_days' ? (
        <Field label={t.expenses.intervalDays}>
          <TextInput required type="number" min="1" max="366" value={value.intervalDays} disabled={disabled} onChange={(event) => change('intervalDays', event.target.value)} aria-label={t.expenses.intervalDays} />
        </Field>
      ) : null}
      <DateField label={t.companyFinance.installmentStartsOn} value={value.startsOn} disabled={disabled} onChange={(next) => change('startsOn', next)} />
    </div>
  )
}

function positiveMoney(value: string): boolean {
  try {
    return parseMinor(value) > 0n
  } catch {
    return false
  }
}

function sourceLabel(source: InstallmentPaidFrom, t: ReturnType<typeof useApp>['t']): string {
  if (source === 'pocket') return t.companyFinance.pocket
  if (source === 'reserve') return t.companyFinance.reserve
  return t.companyFinance.ownerOutside
}

function scheduleLabel(plan: AssetInstallmentPlan, t: ReturnType<typeof useApp>['t']): string {
  if (plan.scheduleKind === 'monthly_first') return t.expenses.monthlyFirst
  if (plan.scheduleKind === 'weekly') return `${t.expenses.weekly} · ${t.expenses.weekdays[plan.weekday ?? 0]}`
  return `${t.expenses.everyNDays} · ${plan.intervalDays}`
}

export function AssetInstallmentPanel({
  rows,
  due,
  today,
  busy,
  mutate,
}: {
  rows: Asset[]
  due: AssetInstallmentDueFeed
  today: string
  busy: boolean
  mutate: Mutate
}): ReactNode {
  const { api, t, lang } = useApp()
  const confirm = useConfirm()
  const requestText = useTextPrompt()
  const [assetId, setAssetId] = useState<string | null>(null)
  const [draft, setDraft] = useState<InstallmentPlanDraft>(() => newInstallmentPlanDraft(today))
  const [sources, setSources] = useState<Record<string, InstallmentPaidFrom>>({})
  const asset = useMemo(() => rows.find((row) => row.id === assetId) ?? null, [assetId, rows])
  const financed = rows.filter((row) => row.debtId !== null && positiveMoney(row.outstanding))
  const dueKey = (row: AssetInstallmentDue): string => `${row.id}:${row.dueDate}`
  const selectedSource = (row: AssetInstallmentDue): InstallmentPaidFrom => sources[dueKey(row)] ?? row.paidFrom

  const openPlan = (row: Asset): void => {
    setAssetId(row.id)
    setDraft(newInstallmentPlanDraft(today < row.purchasedOn ? row.purchasedOn : today))
  }
  const createPlan = (event: FormEvent): void => {
    event.preventDefault()
    if (asset === null) return
    void mutate(
      () => api.post(`/company/assets/${asset.id}/installment-plans`, installmentPlanPayload(draft)),
      t.companyFinance.installmentPlanSaved,
    ).then((saved) => { if (saved) setAssetId(null) })
  }
  const deactivate = (row: Asset, plan: AssetInstallmentPlan): void => {
    void (async () => {
      const reason = await requestText({
        title: t.companyFinance.deactivateInstallmentPlan,
        label: t.companyFinance.deactivationReason,
        confirmLabel: t.companyFinance.deactivateInstallmentPlan,
        danger: true,
      })
      if (reason === null) return
      await mutate(
        () => api.post(`/company/assets/${row.id}/installment-plans/${plan.id}/deactivate`, { reason }),
        t.companyFinance.installmentPlanDeactivated,
      )
    })()
  }
  const pay = (row: AssetInstallmentDue): void => {
    void (async () => {
      const source = selectedSource(row)
      const accepted = await confirm({
        title: t.companyFinance.installmentPayConfirmTitle,
        body: t.companyFinance.installmentPayConfirmBody
          .replace('{asset}', row.assetName)
          .replace('{amount}', `${groupThousands(row.amountDue)} ${t.currency[row.currency]}`)
          .replace('{source}', sourceLabel(source, t)),
        confirmLabel: t.companyFinance.payInstallment,
      })
      if (!accepted) return
      await mutate(
        () => api.post(`/company/assets/${row.assetId}/installment-plans/${row.id}/occurrences/${row.dueDate}/pay`, {
          idempotencyKey: crypto.randomUUID(), source,
        }),
        t.companyFinance.installmentPaid,
      )
    })()
  }
  const skip = (row: AssetInstallmentDue): void => {
    void (async () => {
      const reason = await requestText({
        title: t.companyFinance.skipInstallment,
        label: t.companyFinance.skipInstallmentReason,
        confirmLabel: t.companyFinance.skipInstallment,
      })
      if (reason === null) return
      await mutate(
        () => api.post(`/company/assets/${row.assetId}/installment-plans/${row.id}/occurrences/${row.dueDate}/skip`, {
          idempotencyKey: crypto.randomUUID(), reason,
        }),
        t.companyFinance.installmentSkipped,
      )
    })()
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={t.companyFinance.installmentsDue}
        subtitle={due.olderUnresolved > 0
          ? t.companyFinance.olderInstallments.replace('{count}', String(due.olderUnresolved))
          : t.companyFinance.installmentsDueHint}
      >
        <Table
          head={[t.companyFinance.name, t.companyFinance.date, t.companyFinance.amount, t.companyFinance.paidFrom, t.expenses.actionLabel]}
          isEmpty={due.due.length === 0}
          empty={t.companyFinance.noInstallmentsDue}
        >
          {due.due.map((row) => {
            const enabled = !busy && row.dueDate <= today
            const source = selectedSource(row)
            return (
              <tr key={dueKey(row)}>
                <td className="px-3 py-2">{row.assetName}</td>
                <td className="px-3 py-2">{formatBusinessDate(row.dueDate, lang)}</td>
                <td className="px-3 py-2 text-end"><Money value={row.amountDue} currency={row.currency} /></td>
                <td className="px-3 py-2">
                  <Select
                    value={source}
                    disabled={!enabled}
                    onChange={(event) => setSources((current) => ({ ...current, [dueKey(row)]: event.target.value as InstallmentPaidFrom }))}
                    aria-label={`${t.companyFinance.paidFrom} ${row.assetName}`}
                  >
                    <option value="pocket">{t.companyFinance.pocket}</option>
                    <option value="reserve">{t.companyFinance.reserve}</option>
                    <option value="owner_outside">{t.companyFinance.ownerOutside}</option>
                  </Select>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" type="button" disabled={!enabled} onClick={() => pay(row)}>{t.companyFinance.payInstallment}</Button>
                    <Button size="sm" type="button" variant="ghost" disabled={!enabled} onClick={() => skip(row)}>{t.companyFinance.skipInstallment}</Button>
                  </div>
                </td>
              </tr>
            )
          })}
        </Table>
      </Card>
      <Card title={t.companyFinance.installmentPlan} subtitle={t.companyFinance.installmentHint}>
        <Table
          head={[t.companyFinance.name, t.companyFinance.outstanding, t.companyFinance.installmentPlan, t.expenses.actionLabel]}
          isEmpty={financed.length === 0}
          empty={t.companyFinance.noInstallmentPlan}
        >
          {financed.map((row) => {
            const plan = row.activeInstallmentPlan
            return (
              <tr key={row.id}>
                <td className="px-3 py-2">{row.name}</td>
                <td className="px-3 py-2 text-end"><Money value={row.outstanding} currency={row.currency} /></td>
                <td className="px-3 py-2">
                  {plan === null ? <span className="text-label text-ink-muted">{t.companyFinance.noInstallmentPlan}</span> : (
                    <span className="text-label text-ink-muted"><Money value={plan.amount} currency={row.currency} /> · {scheduleLabel(plan, t)}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {plan === null ? (
                    <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => openPlan(row)}>{t.companyFinance.createInstallmentPlan}</Button>
                  ) : (
                    <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => deactivate(row, plan)}>{t.companyFinance.deactivateInstallmentPlan}</Button>
                  )}
                </td>
              </tr>
            )
          })}
        </Table>
        {asset !== null ? (
          <form className="mt-4 flex flex-col gap-3 border-t border-line-strong pt-4" onSubmit={createPlan}>
            <p className="text-body font-semibold text-ink">{asset.name}</p>
            <InstallmentPlanFields value={draft} onChange={setDraft} disabled={busy} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>{t.companyFinance.saveInstallmentPlan}</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setAssetId(null)}>{t.common.cancel}</Button>
            </div>
          </form>
        ) : null}
      </Card>
    </div>
  )
}
