import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Button, Card, MoneyInput, Pending, TextInput } from '../ui.tsx'

interface Fx {
  businessDate: string
  sypMinorPerUsd: number | null
  provisional: boolean
}
interface GeneralSettings {
  receiptCeilingMinor: string | null
  kwhPriceMinor: string | null
}

/**
 * System settings (SRS A-4) — system admin only.
 *
 * Two things live here that had endpoints but no screen: the day's exchange rate (BR6, entered
 * every morning), and the general operating constants — the receipt-required ceiling (the value
 * actually enforced on expenses and manual entries) and the kWh price. Money is shown and entered
 * as ordinary SYP; the wire carries it as minor units.
 */
export function Settings(): ReactNode {
  const { api, t, session } = useApp()
  const [fx, setFx] = useState<Fx | null>(null)
  const [general, setGeneral] = useState<GeneralSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Defends itself even though the nav already hides it from non-sysadmins.
  const canEdit = session?.roleKey === 'system_admin'

  const load = useCallback(() => {
    setError(null)
    void Promise.all([api.fxRate(), api.settings()])
      .then(([f, g]) => {
        setFx(f)
        setGeneral(g)
        setLoaded(true)
      })
      .catch((e: { error?: string }) => setError(e.error ?? 'error'))
  }, [api])
  useEffect(load, [load])

  if (!loaded) {
    return (
      <Pending
        error={error}
        loadingLabel={t.common.loading}
        errorLabel={explainError(error, t)}
        onRetry={load}
        retryLabel={t.common.retry}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {fx ? <FxCard fx={fx} canEdit={canEdit} onSaved={load} /> : null}
      {general ? <GeneralCard general={general} canEdit={canEdit} onSaved={load} /> : null}
    </div>
  )
}

/** The daily rate. `sypMinorPerUsd` is minor units per USD — 13000 = 130.00 SYP/USD. */
function FxCard({ fx, canEdit, onSaved }: { fx: Fx; canEdit: boolean; onSaved(): void }): ReactNode {
  const { api, t } = useApp()
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const current = fx.sypMinorPerUsd === null ? '—' : (fx.sypMinorPerUsd / 100).toFixed(2)

  return (
    <Card title={t.settings.fxTitle}>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt className="text-slate-500">{t.common.today}</dt>
        <dd className="num text-end">{fx.businessDate}</dd>
        <dt className="text-slate-500">{t.settings.fxToday}</dt>
        <dd className="num text-end font-semibold">
          {current}
          <span className="ms-2">
            <Badge tone={fx.provisional ? 'amber' : 'green'}>
              {fx.provisional ? t.settings.fxProvisional : t.settings.fxEntered}
            </Badge>
          </span>
        </dd>
      </dl>

      {canEdit ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {/* Entered as ordinary SYP-per-USD (e.g. 130.00); sent as minor units (×100). */}
          <MoneyInput
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t.settings.fxRate}
            className="w-40"
          />
          <Button
            disabled={text.trim() === ''}
            onClick={async () => {
              setErr(null)
              setMsg(null)
              try {
                await api.setFxRate(fx.businessDate, Math.round(Number(text) * 100))
                setText('')
                setMsg(t.settings.saved)
                onSaved()
              } catch (e) {
                setErr((e as { error?: string }).error ?? 'error')
              }
            }}
          >
            {t.settings.fxSet}
          </Button>
          {msg ? <span className="text-sm font-medium text-emerald-700">{msg}</span> : null}
          {err ? <span className="text-sm font-medium text-red-600">{explainError(err, t)}</span> : null}
        </div>
      ) : null}
    </Card>
  )
}

/**
 * The general constants. Each row saves only itself, so changing the ceiling never disturbs the
 * kWh price. A blank field is left unchanged rather than cleared.
 */
function GeneralCard({
  general,
  canEdit,
  onSaved,
}: {
  general: GeneralSettings
  canEdit: boolean
  onSaved(): void
}): ReactNode {
  const { api, t } = useApp()
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const save = async (body: { receiptCeilingMinor?: string; kwhPriceMinor?: string }): Promise<void> => {
    setErr(null)
    setMsg(null)
    try {
      await api.updateSettings(body)
      setMsg(t.settings.saved)
      onSaved()
    } catch (e) {
      setErr((e as { error?: string }).error ?? 'error')
    }
  }

  return (
    <Card title={t.settings.generalTitle}>
      <div className="flex flex-col gap-4">
        <MoneySetting
          label={t.settings.receiptCeiling}
          hint={t.settings.receiptCeilingHint}
          current={general.receiptCeilingMinor}
          canEdit={canEdit}
          onSave={(v) => save({ receiptCeilingMinor: v })}
          saveLabel={t.common.save}
        />
        <MoneySetting
          label={t.settings.kwhPrice}
          current={general.kwhPriceMinor}
          canEdit={canEdit}
          onSave={(v) => save({ kwhPriceMinor: v })}
          saveLabel={t.common.save}
        />
      </div>
      {msg ? <p className="mt-3 text-sm font-medium text-emerald-700">{msg}</p> : null}
      {err ? <p className="mt-3 text-sm font-medium text-red-600">{explainError(err, t)}</p> : null}
    </Card>
  )
}

/** One money setting: shows the current value, saves the new one on button press. */
function MoneySetting({
  label,
  hint,
  current,
  canEdit,
  onSave,
  saveLabel,
}: {
  label: string
  hint?: string
  current: string | null
  canEdit: boolean
  onSave(value: string): void | Promise<void>
  saveLabel: string
}): ReactNode {
  const [text, setText] = useState('')
  // Re-sync the field's placeholder when the server restates the value after a save.
  useEffect(() => setText(''), [current])

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      {hint ? <div className="mt-0.5 text-xs text-slate-400">{hint}</div> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="num text-lg font-bold">{current ?? '—'}</span>
        {canEdit ? (
          <>
            <MoneyInput value={text} onChange={(e) => setText(e.target.value)} className="w-40" placeholder="—" />
            <Button variant="ghost" disabled={text.trim() === ''} onClick={() => onSave(text)}>
              {saveLabel}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}
