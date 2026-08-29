import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type CheckInWindow,
  assessCheckIn,
  distanceMetres,
  isWithinOperatingRegion,
  localMinuteOfDay,
  rollCall,
  swapWouldBeInRegion,
  windowFor,
} from '../../src/attendance/checkin.ts'

/**
 * «التفقّد» — the branch manager proving he was at the branch when he was expected there
 * (owner request, 2026-08-29): several rounds a day, each within a tolerance, each from inside the
 * branch's own patch of ground. Drivers are excluded — they are out on the road by design.
 */

/** The branch, and a few points around it. Damascus, so the latitude is real. */
const BRANCH = { lat: 33.5138, lng: 36.2765, radiusMetres: 150 }
const DAMASCUS_OFFSET = 180

/** 01:00, 05:00 and 10:00, the owner's own example. */
const WINDOWS: CheckInWindow[] = [
  { windowRef: 'w1', atMinute: 60, toleranceMinutes: 30 },
  { windowRef: 'w5', atMinute: 300, toleranceMinutes: 30 },
  { windowRef: 'w10', atMinute: 600, toleranceMinutes: 30 },
]

/** An instant at a given branch-local hour and minute on 2026-08-29. */
const at = (hour: number, minute = 0): number =>
  Date.UTC(2026, 7, 29, hour, minute) - DAMASCUS_OFFSET * 60_000

describe('distance on the ground', () => {
  it('is zero at the same point and symmetric', () => {
    expect(distanceMetres(BRANCH, BRANCH)).toBe(0)
    const other = { lat: 33.52, lng: 36.28 }
    expect(distanceMetres(BRANCH, other)).toBeCloseTo(distanceMetres(other, BRANCH), 6)
  })

  it('measures a known separation to within a metre', () => {
    // 0.001° of latitude is ~111.2 m anywhere on earth.
    const north = { lat: BRANCH.lat + 0.001, lng: BRANCH.lng }
    expect(distanceMetres(BRANCH, north)).toBeGreaterThan(110)
    expect(distanceMetres(BRANCH, north)).toBeLessThan(113)
  })

  it('does not treat a degree of longitude as a degree of latitude', () => {
    // The flat-earth shortcut this guards: at 33.5°N a degree of longitude is ~17% shorter than a
    // degree of latitude, and a fence is decided exactly at its edge.
    const north = { lat: BRANCH.lat + 0.001, lng: BRANCH.lng }
    const east = { lat: BRANCH.lat, lng: BRANCH.lng + 0.001 }
    expect(distanceMetres(BRANCH, east)).toBeLessThan(distanceMetres(BRANCH, north))
  })
})

describe('the local minute of day', () => {
  it('reads branch-local time, not UTC', () => {
    expect(localMinuteOfDay(at(1), DAMASCUS_OFFSET)).toBe(60)
    expect(localMinuteOfDay(at(10, 30), DAMASCUS_OFFSET)).toBe(630)
  })

  it('never returns a negative minute', () => {
    // A negative offset near local midnight is where a naive % silently matches no window at all.
    fc.assert(
      fc.property(fc.integer({ min: -720, max: 840 }), fc.integer({ min: 0, max: 86_399_999 }), (offset, ms) => {
        const minute = localMinuteOfDay(ms, offset)
        expect(minute).toBeGreaterThanOrEqual(0)
        expect(minute).toBeLessThan(1440)
      }),
      { numRuns: 300 },
    )
  })
})

describe('which round a check-in answers', () => {
  it('matches a window within its tolerance and reports how early or late', () => {
    expect(windowFor(60, WINDOWS)).toMatchObject({ minutesFromTarget: 0 })
    expect(windowFor(45, WINDOWS)?.window.windowRef).toBe('w1')
    expect(windowFor(45, WINDOWS)?.minutesFromTarget).toBe(-15)
    expect(windowFor(615, WINDOWS)?.window.windowRef).toBe('w10')
    expect(windowFor(615, WINDOWS)?.minutesFromTarget).toBe(15)
  })

  it('answers no window when none is open', () => {
    expect(windowFor(200, WINDOWS)).toBeNull()
    expect(windowFor(1439, WINDOWS)).toBeNull()
  })

  it('picks the CLOSEST window when tolerances overlap, not the first', () => {
    // 01:00 ± 45 and 02:00 ± 45 both accept 01:55. A manager checking in at 01:55 means the two
    // o'clock round — not the one o'clock round he is 55 minutes late for.
    const overlapping: CheckInWindow[] = [
      { windowRef: 'one', atMinute: 60, toleranceMinutes: 45 },
      { windowRef: 'two', atMinute: 120, toleranceMinutes: 45 },
    ]
    expect(windowFor(115, overlapping)?.window.windowRef).toBe('two')
    expect(windowFor(70, overlapping)?.window.windowRef).toBe('one')
  })

  it('breaks an exact tie deterministically, so the same input never flips', () => {
    const tied: CheckInWindow[] = [
      { windowRef: 'later', atMinute: 120, toleranceMinutes: 60 },
      { windowRef: 'earlier', atMinute: 60, toleranceMinutes: 60 },
    ]
    // 90 is exactly 30 from both. The earlier target wins, whatever order they arrive in.
    expect(windowFor(90, tied)?.window.windowRef).toBe('earlier')
    expect(windowFor(90, [...tied].reverse())?.window.windowRef).toBe('earlier')
  })
})

