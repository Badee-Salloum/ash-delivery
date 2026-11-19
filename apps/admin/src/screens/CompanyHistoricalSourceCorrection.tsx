import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { formatMinor, minor, parseMinor, type Currency } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { uncertainMoneyMoveOutcome } from '../money-move-idempotency.ts'
import { Button, Field, Money, MoneyInput, Pending, Select, TextInput } from '../ui.tsx'
import { FinanceActionForm, FinanceDialog, useResource } from './CompanyFinanceReview.tsx'
import type { Mutate } from './CompanyFund.tsx'

type Values = { currency: Currency | null; amount: string | null; occurredOn: string; description: string; excluded: boolean; sypMinorPerUsd: string | null; rateBasis: 'estimated' | 'documented' | null }
type Review = { version: number; original: Values; effective: Values; capabilities: { editableFields: string[]; financialCorrectionSupported: boolean; blockingReason: string | null }; history: Array<{ id: string; version: number; reason: string }> }
type Payload = { sourceReference: string; expectedVersion: number; reason: string; values: Partial<Values> }
type Preview = { before: Values; after: Values; impact: { companyCash: Record<Currency, string>; ownerPayments: Record<Currency, string>; branchCash: string; administrativeOnly: boolean } }
type Saved = { payload: Payload; preview: Preview }

export function CompanyHistoricalSourceCorrection({ sourceReference, mutate, onClose }: { sourceReference: string; mutate: Mutate; onClose: () => void }): ReactNode {
  const { t } = useApp()
  const feed = useResource<Review>(`/company/historical-imports/${encodeURIComponent(sourceReference)}/review`, 0)
  return <FinanceDialog title={t.financeReview.correction} onClose={onClose}>{!feed.data ? <Pending error={feed.error} loadingLabel={t.common.loading} errorLabel={explainError(feed.error, t)} onRetry={feed.load} retryLabel={t.common.retry} /> : <CorrectionForm sourceReference={sourceReference} data={feed.data} mutate={mutate} onSaved={onClose} />}</FinanceDialog>
}

