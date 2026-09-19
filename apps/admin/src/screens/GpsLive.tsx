import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { formatDateTimeSeconds, type GpsLiveDriver } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { type GpsFreshness, gpsAgeMinutes, gpsFreshness } from '../gps-freshness.ts'
import { leafletFreshnessPaints } from '../map-theme.ts'
import { Badge, Card } from '../ui.tsx'

/**
 * The live map (SRS K-2): the latest GPS fix per driver in the branch, polled every 10 s. A pin per
 * driver + a side list. Foreground-only tracking, so a driver with the app backgrounded goes stale
 * rather than moving — his last-seen time says so.
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
  const [names, setNames] = useState<Record<string, DriverLite>>({})
  const [error, setError] = useState<string | null>(null)

  const mapDiv = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)

  const load = useCallback(() => {
    setError(null)
    void api
      .gpsLive()
      .then((r) => setDrivers(r.drivers))
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
    </div>
  )
}
