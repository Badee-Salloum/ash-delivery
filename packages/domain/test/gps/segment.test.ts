import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { minuteKeyForOffset, printedMinuteKey } from '../../src/time/civil.ts'
import { type TrailOrderInput, type TrailPingInput, sliceTrailByOrders } from '../../src/gps/segment.ts'

/**
 * The per-order path slicer (GPS ↔ order linking). Orders carry only a minute-precision printed
 * clock that is often null, so this is best-effort by time: an order owns the trail from its own
 * printed minute to the next order's, the last order runs to close-submission, and pings before the
 * first order or at/after the submit minute are their own buckets. The rules that matter are that
 * every ping lands in exactly one bucket and that an unreadable minute never invents a segment.
 */

const OFFSET = 180 // Asia/Damascus

/** A branch-local `"YYYY-MM-DD HH:MM"` (optionally `+seconds`) as an epoch instant. */
function at(local: string, seconds = 0): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(local)
  if (!m) throw new Error(`bad local time: ${local}`)
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, seconds) - OFFSET * 60_000
}

function ping(local: string, seconds = 0): TrailPingInput {
  return { capturedAtMs: at(local, seconds) }
}

function order(providerOrderNo: string, date: string | null, minute: string | null): TrailOrderInput {
  return { orderId: `ord-${providerOrderNo}`, providerOrderNo, occurredDate: date, occurredMinute: minute }
}

describe('sliceTrailByOrders — worked cases', () => {
  it('splits a trail into before / per-order / after by printed minute', () => {
    const pings = [
      ping('2026-09-21 08:58'), ping('2026-09-21 08:59'), // before the first order
      ping('2026-09-21 09:00'), ping('2026-09-21 09:05'), ping('2026-09-21 09:09'), // order A
      ping('2026-09-21 09:10'), ping('2026-09-21 09:15'), // order B
      ping('2026-09-21 09:20'), ping('2026-09-21 09:25'), // order C
      ping('2026-09-21 09:30'), ping('2026-09-21 09:35'), // after submit
    ]
    const orders = [
      order('1', '2026-09-21', '09:00'),
      order('2', '2026-09-21', '09:10'),
      order('3', '2026-09-21', '09:20'),
    ]
    const r = sliceTrailByOrders({ pings, orders, submittedAtMs: at('2026-09-21 09:30'), offsetMinutes: OFFSET })

    expect(r.beforeFirst).toEqual({ pingStartIndex: 0, pingEndIndex: 2 })
    expect(r.segments.map((s) => [s.providerOrderNo, s.pingStartIndex, s.pingEndIndex])).toEqual([
      ['1', 2, 5],
      ['2', 5, 7],
      ['3', 7, 9],
    ])
    expect(r.afterClose).toEqual({ pingStartIndex: 9, pingEndIndex: 11 })
    expect(r.untimedOrderIds).toEqual([])
  })

  it('gives an order with an unreadable minute no segment', () => {
    const pings = [ping('2026-09-21 09:05')]
    const orders = [order('1', '2026-09-21', '09:00'), order('2', '2026-09-21', null), order('3', null, '09:00')]
    const r = sliceTrailByOrders({ pings, orders, submittedAtMs: null, offsetMinutes: OFFSET })
    expect(r.boundaries.map((b) => b.providerOrderNo)).toEqual(['1'])
    expect([...r.untimedOrderIds].sort()).toEqual(['ord-2', 'ord-3'])
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0]).toMatchObject({ providerOrderNo: '1', pingStartIndex: 0, pingEndIndex: 1 })
  })

  it('gives a shared minute to the later order (by provider number); the earlier one is empty', () => {
    const pings = [ping('2026-09-21 09:10'), ping('2026-09-21 09:11')]
    const orders = [order('6', '2026-09-21', '09:10'), order('5', '2026-09-21', '09:10')]
    const r = sliceTrailByOrders({ pings, orders, submittedAtMs: null, offsetMinutes: OFFSET })
    // sorted by provider number at an equal minute → '5' then '6'; the ping at 09:10 is start-owned
    // by the last order at that key, which is '6'.
    expect(r.segments.map((s) => [s.providerOrderNo, s.pingStartIndex, s.pingEndIndex])).toEqual([
      ['5', 0, 0], // empty
      ['6', 0, 2],
    ])
  })

  it('sorts a prior-calendar-day order before same-day orders', () => {
    const pings = [ping('2026-09-20 23:56'), ping('2026-09-21 00:06')]
    const orders = [order('2', '2026-09-21', '00:05'), order('1', '2026-09-20', '23:55')]
    const r = sliceTrailByOrders({ pings, orders, submittedAtMs: null, offsetMinutes: OFFSET })
    expect(r.boundaries.map((b) => b.providerOrderNo)).toEqual(['1', '2'])
    expect(r.segments.map((s) => [s.providerOrderNo, s.pingStartIndex, s.pingEndIndex])).toEqual([
      ['1', 0, 1],
      ['2', 1, 2],
    ])
    expect(r.beforeFirst).toEqual({ pingStartIndex: 0, pingEndIndex: 0 })
  })

  it('puts a ping on the submit minute in afterClose, not the last order', () => {
    const pings = [ping('2026-09-21 09:20'), ping('2026-09-21 09:30')]
    const orders = [order('1', '2026-09-21', '09:20')]
    const r = sliceTrailByOrders({ pings, orders, submittedAtMs: at('2026-09-21 09:30'), offsetMinutes: OFFSET })
    expect(r.segments[0]).toMatchObject({ pingStartIndex: 0, pingEndIndex: 1 })
    expect(r.afterClose).toEqual({ pingStartIndex: 1, pingEndIndex: 2 })
  })

  it('runs the last order to the end of the trail when the shift is still open (no submit)', () => {
    const pings = [ping('2026-09-21 09:20'), ping('2026-09-21 09:40'), ping('2026-09-21 10:00')]
    const orders = [order('1', '2026-09-21', '09:20')]
    const r = sliceTrailByOrders({ pings, orders, submittedAtMs: null, offsetMinutes: OFFSET })
    expect(r.segments[0]).toMatchObject({ pingStartIndex: 0, pingEndIndex: 3 })
    expect(r.afterClose).toEqual({ pingStartIndex: 3, pingEndIndex: 3 })
  })

  it('assigns the whole trail to beforeFirst when no order has a readable minute', () => {
    const pings = [ping('2026-09-21 09:00'), ping('2026-09-21 09:05')]
    const orders = [order('1', '2026-09-21', null)]
    const r = sliceTrailByOrders({ pings, orders, submittedAtMs: at('2026-09-21 10:00'), offsetMinutes: OFFSET })
    expect(r.segments).toEqual([])
    expect(r.untimedOrderIds).toEqual(['ord-1'])
    expect(r.beforeFirst).toEqual({ pingStartIndex: 0, pingEndIndex: 2 })
    expect(r.afterClose).toEqual({ pingStartIndex: 2, pingEndIndex: 2 })
  })

  it('classifies fixes after submission even when every order is untimed', () => {
    const pings = [ping('2026-09-21 09:00'), ping('2026-09-21 10:00')]
    const r = sliceTrailByOrders({
      pings, orders: [order('1', '2026-09-21', null)],
      submittedAtMs: at('2026-09-21 09:30'), offsetMinutes: OFFSET,
    })
    expect(r.beforeFirst).toEqual({ pingStartIndex: 0, pingEndIndex: 1 })
    expect(r.afterClose).toEqual({ pingStartIndex: 1, pingEndIndex: 2 })
  })

  it('handles an empty trail', () => {
    const orders = [order('1', '2026-09-21', '09:00')]
    const r = sliceTrailByOrders({ pings: [], orders, submittedAtMs: at('2026-09-21 09:30'), offsetMinutes: OFFSET })
    expect(r.beforeFirst).toEqual({ pingStartIndex: 0, pingEndIndex: 0 })
    expect(r.segments[0]).toMatchObject({ pingStartIndex: 0, pingEndIndex: 0 })
    expect(r.afterClose).toEqual({ pingStartIndex: 0, pingEndIndex: 0 })
  })
})

