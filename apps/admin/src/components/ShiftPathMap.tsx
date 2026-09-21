import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { type GpsPathView, formatDateTimeSeconds } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { explainError } from '../errors.ts'
import { leafletPathPaints } from '../map-theme.ts'
import { Badge, Card } from '../ui.tsx'

/**
 * One shift's recorded GPS trail (SRS K), with a path segment per order by printed time.
 *
 * The split is best-effort: an order carries only a minute-precision printed clock that is often
 * illegible, so a segment is where the driver probably was between one order and the next — never
 * proof. The full trail is drawn muted; selecting an order highlights its own stretch. Start and end
 * are marked so direction reads at a glance. Uses Leaflet directly, like the live map, and reads its
 * paints from the semantic tokens so it is never a light-mode island.
 */

const DAMASCUS: [number, number] = [33.5138, 36.2765]

export function ShiftPathMap({ shiftId, hideWhenEmpty = false }: { shiftId: string; hideWhenEmpty?: boolean }): ReactNode {
  const { api, t, lang, theme } = useApp()
  const [view, setView] = useState<GpsPathView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const mapDiv = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)

  const load = useCallback(() => {
    setError(null)
    void api
      .getShiftGpsPath(shiftId)
      .then(setView)
      .catch((e: { error?: string }) => setError(e.error ?? 'error'))
  }, [api, shiftId])

  useEffect(() => {
    load()
  }, [load])

  // The map div is always in the DOM, so the container is real when this runs.
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

  // Redraw whenever the data, the selection or the theme changes.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    layer.clearLayers()
    if (!view || view.pings.length === 0) return
    const paints = leafletPathPaints()
    const points: [number, number][] = view.pings.map((p) => [p.lat, p.lng])

    // The whole trail, muted.
    L.polyline(points, { color: paints.path, weight: 3, opacity: 0.65 }).addTo(layer)

    // The selected order's own stretch, drawn bright and on top.
    const seg = selected === null ? null : view.segments.find((s) => s.orderId === selected)
    if (seg && seg.pingEndIndex > seg.pingStartIndex) {
      const slice = points.slice(seg.pingStartIndex, seg.pingEndIndex)
      L.polyline(slice, { color: paints.segment, weight: 6, opacity: 0.95 }).addTo(layer)
      const head = slice[0]
      if (head) L.circleMarker(head, { radius: 6, color: paints.segment, fillColor: paints.segment, fillOpacity: 1, weight: 2 }).addTo(layer)
    }

    // Start (green) and end (red), so a route reads its direction.
    const first = points[0]
    const last = points[points.length - 1]
    if (first) L.circleMarker(first, { radius: 7, color: paints.start, fillColor: paints.start, fillOpacity: 1, weight: 2 }).addTo(layer)
    if (last) L.circleMarker(last, { radius: 7, color: paints.end, fillColor: paints.end, fillOpacity: 1, weight: 2 }).addTo(layer)

    if (mapRef.current) mapRef.current.fitBounds(L.latLngBounds(points).pad(0.3), { maxZoom: 16 })
  }, [view, selected, theme])

  const orderLabel = useCallback(
    (providerOrderNo: string, minute: string | null): string =>
      minute ? `${providerOrderNo} · ${minute}` : providerOrderNo,
    [],
  )

  const trackerPings = view ? view.pings.filter((p) => p.source === 'tracker').length : 0

  // In an embedded surface (the review overlay) a shift with no recorded trail should show nothing
  // rather than an empty map card. The standalone screens pass the message through instead.
  if (hideWhenEmpty && error === null && (view === null || view.pings.length === 0)) return null

  return (
    <div className="flex flex-col gap-4">
      <Card title={t.shiftPath.title}>
        {error ? <p className="mb-2 text-sm text-danger-ink">{explainError(error, t)}</p> : null}
        <div ref={mapDiv} className="h-[55vh] w-full rounded-lg" />
        {view && view.pings.length === 0 ? <p className="mt-2 text-sm text-ink-muted">{t.shiftPath.empty}</p> : null}
        {trackerPings > 0 ? (
          <p className="mt-2 text-xs text-ink-muted">
            <Badge tone="slate">{t.shiftPath.sourceTracker}</Badge> {t.shiftPath.mixedSources}
          </p>
        ) : null}
      </Card>

      {view && view.pings.length > 0 ? (
        <Card title={t.shiftPath.ordersTitle}>
          <ul className="flex flex-col gap-1 text-sm">
            <li>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="w-full text-start"
                aria-pressed={selected === null}
              >
                {t.shiftPath.wholeTrail} · {t.shiftPath.points.replace('{n}', String(view.pings.length))}
              </button>
            </li>
            <li className="flex items-center gap-2 border-t border-line-subtle py-1 text-ink-muted">
              {t.shiftPath.beforeFirst}
              <span className="num ms-auto" dir="ltr">
                {view.beforeFirst.pingEndIndex - view.beforeFirst.pingStartIndex}
              </span>
            </li>
            {view.segments.map((s) => {
              const count = s.pingEndIndex - s.pingStartIndex
              return (
                <li key={s.orderId} className="border-t border-line-subtle">
                  <button
                    type="button"
                    onClick={() => setSelected(s.orderId === selected ? null : s.orderId)}
                    className="flex w-full items-center gap-2 py-1 text-start"
                    aria-pressed={selected === s.orderId}
                  >
                    <span className={selected === s.orderId ? 'font-semibold' : ''}>
                      {orderLabel(s.providerOrderNo, s.minuteKey.slice(11))}
                    </span>
                    {count === 0 ? <Badge tone="slate">{t.shiftPath.noSegment}</Badge> : null}
                    <span className="num ms-auto" dir="ltr">
                      {count}
                    </span>
                  </button>
                </li>
              )
            })}
            <li className="flex items-center gap-2 border-t border-line-subtle py-1 text-ink-muted">
              {t.shiftPath.afterClose}
              <span className="num ms-auto" dir="ltr">
                {view.afterClose.pingEndIndex - view.afterClose.pingStartIndex}
              </span>
            </li>
            {view.untimedOrderIds.length > 0 ? (
              <li className="border-t border-line-subtle py-1 text-ink-muted">
                {t.shiftPath.untimed.replace('{n}', String(view.untimedOrderIds.length))}
              </li>
            ) : null}
          </ul>
          {view.pings.length > 0 ? (
            <p className="mt-2 text-xs text-ink-muted" dir="ltr">
              {formatDateTimeSeconds(view.pings[0]!.capturedAt, lang)} →{' '}
              {formatDateTimeSeconds(view.pings[view.pings.length - 1]!.capturedAt, lang)}
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  )
}
