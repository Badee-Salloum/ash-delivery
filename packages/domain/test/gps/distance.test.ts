import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type GeoPoint, distanceMetres } from '../../src/geo/haversine.ts'
import { pathLengthMetres } from '../../src/gps/distance.ts'

/**
 * The length of a recorded GPS path. It is a plain sum of great-circle hops between consecutive
 * fixes, so the rules that matter are the boring ones: fewer than two points has no length, the
 * length never goes down when you add a point, it reads the same forwards or backwards, and a path
 * cut at a shared point is the sum of its parts.
 */

const p = (lat: number, lng: number): GeoPoint => ({ lat, lng })

describe('pathLengthMetres — worked cases', () => {
  it('has no length below two points', () => {
    expect(pathLengthMetres([])).toBe(0)
    expect(pathLengthMetres([p(33.5, 36.3)])).toBe(0)
  })

  it('is exactly the single hop for two points', () => {
    const a = p(33.5138, 36.2765)
    const b = p(33.52, 36.28)
    expect(pathLengthMetres([a, b])).toBe(distanceMetres(a, b))
  })

  it('measures a small north–south hop', () => {
    // 0.001° of latitude ≈ EARTH_RADIUS · (0.001 · π/180) ≈ 111.19 m.
    expect(pathLengthMetres([p(33.5, 36.3), p(33.501, 36.3)])).toBeCloseTo(111.19, 1)
  })

  it('sums consecutive hops', () => {
    const pts = [p(33.500, 36.300), p(33.501, 36.300), p(33.502, 36.300)]
    expect(pathLengthMetres(pts)).toBeCloseTo(distanceMetres(pts[0]!, pts[1]!) + distanceMetres(pts[1]!, pts[2]!), 6)
  })

  it('is additive along a meridian: three collinear points equal the end-to-end distance', () => {
    const pts = [p(33.50, 36.30), p(33.55, 36.30), p(33.60, 36.30)]
    // Along a single meridian the great-circle path is the straight run, so the hops add up to it.
    expect(pathLengthMetres(pts)).toBeCloseTo(distanceMetres(pts[0]!, pts[2]!), 3)
  })
})

// ── Properties ───────────────────────────────────────────────────────────────────────────────

// Coordinates near Damascus, kept off the poles and the ±180 seam so the tests read plainly.
const pointArb = fc.record({
  lat: fc.double({ min: 30, max: 36, noNaN: true }),
  lng: fc.double({ min: 33, max: 39, noNaN: true }),
})
const pathArb = fc.array(pointArb, { maxLength: 16 })

describe('pathLengthMetres — properties', () => {
  it('is never negative', () => {
    fc.assert(
      fc.property(pathArb, (pts) => {
        expect(pathLengthMetres(pts)).toBeGreaterThanOrEqual(0)
      }),
    )
  })

  it('is zero for fewer than two points', () => {
    fc.assert(
      fc.property(pointArb, (pt) => {
        expect(pathLengthMetres([pt])).toBe(0)
      }),
    )
  })

  it('reads the same forwards and backwards', () => {
    // The same hops summed in the opposite order — equal but for the last bit of floating point.
    fc.assert(
      fc.property(pathArb, (pts) => {
        expect(pathLengthMetres([...pts].reverse())).toBeCloseTo(pathLengthMetres(pts), 3)
      }),
    )
  })

  it('never shrinks when a point is appended', () => {
    fc.assert(
      fc.property(pathArb, pointArb, (pts, extra) => {
        expect(pathLengthMetres([...pts, extra])).toBeGreaterThanOrEqual(pathLengthMetres(pts))
      }),
    )
  })

  it('a path cut at a shared point is the sum of its parts', () => {
    fc.assert(
      fc.property(pathArb, pathArb, pointArb, (head, tail, join) => {
        const whole = pathLengthMetres([...head, join, ...tail])
        const parts = pathLengthMetres([...head, join]) + pathLengthMetres([join, ...tail])
        expect(whole).toBeCloseTo(parts, 3)
      }),
    )
  })
})
