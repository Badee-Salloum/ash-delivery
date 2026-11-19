import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { parseMinor, type Currency } from '@ash/domain'
import { formatBusinessDate } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { pendingAfterAttempt, pendingMoneyMove, uncertainMoneyMoveOutcome, type PendingMoneyMove } from '../money-move-idempotency.ts'
import { Button, Field, Money, Pending, Select, Stat, Table, TextInput } from '../ui.tsx'
import { FinanceDialog, useResource } from './CompanyFinanceReview.tsx'
import type { Mutate } from './CompanyFund.tsx'

type Amounts = Record<Currency, string>
export type HistoricalMatchingGroup = {
  restorationId: number; businessDate: string; branchEntryIds: number[]; sourceReferences: string[]; hqEntryIds: number[]
  branchNet: string; companyNet: string; variance: string
  sources: Array<{ sourceReference: string; occurredOn: string; description: string; journalEntryId: number; amount: string; direction: 'to_company' | 'from_company'; linkStatus: string; linkNote: string | null }>
}
export type HistoricalMatchingPreview = {
  branchId: string; companyBranchId: string; version: number; evidenceHash: string; eligible: boolean; blockingReasons: string[]
  counts: { sourceCount: number; hqJournalCount: number; branchSourceCount: number; groupCount: number }
  totals: { currency: 'SYP_NEW'; hqNet: string; branchNet: string; amountDifference: string }
  groups: HistoricalMatchingGroup[]
  plan: { before: { historicalTransit: string; clearing: string; matchingDifference: string }; after: { historicalTransit: string; clearing: string; matchingDifference: string } }
  impacts: { companyCash: Amounts; branchCash: Amounts; pnl: Amounts }
  settlements: Array<{ id: string; version: number; businessDate: string; reason: string; groupCount: number; sourceCount: number; createdAtMs: number }>
  unlinkedHistoricalCount: number
}
export type HistoricalMatchingPayload = { branchId: string; evidenceHash: string; expectedVersion: number; reason: string; reviewedLinks: true }
type Attempt = { request: PendingMoneyMove; payload: HistoricalMatchingPayload; preview: HistoricalMatchingPreview; uncertain: boolean }
type Draft = { reason: string; acknowledgedHash: string | null; attempt: Attempt | null }

/** An incomplete impact proof is unavailable, never silently treated as zero. */
export function historicalMatchingIsNeutral(preview: Pick<HistoricalMatchingPreview, 'impacts'>): boolean {
  try { return (['companyCash', 'branchCash', 'pnl'] as const).every(effect => (['SYP_NEW', 'USD'] as const).every(currency => typeof preview.impacts?.[effect]?.[currency] === 'string' && parseMinor(preview.impacts[effect][currency]) === 0n)) } catch { return false }
}
export function historicalMatchingHasMultipleLinks(group: HistoricalMatchingGroup): boolean {
  return new Set(group.sourceReferences).size > 1 || new Set(group.hqEntryIds).size > 1 || new Set(group.branchEntryIds).size > 1
}
const historicalLinkLabels = {
  probable_amount_date: 'historicalLinkProbable',
  confirmed_by_user: 'historicalLinkConfirmed',
  confirmed_by_user_branch_payment: 'historicalLinkConfirmedBranchPayment',
  confirmed_by_user_posted_later: 'historicalLinkConfirmedPostedLater',
  exact_amount_date: 'historicalLinkExact',
  exact_amount_near_date: 'historicalLinkNearDate',
} as const
export function historicalMatchingLinkLabelKey(status: string): typeof historicalLinkLabels[keyof typeof historicalLinkLabels] | 'historicalLinkUnknown' {
  return Object.hasOwn(historicalLinkLabels, status) ? historicalLinkLabels[status as keyof typeof historicalLinkLabels] : 'historicalLinkUnknown'
}
function readDraft(key: string, branchId: string): Draft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Draft | null
    if (!saved || typeof saved.reason !== 'string') return { reason: '', acknowledgedHash: null, attempt: null }
    const attempt = saved.attempt
    if (attempt && (attempt.payload?.branchId !== branchId || !attempt.request?.idempotencyKey || !attempt.request?.fingerprint || !attempt.preview?.evidenceHash)) return { reason: saved.reason, acknowledgedHash: null, attempt: null }
    return saved
  } catch { return { reason: '', acknowledgedHash: null, attempt: null } }
}
function storeDraft(key: string, draft: Draft | null): void { try { if (draft) sessionStorage.setItem(key, JSON.stringify(draft)); else sessionStorage.removeItem(key) } catch { /* The mounted form still preserves its exact request. */ } }