// ── Properties, checked against a brute-force oracle ─────────────────────────────────────────

interface Bucket {
  kind: 'before' | 'order' | 'after'
  orderIndex?: number
}

/** The slowest, most obviously-correct assignment: for each ping, the last timed order at/under it. */
function oracle(input: {
  pings: readonly TrailPingInput[]
  orders: readonly TrailOrderInput[]
  submittedAtMs: number | null
  offsetMinutes: number
}): Bucket[] {
  const timed = input.orders
    .map((o) => ({ providerOrderNo: o.providerOrderNo, key: printedMinuteKey(o.occurredDate, o.occurredMinute) }))
    .filter((o): o is { providerOrderNo: string; key: string } => o.key !== null)
    .sort((a, b) => (a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.providerOrderNo < b.providerOrderNo ? -1 : 1))
  return input.pings.map((p) => {
    const pk = minuteKeyForOffset(p.capturedAtMs, input.offsetMinutes)
    let active = -1
    for (let j = 0; j < timed.length; j++) if (timed[j]!.key <= pk) active = j
    if (input.submittedAtMs !== null && p.capturedAtMs >= input.submittedAtMs) return { kind: 'after' }
    if (active === -1) return { kind: 'before' }
    return { kind: 'order', orderIndex: active }
  })
}

/** Expand the range-based result back to a per-ping bucket label, to compare with the oracle. */
function labelsFrom(r: ReturnType<typeof sliceTrailByOrders>, total: number): Bucket[] {
  const labels = new Array<Bucket>(total)
  const put = (range: { pingStartIndex: number; pingEndIndex: number }, b: Bucket): void => {
    for (let i = range.pingStartIndex; i < range.pingEndIndex; i++) labels[i] = b
  }
  put(r.beforeFirst, { kind: 'before' })
  r.segments.forEach((s, orderIndex) => put(s, { kind: 'order', orderIndex }))
  put(r.afterClose, { kind: 'after' })
  return labels
}

