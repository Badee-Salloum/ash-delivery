import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { formatDateTimeSeconds, formatGpsFailureReason, type GpsHealthCause, type GpsLiveDriver, type GpsLiveHealth, type GpsSilentShift } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { type GpsFreshness, gpsAgeMinutes, gpsFreshness } from '../gps-freshness.ts'
import { leafletFreshnessPaints } from '../map-theme.ts'
import { Badge, Card } from '../ui.tsx'

/**
 * The live map (SRS K-2): the latest GPS fix per driver in the branch, polled every 10 s. A pin per
 * driver + a side list. Freshness uses capture time, even when an offline batch arrives later.
 *
 * Uses Leaflet directly with `circleMarker` (a drawn circle, no image asset) to avoid the classic
 * bundler-vs-marker-icon problem entirely.
 */

interface DriverLite {
  id: string
  fullNameAr: string
  fullNameEn: string | null
}
const DAMASCUS: [number, number] = [33.5138, 36.2765]

/** Leaflet takes literal colours, so these cannot be theme tokens; they are the map's own ink. */
const MARKER_OPACITY: Record<GpsFreshness, number> = { fresh: 0.9, recent: 0.75, stale: 0.15 }
  // Hollow: still where he last was, which is worth seeing — but not where he is.
export function GpsLive(): ReactNode {
  const { api, t, lang, theme, branchId } = useApp()
  const [drivers, setDrivers] = useState<GpsLiveDriver[]>([])
  const [silent, setSilent] = useState<GpsSilentShift[]>([])
  const [health, setHealth] = useState<GpsLiveHealth[]>([])
  const [names, setNames] = useState<Record<string, DriverLite>>({})
  const [error, setError] = useState<string | null>(null)

  const mapDiv = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)

  const load = useCallback(() => {
    setError(null)
    void api
      .gpsLive()
      .then((r) => {
        setDrivers(r.drivers)
        setSilent(r.silent)
        setHealth(r.health ?? [])
      })
      .catch((e: { error?: string }) => setError(e.error ?? 'error'))
    void api
      .get<{ drivers: DriverLite[] }>('/drivers')
      .then((r) => setNames(Object.fromEntries(r.drivers.map((d) => [d.id, d]))))
      .catch(() => undefined)
  }, [api])

  useEffect(() => {
    load()
    const timer = setInterval(load, 10_000)
    return () => clearInterval(timer)
  }, [load, branchId])

  // Initialise the map once. The div is always in the DOM (no Pending gate), so this runs with a
  // real container.
  useEffect(() => {
    if (!mapDiv.current || mapRef.current) return
    const map = L.map(mapDiv.current).setView(DAMASCUS, 12)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
    }
  }, [])

  const driverName = useCallback(
    (id: string): string => {
      const d = names[id]
      if (!d) return id.slice(0, 8)
      return (lang === 'en' ? d.fullNameEn : null) ?? d.fullNameAr
    },
    [names, lang],
  )

  const causeLabel = (cause: GpsHealthCause): string => ({
    unknown: t.gpsLive.causeUnknown,
    permission: t.gpsLive.causePermission,
    location_disabled: t.gpsLive.causeLocationDisabled,
    service_stopped: t.gpsLive.causeServiceStopped,
    offline: t.gpsLive.causeOffline,
    capture_stopped: t.gpsLive.causeCaptureStopped,
    upload_stalled: t.gpsLive.causeUploadStalled,
    healthy: t.gpsLive.causeHealthy,
  })[cause]
  const healthByShift = new Map(health.map((item) => [item.shiftId, item]))
  const stamp = (value: number | null | undefined): string =>
    value == null ? '—' : formatDateTimeSeconds(new Date(value).toISOString(), lang)

  // Redraw the markers whenever the fixes change.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const paints = leafletFreshnessPaints()
    layer.clearLayers()
    const pts: [number, number][] = []
    for (const d of drivers) {
      const pt: [number, number] = [d.lat, d.lng]
      pts.push(pt)
      /*
       * The pin's colour IS its freshness, because a manager reads the map before he reads the
       * list. A stale fix is drawn hollow and grey: it is still where the driver last was, which is
       * worth seeing, but it must not look like where he is.
       */
      const age = gpsFreshness(Date.parse(d.capturedAt), Date.now())
      const paint = paints[age]
      L.circleMarker(pt, { radius: 8, weight: 2, fillOpacity: MARKER_OPACITY[age], color: paint.color, fillColor: paint.fillColor })
        .bindTooltip(driverName(d.driverId))
        .bindPopup(`${driverName(d.driverId)}<br>${formatDateTimeSeconds(d.capturedAt, lang)}`)
        .addTo(layer)
    }
    if (pts.length > 0 && mapRef.current) mapRef.current.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 15 })
  }, [drivers, driverName, lang, theme])

  return (
    <div className="flex flex-col gap-4">
      <Card title={t.gpsLive.title}>
        {error ? <p className="mb-2 text-sm text-red-600">{explainError(error, t)}</p> : null}
        <div ref={mapDiv} className="h-[60vh] w-full rounded-lg" />
      </Card>
      {silent.length > 0 ? (
        <Card title={t.gpsLive.silentTitle}>
          <p className="mb-2 text-sm text-ink-muted">{t.gpsLive.silentHint}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {silent.map((s) => (
              <li key={s.shiftId} className="flex flex-wrap items-center gap-2 border-b border-line-subtle py-1 last:border-0">
                <span className="font-medium">{driverName(s.driverId)}</span>
                <Badge tone="danger">{t.gpsLive.silentFor.replace('{n}', String(s.silentMinutes))}</Badge>
                <span className="text-ink-muted">{causeLabel(healthByShift.get(s.shiftId)?.cause ?? 'unknown')}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card title={t.gpsLive.drivers}>
        {drivers.length === 0 ? (
          <p className="py-6 text-center text-slate-600">{t.gpsLive.none}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {drivers.map((d) => (
              <li key={d.driverId} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1 last:border-0">
                <span className="font-medium">{driverName(d.driverId)}</span>
                <span className="num text-slate-500" dir="ltr">
                  {d.lat.toFixed(5)}, {d.lng.toFixed(5)}
                </span>
                {d.accuracyM !== null ? <Badge tone="slate">±{Math.round(d.accuracyM)}m</Badge> : null}
                <span className="num ms-auto text-xs text-slate-600" dir="ltr">
                  {formatDateTimeSeconds(d.capturedAt, lang)}
                </span>
                {Date.parse(d.receivedAt) - Date.parse(d.capturedAt) > 5 * 60_000 ? <Badge tone="warning">{t.gpsLive.lateUpload}</Badge> : null}
                {/* Named, not merely coloured: «قبل ٣٢ دقيقة» is the fact the old screen hid. */}
                {gpsFreshness(Date.parse(d.capturedAt), Date.now()) !== 'fresh' ? (
                  <Badge tone={gpsFreshness(Date.parse(d.capturedAt), Date.now()) === 'stale' ? 'danger' : 'warning'}>
                    {t.gpsLive.lastSeen.replace('{n}', String(gpsAgeMinutes(Date.parse(d.capturedAt), Date.now())))}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {health.length > 0 ? (
        <Card title={t.gpsLive.diagnosisTitle}>
          <ul className="flex flex-col gap-3 text-sm">
            {health.map((item) => {
              const lost = (item.droppedExpired ?? 0) + (item.droppedCapacity ?? 0) + (item.droppedStorage ?? 0)
              const reasons = Object.entries(item.rejectionReasons ?? {}).filter(([, count]) => count > 0)
              return (
                <li key={item.shiftId} className="border-b border-line-subtle pb-2 last:border-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{driverName(item.driverId)}</strong>
                    <Badge tone={item.cause === 'healthy' ? 'success' : item.cause === 'unknown' ? 'neutral' : 'warning'}>{causeLabel(item.cause)}</Badge>
                  </div>
                  <div className="mt-1 grid gap-x-4 gap-y-1 text-ink-muted sm:grid-cols-2">
                    <span>{t.gpsLive.lastCapture}: <span className="num">{stamp(item.lastCapturedAtMs)}</span></span>
                    <span>{t.gpsLive.lastUpload}: <span className="num">{stamp(item.lastUploadedAtMs)}</span></span>
                    <span>{t.gpsTracking.permission}: {item.permission === 'precise' ? t.gpsTracking.precise :
                      item.permission === 'approximate' ? t.gpsTracking.approximate :
                      item.permission === 'denied' ? t.gpsTracking.denied : t.gpsTracking.unknown}</span>
                    <span>{t.gpsTracking.service}: {item.service === 'running' ? t.gpsTracking.enabled :
                      item.service === 'stopped' ? t.gpsTracking.disabled : t.gpsTracking.unknown}</span>
                    <span>{t.gpsTracking.network}: {item.network === 'online' ? t.gpsTracking.online :
                      item.network === 'offline' ? t.gpsTracking.offline : t.gpsTracking.unknown}</span>
                    <span>{t.gpsLive.pending.replace('{n}', String(item.pendingCount ?? 0))}</span>
                    {lost > 0 ? <span className="text-danger-ink">{t.gpsLive.dropped.replace('{n}', String(lost))}</span> : null}
                    {(item.droppedStorage ?? 0) > 0 ? <span className="text-danger-ink">{t.gpsLive.lostStorage.replace('{n}', String(item.droppedStorage))}</span> : null}
                  </div>
                  {reasons.length > 0 ? (
                    <p className="mt-1 text-warning-ink">{t.gpsLive.rejected.replace('{reasons}', reasons.map(([reason, count]) => `${formatGpsFailureReason(reason, t.gpsTracking)}: ${count}`).join(' · '))}</p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}
