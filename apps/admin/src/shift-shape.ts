/**
 * «شيفت عادية او دبل» — the owner's question, and it has two right answers that look different.
 *
 * A driver has worked a DOUBLE in two distinct shapes, and a screen that reads only one of them is
 * wrong about roughly half the cases:
 *
 *   1. ONE `full` shift. The dominant shape in the data — 12:00 → 01:00, 36 of 129 measured shifts
 *      over a fortnight. One shift row, one driver, both slots.
 *   2. TWO shift rows on the same business date. Two ordinary shifts, same driver, same day.
 *
 * Reading only the pattern misses (2); counting only rows misses (1). Both are here.
 *
 * `pending` is not a hedge, it is the honest state. A morning start that is still running becomes a
 * single or a double depending on when the driver comes back, and `workedTime` deliberately refuses
 * to guess — a badge that said «عادية» at noon and «دبل» after midnight would be changing its story
 * in front of the manager. An EVENING start, by contrast, is unambiguous the moment it opens:
 * nothing it can still turn into is a day shift.
 *
 * `null` means «we know nothing», which is not the same as «عادية». A driver with orders but no
 * shift row in the range — a shift outside the window read, or one not yet created — must not be
 * labelled as having worked a normal shift.
 */

import type { ShiftPattern } from '@ash/domain'

export type ShiftShape = 'single' | 'double' | 'pending'

/** Just enough of a shift row to judge its shape. */
export interface ShapedShift {
  readonly worked?: { readonly pattern: ShiftPattern } | undefined
}

/**
 * One shift, judged alone — what the running-shifts board and a shift's own page can say.
 *
 * This cannot see a second shift on the same day, so it can never return `double` for shape (2).
 * Use `shiftShapeForDay` wherever all of a driver's shifts for the date are in hand.
 */
export function shiftShapeOf(shift: ShapedShift | null | undefined): ShiftShape | null {
  const pattern = shift?.worked?.pattern
  if (pattern === undefined) return null
  if (pattern === 'full') return 'double'
  if (pattern === 'unknown') return 'pending'
  return 'single'
}

/**
 * All of ONE driver's shifts on ONE business date.
 *
 * Two rows settle it immediately: whatever either pattern turns out to be, he worked twice. That is
 * why the count is checked before the pattern — a driver with a running morning shift AND a closed
 * one is a double already, and asking `workedTime` about the live row would only return `pending`.
 */
export function shiftShapeForDay(rows: readonly ShapedShift[]): ShiftShape | null {
  if (rows.length === 0) return null
  if (rows.length > 1) return 'double'
  return shiftShapeOf(rows[0])
}

/** Group a day's shifts by driver, ready for `shiftShapeForDay`. */
export function shiftsByDriver<T extends { driverId: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const existing = grouped.get(row.driverId)
    if (existing) existing.push(row)
    else grouped.set(row.driverId, [row])
  }
  return grouped
}
