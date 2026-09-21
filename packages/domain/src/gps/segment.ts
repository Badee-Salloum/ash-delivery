/**
 * Split a shift's GPS trail into a path segment per order, by time.
 *
 * An order carries only a MINUTE-resolution printed clock (`occurred_date` + `occurred_minute`,
 * branch-local), which is a screenshot claim and is frequently null; there is no real per-order
 * interval. A GPS ping carries a precise captured instant. So a per-order path can only be DERIVED,
 * and this is best-effort by printed time — never proof a position belongs to an order.
 *
 * Ownership is START-OWNED (owner's rule): an order owns the pings from ITS OWN printed minute up to
 * the NEXT timed order's printed minute; the last timed order runs to the shift's close-submission
 * minute (`submittedAtMs`); pings before the first timed order are `beforeFirst`; pings at or after
 * the submit minute are `afterClose`. Orders with an unreadable minute get no segment.
 *
 * This module is timing-only — it never sees lat/lng, so it is trivially testable and the map layer
 * is the only place that needs coordinates. All keys are branch-local minute strings, so a ping and
 * an order compare like for like and a prior-calendar-day order sorts first automatically.
 *
 * PRECONDITION: `pings` is in capture order (non-decreasing `capturedAtMs`), exactly as
 * `GpsPingRepo.listForShift` returns them. Returned indices are into that same array.
 */

import { minuteKeyForOffset, printedMinuteKey } from '../time/civil.ts'

export interface TrailOrderInput {
  readonly orderId: string
  readonly providerOrderNo: string
  readonly occurredDate: string | null
  readonly occurredMinute: string | null
}

export interface TrailPingInput {
  readonly capturedAtMs: number
}

/** A half-open `[pingStartIndex, pingEndIndex)` range into the ping array; empty when start === end. */
export interface PingRange {
  readonly pingStartIndex: number
  readonly pingEndIndex: number
}

export interface OrderSegment extends PingRange {
  readonly orderId: string
  readonly providerOrderNo: string
  /** The order's branch-local `"YYYY-MM-DD HH:MM"` key — the segment's lower bound. */
  readonly minuteKey: string
}

export interface TrailSegmentation {
  /** The timed orders, sorted chronologically (tiebreak `providerOrderNo`). */
  readonly boundaries: readonly { orderId: string; providerOrderNo: string; minuteKey: string }[]
  /** One entry per timed order, in boundary order; an empty range means it owned no ping. */
  readonly segments: readonly OrderSegment[]
  /** Orders whose printed minute was unreadable, so they could not be placed on the trail. */
  readonly untimedOrderIds: readonly string[]
  /** Pings before the first timed order (driving to the first pickup, or idle before it). */
  readonly beforeFirst: PingRange
  /** Pings at or after the close-submission minute (present because tracking runs into review). */
  readonly afterClose: PingRange
}

function compareBoundary(
  a: { minuteKey: string; providerOrderNo: string },
  b: { minuteKey: string; providerOrderNo: string },
): number {
  if (a.minuteKey !== b.minuteKey) return a.minuteKey < b.minuteKey ? -1 : 1
  if (a.providerOrderNo !== b.providerOrderNo) return a.providerOrderNo < b.providerOrderNo ? -1 : 1
  return 0
}

export function sliceTrailByOrders(input: {
  readonly pings: readonly TrailPingInput[]
  readonly orders: readonly TrailOrderInput[]
  readonly submittedAtMs: number | null
  readonly offsetMinutes: number
}): TrailSegmentation {
  const { pings, orders, submittedAtMs, offsetMinutes } = input

  // 1. Split orders into timed boundaries and untimed leftovers.
  const boundaries: { orderId: string; providerOrderNo: string; minuteKey: string }[] = []
  const untimedOrderIds: string[] = []
  for (const order of orders) {
    const minuteKey = printedMinuteKey(order.occurredDate, order.occurredMinute)
    if (minuteKey === null) untimedOrderIds.push(order.orderId)
    else boundaries.push({ orderId: order.orderId, providerOrderNo: order.providerOrderNo, minuteKey })
  }
  boundaries.sort(compareBoundary)

  const n = boundaries.length
  const total = pings.length
  const submittedKey = submittedAtMs === null ? null : minuteKeyForOffset(submittedAtMs, offsetMinutes)

  // 2. Label each ping with a slot: 0 = beforeFirst, 1..n = order (boundary a → slot a+1),
  //    n+1 = afterClose. The pointer only advances because pings are capture-ordered, so the slot
  //    sequence is non-decreasing and every slot is therefore a contiguous index range.
  const SLOTS = n + 2
  const slotStart = new Array<number>(SLOTS).fill(total)
  let active = -1 // last boundary index whose key <= the current ping key
  let next = 0 // next boundary to consider
  let prevSlot = -1
  for (let i = 0; i < total; i++) {
    const pKey = minuteKeyForOffset(pings[i]!.capturedAtMs, offsetMinutes)
    while (next < n && boundaries[next]!.minuteKey <= pKey) {
      active = next
      next++
    }
    let slot: number
    if (active === -1) slot = 0
    else if (active === n - 1 && submittedKey !== null && pKey >= submittedKey) slot = n + 1
    else slot = active + 1
    if (slot > prevSlot) {
      // Fill this slot and every skipped (empty) slot below it with this first index.
      for (let k = prevSlot + 1; k <= slot; k++) slotStart[k] = i
      prevSlot = slot
    }
  }

  // 3. Materialise ranges. Slot s spans [slotStart[s], end), where end is the next slot's start
  //    (or the trail end for the last slot). Skipped slots have start === next start, so empty.
  const endOf = (s: number): number => (s + 1 < SLOTS ? slotStart[s + 1]! : total)
  const segments: OrderSegment[] = boundaries.map((b, a) => ({
    orderId: b.orderId,
    providerOrderNo: b.providerOrderNo,
    minuteKey: b.minuteKey,
    pingStartIndex: slotStart[a + 1]!,
    pingEndIndex: endOf(a + 1),
  }))

  return {
    boundaries,
    segments,
    untimedOrderIds,
    beforeFirst: { pingStartIndex: slotStart[0]!, pingEndIndex: endOf(0) },
    afterClose: { pingStartIndex: slotStart[n + 1]!, pingEndIndex: endOf(n + 1) },
  }
}
