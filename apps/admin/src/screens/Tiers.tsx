import { type ReactNode, useCallback, useEffect, useState } from 'react'
import type { TierBand, TierRuleView, TierSimResult } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { useToast } from '../feedback.tsx'
import { explainError } from '../errors.ts'
import { Badge, Button, Card, DateField, Field, Money, Pending, Select, Table, TextInput } from '../ui.tsx'

/**
 * Tier admin (SRS F-3…F-6) — system-admin only. Publish an effective-dated share table (whole or
 * marginal), withdraw one, and run the read-only what-if simulation before committing. The engine
 * itself is in the domain and already runs at close; this is the screen that changes it.
 *
 * Driver share is entered as a PERCENT and converted to basis points on the wire; the domain's
 * validateBands owns the real rule (share ≤ 80%, Yallago's 20% is fixed) and answers a 422.
 */

interface BandForm {
  from: string
  to: string
  sharePct: string
}

const DEFAULT_FORM: BandForm[] = [
  { from: '0', to: '14', sharePct: '35' },
  { from: '15', to: '24', sharePct: '40' },
  { from: '25', to: '34', sharePct: '43' },
  { from: '35', to: '', sharePct: '46' },
]

export function Tiers(): ReactNode {
  const { api, t } = useApp()
  const toast = useToast()
  const [rules, setRules] = useState<TierRuleView[] | null>(null)
  const [fallback, setFallback] = useState<{ bands: TierBand[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [mode, setMode] = useState<'whole' | 'marginal'>('whole')
  const [bands, setBands] = useState<BandForm[]>(DEFAULT_FORM)
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [simFrom, setSimFrom] = useState('')
  const [simTo, setSimTo] = useState('')
  const [sim, setSim] = useState<TierSimResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    void api
      .tierRules()
      .then((r) => {
        setRules(r.rules)
        setFallback(r.fallback)
      })
      .catch((e: { error?: string }) => {
        setRules([])
        setError(e.error ?? 'error')
      })
  }, [api])
  useEffect(load, [load])

  const toWire = (): TierBand[] =>
    bands.map((b) => ({
      from: Number(b.from),
      to: b.to.trim() === '' ? null : Number(b.to),
      driverBps: Math.round(Number(b.sharePct) * 100),
    }))
  const setBand = (i: number, patch: Partial<BandForm>): void => setBands((prev) => prev.map((b, j) => (j === i ? { ...b, ...patch } : b)))
  const addBand = (): void => setBands((prev) => [...prev, { from: '', to: '', sharePct: '' }])
  const removeBand = (i: number): void => setBands((prev) => prev.filter((_, j) => j !== i))

  const publish = async (): Promise<void> => {
    setBusy(true)
    setFormError(null)
    try {
      await api.publishTier({ mode, bands: toWire(), effectiveFrom })
      toast.success(t.tiers.published)
      setSim(null)
      load()
    } catch (e) {
      setFormError((e as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }
  const withdraw = async (id: number): Promise<void> => {
    try {
      await api.withdrawTier(id)
      toast.success(t.tiers.withdrawn)
      load()
    } catch (e) {
      toast.error(explainError((e as { error?: string }).error ?? 'error', t))
    }
  }
  const simulate = async (): Promise<void> => {
    setBusy(true)
    setFormError(null)
    try {
      setSim(await api.simulateTier({ mode, bands: toWire(), from: simFrom, to: simTo }))
    } catch (e) {
      setFormError((e as { error?: string }).error ?? 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!rules) {
    return <Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error, t)} onRetry={load} retryLabel={t.common.retry} />
  }

  const bandLabel = (b: TierBand): string => `${b.from}–${b.to ?? t.tiers.andAbove}: ${b.driverBps / 100}%`
  const statusTone = (s: string): 'green' | 'slate' | 'red' => (s === 'active' ? 'green' : s === 'superseded' ? 'slate' : 'red')
  const statusLabel = (s: string): string => (s === 'active' ? t.tiers.statusActive : s === 'superseded' ? t.tiers.statusSuperseded : t.tiers.statusWithdrawn)

  return (
    <div className="flex flex-col gap-4">
      <Card title={t.tiers.currentRules}>
        {rules.length === 0 ? (
          <p className="text-sm text-slate-500">
            {t.tiers.defaultTable}: {fallback?.bands.map(bandLabel).join(' · ')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1 last:border-0">
                <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                <span className="num text-slate-500">{r.effectiveFrom}</span>
                <span className="text-slate-500">{t.tiers[r.mode]}</span>
                <span className="text-slate-700">{r.bands.map(bandLabel).join(' · ')}</span>
                {r.status === 'active' ? (
                  <Button variant="ghost" className="ms-auto" onClick={() => withdraw(r.id)}>
                    {t.tiers.withdraw}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t.tiers.newTable}>
        <div className="flex flex-col gap-3">
          <Field label={t.tiers.mode} className="max-w-48">
            <Select value={mode} onChange={(e) => setMode(e.target.value as 'whole' | 'marginal')}>
              <option value="whole">{t.tiers.whole}</option>
              <option value="marginal">{t.tiers.marginal}</option>
            </Select>
          </Field>

          <Table head={[t.tiers.fromOrders, t.tiers.toOrders, t.tiers.driverShare, '']}>
            {bands.map((b, i) => (
              <tr key={i}>
                <td className="px-2 py-1">
                  <TextInput inputMode="numeric" value={b.from} onChange={(e) => setBand(i, { from: e.target.value })} className="w-20" aria-label={t.tiers.fromOrders} />
                </td>
                <td className="px-2 py-1">
                  <TextInput inputMode="numeric" value={b.to} onChange={(e) => setBand(i, { to: e.target.value })} className="w-20" placeholder={t.tiers.andAbove} aria-label={t.tiers.toOrders} />
                </td>
                <td className="px-2 py-1">
                  <TextInput inputMode="decimal" value={b.sharePct} onChange={(e) => setBand(i, { sharePct: e.target.value })} className="w-20" aria-label={t.tiers.driverShare} />
                </td>
                <td className="px-2 py-1">
                  <Button variant="ghost" onClick={() => removeBand(i)} aria-label={t.common.remove}>
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
          <Button variant="ghost" onClick={addBand} className="self-start">
            + {t.tiers.addBand}
          </Button>

          {formError ? <p className="text-sm text-red-600">{explainError(formError, t)}</p> : null}

          <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
            <DateField label={t.tiers.effectiveFrom} value={effectiveFrom} onChange={setEffectiveFrom} />
            <Button variant="primary" disabled={busy || effectiveFrom === ''} onClick={publish}>
              {t.tiers.publish}
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
            <DateField label={t.tiers.simFrom} value={simFrom} onChange={setSimFrom} />
            <DateField label={t.tiers.simTo} value={simTo} onChange={setSimTo} />
            <Button variant="ghost" disabled={busy || simFrom === '' || simTo === ''} onClick={simulate}>
              {t.tiers.simulate}
            </Button>
          </div>
        </div>
      </Card>

      {sim ? (
        <Card title={t.tiers.simulateResult}>
          <Table head={[t.tiers.colDriver, t.tiers.colOrders, t.tiers.colCurrent, t.tiers.colCandidate, t.tiers.colDelta]}>
            {sim.drivers.map((d) => (
              <tr key={d.driverId}>
                <td className="num px-3 py-1">{d.driverId.slice(0, 8)}</td>
                <td className="num px-3 py-1">{d.orders}</td>
                <td className="px-3 py-1"><Money value={d.currentDriverShare} /></td>
                <td className="px-3 py-1"><Money value={d.candidateDriverShare} /></td>
                <td className="px-3 py-1"><Money value={d.driverDelta} /></td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-sm text-slate-600">
            {t.tiers.companyDelta}: <Money value={sim.companyTotalDelta} />
          </p>
        </Card>
      ) : null}
    </div>
  )
}