function MatchingDate({ value }: { value: string }): ReactNode {
  const { lang } = useApp()
  return <time dateTime={value} title={value}>{formatBusinessDate(value, lang)}</time>
}
function ImpactMoney({ value, currency }: { value: string | undefined; currency: Currency }): ReactNode {
  const { t } = useApp()
  try { if (typeof value === 'string') { parseMinor(value); return <Money value={value} currency={currency} /> } } catch { /* Missing or malformed proof is not a zero impact. */ }
  return <span>{t.financeReview.unavailable}</span>
}

export function CompanyHistoricalRestorationMatching({ branchId, revision, mutate, onSaved }: { branchId?: string | undefined; revision: number; mutate: Mutate; onSaved: () => void }): ReactNode {
  const { t, branches, branchId: activeBranchId, lang } = useApp(), r = t.financeReview
  const fallback = branchId ?? (branches.some(branch => branch.id === activeBranchId) ? activeBranchId : branches[0]?.id) ?? ''
  const [selectedBranch, setSelectedBranch] = useState(fallback)
  useEffect(() => setSelectedBranch(fallback), [branchId, activeBranchId, fallback])
  return <section aria-label={r.historicalMatching} className="mt-5 border-t border-line pt-4"><h3 className="mb-2 font-semibold">{r.historicalMatching}</h3><p className="mb-3 text-body text-ink-muted">{r.historicalMatchingHint}</p><Field label={t.accounts.branch}><Select value={selectedBranch} aria-label={r.historicalMatchingBranch} onChange={event => setSelectedBranch(event.target.value)}>{branches.map(branch => <option key={branch.id} value={branch.id}>{lang === 'ar' ? branch.nameAr : branch.nameEn}</option>)}</Select></Field>{selectedBranch ? <MatchingScope key={selectedBranch} branchId={selectedBranch} revision={revision} mutate={mutate} onSaved={onSaved} /> : <p>{r.unavailable}</p>}</section>
}

function MatchingScope({ branchId, revision, mutate, onSaved }: { branchId: string; revision: number; mutate: Mutate; onSaved: () => void }): ReactNode {
  const { t } = useApp(), r = t.financeReview
  const feed = useResource<HistoricalMatchingPreview>(`/company/historical-restoration-settlements/preview?branchId=${encodeURIComponent(branchId)}`, revision)
  const [open, setOpen] = useState(false)
  const data = feed.data
  return <>{!data ? <Pending error={feed.error} loadingLabel={t.common.loading} errorLabel={explainError(feed.error, t)} onRetry={feed.load} retryLabel={t.common.retry} /> : <><div className="my-3 grid grid-cols-1 gap-3 sm:grid-cols-3"><Stat label={r.historicalSourcesCount} value={<bdi>{data.counts.sourceCount}</bdi>} /><Stat label={r.historicalHqEntriesCount} value={<bdi>{data.counts.hqJournalCount}</bdi>} /><Stat label={r.historicalBranchEntriesCount} value={<bdi>{data.counts.branchSourceCount}</bdi>} /></div><NetComparison data={data} /><p className="my-3 text-label text-ink-muted">{r.historicalUnitsHint}</p><p className="mb-3 text-body">{r.historicalDifferenceRemains} · {r.unlinkedRestorations}: <bdi>{data.unlinkedHistoricalCount}</bdi></p><Button variant="ghost" onClick={() => setOpen(true)}>{r.counterpartCorrectionReview}</Button>{data.settlements.length ? <details className="mt-3"><summary className="cursor-pointer text-brand">{r.correctionHistory}</summary>{data.settlements.map(settlement => <div key={settlement.id} className="mt-3 rounded-lg border border-line p-3"><p><MatchingDate value={settlement.businessDate} /> · {r.version}: <bdi>{settlement.version}</bdi></p><p className="break-words">{settlement.reason}</p><p>{r.historicalSourcesCount}: <bdi>{settlement.sourceCount}</bdi></p><p className="text-label text-ink-muted"><bdi>{settlement.id}</bdi></p></div>)}</details> : null}</>}{open ? <FinanceDialog title={r.counterpartCorrectionReview} onClose={() => setOpen(false)}>{data ? <MatchingConfirmation key={branchId} data={data} mutate={mutate} onReload={feed.load} onSaved={() => { setOpen(false); onSaved() }} /> : <Pending error={feed.error} loadingLabel={t.common.loading} errorLabel={explainError(feed.error, t)} onRetry={feed.load} retryLabel={t.common.retry} />}</FinanceDialog> : null}</>
}

