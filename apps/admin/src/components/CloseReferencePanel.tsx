import { formatDateTimeSeconds } from '@ash/client'
import { useEffect, useState, type ReactNode } from 'react'
import { compareDailySummary } from '@ash/client'
import { useApp } from '../app-context.tsx'

export function CloseReferencePanel({shiftId, orders, version}: {
  shiftId: string
  orders: readonly {included?: boolean; fee: string; occurredDate?: string | null}[]
  version: string
}): ReactNode {
  const {api, t, lang} = useApp()
  const copy = t.dailySummary
  const [reference, setReference] = useState<Awaited<ReturnType<typeof api.closeReference>> | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    let sequence = 0
    const load = async () => {
      const current = ++sequence
      try {const data = await api.closeReference(shiftId); if (live && current === sequence) {setReference(data); setFailed(false)}}
      catch {if (live && current === sequence) setFailed(true)}
    }
    setReference(null)
    void load()
    const timer = setInterval(() => {void load()}, 30_000)
    return () => {live = false; clearInterval(timer)}
  }, [api, shiftId, version])
  const summary = reference?.summary
  const comparison = compareDailySummary(summary?.read?.fields ?? {}, summary?.date ?? null, orders)
  const comparisonLabel = comparison.status === 'date_required' ? copy.dateRequired : comparison.status === 'incomplete' ? copy.incomplete
    : comparison.status === 'partial' ? copy.calendarSubset : comparison.status === 'match' ? copy.matched : copy.different
  return <section className="rounded-xl border border-line bg-surface-card p-4">
    <h3 className="font-bold">{copy.permissionsTitle}</h3>
    {failed ? <p role="status" className="text-sm text-warning-ink">{copy.permissionsUnavailable}</p> : null}
    {reference?.permissionEvents.map(event => <div key={event.id} className={`mt-2 rounded-lg p-3 text-sm ${event.recoveredAt ? 'bg-success-surface text-success-ink' : 'bg-warning-surface text-warning-ink'}`} role={event.recoveredAt ? 'status' : 'alert'}>
      <p className="font-bold">{event.recoveredAt ? copy.permissionRecovered : copy.permissionOpen} · {copy[event.permission]}</p>
      <p>{copy.receivedAt} · {formatDateTimeSeconds(event.openedAt, lang)}</p>
      {event.observedAt ? <p className="text-xs">{copy.observedAt} · {formatDateTimeSeconds(event.observedAt, lang)}</p> : null}
      {event.recoveredAt ? <p>{copy.permissionRecovered} · {formatDateTimeSeconds(event.recoveredAt, lang)}</p> : null}
    </div>)}
    <h3 className="mt-4 font-bold">{copy.title} · {copy.optional}</h3>
    {summary?.read?.status === 'complete' ? <>
      <p className="mt-2 text-sm font-bold text-success-ink">{copy.saved}</p>
      <p className="mt-1 text-xs text-ink-muted">{copy.photoDate} · {summary.date ?? '—'}</p>
      <p role="status" className={`mt-3 rounded-lg p-3 text-sm ${comparison.status === 'match' ? 'bg-success-surface text-success-ink' : 'bg-warning-surface text-warning-ink'}`}>{comparisonLabel}</p>
      <table className="mt-3 w-full table-fixed text-xs sm:text-sm"><thead><tr>{['',copy.imageColumn,copy.ordersColumn,copy.differenceColumn].map(label => <th key={label} className="break-words border-b border-line p-2 text-start font-medium">{label}</th>)}</tr></thead><tbody>
        {[[copy.gross,comparison.grossTotal,comparison.orderTotal,comparison.difference],[copy.trips,comparison.trips,comparison.orderCount,comparison.countDifference]].map(([label,image,recorded,difference]) => <tr key={String(label)}><th className="break-words border-b border-line p-2 text-start font-medium">{label}</th>{[image,recorded,difference].map((value,index) => <td key={index} dir="ltr" className="break-words border-b border-line p-2 text-start font-bold">{value ?? '—'}</td>)}</tr>)}
      </tbody></table>
      <p className="mt-2 text-xs text-ink-muted">{copy.blueHint}</p>
      <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
        {[[copy.blue, comparison.blueTotal], [copy.distance, comparison.distanceKm], [copy.minutes, comparison.onlineMinutes], [copy.odometerDistance, reference?.shiftMetrics?.distanceKm], [copy.shiftMinutes, reference?.shiftMetrics?.durationMinutes], [copy.outsideOrders, comparison.outsideOrderCount], [copy.undatedOrders, comparison.undatedOrderCount]].map(([label,value]) => <div key={String(label)}><dt className="text-ink-muted">{label}</dt><dd className="font-bold" dir="ltr">{value ?? '—'}</dd></div>)}
      </dl>
      <p className="mt-2 text-xs text-ink-muted">{copy.metricsHint}</p>
    </> : <p role="status" className="mt-2 text-sm text-ink-secondary">{summary?.read?.status === 'running' ? copy.reading : summary?.read?.status === 'failed' ? copy.unreadable : summary ? copy.awaitingRead : copy.notProvided}</p>}
    <p className="mt-2 text-xs text-ink-muted">{copy.coverage}</p>
    <p className="mt-2 text-sm text-brand">{copy.nonblocking}</p>
  </section>
}
