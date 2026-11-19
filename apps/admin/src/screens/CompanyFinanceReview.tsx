import { Fragment, type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatMinor, minor, monthEndFor, parseMinor, type Currency } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { pendingAfterAttempt, pendingMoneyMove, uncertainMoneyMoveOutcome, type PendingMoneyMove } from '../money-move-idempotency.ts'
import { Button, Card, Field, FinancePagination, Money, MoneyInput, Pending, Select, Stat, Table, TextInput } from '../ui.tsx'
import type { Mutate } from './CompanyFund.tsx'
import { CompanyFinanceFilters, defaultFinanceFilters, downloadFinanceRows, filterFinanceRows, financeRowTotals, type FinanceFilterRow, type FinanceFilters } from './CompanyFinanceFilters.tsx'
import { CompanyHistoricalRestorationMatching } from './CompanyHistoricalRestorationMatching.tsx'

export { ExistingAssetsPanel } from './CompanyExistingAssets.tsx'
export type FormField = { key: string; label: string; section?: string; value?: string; type?: 'money' | 'date' | 'month' | 'number'; optional?: boolean; advanced?: boolean; allowFuture?: boolean; visibleWhen?: { key: string; value: string | string[] }; options?: Array<{ value: string; label: string }> }

/** Visible, keyboard-accessible editing; opening a financial form is never a financial write. */
export function FinanceDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): ReactNode {
  const { t } = useApp(), titleId = useId(), ref = useRef<HTMLDivElement>(null), close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = (): HTMLElement[] => [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])') ?? [])].filter(el => el.getClientRects().length > 0)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab') return
      const items = focusable(), first = items[0], last = items[items.length - 1]
      if (!first || !last) { event.preventDefault(); ref.current?.focus() }
      else if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    const frame = requestAnimationFrame(() => (focusable()[0] ?? ref.current)?.focus())
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; if (opener?.isConnected) opener.focus() }
  }, [])
  return createPortal(<div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim/90 p-3 sm:p-6"><div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="my-auto w-full max-w-4xl rounded-xl border border-line bg-surface-card p-4 shadow-xl sm:p-6"><div className="mb-4 flex items-center justify-between gap-3"><h2 id={titleId} className="text-title font-semibold">{title}</h2><Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button></div>{children}</div></div>, document.body)
}

/** Per-user/session drafts are working state, never posted financial facts. */
function readDraft(key: string): Record<string, string> {
  try { const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}'); return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) : {} } catch { return {} }
}
function writeDraft(key: string, value: unknown): void { try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* Private mode still permits the in-memory form. */ } }

