/** A display preference only: no driver fixes, trails or tracking settings are persisted here. */
export interface MapViewport { lat: number; lng: number; zoom: number }
export interface ViewportStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export function mapViewportKey(userId: string | null, branchId: string | null): string | null {
  return userId && branchId ? `ash.gpsLive.viewport.v1:${encodeURIComponent(userId)}:${encodeURIComponent(branchId)}` : null
}
export function validMapViewport(value: unknown): value is MapViewport {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<MapViewport>
  return typeof v.lat === 'number' && Number.isFinite(v.lat) && Math.abs(v.lat) <= 85.05112878 &&
    typeof v.lng === 'number' && Number.isFinite(v.lng) && Math.abs(v.lng) <= 180 &&
    typeof v.zoom === 'number' && Number.isFinite(v.zoom) && v.zoom >= 0 && v.zoom <= 19
}
export function readMapViewport(storage: ViewportStorage | null, key: string | null): MapViewport | null {
  if (!storage || !key) return null
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? 'null')
    if (!validMapViewport(value)) return null
    return { lat: value.lat, lng: value.lng, zoom: value.zoom }
  } catch { return null }
}
export function writeMapViewport(storage: ViewportStorage | null, key: string | null, view: MapViewport): boolean {
  if (!storage || !key) return false
  // Leaflet permits panning into a repeated world. Persist its equivalent longitude, not overflow.
  const normalized = { lat: view.lat, lng: Math.abs(view.lng) <= 180 ? view.lng : ((view.lng + 180) % 360 + 360) % 360 - 180, zoom: view.zoom }
  if (!validMapViewport(normalized)) return false
  try { storage.setItem(key, JSON.stringify(normalized)); return true } catch { return false }
}
export function browserViewportStorage(): ViewportStorage | null {
  try { return window.localStorage } catch { return null }
}
