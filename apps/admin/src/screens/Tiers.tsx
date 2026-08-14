import { type ReactNode, useCallback, useEffect, useState } from 'react'
import type { TierBand, TierRuleView } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { Badge, Card, Pending } from '../ui.tsx'

/**
 * Legacy tier history.
 *
 * New and still-unapproved shifts always use the fixed 40% settlement policy. Tier tables remain
 * visible only so an auditor can understand settlements that were approved under the former
 * effective-dated rules; this screen deliberately exposes no mutation or simulation controls.
 */
export function Tiers(): ReactNode {
  const { api, t } = useApp()
  const [rules, setRules] = useState<TierRuleView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    void api
      .tierRules()
      .then((response) => setRules(response.rules))
      .catch((cause: { error?: string }) => {
        setRules([])
        setError(cause.error ?? 'error')
      })
  }, [api])

  useEffect(load, [load])

  if (!rules) {
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

  const bandLabel = (band: TierBand): string =>
    `${band.from}–${band.to ?? t.tiers.andAbove}: ${band.driverBps / 100}%`
  const statusTone = (status: string): 'green' | 'slate' | 'red' =>
    status === 'active' ? 'green' : status === 'superseded' ? 'slate' : 'red'
  const statusLabel = (status: string): string =>
    status === 'active'
      ? t.tiers.statusActive
      : status === 'superseded'
        ? t.tiers.statusSuperseded
        : t.tiers.statusWithdrawn

  return (
    <div className="flex flex-col gap-4">
      <Card title={t.tiers.fixedPolicyTitle}>
        <div className="flex items-start gap-3">
          <Badge tone="green">40%</Badge>
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-semibold text-slate-800">{t.tiers.fixedPolicyDescription}</p>
            <p className="text-slate-600">{t.tiers.legacyReadOnlyNotice}</p>
          </div>
        </div>
      </Card>

      <Card title={t.tiers.historyTitle}>
        {rules.length === 0 ? (
          <p className="text-sm text-slate-500">{t.tiers.historyEmpty}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-2 last:border-0"
              >
                <Badge tone={statusTone(rule.status)}>{statusLabel(rule.status)}</Badge>
                <span className="text-slate-500">{t.tiers.effectiveFrom}</span>
                <span className="num text-slate-500">{rule.effectiveFrom}</span>
                <span className="text-slate-500">{t.tiers[rule.mode]}</span>
                <span className="text-slate-700">{rule.bands.map(bandLabel).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