function CorrectionForm({ sourceReference, data, mutate, onSaved }: { sourceReference: string; data: Review; mutate: Mutate; onSaved: () => void }): ReactNode {
  const { api, t, session } = useApp(), r = t.financeReview, current = data.effective
  const key = `ash.historical-source-preview:${session?.userId}:${sourceReference}`
  const storedUncertain = (): boolean => { try { const raw = JSON.parse(sessionStorage.getItem(`ash.finance-draft:${session?.userId ?? ''}:/company/historical-source-corrections:${sourceReference}:request`) ?? 'null') as { uncertain?: string } | null; return raw?.uncertain === 'true' } catch { return false } }
  const [values, setValues] = useState(current), [reason, setReason] = useState(''), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null), [acknowledged, setAcknowledged] = useState(storedUncertain), [uncertain, setUncertain] = useState(storedUncertain)
  const [saved, setSaved] = useState<Saved | null>(() => { try { const raw = sessionStorage.getItem(key); if (!raw) return null; const result = JSON.parse(raw) as Saved; return result.payload?.sourceReference === sourceReference && result.preview?.impact ? result : null } catch { return null } })
  const [rate, setRate] = useState(current.sypMinorPerUsd ? formatMinor(minor(BigInt(current.sypMinorPerUsd))) : '')
  const editable = (field: string): boolean => data.capabilities.editableFields.includes(field)
  useEffect(() => { if (saved) { setValues(saved.preview.after); setReason(saved.payload.reason) } }, [])
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setLoading(true); setError(null)
    try {
      const changes = Object.fromEntries(Object.entries(values).filter(([field]) => editable(field))) as Partial<Values>
      if (editable('sypMinorPerUsd')) { changes.sypMinorPerUsd = values.currency === 'USD' && rate ? parseMinor(rate).toString() : null; changes.rateBasis = changes.sypMinorPerUsd ? values.rateBasis ?? 'estimated' : null }
      if (changes.amount != null) changes.amount = formatMinor(parseMinor(changes.amount))
      const payload = { sourceReference, expectedVersion: data.version, reason: reason.trim(), values: changes }
      const preview = await api.post<Preview>('/company/historical-source-corrections/preview', payload)
      const next = { payload, preview }; setSaved(next); setAcknowledged(false)
      try { sessionStorage.setItem(key, JSON.stringify(next)) } catch { /* In-memory retry remains available. */ }
    } catch (cause) { setError((cause as { error?: string }).error ?? 'error') } finally { setLoading(false) }
  }
  return <div className="flex flex-col gap-4"><p className="text-body text-ink-muted">{r.correctionHint}</p><p>{r.before}: {current.amount !== null && current.currency ? <bdi><Money value={current.amount} currency={current.currency} /></bdi> : r.unknown} · <bdi>{current.occurredOn}</bdi></p>
    {!data.capabilities.financialCorrectionSupported ? <p className="rounded-lg border border-warning-line bg-warning-surface p-3 text-warning-ink">{r.historicalLinkedCorrectionHint}</p> : null}
    {!saved ? <form onSubmit={event => void submit(event)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {editable('amount') ? <Field label={r.after}><MoneyInput required disabled={loading} value={values.amount ?? ''} aria-label={r.after} onChange={event => setValues(v => ({ ...v, amount: event.target.value }))} /></Field> : null}
      {editable('currency') ? <Field label={t.companyFinance.currency}><Select value={values.currency ?? 'SYP_NEW'} disabled={loading} aria-label={t.companyFinance.currency} onChange={event => setValues(v => ({ ...v, currency: event.target.value as Currency }))}><option value="SYP_NEW">{t.currency.SYP_NEW}</option><option value="USD">{t.currency.USD}</option></Select></Field> : null}
      {editable('occurredOn') ? <Field label={t.companyFinance.occurredOn}><TextInput required type="date" min="2000-01-01" max={session?.businessDate} disabled={loading} aria-label={t.companyFinance.occurredOn} value={values.occurredOn} onChange={event => setValues(v => ({ ...v, occurredOn: event.target.value }))} /></Field> : null}
      {editable('description') ? <Field label={t.companyFinance.description}><TextInput required disabled={loading} aria-label={t.companyFinance.description} value={values.description} onChange={event => setValues(v => ({ ...v, description: event.target.value }))} /></Field> : null}
      {values.currency === 'USD' && editable('sypMinorPerUsd') ? <><Field label={t.companyFinance.historicalRate} hint={r.optional}><MoneyInput disabled={loading} value={rate} aria-label={t.companyFinance.historicalRate} onChange={event => setRate(event.target.value)} /></Field><Field label={r.rateBasis}><Select disabled={loading || !rate} value={values.rateBasis ?? 'estimated'} aria-label={r.rateBasis} onChange={event => setValues(v => ({ ...v, rateBasis: event.target.value as 'estimated' | 'documented' }))}><option value="estimated">{r.estimated}</option><option value="documented">{r.documented}</option></Select></Field></> : null}
      {editable('excluded') ? <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={values.excluded} disabled={loading} onChange={event => setValues(v => ({ ...v, excluded: event.target.checked }))} /><span>{r.excludeFromEffective}</span></label> : null}
      <Field label={t.companyFinance.reason}><TextInput required disabled={loading} value={reason} aria-label={t.companyFinance.reason} onChange={event => setReason(event.target.value)} /></Field><Button type="submit" disabled={loading} className="sm:col-span-2">{r.confirm}</Button>
    </form> : <div className="rounded-lg border border-warning-line bg-warning-surface p-3 text-warning-ink"><p>{r.after}: {saved.preview.after.amount !== null && saved.preview.after.currency ? <bdi><Money value={saved.preview.after.amount} currency={saved.preview.after.currency} /></bdi> : r.unknown} · <bdi>{saved.preview.after.occurredOn}</bdi></p><p>{saved.preview.after.description}</p><p>{saved.payload.reason}</p><p className="mt-3">{r.cashImpact}: <bdi><Money value={saved.preview.impact.companyCash.SYP_NEW} currency="SYP_NEW" /> · <Money value={saved.preview.impact.companyCash.USD} currency="USD" /></bdi></p><p>{r.ownerTitle}: <bdi><Money value={saved.preview.impact.ownerPayments.SYP_NEW} currency="SYP_NEW" /> · <Money value={saved.preview.impact.ownerPayments.USD} currency="USD" /></bdi></p><p>{r.branchUnchanged}</p>{saved.preview.after.excluded ? <p>{r.excludeFromEffective}</p> : null}<label className="my-3 flex gap-2"><input type="checkbox" checked={acknowledged} disabled={uncertain} onChange={event => setAcknowledged(event.target.checked)} /><span>{r.acknowledgeCash}</span></label>{acknowledged ? <FinanceActionForm path="/company/historical-source-corrections" storageScope={sourceReference} fields={[]} title={r.confirmCorrection} build={() => ({ ...saved.payload, acknowledgeCashEffect: true })} mutate={(operation, success, attempt) => mutate(operation, success, outcome => { setUncertain(uncertainMoneyMoveOutcome(outcome)); attempt?.(outcome) })} onSaved={() => { try { sessionStorage.removeItem(key) } catch { /* No financial state in storage. */ } onSaved() }} preview={() => <><p>{saved.payload.reason}</p><p>{r.branchUnchanged}</p></>} /> : null}<Button variant="ghost" disabled={uncertain} className="mt-3" onClick={() => { setSaved(null); setAcknowledged(false); try { sessionStorage.removeItem(key) } catch { /* In memory. */ } }}>{r.edit}</Button></div>}
    {error ? <p role="alert" className="text-danger-ink">{explainError(error, t)}</p> : null}
    {data.history.length ? <details><summary className="cursor-pointer text-brand">{r.correctionHistory}</summary>{data.history.map(row => <p key={row.id}>{row.version} · {row.reason}</p>)}</details> : null}
  </div>
}
