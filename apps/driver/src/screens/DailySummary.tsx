import { useEffect, useRef, useState, type ReactNode } from 'react'
import { compareDailySummary, suggestDailySummaryDate, type CloseDraftAttachment, type CloseDraftView, type DraftOrder, type EvidenceUploadResponse } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { PhotoSlot } from './PhotoSlot.tsx'
import { Card } from '../ui.tsx'

export function DailySummary({ shiftId, businessDate, attachment, revision, date, orders, onDraft, onRead, onDate }: {
  shiftId: string
  businessDate: string
  attachment: CloseDraftAttachment | null
  revision: number | null
  date: string | null
  orders: readonly DraftOrder[]
  onDraft(draft: CloseDraftView): void
  onRead(upload?: EvidenceUploadResponse, retry?: boolean): Promise<unknown>
  onDate(date: string | null, attachmentToken: string): Promise<void>
}): ReactNode {
  const { api, t } = useApp()
  const copy = t.dailySummary
  const [localDate, setLocalDate] = useState(date ?? '')
  const [dateError, setDateError] = useState(false)
  const [dateSaving, setDateSaving] = useState(false)
  const [readError, setReadError] = useState<'save' | 'read' | null>(null)
  const [reading, setReading] = useState(false)
  const readAttempt = useRef({id: 0, token: attachment?.attachmentToken ?? null})
  const live = useRef(true)
  useEffect(() => {live.current = true; return () => {live.current = false; readAttempt.current.id++}}, [])
  useEffect(() => { setLocalDate(date ?? ''); setDateError(false) }, [date, attachment?.attachmentToken])
  useEffect(() => {
    const token = attachment?.attachmentToken ?? null
    if (readAttempt.current.token === token) return
    readAttempt.current = {id: readAttempt.current.id + 1, token}
    setReadError(null); setReading(false); setDateSaving(false)
  }, [attachment?.attachmentToken])
  const read = attachment?.read
  const runRead = async (upload?: EvidenceUploadResponse, retry = false) => {
    const attempt = {id: readAttempt.current.id + 1, token: upload?.attachmentToken ?? attachment?.attachmentToken ?? null}
    readAttempt.current = attempt
    const owns = () => live.current && readAttempt.current.id === attempt.id
    setReadError(null)
    setReading(true)
    try {
      const result = await onRead(upload, retry)
      if (owns() && result === null) setReadError('read')
    } catch (error) {
      if (owns()) setReadError((error as {error?: string}).error === 'daily_summary_save_failed' ? 'save' : 'read')
    } finally { if (owns()) setReading(false) }
  }
  const saveDate = async () => {
    const token = attachment?.attachmentToken
    if (!token) return
    setDateSaving(true)
    setDateError(false)
    try { await onDate(localDate || null, token) }
    catch { if (live.current && readAttempt.current.token === token) setDateError(true) }
    finally { if (live.current && readAttempt.current.token === token) setDateSaving(false) }
  }
  const [metrics, setMetrics] = useState<Awaited<ReturnType<typeof api.closeReference>>['shiftMetrics']>(undefined)
  useEffect(() => {
    let live = true
    if (!attachment) {setMetrics(undefined);return () => {live = false}}
    void api.closeReference(shiftId, true).then(reference => {if (live) setMetrics(reference.shiftMetrics)}, () => {if (live) setMetrics(undefined)})
    return () => {live = false}
  }, [api, shiftId, attachment?.attachmentToken, read?.readId])
  const comparisonOrders = orders.map(order => ({included: order.included !== false, fee: /^\d+(?:\.\d{1,2})?$/.test(order.feeText) ? order.feeText : null, occurredDate: order.dateText ?? null}))
  const datePending = localDate !== (date ?? '') || dateSaving || dateError
  const comparison = compareDailySummary(read?.fields ?? {}, datePending ? null : date, comparisonOrders)
  const suggested = suggestDailySummaryDate(comparisonOrders, businessDate)
  const statusText = comparison.status === 'date_required' ? copy.dateRequired : comparison.status === 'incomplete' ? copy.incomplete
    : comparison.status === 'partial' ? copy.calendarSubset : comparison.status === 'match' ? copy.matched : copy.different
  return <Card className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">{copy.title}</h3><span className="text-xs text-ink-muted">{copy.optional}</span></div>
    <p className="text-sm text-ink-secondary">{copy.optionalHint}</p>
    <PhotoSlot shiftId={shiftId} pkg="end" slot="daily_summary" label={copy.title}
      attachment={attachment} closeDraftRevision={revision} onCloseDraft={onDraft}
      onUploaded={() => {}} recognitionQuality
      onImage={async (_file, upload) => { await runRead(upload) }}
      onRetryRead={async () => { await runRead(undefined, true) }} />
    {attachment ? <>
      {readError ? <p role="alert" className="rounded-lg bg-warning-surface p-3 text-sm text-warning-ink">{readError === 'save' ? copy.saveFailed : copy.readFailed}</p> : null}
      <label className="flex flex-col gap-1 text-sm">{copy.photoDate}<input type="date" value={localDate}
        disabled={dateSaving}
        className="min-h-12 min-w-0 rounded-lg border border-line bg-surface-card p-2" onChange={(event) => setLocalDate(event.target.value)} /></label>
      {suggested && !localDate ? <div className="flex flex-wrap items-center gap-2 text-sm"><span>{copy.suggestedDate} · <b dir="ltr">{suggested}</b></span><button type="button" disabled={dateSaving} className="min-h-11 rounded-lg border border-line px-3 text-brand" onClick={() => setLocalDate(suggested)}>{copy.useSuggestedDate}</button></div> : null}
      <button type="button" disabled={!datePending || dateSaving} onClick={() => {void saveDate()}} className="min-h-12 rounded-lg bg-brand px-3 text-sm font-bold text-on-brand disabled:opacity-40">{dateSaving ? t.common.loading : copy.confirmDate}</button>
      {datePending && !dateError ? <p role="status" className="text-sm text-warning-ink">{copy.datePending}</p> : null}
      {dateError ? <p role="status" className="text-sm text-warning-ink">{copy.dateSaveFailed}</p> : null}
      {read?.status === 'complete' && !reading ? <>
        <p role="status" className="text-sm font-bold text-success-ink">{copy.saved}</p>
        <p role="status" className={`rounded-lg p-3 text-sm ${comparison.status === 'match' ? 'bg-success-surface text-success-ink' : 'bg-warning-surface text-warning-ink'}`}>{statusText}</p>
        <table className="w-full table-fixed text-xs"><thead><tr>{['',copy.imageColumn,copy.ordersColumn,copy.differenceColumn].map(label => <th key={label} className="break-words border-b border-line p-1.5 text-start font-medium">{label}</th>)}</tr></thead><tbody>
          {[[copy.gross,comparison.grossTotal,comparison.orderTotal,comparison.difference],[copy.trips,comparison.trips,comparison.orderCount,comparison.countDifference]].map(([label,image,recorded,difference]) => <tr key={String(label)}><th className="break-words border-b border-line p-1.5 text-start font-medium">{label}</th>{[image,recorded,difference].map((value,index) => <td key={index} dir="ltr" className="break-words border-b border-line p-1.5 text-start font-bold">{value ?? '—'}</td>)}</tr>)}
        </tbody></table>
        <p className="text-xs text-ink-muted">{copy.blueHint}</p>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          {[[copy.blue, comparison.blueTotal], [copy.distance, comparison.distanceKm], [copy.minutes, comparison.onlineMinutes], [copy.odometerDistance, metrics?.distanceKm], [copy.shiftMinutes, metrics?.durationMinutes], [copy.outsideOrders, comparison.outsideOrderCount], [copy.undatedOrders, comparison.undatedOrderCount]].map(([label, value]) => <div key={String(label)}><dt className="text-ink-muted">{label}</dt><dd className="font-bold" dir="ltr">{value ?? '—'}</dd></div>)}
        </dl>
        <p className="text-xs text-ink-muted">{copy.metricsHint}</p>
      </> : <p className="text-sm text-ink-secondary" role="status">{reading || read?.status === 'running' ? copy.reading : read?.status === 'failed' ? copy.unreadable : copy.awaitingRead}</p>}
      <p className="text-xs text-ink-muted">{copy.coverage}</p>
    </> : null}
    <p className="text-sm font-medium text-brand">{copy.nonblocking}</p>
  </Card>
}
