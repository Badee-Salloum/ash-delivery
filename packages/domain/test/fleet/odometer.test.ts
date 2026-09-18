import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_DISTANCE_TOTAL,
  type OdometerReading,
  addShiftDistance,
  odometerTimeline,
  shiftDistance,
  totalDistance,
} from '../../src/fleet/odometer.ts'

/**
 * «كم» per shift (P3). The fleet table sums these, so the two rules that matter are that a shift
 * with no trustworthy pair never contributes a kilometre, and that it is never silently lost either.
 */

describe('shiftDistance', () => {
  it('is the end reading minus the start reading', () => {
    expect(shiftDistance({ start: 1, end: 92 })).toEqual({ recorded: true, km: 91 })
    expect(shiftDistance({ start: 12_400, end: 12_400 })).toEqual({ recorded: true, km: 0 })
  })

  it('says «missing» when either reading is absent', () => {
    expect(shiftDistance({ start: null, end: 10 })).toEqual({ recorded: false, reason: 'missing' })
    expect(shiftDistance({ start: 10, end: null })).toEqual({ recorded: false, reason: 'missing' })
    expect(shiftDistance({ start: undefined, end: undefined })).toEqual({ recorded: false, reason: 'missing' })
  })

  it('never turns a backwards reading into negative kilometres', () => {
    // The P2 fixture: a reset odometer, 180 → 150.
    expect(shiftDistance({ start: 180, end: 150 })).toEqual({ recorded: false, reason: 'rollback' })
  })

  it('refuses a reading that is not a whole, non-negative, exact number', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(shiftDistance({ start: bad, end: 100 }), String(bad)).toEqual({ recorded: false, reason: 'missing' })
      expect(shiftDistance({ start: 0, end: bad }), String(bad)).toEqual({ recorded: false, reason: 'missing' })
    }
  })
})

describe('odometerTimeline', () => {
  it('separates driven shifts, unlogged gaps and rollbacks', () => {
    expect(odometerTimeline([
      { start: 100, end: 140 },
      { start: 150, end: 180 },
      { start: 170, end: 190 },
      { start: null, end: 220 },
    ])).toEqual({
      distance: { km: 90, recordedShifts: 3, unrecordedShifts: 1, missing: 1, rollbacks: 0 },
      unloggedKm: 10,
      boundaryRollbacks: 1,
      unknownBoundaries: 1,
    })
  })

  it('telescopes for every monotonic complete timeline', () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: 1, maxLength: 40 }),
      fc.integer({ min: 0, max: 10_000 }),
      (steps, first) => {
        let cursor = first
        const shifts = steps.map((step, index) => {
          const gap = index % 4
          const start = cursor + gap
          const end = start + step
          cursor = end
          return { start, end }
        })
        const timeline = odometerTimeline(shifts)
        expect(timeline.boundaryRollbacks).toBe(0)
        expect(timeline.unknownBoundaries).toBe(0)
        expect(timeline.distance.km + timeline.unloggedKm).toBe(
          shifts.at(-1)!.end - shifts[0]!.start,
        )
      },
    ))
  })
})

describe('totalDistance', () => {
  it('sums the recorded shifts and counts the others beside them', () => {
    expect(
      totalDistance([
        { start: 1, end: 92 },
        { start: 100, end: 180 },
        { start: 180, end: 150 },
        { start: null, end: null },
      ]),
    ).toEqual({ km: 171, recordedShifts: 2, unrecordedShifts: 2, missing: 1, rollbacks: 1 })
  })

  it('is empty for no shifts', () => {
    expect(totalDistance([])).toEqual(EMPTY_DISTANCE_TOTAL)
  })
})

const reading: fc.Arbitrary<OdometerReading> = fc.record({
  start: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: -50, max: -1 })),
  end: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: -50, max: -1 })),
})

describe('totalDistance properties', () => {
  it('equals the sum of the per-shift kilometres it was built from', () => {
    fc.assert(
      fc.property(fc.array(reading, { maxLength: 60 }), (readings) => {
        const perShift = readings.map(shiftDistance)
        const sum = perShift.reduce((acc, d) => acc + (d.recorded ? d.km : 0), 0)
        const total = totalDistance(readings)
        expect(total.km).toBe(sum)
        expect(total.recordedShifts + total.unrecordedShifts).toBe(readings.length)
        expect(total.missing + total.rollbacks).toBe(total.unrecordedShifts)
      }),
    )
  })

  it('never counts a negative distance, and never goes below zero', () => {
    fc.assert(
      fc.property(fc.array(reading, { maxLength: 60 }), (readings) => {
        for (const r of readings) {
          const d = shiftDistance(r)
          if (d.recorded) expect(d.km).toBeGreaterThanOrEqual(0)
          if (typeof r.start === 'number' && typeof r.end === 'number' && r.end < r.start) {
            expect(d.recorded).toBe(false)
          }
        }
        expect(totalDistance(readings).km).toBeGreaterThanOrEqual(0)
      }),
    )
  })

  it('does not depend on the order of the shifts, and splits additively', () => {
    fc.assert(
      fc.property(fc.array(reading, { maxLength: 40 }), fc.array(reading, { maxLength: 40 }), (a, b) => {
        const whole = totalDistance([...a, ...b])
        expect(totalDistance([...b, ...a])).toEqual(whole)
        const left = totalDistance(a)
        const right = totalDistance(b)
        expect(whole.km).toBe(left.km + right.km)
        expect(whole.unrecordedShifts).toBe(left.unrecordedShifts + right.unrecordedShifts)
      }),
    )
  })

  it('agrees with folding addShiftDistance by hand', () => {
    fc.assert(
      fc.property(fc.array(reading, { maxLength: 40 }), (readings) => {
        const folded = readings.reduce((acc, r) => addShiftDistance(acc, shiftDistance(r)), EMPTY_DISTANCE_TOTAL)
        expect(folded).toEqual(totalDistance(readings))
      }),
    )
  })
})