const orderArb = fc
  .record({
    providerOrderNo: fc.integer({ min: 1, max: 9_999 }).map((n) => String(n).padStart(5, '0')),
    occurredDate: fc.constantFrom('2026-09-20', '2026-09-21', null),
    occurredMinute: fc.constantFrom('08:59', '09:00', '09:10', '09:10', '10:30', '23:55', null),
  })
  // Real order ids are unique PKs; deriving from the (uniquified) provider number keeps them so.
  .map((o) => ({ ...o, orderId: `ord-${o.providerOrderNo}` }))

// Sorted capturedAt instants across the same window the minutes live in.
const pingsArb = fc
  .array(fc.integer({ min: 0, max: 60 * 26 }), { maxLength: 40 }) // minutes past 2026-09-20 22:00
  .map((mins) => mins.sort((a, b) => a - b).map((mm) => ({ capturedAtMs: at('2026-09-20 22:00') + mm * 60_000 })))

describe('sliceTrailByOrders — properties', () => {
  it('matches the brute-force oracle for every ping', () => {
    fc.assert(
      fc.property(
        pingsArb,
        fc.array(orderArb, { maxLength: 8 }),
        fc.option(fc.integer({ min: 0, max: 60 * 26 }), { nil: null }),
        (pings, orders, submitMin) => {
          const submittedAtMs = submitMin === null ? null : at('2026-09-20 22:00') + submitMin * 60_000
          // Provider numbers must be unique so ties are fully ordered (as they are in the repo).
          const unique = orders.filter((o, i) => orders.findIndex((x) => x.providerOrderNo === o.providerOrderNo) === i)
          const r = sliceTrailByOrders({ pings, orders: unique, submittedAtMs, offsetMinutes: OFFSET })
          expect(labelsFrom(r, pings.length)).toEqual(oracle({ pings, orders: unique, submittedAtMs, offsetMinutes: OFFSET }))
        },
      ),
    )
  })

  it('tiles the trail: ranges are contiguous, disjoint and cover [0, n)', () => {
    fc.assert(
      fc.property(pingsArb, fc.array(orderArb, { maxLength: 8 }), (pings, orders) => {
        const unique = orders.filter((o, i) => orders.findIndex((x) => x.providerOrderNo === o.providerOrderNo) === i)
        const r = sliceTrailByOrders({ pings, orders: unique, submittedAtMs: null, offsetMinutes: OFFSET })
        const ranges = [r.beforeFirst, ...r.segments, r.afterClose]
        let cursor = 0
        for (const range of ranges) {
          expect(range.pingStartIndex).toBe(cursor)
          expect(range.pingEndIndex).toBeGreaterThanOrEqual(range.pingStartIndex)
          cursor = range.pingEndIndex
        }
        expect(cursor).toBe(pings.length)
      }),
    )
  })

  it('never segments an untimed order, and every order is placed exactly once', () => {
    fc.assert(
      fc.property(pingsArb, fc.array(orderArb, { maxLength: 8 }), (pings, orders) => {
        const unique = orders.filter((o, i) => orders.findIndex((x) => x.providerOrderNo === o.providerOrderNo) === i)
        const r = sliceTrailByOrders({ pings, orders: unique, submittedAtMs: null, offsetMinutes: OFFSET })
        const segmentIds = new Set(r.segments.map((s) => s.orderId))
        for (const id of r.untimedOrderIds) expect(segmentIds.has(id)).toBe(false)
        expect(r.segments.length + r.untimedOrderIds.length).toBe(unique.length)
      }),
    )
  })

  it('places the same timed orders on the trail whatever order they arrive in', () => {
    // The trail placement (boundaries, segments, before/after) is canonically sorted, so it is
    // permutation-invariant. `untimedOrderIds` keeps the caller's order (the repo's provider-number
    // order), so only its membership — not its sequence — is invariant.
    fc.assert(
      fc.property(pingsArb, fc.array(orderArb, { maxLength: 8 }), (pings, orders) => {
        const unique = orders.filter((o, i) => orders.findIndex((x) => x.providerOrderNo === o.providerOrderNo) === i)
        const a = sliceTrailByOrders({ pings, orders: unique, submittedAtMs: null, offsetMinutes: OFFSET })
        const b = sliceTrailByOrders({ pings, orders: [...unique].reverse(), submittedAtMs: null, offsetMinutes: OFFSET })
        expect({ ...a, untimedOrderIds: [...a.untimedOrderIds].sort() }).toEqual({
          ...b,
          untimedOrderIds: [...b.untimedOrderIds].sort(),
        })
      }),
    )
  })
})
