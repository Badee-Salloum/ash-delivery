import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { GpsLiveDriver } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
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

export function GpsLive(): ReactNode {
  const { api, t, lang, branchId } = useApp()
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
    layer.clearLayers()
    const pts: [number, number][] = []
    for (const d of drivers) {
      const pt: [number, number] = [d.lat, d.lng]
      pts.push(pt)
      L.circleMarker(pt, { radius: 8, color: '#1d4ed8', fillColor: '#3b82f6', fillOpacity: 0.9, weight: 2 })
        .bindTooltip(driverName(d.driverId))
        .bindPopup(`${driverName(d.driverId)}<br>${new Date(d.receivedAt).toLocaleTimeString()}`)
        .addTo(layer)
    }
    if (pts.length > 0 && mapRef.current) mapRef.current.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 15 })
  }, [drivers, driverName])

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
                <span className="num ms-auto text-xs text-slate-600">{new Date(d.receivedAt).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