function NetComparison({ data }: { data: HistoricalMatchingPreview }): ReactNode {
  const { t } = useApp(), r = t.financeReview
  return <dl className="grid grid-cols-1 gap-3 rounded-lg border border-line p-3 sm:grid-cols-3">{[{ label: r.historicalHqNet, value: data.totals.hqNet }, { label: r.historicalBranchNet, value: data.totals.branchNet }, { label: r.historicalAmountDifference, value: data.totals.amountDifference }].map(item => <div key={item.label}><dt className="text-label text-ink-muted">{item.label}</dt><dd className="mt-1 font-semibold"><Money value={item.value} currency={data.totals.currency} /></dd></div>)}</dl>
}

function MatchingConfirmation({ data, mutate, onReload, onSaved }: { data: HistoricalMatchingPreview; mutate: Mutate; onReload: () => void; onSaved: () => void }): ReactNode {
  const { api, t, session } = useApp(), r = t.financeReview
  const key = `ash.historical-counterpart-review:${session?.userId ?? ''}:${data.branchId}`
  const [draft, setDraft] = useState(() => readDraft(key, data.branchId)), [sending, setSending] = useState(false), [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const uncertain = draft.attempt?.uncertain === true, shown = uncertain ? draft.attempt!.preview : data
  const acknowledged = uncertain || draft.acknowledgedHash === data.evidenceHash, neutral = historicalMatchingIsNeutral(shown)
  const update = (next: Draft): void => { storeDraft(key, next); setDraft(next) }
  useEffect(() => { if (!uncertain && draft.acknowledgedHash && draft.acknowledgedHash !== data.evidenceHash) update({ ...draft, acknowledgedHash: null }) }, [data.evidenceHash])
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setError(null)
    if (!uncertain && (!data.eligible || !acknowledged || !draft.reason.trim() || !neutral)) { setError('historical_settlement_review_required'); return }
    const payload: HistoricalMatchingPayload = uncertain ? draft.attempt!.payload : { branchId: data.branchId, expectedVersion: data.version, evidenceHash: data.evidenceHash, reason: draft.reason.trim(), reviewedLinks: true }
    const request = pendingMoneyMove(draft.attempt?.request ?? null, { command: '/company/historical-restoration-settlements', branchId: payload.branchId, amount: '', reason: payload.reason, details: payload })
    const attempt: Attempt = { request, payload, preview: shown, uncertain: true }
    const submitted = { reason: payload.reason, acknowledgedHash: payload.evidenceHash, attempt }
    update(submitted); setSending(true)
    try {
      const saved = await mutate(() => api.post('/company/historical-restoration-settlements', { ...payload, idempotencyKey: request.idempotencyKey }), r.historicalCorrectionDone, outcome => {
        const held = pendingAfterAttempt(request, outcome)
        const next = outcome.ok ? null : { ...submitted, attempt: held ? { ...attempt, request: held, uncertain: uncertainMoneyMoveOutcome(outcome) } : null }
        storeDraft(key, next)
        if (!mounted.current) return
        if (next) setDraft(next)
        if (!outcome.ok) {
          setError(outcome.error ?? 'error')
          if (['historical_settlement_source_changed', 'historical_settlement_version_conflict'].includes(outcome.error ?? '')) onReload()
        }
      })
      if (saved && mounted.current) { storeDraft(key, null); onSaved() }
    } finally { if (mounted.current) setSending(false) }
  }
  const ids = (values: Array<string | number>): ReactNode => values.length ? values.map(value => <bdi key={value} className="inline-block break-all me-2">{value}</bdi>) : '—'
  return <div className="flex flex-col gap-4"><p className="text-body text-ink-muted">{r.counterpartNeutralHint}</p><NetComparison data={shown} /><p>{r.historicalDifferenceRemains}</p><Table head={[t.companyFinance.kind, r.counterpartBefore, r.counterpartAfter]} isEmpty={false} empty={r.unavailable}>{(['historicalTransit', 'clearing', 'matchingDifference'] as const).map(account => <tr key={account}><td className="px-3 py-2">{account === 'historicalTransit' ? r.historicalTransitAccount : account === 'clearing' ? r.historicalClearingAccount : r.totalBookDifference}</td><td className="px-3 py-2"><Money value={shown.plan.before[account]} currency={shown.totals.currency} /></td><td className="px-3 py-2"><Money value={shown.plan.after[account]} currency={shown.totals.currency} /></td></tr>)}</Table><dl className={`grid grid-cols-1 gap-3 rounded-lg border p-3 sm:grid-cols-3 ${neutral ? 'border-success-line bg-success-surface' : 'border-warning-line bg-warning-surface'}`}>{(['companyCash', 'branchCash', 'pnl'] as const).map(effect => <div key={effect}><dt className="text-label">{effect === 'companyCash' ? r.companyCashEffect : effect === 'branchCash' ? r.branchCashEffect : r.pnlEffect}</dt><dd className="mt-1"><ImpactMoney value={shown.impacts?.[effect]?.SYP_NEW} currency="SYP_NEW" /> · <ImpactMoney value={shown.impacts?.[effect]?.USD} currency="USD" /></dd></div>)}</dl>{!neutral ? <p role="alert" className="text-danger-ink">{r.historicalCorrectionBlocked}</p> : null}<div><h3 className="mb-2 font-semibold">{r.historicalLinksDetails}</h3>{shown.groups.map(group => <details key={group.restorationId} className="mb-3 rounded-lg border border-line p-3"><summary className="cursor-pointer text-brand"><MatchingDate value={group.businessDate} /> · {historicalMatchingHasMultipleLinks(group) ? r.historicalMultipleMapping : r.historicalSingleMapping}</summary><dl className="my-3 grid grid-cols-1 gap-3 sm:grid-cols-2"><div><dt>{r.historicalRestorationIds}</dt><dd>{ids([group.restorationId])}</dd></div><div><dt>{r.historicalSourceReferences}</dt><dd>{ids(group.sourceReferences)}</dd></div><div><dt>{r.historicalHqEntries}</dt><dd>{ids(group.hqEntryIds)}</dd></div><div><dt>{r.historicalBranchEntries}</dt><dd>{ids(group.branchEntryIds)}</dd></div><div><dt>{r.historicalHqNet}</dt><dd><Money value={group.companyNet} currency={shown.totals.currency} /></dd></div><div><dt>{r.historicalBranchNet}</dt><dd><Money value={group.branchNet} currency={shown.totals.currency} /></dd></div><div><dt>{r.historicalAmountDifference}</dt><dd><Money value={group.variance} currency={shown.totals.currency} /></dd></div></dl>{group.sources.map(source => <article key={`${source.sourceReference}:${source.journalEntryId}`} className="my-3 rounded-lg border border-line p-3"><p><MatchingDate value={source.occurredOn} /> · {source.direction === 'to_company' ? r.toCompany : r.fromCompany} · <Money value={source.amount} currency={shown.totals.currency} /></p><p className="my-2 break-words">{source.description}</p><p className="text-label"><bdi>{source.sourceReference}</bdi> · <bdi>{source.journalEntryId}</bdi></p><p className="mt-2 text-label">{r.historicalLinkStatus}: {r[historicalMatchingLinkLabelKey(source.linkStatus)]}</p>{historicalMatchingLinkLabelKey(source.linkStatus) === 'historicalLinkUnknown' ? <details className="mt-2 text-label"><summary className="cursor-pointer text-brand">{r.historicalLinkTechnicalCode}</summary><bdi className="break-all">{source.linkStatus}</bdi></details> : null}{source.linkNote ? <p className="text-label">{source.linkNote}</p> : null}</article>)}</details>)}</div>{!data.eligible && !uncertain ? <div className="rounded-lg border border-warning-line bg-warning-surface p-3 text-warning-ink"><p>{r.historicalCorrectionBlocked}</p>{data.blockingReasons.map(code => <p key={code} className="mt-2 text-body">{explainError(code, t)}</p>)}</div> : null}<form onSubmit={event => void submit(event)} className="flex flex-col gap-3"><Field label={t.companyFinance.reason}><TextInput required maxLength={500} value={draft.reason} aria-label={t.companyFinance.reason} disabled={sending || uncertain} onChange={event => update({ ...draft, reason: event.target.value })} /></Field><label className="flex gap-2"><input type="checkbox" checked={acknowledged} disabled={sending || uncertain || !data.eligible || !neutral} onChange={event => update({ ...draft, acknowledgedHash: event.target.checked ? data.evidenceHash : null })} /><span>{r.reviewedHistoricalLinks}</span></label>{uncertain ? <p role="status" className="text-warning-ink">{r.unknownAttempt}</p> : null}{error ? <p role="alert" className="text-danger-ink">{explainError(error, t)}</p> : null}<Button type="submit" disabled={sending || (!uncertain && (!data.eligible || !acknowledged || !draft.reason.trim() || !neutral))}>{uncertain ? r.retryCounterpartCorrection : r.counterpartCorrectionConfirm}</Button></form></div>
}
