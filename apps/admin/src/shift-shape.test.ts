import { describe, expect, it } from 'vitest'
import { shiftShapeForDay, shiftShapeOf, shiftsByDriver } from './shift-shape.ts'

const shift = (pattern?: 'day' | 'evening' | 'full' | 'unknown') =>
  pattern === undefined ? {} : { worked: { pattern } }

describe('«شيفت عادية او دبل» — the two shapes of a double', () => {
  it('reads ONE full shift as a double', () => {
    // The dominant shape in the data: 12:00 → 01:00, one row, both slots. 36 of 129 measured.
    expect(shiftShapeForDay([shift('full')])).toBe('double')
    expect(shiftShapeOf(shift('full'))).toBe('double')
  })

  it('reads TWO ordinary shifts on one day as a double too', () => {
    // The shape a pattern-only reading misses entirely. Whatever either one is, he worked twice.
    expect(shiftShapeForDay([shift('day'), shift('evening')])).toBe('double')
    expect(shiftShapeForDay([shift('day'), shift('day')])).toBe('double')
  })

  it('counts the rows BEFORE asking the pattern', () => {
    // A closed morning shift plus a live second one is already a double. Asking `workedTime` about
    // the live row would answer `pending` and hide a fact the row count has already settled.
    expect(shiftShapeForDay([shift('day'), shift('unknown')])).toBe('double')
  })

  it('reads a single day or evening shift as normal', () => {
    expect(shiftShapeForDay([shift('day')])).toBe('single')
    expect(shiftShapeForDay([shift('evening')])).toBe('single')
  })

  it('says «not yet known» for a running morning shift rather than guessing', () => {
    /*
     * This is the whole reason `unknown` exists. A 12:00 start is a single or a double and only the
     * end says which — a badge that read «عادية» at noon and «دبل» after midnight would be changing
     * its story in front of the manager who is about to settle real cash on it.
     */
    expect(shiftShapeForDay([shift('unknown')])).toBe('pending')
    expect(shiftShapeOf(shift('unknown'))).toBe('pending')
  })

  it('distinguishes «we know nothing» from «عادية»', () => {
    // A driver with orders but no shift row must NOT be labelled as having worked a normal shift.
    expect(shiftShapeForDay([])).toBeNull()
    expect(shiftShapeOf(undefined)).toBeNull()
    expect(shiftShapeOf(null)).toBeNull()
    // An API old enough to serve no `worked` is the same case, not a normal shift.
    expect(shiftShapeOf(shift())).toBeNull()
    expect(shiftShapeForDay([shift()])).toBeNull()
  })

  it('cannot see a second shift when judging one alone', () => {
    // The documented limit of `shiftShapeOf`: it is what the running-shifts board can say about a
    // card, and it is why the dashboard groups by driver first.
    expect(shiftShapeOf(shift('day'))).toBe('single')
    expect(shiftShapeForDay([shift('day'), shift('day')])).toBe('double')
  })
})

describe('grouping a day by driver', () => {
  it('keeps every row, including a driver who worked twice', () => {
    const grouped = shiftsByDriver([
      { driverId: 'a', worked: { pattern: 'day' as const } },
      { driverId: 'b', worked: { pattern: 'full' as const } },
      { driverId: 'a', worked: { pattern: 'evening' as const } },
    ])
    expect(grouped.get('a')).toHaveLength(2)
    expect(grouped.get('b')).toHaveLength(1)
    expect(shiftShapeForDay(grouped.get('a') ?? [])).toBe('double')
    expect(shiftShapeForDay(grouped.get('b') ?? [])).toBe('double')
    expect(shiftShapeForDay(grouped.get('nobody') ?? [])).toBeNull()
  })
})
