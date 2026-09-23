/**
 * Great-circle geometry — a general geo primitive, not owned by any one feature.
 *
 * It lives in its own module because two unrelated features need it: attendance geofencing (is the
 * manager within his branch's radius?) and GPS path length (how far did this order's trail run?).
 * Putting it under either one would make the other depend on a feature it has nothing to do with.
 *
 * PURE: no clock, no I/O, no locale. Coordinates are plain `number` degrees — ASSUMPTIONS A-20: the
 * no-float rule is scoped to money, and `double precision` is legal for physical measurements.
 */

export interface GeoPoint {
  readonly lat: number
  readonly lng: number
}

const EARTH_RADIUS_METRES = 6_371_008.8
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than the flat-earth approximation: the error of treating degrees as a plane
 * grows with latitude, and a geofence is decided at its edge — precisely where an approximation
 * is least trustworthy. At Damascus's latitude a naive equirectangular fit is off by enough to
 * matter for a 150 m fence.
 */
export function distanceMetres(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.lat - a.lat)
  const dLng = toRadians(b.lng - a.lng)
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)))
}
