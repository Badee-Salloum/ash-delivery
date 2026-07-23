import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type VehicleNumber,
  VehicleNumberError,
  formatVehicleNumber,
  nextMachineNo,
  parseVehicleNumber,
} from '../../src/fleet/numbering.ts'

/**
 * «رقم الآلية» — `<governorate>-<branch>-<type>-<machine>`.
 *
 * The number is printed on the bike, typed into a search box, and read aloud over a phone. What
 * matters is that exactly ONE spelling of a given machine exists, so these tests care far more
 * about round-tripping and about rejecting near-misses than about any single happy path.
 */

const segment = (max: number) => fc.integer({ min: 1, max })
const anyNumber = fc.record({
  governorateNo: segment(99),
  branchNo: segment(99),
  typeNo: segment(99),
  machineNo: segment(999),
})

describe('the number the client asked for', () => {
  it('the first motorbike of the first branch in Damascus is 1-1-1-1', () => {
    expect(formatVehicleNumber({ governorateNo: 1, branchNo: 1, typeNo: 1, machineNo: 1 })).toBe('1-1-1-1')
  })

  it('does not pad, so there is one spelling per machine', () => {
    expect(formatVehicleNumber({ governorateNo: 1, branchNo: 2, typeNo: 3, machineNo: 7 })).toBe('1-2-3-7')
    expect(formatVehicleNumber({ governorateNo: 11, branchNo: 1, typeNo: 1, machineNo: 100 })).toBe('11-1-1-100')
  })
})

describe('format and parse are inverses', () => {
  it('round-trips every number that can be stored', () => {
    fc.assert(
      fc.property(anyNumber, (n: VehicleNumber) => {
        expect(parseVehicleNumber(formatVehicleNumber(n))).toEqual(n)
      }),
    )
  })

  it('parse rejects anything format could not have produced', () => {
    // A leading zero would parse to a number that formats back differently — two spellings of
    // one identifier is exactly what this scheme exists to prevent.
    expect(parseVehicleNumber('01-1-1-1')).toBeNull()
    expect(parseVehicleNumber('1-1-1-001')).toBeNull()
    expect(parseVehicleNumber('0-1-1-1')).toBeNull()
    expect(parseVehicleNumber('1-1-1-0')).toBeNull()
  })

  it('parse returns null for a half-typed search box rather than throwing', () => {
    for (const text of ['', '1', '1-', '1-1-', '1-1-1', 'VEH-001', '1-1-1-1-1', 'a-b-c-d']) {
      expect(parseVehicleNumber(text), text).toBeNull()
    }
  })

  it('tolerates surrounding whitespace, because a pasted code carries it', () => {
    expect(parseVehicleNumber('  1-1-1-1 ')).toEqual({ governorateNo: 1, branchNo: 1, typeNo: 1, machineNo: 1 })
  })
})

describe('bounds match the CHECK constraints in migration 0007', () => {
  it('refuses a segment the database would reject, instead of storing a broken code', () => {
    expect(() => formatVehicleNumber({ governorateNo: 100, branchNo: 1, typeNo: 1, machineNo: 1 })).toThrow(VehicleNumberError)
    expect(() => formatVehicleNumber({ governorateNo: 1, branchNo: 1, typeNo: 1, machineNo: 1000 })).toThrow(VehicleNumberError)
    expect(() => formatVehicleNumber({ governorateNo: 0, branchNo: 1, typeNo: 1, machineNo: 1 })).toThrow(VehicleNumberError)
    expect(() => formatVehicleNumber({ governorateNo: 1.5, branchNo: 1, typeNo: 1, machineNo: 1 })).toThrow(VehicleNumberError)
  })

  it('parse agrees with format about what is out of range', () => {
    expect(parseVehicleNumber('1-1-1-1000')).toBeNull()
  })
})

describe('machine numbering fills holes', () => {
  it('starts at 1 on an empty branch', () => {
    expect(nextMachineNo([])).toBe(1)
  })

  it('reuses a retired bike’s number rather than leaving a permanent gap', () => {
    // Highest-plus-one would return 11 here and the fleet's numbering would slowly become sparse;
    // these numbers are written on paperwork and read aloud, so density is worth having.
    expect(nextMachineNo([1, 2, 4, 5])).toBe(3)
  })

  it('always returns a number not already taken', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 50 }), { maxLength: 40 }), (taken) => {
        const next = nextMachineNo(taken)
        expect(taken).not.toContain(next)
        expect(next).toBeGreaterThanOrEqual(1)
      }),
    )
  })

  it('is unaffected by the order it is given', () => {
    expect(nextMachineNo([5, 1, 4, 2])).toBe(nextMachineNo([1, 2, 4, 5]))
  })
})
