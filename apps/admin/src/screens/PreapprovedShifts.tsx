import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { formatDateTime, type PreapprovedShiftRuleView } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { useConfirm, useToast } from '../feedback.tsx'
import {
  type PreapprovedDraftError,
  preapprovedRuleStatus,
  validatePreapprovedDraft,
} from '../preapproved-shifts.ts'
import { Badge, Button, Card, DateField, Field, Money, MoneyInput, Pending, Select, Table, TextInput } from '../ui.tsx'

interface DriverLite {
  id: string
  code: string
  fullNameAr: string
  fullNameEn: string | null
  active: boolean
}

const sortRules = (rules: readonly PreapprovedShiftRuleView[]): PreapprovedShiftRuleView[] =>
  [...rules].sort(
    (left, right) =>
      left.businessDate.localeCompare(right.businessDate) ||
      left.windowStart.localeCompare(right.windowStart) ||
      left.driverId.localeCompare(right.driverId),
  )

/** Rules that let a driver's timely start become an already-authorized, already-funded shift. */
export function PreapprovedShifts(): ReactNode {
  const { api, t, lang, session, branchId } = useApp()
  const toast = useToast()
  const confirm = useConfirm()
  const currentBranch = useRef(branchId)

  const [rules, setRules] = useState<PreapprovedShiftRuleView[] | null>(null)
  const [drivers, setDrivers] = useState<DriverLite[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [driverId, setDriverId] = useState('')
  const [dates, setDates] = useState<string[]>([session?.businessDate ?? ''])
  const [windowStart, setWindowStart] = useState('')
  const [windowEnd, setWindowEnd] = useState('')
  const [cashFloat, setCashFloat] = useState('0.00')
  const [walletTopup, setWalletTopup] = useState('0.00')
  const [formError, setFormError] = useState<PreapprovedDraftError | string | null>(null)
  const [creating, setCreating] = useState(false)
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null)

  useEffect(() => {
    currentBranch.current = branchId
  }, [branchId])

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoadError(null)
      try {
        const [rulesResponse, driversResponse] = await Promise.all([
          api.preapprovedShiftRules({ cache: 'no-store', ...(signal ? { signal } : {}) }),
          api.get<{ drivers: DriverLite[] }>('/drivers', { cache: 'no-store', ...(signal ? { signal } : {}) }),
        ])
        setRules(sortRules(rulesResponse.rules))
        setDrivers(driversResponse.drivers)
        setDriverId((selected) =>
          driversResponse.drivers.some((driver) => driver.id === selected && driver.active) ? selected : '',
        )
      } catch (cause) {
        if ((cause as { name?: string }).name === 'AbortError') return
        setLoadError((cause as { error?: string }).error ?? 'error')
      }
    },
    [api],
  )

  useEffect(() => {
    const controller = new AbortController()
    setRules(null)
    setDrivers([])
    setFormError(null)
    void load(controller.signal)
    return () => controller.abort()
  }, [branchId, load])

  const driverName = (id: string): string => {
    const driver = drivers.find((row) => row.id === id)
    if (!driver) return id.slice(0, 8)
    const name = lang === 'ar' ? driver.fullNameAr : (driver.fullNameEn?.trim() || driver.fullNameAr)
    return `${driver.code} · ${name}`
  }

  const validationText = (error: PreapprovedDraftError | string): string => {
    if (error === 'driver') return t.preapprovedShifts.errorDriver
    if (error === 'dates') return t.preapprovedShifts.errorDates
    if (error === 'window') return t.preapprovedShifts.errorWindow
    if (error === 'money') return t.preapprovedShifts.errorMoney
    return explainError(error, t)
  }

  const updateDate = (index: number, value: string): void => {
    setDates((current) => current.map((date, row) => (row === index ? value : date)))
    setFormError(null)
  }

  const createRules = async (): Promise<void> => {
    const validation = validatePreapprovedDraft({ driverId, dates, windowStart, windowEnd, cashFloat, walletTopup })
    if (validation) {
      setFormError(validation)
      return
    }

    const targetBranch = branchId
    setCreating(true)
    setFormError(null)
    try {
      const response = await api.createPreapprovedShiftRules({
        driverId,
        dates,
        windowStart,
        windowEnd,
        cashFloat,
        walletTopup,
      })
      if (currentBranch.current === targetBranch) {
        setRules((current) => {
          const createdIds = new Set(response.rules.map((rule) => rule.id))
          return sortRules([...response.rules, ...(current ?? []).filter((rule) => !createdIds.has(rule.id))])
        })
        setDates([session?.businessDate ?? ''])
        setDriverId('')
        setCashFloat('0.00')
        setWalletTopup('0.00')
      }
      toast.success(t.preapprovedShifts.created)
    } catch (cause) {
      setFormError((cause as { error?: string }).error ?? 'error')
    } finally {
      setCreating(false)
    }
  }

  const deactivate = async (rule: PreapprovedShiftRuleView): Promise<void> => {
    if (!rule.active || rule.consumedByShiftId !== null) return
    const accepted = await confirm({
      title: t.preapprovedShifts.confirmDeactivateTitle,
      body: `${t.preapprovedShifts.confirmDeactivateBody}\n${driverName(rule.driverId)} · ${rule.businessDate}`,
      confirmLabel: t.preapprovedShifts.deactivate,
      danger: true,
    })
    if (!accepted) return

    const targetBranch = branchId
    setDeactivatingId(rule.id)
    try {
      await api.deletePreapprovedShiftRule(rule.id)
      if (currentBranch.current === targetBranch) {
        // DELETE may be implemented as a soft deactivation. Keep the row and its audit context
        // until the authoritative reload tells us whether the server retains or removes it.
        setRules((current) =>
          current?.map((row) => (row.id === rule.id ? { ...row, active: false } : row)) ?? null,
        )
        void load()
      }
      toast.success(t.preapprovedShifts.deactivated)
    } catch (cause) {
      toast.error(explainError((cause as { error?: string }).error ?? 'error', t))
    } finally {
      setDeactivatingId(null)
    }
  }

  if (!rules) {
    return (
      <Pending
        error={loadError}
        loadingLabel={t.common.loading}
        errorLabel={explainError(loadError, t)}
        onRetry={() => void load()}
        retryLabel={t.common.retry}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title={t.preapprovedShifts.title}>
        <p className="text-sm leading-6 text-slate-600">{t.preapprovedShifts.intro}</p>
        <p className="mt-2 text-sm font-medium leading-6 text-slate-700">{t.preapprovedShifts.scopeHint}</p>
      </Card>

      <Card title={t.preapprovedShifts.createTitle}>
        <div className="flex flex-col gap-4">
          <Field label={t.preapprovedShifts.driver}>
            <Select
              aria-label={t.preapprovedShifts.driver}
              value={driverId}
              onChange={(event) => {
                setDriverId(event.target.value)
                setFormError(null)
              }}
              className="w-full max-w-md"
            >
              <option value="">{t.preapprovedShifts.chooseDriver}</option>
              {drivers.filter((driver) => driver.active).map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driverName(driver.id)}
                </option>
              ))}
            </Select>
          </Field>

          <div>
            <div className="mb-2 text-xs font-medium text-slate-500">{t.preapprovedShifts.dates}</div>
            <div className="grid gap-3 md:grid-cols-2">
              {dates.map((date, index) => (
                <div key={index} className="flex items-end gap-2">
                  <DateField
                    label={`${t.preapprovedShifts.date} ${index + 1}`}
                    value={date}
                    onChange={(value) => updateDate(index, value)}
                    className="min-w-0 flex-1"
                  />
                  {dates.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="shrink-0"
                      onClick={() => {
                        setDates((current) => current.filter((_, row) => row !== index))
                        setFormError(null)
                      }}
                    >
                      {t.preapprovedShifts.removeDate}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              className="mt-3"
              disabled={dates.length >= 62}
              onClick={() => {
                setDates((current) => [...current, ''])
                setFormError(null)
              }}
            >
              {t.preapprovedShifts.addDate}
            </Button>
          </div>

          <div className="flex flex-wrap gap-3">
            <Field label={t.preapprovedShifts.windowStart}>
              <TextInput
                aria-label={t.preapprovedShifts.windowStart}
                type="time"
                dir="ltr"
                value={windowStart}
                onChange={(event) => {
                  setWindowStart(event.target.value)
                  setFormError(null)
                }}
                className="num w-36"
              />
            </Field>
            <Field label={t.preapprovedShifts.windowEnd} hint={t.preapprovedShifts.windowHint}>
              <TextInput
                aria-label={t.preapprovedShifts.windowEnd}
                type="time"
                dir="ltr"
                value={windowEnd}
                onChange={(event) => {
                  setWindowEnd(event.target.value)
                  setFormError(null)
                }}
                className="num w-36"
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-3">
            <Field label={t.preapprovedShifts.cashFloat} hint={t.preapprovedShifts.fundingHint}>
              <MoneyInput
                aria-label={t.preapprovedShifts.cashFloat}
                value={cashFloat}
                onChange={(event) => {
                  setCashFloat(event.target.value)
                  setFormError(null)
                }}
                className="w-40"
              />
            </Field>
            <Field label={t.preapprovedShifts.walletTopup}>
              <MoneyInput
                aria-label={t.preapprovedShifts.walletTopup}
                value={walletTopup}
                onChange={(event) => {
                  setWalletTopup(event.target.value)
                  setFormError(null)
                }}
                className="w-40"
              />
            </Field>
          </div>

          {formError ? <p className="text-sm font-medium text-red-600">{validationText(formError)}</p> : null}
          <Button className="self-start" disabled={creating} onClick={() => void createRules()}>
            {creating ? t.preapprovedShifts.creating : t.preapprovedShifts.create}
          </Button>
        </div>
      </Card>

      {loadError ? (
        <Card>
          <p className="text-sm font-medium text-red-600">{explainError(loadError, t)}</p>
          <p className="mt-1 text-xs text-slate-600">{loadError}</p>
        </Card>
      ) : null}

      <Card title={t.preapprovedShifts.rulesTitle}>
        <Table
          head={[
            t.preapprovedShifts.date,
            t.preapprovedShifts.driver,
            t.preapprovedShifts.window,
            t.preapprovedShifts.cashFloat,
            t.preapprovedShifts.walletTopup,
            t.preapprovedShifts.status,
            t.preapprovedShifts.action,
          ]}
          isEmpty={rules.length === 0}
          empty={t.preapprovedShifts.none}
        >
          {rules.map((rule) => {
            const status = preapprovedRuleStatus(rule)
            return (
              <tr key={rule.id}>
                <td className="num whitespace-nowrap px-3 py-2">{rule.businessDate}</td>
                <td className="px-3 py-2">{driverName(rule.driverId)}</td>
                <td className="num whitespace-nowrap px-3 py-2" dir="ltr">
                  {rule.windowStart}–{rule.windowEnd}
                </td>
                <td className="px-3 py-2"><Money value={rule.cashFloat} /></td>
                <td className="px-3 py-2"><Money value={rule.walletTopup} /></td>
                <td className="px-3 py-2">
                  <div className="flex flex-col items-start gap-1">
                    <Badge tone={status === 'active' ? 'green' : status === 'consumed' ? 'sky' : 'slate'}>
                      {status === 'active'
                        ? t.preapprovedShifts.statusActive
                        : status === 'consumed'
                          ? t.preapprovedShifts.statusConsumed
                          : t.preapprovedShifts.statusInactive}
                    </Badge>
                    {rule.consumedAt ? (
                      <span className="num whitespace-nowrap text-xs text-slate-500">
                        {t.preapprovedShifts.consumedAt} {formatDateTime(rule.consumedAt, lang)}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {status === 'active' ? (
                    <Button
                      variant="danger"
                      disabled={deactivatingId === rule.id}
                      onClick={() => void deactivate(rule)}
                    >
                      {t.preapprovedShifts.deactivate}
                    </Button>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </Table>
      </Card>
    </div>
  )
}