describe('judging one check-in', () => {
  const inside = { lat: BRANCH.lat + 0.0005, lng: BRANCH.lng } // ~56 m
  const far = { lat: BRANCH.lat + 0.02, lng: BRANCH.lng } // ~2.2 km

  const judge = (point: { lat: number; lng: number }, hour: number, minute = 0) =>
    assessCheckIn({ at: point, fence: BRANCH, epochMs: at(hour, minute), offsetMinutes: DAMASCUS_OFFSET, windows: WINDOWS })

  it('is on time inside the fence and inside a window', () => {
    const a = judge(inside, 5)
    expect(a.verdict).toBe('on_time')
    expect(a.windowRef).toBe('w5')
    expect(a.insideArea).toBe(true)
    expect(a.distanceMetres).toBeLessThan(150)
  })

  it('separates being in the wrong place from being at the wrong time', () => {
    expect(judge(far, 5).verdict).toBe('outside_area')
    expect(judge(inside, 3).verdict).toBe('outside_window')
    expect(judge(far, 3).verdict).toBe('outside_both')
  })

  it('records the distance and the lateness either way — it never refuses', () => {
    // Nothing here blocks anyone. A manager genuinely away still gets a row that says so, with
    // the numbers a human needs to judge it.
    const a = judge(far, 10, 20)
    expect(a.verdict).toBe('outside_area')
    expect(a.windowRef).toBe('w10')
    expect(a.minutesFromTarget).toBe(20)
    expect(a.distanceMetres).toBeGreaterThan(1_000)
  })

  it('treats the fence edge as inside', () => {
    // A boundary that excludes its own radius would fail someone standing exactly where told to.
    const edge = { lat: BRANCH.lat, lng: BRANCH.lng }
    expect(assessCheckIn({ at: edge, fence: { ...BRANCH, radiusMetres: 0 }, epochMs: at(1), offsetMinutes: DAMASCUS_OFFSET, windows: WINDOWS }).insideArea).toBe(true)
  })
})

describe('the day’s roll-call', () => {
  it('shows a window nobody answered — the row that matters most', () => {
    // Built from the WINDOWS, not from the check-ins: a report driven by what happened can never
    // show what didn't.
    const outcomes = rollCall(WINDOWS, [
      { windowRef: 'w1', insideArea: true, distanceMetres: 20, minutesFromTarget: 0 },
      { windowRef: 'w10', insideArea: false, distanceMetres: 2_200, minutesFromTarget: 5 },
    ])
    expect(outcomes.map((o) => [o.windowRef, o.status])).toEqual([
      ['w1', 'on_time'],
      ['w5', 'missed'],
      ['w10', 'outside_area'],
    ])
  })

  it('lets a later check-in from the office redeem an earlier one from the road', () => {
    const outcomes = rollCall([WINDOWS[0]!], [
      { windowRef: 'w1', insideArea: false, distanceMetres: 3_000, minutesFromTarget: -20 },
      { windowRef: 'w1', insideArea: true, distanceMetres: 15, minutesFromTarget: 5 },
    ])
    expect(outcomes[0]?.status).toBe('on_time')
    expect(outcomes[0]?.distanceMetres).toBe(15)
  })

  it('is ordered by the time of day, so the report reads like the day', () => {
    const shuffled = [WINDOWS[2]!, WINDOWS[0]!, WINDOWS[1]!]
    expect(rollCall(shuffled, []).map((o) => o.atMinute)).toEqual([60, 300, 600])
  })

  it('reports every window as missed when nobody checked in at all', () => {
    expect(rollCall(WINDOWS, []).every((o) => o.status === 'missed')).toBe(true)
  })
})

describe('a swapped latitude and longitude', () => {
  /**
   * The real one, read out of production on 2026-08-29: the Damascus branch was stored at
   * lat 36.29297 / lng 33.52239 — the two fields filled the wrong way round. Every schema passed
   * it, and the fence landed roughly 300 km away in southern Turkey.
   */
  const damascus = { lat: 33.52239, lng: 36.29297 }
  const swapped = { lat: 36.29297, lng: 33.52239 }

  it('accepts the branch as it actually is', () => {
    expect(isWithinOperatingRegion(damascus)).toBe(true)
    expect(swapWouldBeInRegion(damascus)).toBe(false)
  })

  it('catches the swap that every range check lets through', () => {
    // Both numbers are individually legal in both fields — which is exactly why ±90/±180 cannot
    // see this, and why the check has to be about WHERE the point is, not how big the numbers are.
    expect(swapped.lat).toBeGreaterThanOrEqual(-90)
    expect(swapped.lat).toBeLessThanOrEqual(90)
    expect(isWithinOperatingRegion(swapped)).toBe(false)
    expect(swapWouldBeInRegion(swapped)).toBe(true)
  })

  it('does not offer a swap that would not help', () => {
    // London: outside the region, and reversing it lands in the Indian Ocean. Refuse, but do not
    // suggest — a suggestion that is also wrong is worse than none.
    expect(swapWouldBeInRegion({ lat: 51.5, lng: -0.12 })).toBe(false)
  })

  it('measures the damage, so the refusal is not a matter of taste', () => {
    expect(Math.round(distanceMetres(damascus, swapped) / 1000)).toBeGreaterThan(250)
  })
})
