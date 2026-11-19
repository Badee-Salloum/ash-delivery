import { formatDateTimeSeconds } from '@ash/client'
import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../app-context.tsx'
import { openNativeTrackingSettings } from '../native-tracker.ts'
import { Card } from '../ui.tsx'

export function PermissionHistory({shiftId}: {shiftId: string}): ReactNode {
  const {api, t, lang} = useApp()
  type Reference = Awaited<ReturnType<typeof api.closeReference>>
  const [events, setEvents] = useState<Reference['permissionEvents']>([])
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    let sequence = 0
    const load = async () => {
      const current = ++sequence
      try {
        const reference = await api.closeReference(shiftId, true)
        if (live && current === sequence) {setEvents(reference.permissionEvents); setFailed(false)}
      } catch { if (live && current === sequence) setFailed(true) }
    }
    setEvents([])
    void load()
    const timer = setInterval(() => {void load()}, 30_000)
    return () => {live = false; clearInterval(timer)}
  }, [api, shiftId])
  const copy = t.dailySummary
  return <Card className="flex flex-col gap-2">
    <h3 className="font-bold">{copy.permissionsTitle}</h3>
    {failed ? <p role="status" className="text-sm text-warning-ink">{copy.permissionsUnavailable}</p> : null}
    {events.length === 0 && !failed ? <p className="text-sm text-ink-secondary">{copy.permissionsEmpty}</p> : null}
    {events.map(event => <div key={event.id} role={event.recoveredAt ? 'status' : 'alert'} className={`rounded-lg p-3 text-sm ${event.recoveredAt ? 'bg-success-surface text-success-ink' : 'bg-warning-surface text-warning-ink'}`}>
      <p className="font-bold">{event.recoveredAt ? copy.permissionRecovered : copy.permissionOpen} · {copy[event.permission]}</p>
      <p>{copy.receivedAt} · {formatDateTimeSeconds(event.openedAt, lang)}</p>
      {event.recoveredAt ? <p>{copy.permissionRecovered} · {formatDateTimeSeconds(event.recoveredAt, lang)}</p> : <button type="button" className="mt-2 rounded-lg border border-warning-line bg-surface-card p-2" onClick={() => {void openNativeTrackingSettings(event.permission === 'location_enabled' ? 'location' : event.permission)}}>{t.gpsTracking.openTrackingSettings}</button>}
    </div>)}
  </Card>
}
