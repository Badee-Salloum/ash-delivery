/**
 * The length of a recorded GPS path, in metres.
 *
 * A companion to `sliceTrailByOrders`, which is timing-only and never sees coordinates: this is the
 * one place that turns a run of pings into a distance. The caller passes the ping slice for one
 * order's segment (or the whole trail) and gets the sum of the great-circle hops between consecutive
 * fixes — best-effort, exactly as the segmentation is: it measures the path the phone RECORDED, which
 * under-reads when fixes are sparse and over-reads when they scatter, and is never proof of an
 * odometer distance.
 *
 * PURE. Coordinates are plain `number` (ASSUMPTIONS A-20 — the no-float rule is money-only).
 */

import { type GeoPoint, distanceMetres } from '../geo/haversine.ts'

/** Sum of consecutive great-circle distances along the points, in metres. `0` for fewer than two. */
export function pathLengthMetres(points: readonly GeoPoint[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += distanceMetres(points[i - 1]!, points[i]!)
  }
  return total
}