/** One reusable review/confirm boundary, retaining the exact UUID after uncertain failures. */
export function FinanceActionForm({ path, fields, build, mutate, onSaved, title, preview, validate, storageScope = '', method = 'post' }: {
  path: string; fields: FormField[]; build: (values: Record<string, string>) => Record<string, unknown>
  mutate: Mutate; onSaved?: (values: Record<string, string>) => void; title: string; preview?: (values: Record<string, string>) => ReactNode
  storageScope?: string; method?: 'post' | 'patch'
  validate?: (values: Record<string, string>) => string | null
}): ReactNode {
  const { api, t, session } = useApp()
  const storageKey = `ash.finance-draft:${session?.userId ?? ''}:${path}:${storageScope}`
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...Object.fromEntries(fields.map(f => [f.key, f.value ?? ''])), ...readDraft(storageKey) }))
  const [reviewing, setReviewing] = useState(false), [sending, setSending] = useState(false)
  const [uncertain, setUncertain] = useState(false), [formError, setFormError] = useState<string | null>(null)
  const pending = useRef<PendingMoneyMove | null>(null)
  const visibleFields = fields.filter(field => !field.visibleWhen || (Array.isArray(field.visibleWhen.value) ? field.visibleWhen.value.includes(values[field.visibleWhen.key] ?? '') : values[field.visibleWhen.key] === field.visibleWhen.value))
  const pendingStorageKey = storageKey + ':request'
  useEffect(() => { const stored = readDraft(pendingStorageKey); if (stored.idempotencyKey && stored.fingerprint) { pending.current = { idempotencyKey: stored.idempotencyKey, fingerprint: stored.fingerprint }; setUncertain(stored.uncertain !== 'false') } }, [pendingStorageKey])
  useEffect(() => { writeDraft(storageKey, values) }, [storageKey, values])
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setFormError(null)
    try { for (const field of visibleFields) { if (field.type === 'money' && values[field.key]) { if (parseMinor(values[field.key]!) < 0n) throw new Error('negative') } } } catch { setFormError(t.financeReview.invalidAmount); return }
    if (visibleFields.some(field => !field.optional && !(values[field.key] ?? '').trim())) { setFormError(t.common.required); return }
    const validationError = validate?.(values)
    if (validationError) { setFormError(validationError); return }
    if (!reviewing) { setReviewing(true); return }
    const payload = build(values)
    const request = pendingMoneyMove(pending.current, { command: path, branchId: null, amount: '', reason: values.reason ?? values.description ?? '', details: payload })
    pending.current = request; writeDraft(pendingStorageKey, { ...request, uncertain: 'true' }); setSending(true)
    void mutate(() => method === 'patch' ? api.patch(path, { ...payload, idempotencyKey: request.idempotencyKey }) : api.post(path, { ...payload, idempotencyKey: request.idempotencyKey }), t.companyFinance.saved, outcome => {
      pending.current = pendingAfterAttempt(request, outcome)
      const unknown = pending.current !== null && uncertainMoneyMoveOutcome(outcome)
      writeDraft(pendingStorageKey, pending.current ? { ...pending.current, uncertain: unknown ? 'true' : 'false' } : null)
      setUncertain(unknown)
    }).then(saved => {
      if (!saved) return
      try { sessionStorage.removeItem(storageKey); sessionStorage.removeItem(pendingStorageKey) } catch { /* Memory is enough. */ }
      onSaved?.(values); setValues(Object.fromEntries(fields.map(f => [f.key, f.value ?? '']))); setReviewing(false)
    }).finally(() => setSending(false))
  }
  const renderField = (field: FormField): ReactNode => <Fragment key={field.key}>{field.section ? <h3 className="mt-2 border-t border-line pt-3 font-semibold sm:col-span-2">{field.section}</h3> : null}<Field label={field.label} {...(field.optional ? { hint: t.financeReview.optional } : {})}>
      {field.options ? <Select required={!field.optional} disabled={sending || uncertain} value={values[field.key] ?? ''} onChange={event => { setValues(v => ({ ...v, [field.key]: event.target.value })); setReviewing(false) }} aria-label={field.label}>
        {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select> : field.type === 'money' ? <MoneyInput required={!field.optional} disabled={sending || uncertain} value={values[field.key] ?? ''} onChange={event => { setValues(v => ({ ...v, [field.key]: event.target.value })); setReviewing(false) }} aria-label={field.label} /> :
        <TextInput required={!field.optional} disabled={sending || uncertain} type={field.type ?? 'text'} min={field.type === 'date' ? '2000-01-01' : field.type === 'month' ? '2000-01' : field.type === 'number' ? '0' : undefined} max={field.allowFuture ? undefined : field.type === 'date' ? session?.businessDate : field.type === 'month' ? session?.businessDate.slice(0, 7) : undefined} value={values[field.key] ?? ''} onChange={event => { setValues(v => ({ ...v, [field.key]: event.target.value })); setReviewing(false) }} aria-label={field.label} />}
    </Field></Fragment>
  return <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
    {visibleFields.filter(field => !field.advanced).map(renderField)}
    {visibleFields.some(field => field.advanced) ? <details className="sm:col-span-2"><summary className="cursor-pointer text-brand">{t.audit.details}</summary><div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{visibleFields.filter(field => field.advanced).map(renderField)}</div></details> : null}
    {reviewing ? <div role="status" className="sm:col-span-2 rounded-lg border border-warning-line bg-warning-surface p-3 text-body text-warning-ink">
      {preview ? preview(values) : <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">{visibleFields.map(field => <div key={field.key}><dt className="text-label">{field.label}</dt><dd className="break-words font-semibold">{field.options?.find(o => o.value === values[field.key])?.label ?? values[field.key] ?? '—'}</dd></div>)}</dl>}
    </div> : null}
    {formError ? <p role="alert" className="sm:col-span-2 text-danger-ink">{formError}</p> : null}
    <p className="sm:col-span-2 text-label text-ink-muted">{uncertain ? t.financeReview.unknownAttempt : t.financeReview.savedDraft}</p>
    <Button type="submit" disabled={sending} className="sm:col-span-2">{reviewing ? title : t.financeReview.confirm}</Button>
  </form>
}

export function useResource<T>(path: string | null, revision: number) {
  const { api } = useApp(), [result, setResult] = useState<{ key: string; data: T | null; error: string | null } | null>(null), request = useRef(0)
  const key = `${path}:${revision}`
  const load = useCallback(() => {
    const current = ++request.current
    setResult({ key, data: null, error: null })
    if (path === null) return () => { if (current === request.current) request.current++ }
    void api.get<T>(path).then(data => { if (current === request.current) setResult({ key, data, error: null }) }).catch(cause => { if (current === request.current) setResult({ key, data: null, error: (cause as { error?: string }).error ?? 'error' }) })
    return () => { if (current === request.current) request.current++ }
  }, [api, path, key])
  useEffect(load, [load, revision])
  return { data: result?.key === key ? result.data : null, error: result?.key === key ? result.error : null, load }
}

export function ownerCombinedTotals(direct: Record<Currency, string>, branch: Record<Currency, string> | undefined): Record<Currency, string> | null {
  if (!branch) return null
  return { SYP_NEW: formatMinor(minor(parseMinor(direct.SYP_NEW) + parseMinor(branch.SYP_NEW))), USD: formatMinor(minor(parseMinor(direct.USD) + parseMinor(branch.USD))) }
}

export function CompanyOwnerPanel({ revision = 0, from = '2000-01-01', to, latest = false }: { revision?: number; from?: string; to?: string; latest?: boolean }): ReactNode {
  const { t, session } = useApp()
  const today = session?.businessDate ?? to ?? ''
  const [all, setAll] = useState(false), [page, setPage] = useState(0)
  const [filters, setFilters] = useState<FinanceFilters>(() => ({ ...defaultFinanceFilters(today), from, period: from === '2000-01-01' ? 'all' : 'custom' }))
  // Summary always reads the complete owner history. Date filters are a local detail projection.
  const requestedFrom = '2000-01-01', requestedTo = today
  const categories = useResource<{ categories: Array<{ id: string; nameAr: string; active: boolean }> }>('/expense-categories', revision)
  const { data, error, load } = useResource<{ totals: Record<Currency, string>; expenseTotals?: Record<Currency, string>; capitalAndDebtTotals?: Record<Currency, string>; branchFundingTotals?: Record<Currency, string>; branchFundingPayments?: Array<{ id: string; branchNameAr: string; channel: string; currency: Currency; amount: string; description: string; occurredOn: string; categoryId?: string | null; reviewStatus?: string; correctionIds?: string[] }>; payments: Array<{ id: string; kind: string; currency: Currency; amount: string; description?: string; occurredOn: string; categoryId?: string | null; reviewStatus?: string; correctionIds?: string[]; metadata?: { occurredPrecision: string; occurredMonth: string | null } }> }>(`/company/owner-payments?from=${encodeURIComponent(requestedFrom)}&to=${encodeURIComponent(requestedTo)}`, revision)
  const combined = data ? ownerCombinedTotals(data.totals, data.branchFundingTotals) : null
  const allPayments = data ? [...data.payments.map(row => ({ ...row, branchNameAr: null, channel: null })), ...(data.branchFundingPayments ?? []).map(row => ({ ...row, kind: 'branch_funding', metadata: undefined }))].sort((a, b) => b.occurredOn.localeCompare(a.occurredOn)) : []
  const index = allPayments.map<FinanceFilterRow & { payment: typeof allPayments[number] }>(payment => {
    const monthOnly = payment.metadata?.occurredPrecision === 'month', month = payment.metadata?.occurredMonth ?? payment.occurredOn.slice(0, 7), date = monthOnly ? `${month}-01` : payment.occurredOn
    return { id: `${payment.kind}:${payment.id}`, date, dateEnd: monthOnly ? monthEndFor(date) : date, datePrecision: monthOnly ? 'month' : 'day', kind: payment.kind ?? 'expense', source: 'owner_outside', category: payment.categoryId ?? 'unclassified', status: payment.reviewStatus ?? (payment.correctionIds?.length ? 'corrected' : 'active'), description: payment.description ?? '', reference: payment.id, amounts: [{ currency: payment.currency, amount: payment.amount }], payment }
  })
  const matched = filterFinanceRows(index, filters, today), matchingTotals = financeRowTotals(matched)
  useEffect(() => setPage(0), [from, to, revision])
  useEffect(() => { setFilters({ ...defaultFinanceFilters(today), from, to: to ?? today, period: from === '2000-01-01' ? 'all' : 'custom' }); setPage(0) }, [from, to, today])
  return <Card title={t.financeReview.ownerTitle} subtitle={t.financeReview.ownerPanelHint}>
    {!data ? <Pending error={error} loadingLabel={t.common.loading} errorLabel={explainError(error, t)} onRetry={load} retryLabel={t.common.retry} /> : <>
      <p className="mb-2 font-semibold">{t.financeReview.ownerCombined}</p><p className="mb-3 text-label text-ink-muted">{t.financeReview.ownerAllHistoryHint} · <bdi>{requestedTo}</bdi> · {t.financeReview.ownerTotalHint}</p><div data-owner-summary className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2"><Stat lead label={t.currency.SYP_NEW} value={combined ? <Money value={combined.SYP_NEW} currency="SYP_NEW" /> : t.financeReview.unavailable} /><Stat label={t.currency.USD} value={combined ? <Money value={combined.USD} currency="USD" /> : t.financeReview.unavailable} /></div>
      <p className="mb-2 font-semibold">{t.financeReview.ownerDirectPayments}</p>{latest ? <p className="mb-3"><Money value={data.totals.SYP_NEW} currency="SYP_NEW" /> · <Money value={data.totals.USD} currency="USD" /></p> : <div className="grid grid-cols-2 gap-3"><Stat label={t.currency.SYP_NEW} value={<Money value={data.totals.SYP_NEW} currency="SYP_NEW" />} /><Stat label={t.currency.USD} value={<Money value={data.totals.USD} currency="USD" />} /></div>}
      {data.expenseTotals && data.capitalAndDebtTotals ? <dl className="my-3 grid grid-cols-1 gap-2 sm:grid-cols-2"><div><dt>{t.financeReview.ownerExpenses}</dt><dd><Money value={data.expenseTotals.SYP_NEW} currency="SYP_NEW" /> · <Money value={data.expenseTotals.USD} currency="USD" /></dd></div><div><dt>{t.financeReview.ownerCapitalPayments}</dt><dd><Money value={data.capitalAndDebtTotals.SYP_NEW} currency="SYP_NEW" /> · <Money value={data.capitalAndDebtTotals.USD} currency="USD" /></dd></div></dl> : null}
      <div data-owner-detail-filters className="mt-4 border-t border-line pt-4"><h3 className="mb-2 font-semibold">{t.financeReview.ownerDetailsTitle}</h3><p className="mb-3 text-label text-ink-muted">{t.financeReview.ownerFilteredDetailsHint}</p>{!all ? <><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label={t.companyFinance.from}><TextInput type="date" min="2000-01-01" max={today} value={filters.from} aria-label={t.companyFinance.from} onChange={event => { setFilters(value => ({ ...value, from: event.target.value, period: 'custom' })); setPage(0) }} /></Field><Field label={t.companyFinance.to}><TextInput type="date" min="2000-01-01" max={today} value={filters.to} aria-label={t.companyFinance.to} onChange={event => { setFilters(value => ({ ...value, to: event.target.value, period: 'custom' })); setPage(0) }} /></Field></div><Button variant="ghost" className="mt-3" onClick={() => { setFilters(defaultFinanceFilters(today)); setPage(0) }}>{t.financeReview.ownerAllDates}</Button></> : null}</div>
      {latest && !all ? <div className="mt-4"><h3 className="mb-3 font-semibold">{t.financeWorkspace.latestOwner}</h3><Table head={[t.companyFinance.date, t.companyFinance.kind, t.companyFinance.description, t.companyFinance.amount]} isEmpty={!matched.length} empty={allPayments.length ? t.financeReview.emptyOwnerPeriod : t.financeReview.emptyOwner}>{matched.slice(0, 5).map(({ payment }) => <tr key={`${payment.kind}:${payment.id}`}><td className="whitespace-nowrap px-3 py-2"><bdi>{payment.metadata?.occurredPrecision === 'month' ? payment.metadata.occurredMonth : payment.occurredOn}</bdi></td><td className="px-3 py-2">{payment.kind === 'branch_funding' ? t.financeReview.ownerBranchFunding : payment.kind === 'asset_payment' ? t.financeReview.assetPayment : payment.kind === 'debt_payment' ? t.financeReview.debtPayment : t.companyFinance.historicalKinds.expense}</td><td className="px-3 py-2"><p className="line-clamp-2">{payment.description || '—'}</p></td><td className="px-3 py-2"><Money value={payment.amount} currency={payment.currency} /></td></tr>)}</Table></div> : null}
      <div className="my-3"><Button variant="ghost" onClick={() => { setAll(value => !value); setPage(0) }}>{all ? t.common.cancel : t.financeReview.ownerShowAll}</Button></div>
      {all ? <div className="rounded-lg border border-line p-3"><CompanyFinanceFilters filters={filters} onChange={value => { setFilters(value); setPage(0) }} today={today} kinds={[{ value: 'expense', label: t.companyFinance.historicalKinds.expense }, { value: 'asset_payment', label: t.financeReview.assetPayment }, { value: 'debt_payment', label: t.financeReview.debtPayment }, { value: 'branch_funding', label: t.financeReview.ownerBranchFunding }]} categories={[{ value: 'unclassified', label: t.financeReview.unclassifiedMovement }, ...(categories.data?.categories ?? []).map(category => ({ value: category.id, label: category.nameAr }))]} statuses={[{ value: 'active', label: t.financeReview.activeStatus }, { value: 'corrected', label: t.financeReview.corrected }]} /><p className="mb-3 text-body">{t.financeReview.resultCount}: <bdi>{matched.length}</bdi> · {t.financeReview.filteredTotals}</p><p className="mb-3">{t.financeReview.filteredPaymentTotals}: <bdi><Money value={matchingTotals.SYP_NEW} currency="SYP_NEW" /> · <Money value={matchingTotals.USD} currency="USD" /></bdi></p><p className="mb-3 text-label text-ink-muted">{t.financeReview.ownerFilteredDetailsHint}</p><Button variant="ghost" disabled={!matched.length} onClick={() => downloadFinanceRows(matched, filters, 'owner-payments')}>{t.financeReview.export}</Button><Table head={[t.companyFinance.date, t.companyFinance.kind, t.accounts.branch, t.companyFinance.description, { label: t.companyFinance.amount, numeric: true }]} isEmpty={!matched.length} empty={t.financeReview.emptyOwner}>{matched.slice(page * 10, page * 10 + 10).map(({ payment }) => <tr key={`${payment.kind}:${payment.id}`}><td className="whitespace-nowrap px-3 py-2"><bdi>{payment.metadata?.occurredPrecision === 'month' ? payment.metadata.occurredMonth : payment.occurredOn}</bdi></td><td className="px-3 py-2">{payment.kind === 'branch_funding' ? t.financeReview.ownerBranchFunding : payment.kind === 'asset_payment' ? t.financeReview.assetPayment : payment.kind === 'debt_payment' ? t.financeReview.debtPayment : t.companyFinance.historicalKinds.expense}</td><td className="px-3 py-2">{payment.branchNameAr ?? '—'}</td><td className="px-3 py-2"><p className="line-clamp-2">{payment.description || '—'}</p><details><summary className="cursor-pointer text-label text-brand">{t.audit.details}</summary><p className="mt-2 break-words text-body">{payment.description || '—'}</p></details></td><td className="px-3 py-2"><bdi><Money value={payment.amount} currency={payment.currency} /></bdi></td></tr>)}</Table><FinancePagination page={page} total={matched.length} pageSize={10} onChange={setPage} /></div> : null}
      {data.branchFundingTotals ? <div className="mt-4 border-t border-line pt-4"><p className="mb-2 font-semibold">{t.financeReview.ownerBranchFunding}</p><p className="mb-3 text-label text-ink-muted">{t.financeReview.ownerAllHistoryHint} <bdi>{today}</bdi> · {t.financeReview.ownerBranchFundingHint}</p><p><Money value={data.branchFundingTotals.SYP_NEW} currency="SYP_NEW" /> · <Money value={data.branchFundingTotals.USD} currency="USD" /></p></div> : null}
    </>}
  </Card>
}


type ReviewLeg = { sourceEntryId: number; amount: string; direction: string; fundCode: string; proposedAmount?: string; confirmedAmount?: string | null }
type Review = { id: string; branchId: string; branchNameAr?: string; reviewEnabled?: boolean; businessDate: string; status: string; version: number; legs: ReviewLeg[]; confirmedLegs?: Array<{ sourceEntryId: number; amount: string }>; revisions?: Array<{ id: string; kind: string; reason: string; version: number }> }
type HistoricalRestoration = { restorationId: number; branchId: string; branchNameAr?: string; businessDate: string; netToCompany: string; status: 'unlinked_legacy'; activationRequired: boolean; reason: string }
type LinkedRestoration = { sourceReference: string; restorationId: number; branchId: string; branchNameAr?: string; journalEntryId: number; occurredOn: string; amount: string | null; currency: Currency; status: 'linked_historical'; description: string }
type AdoptionPreview = { restorationId: number; branchId: string; businessDate: string; evidenceHash: string; companyCashEffect: string; branchCashEffect: string; legs: ReviewLeg[] }

function HistoricalRestorationAdoption({ restoration, mutate, onSaved, onClose }: { restoration: HistoricalRestoration; mutate: Mutate; onSaved: () => void; onClose: () => void }): ReactNode {
  const { t } = useApp(), r = t.financeReview
  const preview = useResource<AdoptionPreview>(`/company/restoration-reviews/adoption-preview/${restoration.restorationId}`, 0)
  return <FinanceDialog title={r.prepareHistoricalRestoration} onClose={onClose}><p className="mb-3">{restoration.branchNameAr ?? r.unknown} · <bdi>{restoration.businessDate}</bdi></p><p className="mb-3 text-body text-ink-muted">{r.adoptionHint}</p>{!preview.data ? <Pending error={preview.error} loadingLabel={t.common.loading} errorLabel={explainError(preview.error, t)} onRetry={preview.load} retryLabel={t.common.retry} /> : <><Table head={[t.companyFinance.kind, t.companyFinance.amount]} isEmpty={!preview.data.legs.length} empty={r.emptyReviews}>{preview.data.legs.map(leg => <tr key={leg.sourceEntryId}><td className="px-3 py-2">{leg.fundCode === 'office_wallet' ? t.treasury.wallet : t.treasury.cashBox} · {leg.direction === 'to_company' ? r.toCompany : r.fromCompany}</td><td className="px-3 py-2"><bdi><Money value={leg.amount} currency="SYP_NEW" /></bdi></td></tr>)}</Table><FinanceActionForm path="/company/restoration-reviews/adopt" storageScope={String(restoration.restorationId)} title={r.prepareHistoricalRestoration} fields={[{ key: 'reason', label: t.companyFinance.reason }]} mutate={mutate} build={values => ({ restorationId: restoration.restorationId, evidenceHash: preview.data!.evidenceHash, reason: values.reason })} onSaved={() => { onSaved(); onClose() }} preview={values => <><p>{r.adoptionHint}</p><p>{r.cashImpact}: <Money value={preview.data!.companyCashEffect} currency="SYP_NEW" /></p><p>{r.branchUnchanged}: <Money value={preview.data!.branchCashEffect} currency="SYP_NEW" /></p><p>{values.reason}</p></>} /></>}</FinanceDialog>
}

export function RestorationReviewPanel({ mutate, branchId, revision: externalRevision = 0, focusId, focusHistoricalId, onFocusClose }: { mutate: Mutate; branchId?: string | undefined; revision?: number; focusId?: string | undefined; focusHistoricalId?: number | undefined; onFocusClose?: () => void }): ReactNode {
  const { t, branches, lang } = useApp(), r = t.financeReview
  const [revision, setRevision] = useState(0), [selected, setSelected] = useState<string | null>(null), [mode, setMode] = useState<'confirm' | 'revise' | 'defer'>('confirm'), [adopting, setAdopting] = useState<HistoricalRestoration | null>(null)
  const [status, setStatus] = useState('pending'), [from, setFrom] = useState(''), [to, setTo] = useState('')
  const feed = useResource<{ enabled?: boolean; branches?: Array<{ branchId: string; reviewEnabled: boolean }>; proposals?: Review[]; reviews?: Review[]; linkedHistorical?: LinkedRestoration[]; unlinkedHistorical?: HistoricalRestoration[]; legacy?: Array<{ id: string; branchId: string; journalEntryId: number; amount: string; direction: string }> }>('/company/restoration-reviews', revision + externalRevision)
  const reviews = feed.data?.proposals ?? feed.data?.reviews ?? [], review = reviews.find(item => item.id === selected)
  const focusOpened = useRef(false)
  useEffect(() => {
    if (!feed.data || focusOpened.current || !onFocusClose) return
    if (focusId) { const item = reviews.find(row => row.id === focusId); if (item) { setSelected(item.id); setMode(item.status === 'confirmed' ? 'revise' : 'confirm'); focusOpened.current = true } }
    if (focusHistoricalId) { const item = feed.data.unlinkedHistorical?.find(row => row.restorationId === focusHistoricalId); if (item) { setAdopting(item); focusOpened.current = true } }
  }, [feed.data, focusId, focusHistoricalId, onFocusClose, reviews])
  const closeFocused = (): void => { setSelected(null); onFocusClose?.() }
  const branchReviewEnabled = (id: string): boolean => feed.data?.branches?.find(item => item.branchId === id)?.reviewEnabled ?? feed.data?.enabled !== false
  const selectedReviewEnabled = review ? review.reviewEnabled ?? branchReviewEnabled(review.branchId) : false
  const branchName = (id: string): string => { const branch = branches.find(item => item.id === id); return branch ? lang === 'ar' ? branch.nameAr : branch.nameEn : r.unknown }
  const legLabel = (leg: ReviewLeg): string => `${leg.fundCode === 'office_wallet' ? t.treasury.wallet : t.treasury.cashBox} · ${leg.direction === 'to_company' ? r.toCompany : r.fromCompany}`
  const filtered = reviews.filter(item => (!branchId || item.branchId === branchId) && (!from || item.businessDate >= from) && (!to || item.businessDate <= to) && (status === 'all' || status === 'pending' ? status === 'all' || item.status !== 'confirmed' : item.status === status)).sort((a, b) => b.businessDate.localeCompare(a.businessDate))
  const historical = (feed.data?.unlinkedHistorical ?? []).filter(item => (!branchId || item.branchId === branchId) && (!from || item.businessDate >= from) && (!to || item.businessDate <= to)).sort((a, b) => b.businessDate.localeCompare(a.businessDate))
  const linked = (feed.data?.linkedHistorical ?? []).filter(item => (!branchId || item.branchId === branchId) && (!from || item.occurredOn >= from) && (!to || item.occurredOn <= to))
  const refresh = (): void => setRevision(value => value + 1)
  return <>{onFocusClose && !focusOpened.current ? <div><Pending error={feed.error ?? (feed.data ? 'error' : null)} loadingLabel={t.common.loading} errorLabel={explainError(feed.error ?? 'error', t)} onRetry={feed.load} retryLabel={t.common.retry} /><Button variant="ghost" onClick={onFocusClose}>{t.common.cancel}</Button></div> : null}<div className={onFocusClose ? 'hidden' : ''}><Card title={r.pendingRestorations} subtitle={r.restorationHint}>
    <CompanyHistoricalRestorationMatching branchId={branchId} revision={revision + externalRevision} mutate={mutate} onSaved={refresh} />
    {!feed.data ? <Pending error={feed.error} loadingLabel={t.common.loading} errorLabel={explainError(feed.error, t)} onRetry={feed.load} retryLabel={t.common.retry} /> : <>
      {feed.data.enabled === false ? <p className="mb-3 rounded-lg border border-warning-line bg-warning-surface p-3 text-warning-ink">{r.reviewDisabled}</p> : null}
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3"><Field label={t.accounts.status}><Select value={status} onChange={event => setStatus(event.target.value)} aria-label={t.accounts.status}><option value="pending">{r.pending}</option><option value="confirmed">{r.confirmed}</option><option value="deferred">{r.deferred}</option><option value="all">{r.allStatuses}</option></Select></Field><Field label={t.companyFinance.from}><TextInput type="date" value={from} onChange={event => setFrom(event.target.value)} aria-label={t.companyFinance.from} /></Field><Field label={t.companyFinance.to}><TextInput type="date" value={to} onChange={event => setTo(event.target.value)} aria-label={t.companyFinance.to} /></Field></div>
      {from && to && from > to ? <p role="alert" className="text-danger-ink">{t.companyFinance.historicalInvalid}</p> : <Table head={[t.companyFinance.date, t.accounts.branch, r.companySourceAmount, t.accounts.status, t.companyFinance.action]} isEmpty={!filtered.length} empty={r.emptyReviews}>{filtered.map(item => <tr key={item.id}><td className="whitespace-nowrap px-3 py-2"><bdi>{item.businessDate}</bdi></td><td className="px-3 py-2">{item.branchNameAr ?? branchName(item.branchId)}</td><td className="px-3 py-2">{item.legs.map(leg => <p key={leg.sourceEntryId}>{leg.direction === 'to_company' ? r.toCompany : r.fromCompany}: <bdi><Money value={leg.amount} currency="SYP_NEW" /></bdi></p>)}</td><td className="px-3 py-2">{item.status === 'confirmed' ? r.confirmed : item.status === 'deferred' ? r.deferred : r.pending}</td><td className="px-3 py-2"><Button variant="ghost" type="button" onClick={() => { setSelected(item.id); setMode(item.status === 'confirmed' ? 'revise' : 'confirm') }}>{r.reviewAction}</Button></td></tr>)}</Table>}
      {historical.length ? <div className="mt-5 border-t border-line pt-4"><h3 className="mb-2 font-semibold">{r.unlinkedRestorations}: <bdi>{historical.length}</bdi></h3><p className="mb-3 text-body text-ink-muted">{r.adoptionHint}</p><Table head={[t.companyFinance.date, t.accounts.branch, t.companyFinance.amount, t.accounts.status, t.companyFinance.action]} isEmpty={false} empty={r.emptyReviews}>{historical.map(item => <tr key={item.restorationId}><td className="whitespace-nowrap px-3 py-2"><bdi>{item.businessDate}</bdi></td><td className="px-3 py-2">{item.branchNameAr ?? branchName(item.branchId)}</td><td className="px-3 py-2"><bdi><Money value={item.netToCompany} currency="SYP_NEW" /></bdi></td><td className="px-3 py-2">{item.activationRequired ? r.branchNotLinked : r.unlinkedRestorations}</td><td className="px-3 py-2"><Button variant="ghost" disabled={!branchReviewEnabled(item.branchId) || item.activationRequired} onClick={() => setAdopting(item)}>{r.prepareHistoricalRestoration}</Button></td></tr>)}</Table></div> : null}
      {linked.length ? <details className="mt-4"><summary className="cursor-pointer text-brand">{r.linkedRestorations}: <bdi>{linked.length}</bdi></summary><p className="my-3 text-body text-ink-muted">{r.linkedRestorationsHint}</p><Table head={[t.companyFinance.date, t.accounts.branch, t.companyFinance.amount, t.companyFinance.description]} isEmpty={false} empty={r.emptyReviews}>{linked.map(item => <tr key={`${item.sourceReference}:${item.restorationId}`}><td className="whitespace-nowrap px-3 py-2"><bdi>{item.occurredOn}</bdi></td><td className="px-3 py-2">{item.branchNameAr ?? branchName(item.branchId)}</td><td className="px-3 py-2">{item.amount === null ? r.unavailable : <bdi><Money value={item.amount} currency={item.currency} /></bdi>}</td><td className="px-3 py-2"><p className="line-clamp-2">{item.description}</p><details><summary className="cursor-pointer text-label text-brand">{t.audit.details}</summary><p className="break-words">{item.description}</p><p><bdi>{item.sourceReference}</bdi> · <bdi>{item.journalEntryId}</bdi></p></details></td></tr>)}</Table></details> : null}
    </>}
    {adopting ? <HistoricalRestorationAdoption restoration={adopting} mutate={mutate} onSaved={refresh} onClose={() => { setAdopting(null); onFocusClose?.() }} /> : null}
    {review ? <FinanceDialog title={r.reviewAction} onClose={closeFocused}><p className="mb-3">{review.branchNameAr ?? branchName(review.branchId)} · <bdi>{review.businessDate}</bdi></p><p className="mb-4 text-body text-ink-muted">{r.restorationHint}</p><Table head={[t.companyFinance.kind, r.companySourceAmount, r.companyConfirmedAmount, r.difference]} isEmpty={!review.legs.length} empty={r.emptyReviews}>{review.legs.map(leg => { const proposed = review.confirmedLegs?.find(l => l.sourceEntryId === leg.sourceEntryId)?.amount ?? leg.proposedAmount ?? leg.amount; const diff = formatMinor(minor(parseMinor(leg.amount) - parseMinor(proposed))); return <tr key={leg.sourceEntryId}><td className="px-3 py-2">{legLabel(leg)}</td><td className="px-3 py-2"><bdi><Money value={leg.amount} currency="SYP_NEW" /></bdi></td><td className="px-3 py-2"><bdi><Money value={proposed} currency="SYP_NEW" /></bdi></td><td className="px-3 py-2"><bdi><Money value={diff} currency="SYP_NEW" /></bdi></td></tr> })}</Table>
      {!selectedReviewEnabled ? <p className="my-4 text-warning-ink">{r.reviewDisabled}</p> : <><div className="my-4 flex flex-wrap gap-2">{review.status !== 'confirmed' ? <Button variant={mode === 'confirm' ? 'primary' : 'ghost'} onClick={() => setMode('confirm')}>{r.approveAmount}</Button> : null}<Button variant={mode === 'revise' ? 'primary' : 'ghost'} onClick={() => setMode('revise')}>{r.editReviewAmount}</Button>{review.status !== 'confirmed' ? <Button variant={mode === 'defer' ? 'primary' : 'ghost'} onClick={() => setMode('defer')}>{r.defer}</Button> : null}</div>
      <FinanceActionForm key={`${review.id}:${review.version}:${mode}`} storageScope={`${review.id}:${review.version}:${mode}`} path={`/company/restoration-reviews/${review.id}/${mode === 'revise' && review.status === 'confirmed' ? 'correct' : mode === 'defer' ? 'defer' : 'confirm'}`} title={mode === 'revise' ? review.status === 'confirmed' ? r.confirmCorrection : r.editReviewAmount : mode === 'defer' ? r.defer : r.approveAmount} fields={[...(mode === 'revise' ? review.legs.map(leg => ({ key: String(leg.sourceEntryId), label: `${r.companyConfirmedAmount} · ${legLabel(leg)}`, type: 'money' as const, value: review.confirmedLegs?.find(l => l.sourceEntryId === leg.sourceEntryId)?.amount ?? leg.proposedAmount ?? leg.amount })) : []), { key: 'reason', label: t.companyFinance.reason }]} mutate={mutate} onSaved={() => { closeFocused(); refresh() }} build={values => ({ expectedVersion: review.version, ...(mode === 'revise' ? { confirmedLegs: review.legs.map(leg => ({ sourceEntryId: leg.sourceEntryId, amount: values[String(leg.sourceEntryId)] })) } : {}), reason: values.reason })} preview={values => <><p>{r.restorationHint}</p>{mode !== 'defer' ? review.legs.map(leg => { const proposed = mode === 'revise' ? values[String(leg.sourceEntryId)] ?? '0.00' : review.confirmedLegs?.find(l => l.sourceEntryId === leg.sourceEntryId)?.amount ?? leg.proposedAmount ?? leg.amount; const previous = review.status === 'confirmed' ? leg.confirmedAmount ?? review.confirmedLegs?.find(item => item.sourceEntryId === leg.sourceEntryId)?.amount ?? '0.00' : '0.00'; const signed = formatMinor(minor((parseMinor(proposed) - parseMinor(previous)) * (leg.direction === 'to_company' ? 1n : -1n))); return <p key={leg.sourceEntryId}>{legLabel(leg)} · {r.cashImpact}: <bdi><Money value={signed} currency="SYP_NEW" /></bdi> · {r.difference}: <bdi><Money value={formatMinor(minor(parseMinor(leg.amount) - parseMinor(proposed)))} currency="SYP_NEW" /></bdi></p> }) : null}<p>{values.reason}</p></>} /></>}
      {review.revisions?.length ? <details className="mt-4"><summary className="cursor-pointer text-brand">{r.correctionHistory}</summary>{review.revisions.map(item => <p key={item.id} className="my-2 text-body">{item.reason}</p>)}</details> : null}
    </FinanceDialog> : null}
    {feed.data?.legacy?.length ? <details className="mt-4"><summary className="cursor-pointer text-brand">{r.legacy_posted}</summary><Table head={[t.accounts.branch, t.companyFinance.amount, t.accounts.status]} isEmpty={false} empty={r.emptyReviews}>{feed.data.legacy.filter(item => !branchId || item.branchId === branchId).map(item => <tr key={item.id}><td className="px-3 py-2">{branchName(item.branchId)}</td><td className="px-3 py-2"><bdi><Money value={item.amount} currency="SYP_NEW" /></bdi></td><td className="px-3 py-2">{r.legacy_posted}</td></tr>)}</Table></details> : null}
  </Card></div></>
}
type ReviewExpense = {
  amount: string; currency: Currency; paidFrom: string; description: string; occurredOn: string; categoryId: string
  sypMinorPerUsd?: string | null; occurredPrecision?: 'day' | 'month'; occurredMonth?: string | null
  rateBasis?: 'documented' | 'estimated' | null; receiptReference?: string | null
}
type ExpenseCorrection = { id: string; targetId: string; targetVersion: number; version: number; reason: string; values: ReviewExpense; blockingReasons: string[]; status: string; financial: boolean }
type CorrectionImpact = { pockets: Record<Currency, string>; reserves: Record<Currency, string>; custody: Record<Currency, string>; ownerPayments: Record<Currency, string> }

/** Exact preview reconstructed for an existing server draft, not a ledger write. */
export function correctionCashPreview(before: ReviewExpense, after: ReviewExpense): CorrectionImpact {
  const values = { pockets: { SYP_NEW: 0n, USD: 0n }, reserves: { SYP_NEW: 0n, USD: 0n }, custody: { SYP_NEW: 0n, USD: 0n }, ownerPayments: { SYP_NEW: 0n, USD: 0n } }
  for (const [expense, reversing] of [[before, true], [after, false]] as const) {
    const amount = parseMinor(expense.amount)
    if (expense.paidFrom === 'owner_outside') values.ownerPayments[expense.currency] += reversing ? -amount : amount
    else values[expense.paidFrom === 'owner_custody' ? 'custody' : expense.paidFrom === 'reserve' ? 'reserves' : 'pockets'][expense.currency] += reversing ? amount : -amount
  }
  return Object.fromEntries(Object.entries(values).map(([key, amounts]) => [key, { SYP_NEW: formatMinor(minor(amounts.SYP_NEW)), USD: formatMinor(minor(amounts.USD)) }])) as CorrectionImpact
}

export function ExpenseCorrectionDrafts({ revision, onReview }: { revision: number; onReview: (targetId: string) => void }): ReactNode {
  const { t } = useApp(), r = t.financeReview
  const feed = useResource<{ corrections: ExpenseCorrection[] }>('/company/movement-corrections', revision)
  const drafts = feed.data?.corrections.filter(row => row.status === 'draft') ?? []
  return <Card title={r.correctionDrafts}>{!feed.data ? <Pending error={feed.error} loadingLabel={t.common.loading} errorLabel={explainError(feed.error, t)} onRetry={feed.load} retryLabel={t.common.retry} /> : <Table head={[t.companyFinance.description, t.companyFinance.amount, t.companyFinance.action]} isEmpty={!drafts.length} empty={r.noCorrectionDrafts}>{drafts.map(draft => <tr key={draft.id}><td className="px-3 py-2">{draft.values.description}</td><td className="px-3 py-2"><Money value={draft.values.amount} currency={draft.values.currency} /></td><td className="px-3 py-2"><Button variant="ghost" onClick={() => onReview(draft.targetId)}>{r.review}</Button></td></tr>)}</Table>}</Card>
}

export function ExpenseCorrectionPanel({ targetId, mutate, categories = [] }: { targetId: string; mutate: Mutate; onClose?: () => void; categories?: Array<{ id: string; nameAr: string; active: boolean }> }): ReactNode {
  const { t } = useApp(), r = t.financeReview
  const [revision, setRevision] = useState(0), [request, setRequest] = useState<ExpenseCorrection | null>(null), [acknowledged, setAcknowledged] = useState(false)
  const [requestImpact, setRequestImpact] = useState<CorrectionImpact | null>(null)
  const feed = useResource<{ effective: ReviewExpense; version: number; corrections: ExpenseCorrection[] }>(`/company/movements/${encodeURIComponent(targetId)}/review`, revision)
  useEffect(() => {
    if (!feed.data) return
    const draft = [...feed.data.corrections].reverse().find(item => item.status === 'draft' && item.targetVersion === feed.data!.version) ?? null
    setRequest(draft); setAcknowledged(false)
    setRequestImpact(draft ? correctionCashPreview(feed.data.effective, draft.values) : null)
  }, [feed.data])
  if (!feed.data) return <Pending error={feed.error} loadingLabel={t.common.loading} errorLabel={explainError(feed.error, t)} onRetry={feed.load} retryLabel={t.common.retry} />
  const current = feed.data.effective, proposal = request?.values ?? current
  const sourceLabel = (value: string): string => value === 'owner_custody' ? t.financeWorkspace.ownerCustody : value === 'owner_outside' ? t.companyFinance.ownerOutside : value === 'reserve' ? t.companyFinance.reserve : t.companyFinance.pocket
  const fields: FormField[] = [
    { key: 'amount', label: r.after, value: proposal.amount, type: 'money' },
    { key: 'currency', label: t.companyFinance.currency, value: proposal.currency, options: [{ value: 'SYP_NEW', label: t.currency.SYP_NEW }, { value: 'USD', label: t.currency.USD }] },
    { key: 'paidFrom', label: r.source, value: proposal.paidFrom, options: [{ value: 'pocket', label: t.companyFinance.pocket }, { value: 'owner_outside', label: t.companyFinance.ownerOutside }, { value: 'reserve', label: t.companyFinance.reserve }, { value: 'owner_custody', label: t.financeWorkspace.ownerCustody }] },
    { key: 'description', label: t.companyFinance.description, value: proposal.description },
    ...(proposal.occurredPrecision === 'month' ? [{ key: 'occurredMonth', label: r.occurredMonth, type: 'month' as const, value: proposal.occurredMonth ?? proposal.occurredOn.slice(0, 7) }] : [{ key: 'occurredOn', label: t.companyFinance.occurredOn, type: 'date' as const, value: proposal.occurredOn }]),
    ...(categories.length ? [{ key: 'categoryId', label: t.expenses.category, value: proposal.categoryId, options: [{ value: '', label: '—' }, ...categories.filter(category => category.active || category.id === proposal.categoryId).map(category => ({ value: category.id, label: category.nameAr }))] }] : []),
    { key: 'historicalRate', label: t.companyFinance.historicalRate, type: 'money', visibleWhen: { key: 'currency', value: 'USD' }, optional: true, value: proposal.sypMinorPerUsd ? formatMinor(minor(BigInt(proposal.sypMinorPerUsd))) : '' },
    { key: 'rateBasis', label: r.rateBasis, visibleWhen: { key: 'currency', value: 'USD' }, value: proposal.rateBasis ?? 'estimated', options: [{ value: 'documented', label: r.documented }, { value: 'estimated', label: r.estimated }] },
    { key: 'receiptReference', label: r.optionalReceipt, advanced: true, optional: true, value: proposal.receiptReference ?? '' },
    { key: 'reason', label: t.companyFinance.reason, value: request?.reason ?? '' },
  ]
  const refresh = (): void => setRevision(value => value + 1)
  return <div><p className="text-body text-ink-muted">{r.correctionHint}</p><p className="mt-2 text-body text-ink-muted">{r.paymentLinksChangeHint}</p>
    <p className="my-3">{r.before}: <Money value={current.amount} currency={current.currency} /> · {sourceLabel(current.paidFrom)}</p>
    <FinanceActionForm key={`${targetId}:${feed.data.version}:${request?.id ?? 'new'}:${request?.version ?? 0}`} storageScope={`${targetId}:${feed.data.version}:${request?.version ?? 0}`} path={request ? `/company/movement-corrections/${request.id}` : '/company/movement-corrections'} method={request ? 'patch' : 'post'} title={r.saveDraft} fields={fields} onSaved={refresh} mutate={async (operation, success, attempt) => mutate(async () => { const result = await operation() as { correction: ExpenseCorrection; impact?: CorrectionImpact }; setRequest(result.correction); setRequestImpact(result.impact ?? correctionCashPreview(current, result.correction.values)); setAcknowledged(false); return result }, success, attempt)} build={values => ({ ...(request ? { expectedVersion: request.version } : { targetId, expectedVersion: feed.data!.version }), reason: values.reason, values: { amount: values.amount, currency: values.currency, paidFrom: values.paidFrom, description: values.description, ...(proposal.occurredPrecision === 'month' ? { occurredOn: `${values.occurredMonth}-01`, occurredPrecision: 'month', occurredMonth: values.occurredMonth } : { occurredOn: values.occurredOn }), ...(values.categoryId ? { categoryId: values.categoryId } : {}), ...(values.currency === 'USD' && values.historicalRate ? { historicalRate: values.historicalRate, rateBasis: values.rateBasis } : {}), receiptReference: values.receiptReference || null } })} />
    {request ? <div className="mt-4 rounded-lg border border-warning-line bg-warning-surface p-3 text-warning-ink"><p>{r.after}: <Money value={request.values.amount} currency={request.values.currency} /> · {sourceLabel(request.values.paidFrom)}</p><p>{request.values.description}</p><p>{request.reason}</p><p>{r.correctionHint}</p>{requestImpact ? <div className="my-3">{(['pockets', 'reserves', 'custody', 'ownerPayments'] as const).map(key => <p key={key}>{key === 'pockets' ? t.companyFinance.pocket : key === 'reserves' ? t.companyFinance.reserve : key === 'custody' ? t.financeWorkspace.ownerCustody : t.companyFinance.ownerOutside}: <Money value={requestImpact[key].SYP_NEW} currency="SYP_NEW" /> · <Money value={requestImpact[key].USD} currency="USD" /></p>)}</div> : null}{request.blockingReasons.length ? <p role="alert">{r.blocked}</p> : <><label className="my-3 flex gap-2"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>{r.acknowledgeCash}</span></label>{acknowledged ? <FinanceActionForm key={`${request.id}:${request.version}:confirm`} path={`/company/movement-corrections/${request.id}/confirm`} title={r.confirmCorrection} fields={[]} mutate={mutate} build={() => ({ expectedVersion: request.version, acknowledgeCashEffect: true })} onSaved={() => { setRequest(null); setRequestImpact(null); setAcknowledged(false); refresh() }} preview={() => <><p>{r.correctionHint}</p><p>{request.reason}</p><Money value={request.values.amount} currency={request.values.currency} /></>} /> : null}</>}</div> : null}
    {feed.data.corrections.length ? <details className="mt-4"><summary className="cursor-pointer text-brand">{r.correctionHistory}</summary><Table head={[t.accounts.status, t.companyFinance.reason, t.companyFinance.amount]} isEmpty={false} empty={r.noCorrectionDrafts}>{feed.data.corrections.map(item => <tr key={item.id}><td className="px-3 py-2">{item.status === 'confirmed' ? r.confirmed : r.draft}</td><td className="px-3 py-2">{item.reason}</td><td className="px-3 py-2"><Money value={item.values.amount} currency={item.values.currency} /></td></tr>)}</Table></details> : null}
  </div>
}
