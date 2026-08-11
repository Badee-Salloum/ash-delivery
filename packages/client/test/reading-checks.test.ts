import { describe, expect, it } from 'vitest'
import {
  BATTERY_START_MIN_PERCENT,
  ODOMETER_SHIFT_MAX_KM,
  checkEndBattery,
  checkEndPackage,
  checkOdometer,
  checkStartBattery,
  checkStartPackage,
} from '../src/reading-checks.ts'

/**
 * A pack was recorded at 1% at the START of a shift, straight from OCR, and nothing questioned it.
 * A driver does not set off on a flat battery — that is the reader mistaking «100» or «10» for «1»,
 * and it went into the evidence as fact.
 *
 * These ASK. Every one of them can legitimately be true, and blocking would make the app wrong about
 * the real world and teach drivers to type whatever gets them past it — which is how the 1% got in.
 */

describe('a charge too low to start on', () => {
  it('asks about the 1% that started this', () => {
    expect(checkStartBattery(1)).toEqual({ kind: 'battery_too_low_to_start', percent: 1 })
  })

  it('says nothing about a charge a bike can actually work on', () => {
    expect(checkStartBattery(100)).toBeNull()
    expect(checkStartBattery(45)).toBeNull()
    expect(checkStartBattery(BATTERY_START_MIN_PERCENT)).toBeNull()
  })

  it('asks just below the line, and not at it', () => {
    expect(checkStartBattery(BATTERY_START_MIN_PERCENT - 1)).not.toBeNull()
    expect(checkStartBattery(BATTERY_START_MIN_PERCENT)).toBeNull()
  })

  it('has nothing to say about a reading that does not exist yet', () => {
    expect(checkStartBattery(null)).toBeNull()
  })

  /** Zero is the most suspicious value of all, and the easiest to fall through a `!percent` test. */
  it('asks about zero rather than treating it as absent', () => {
    expect(checkStartBattery(0)).toEqual({ kind: 'battery_too_low_to_start', percent: 0 })
  })
})

describe('an odometer that disagrees with itself', () => {
  it('asks when the bike came back with fewer kilometres than it left with', () => {
    expect(checkOdometer(6948, 6900)).toEqual({ kind: 'odometer_went_backwards', start: 6948, end: 6900 })
  })

  it('asks about a day longer than any delivery round', () => {
    expect(checkOdometer(1000, 1000 + ODOMETER_SHIFT_MAX_KM + 1)).toEqual({
      kind: 'odometer_jump',
      km: ODOMETER_SHIFT_MAX_KM + 1,
    })
  })

  it('says nothing about an ordinary shift', () => {
    expect(checkOdometer(6948, 6996)).toBeNull()
    // Standing still all day is odd but not impossible — a shift with no deliveries is its own signal.
    expect(checkOdometer(6948, 6948)).toBeNull()
  })

  it('waits until both ends are known', () => {
    expect(checkOdometer(null, 6996)).toBeNull()
    expect(checkOdometer(6948, null)).toBeNull()
  })
})

describe('a pack that gained charge while it was out', () => {
  it('asks, because charge does not go up on the road', () => {
    expect(checkEndBattery(80, 95, false)).toEqual({ kind: 'battery_rose_without_swap', start: 80, end: 95 })
  })

  it('says nothing when a swap explains it', () => {
    expect(checkEndBattery(20, 100, true)).toBeNull()
  })

  it('says nothing about the ordinary case — charge went down', () => {
    expect(checkEndBattery(90, 35, false)).toBeNull()
    expect(checkEndBattery(90, 90, false)).toBeNull()
  })
})

describe('a whole package', () => {
  it('names the slot each question is about, so it can sit beside its own field', () => {
    const questions = checkStartPackage({
      odometerKm: 6948,
      batteries: [
        { slotNo: 1, percent: 1 },
        { slotNo: 2, percent: 88 },
      ],
    })
    expect(questions).toEqual([{ slotNo: 1, check: { kind: 'battery_too_low_to_start', percent: 1 } }])
  })

  it('asks nothing about a package that reads normally', () => {
    expect(
      checkStartPackage({ odometerKm: 6948, batteries: [{ slotNo: 1, percent: 92 }] }),
    ).toEqual([])
  })

  it('puts the odometer question on no slot, because it belongs to the bike', () => {
    const questions = checkEndPackage({
      odometerStart: 6948,
      odometerEnd: 6900,
      batteries: [{ slotNo: 1, startPercent: 90, endPercent: 40, swapped: false }],
    })
    expect(questions).toEqual([
      { slotNo: null, check: { kind: 'odometer_went_backwards', start: 6948, end: 6900 } },
    ])
  })

  it('raises every question a close deserves at once, not one at a time', () => {
    const questions = checkEndPackage({
      odometerStart: 1000,
      odometerEnd: 9000,
      batteries: [
        { slotNo: 1, startPercent: 80, endPercent: 95, swapped: false },
        { slotNo: 2, startPercent: 80, endPercent: 30, swapped: false },
      ],
    })
    expect(questions).toHaveLength(2)
    expect(questions.map((q) => q.check.kind)).toEqual(['odometer_jump', 'battery_rose_without_swap'])
  })
})
