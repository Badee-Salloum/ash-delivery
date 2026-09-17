/**
 * The console's view of a shift's shape and pattern.
 *
 * The rules themselves — single/double/pending, and the per-pattern targets — are the domain's
 * (`packages/domain/src/shift/shape.ts` and `worked-time.ts`), so the API, the dashboard and every
 * screen judge a shift the same way. This module re-exports them for the screens that already
 * import from here, and adds the one thing the domain may not hold: the words.
 */

import { SHIFT_TARGET_MINUTES, type ShiftPattern, type ShiftSlot } from '@ash/domain'

export { type ShapedShift, type ShiftShape, shiftShapeForDay, shiftShapeOf, shiftsByDriver } from '@ash/domain'

/** The strings a pattern badge is built from — `t.completedShifts` satisfies this. */
export interface ShiftPatternLabels {
  readonly patternDay: string
  readonly patternEvening: string
  readonly patternFull: string
  readonly patternUnknown: string
  /** «{pattern} · {h}س» — a judged pattern beside the owner's target for it. */
  readonly patternWithTarget: string
  /** «جارية» — a running shift whose slot is not known. */
  readonly running: string
  /** «جارية — {slot}» — a running shift: its slot is certain, its pattern is not yet. */
  readonly runningSlot: string
}

/** As much of the API's `worked` object as a badge reads. An older API serves no `slot`. */
export interface LabelledWorked {
  readonly pattern: ShiftPattern
  readonly slot?: ShiftSlot | null | undefined
  readonly abandoned?: boolean | undefined
}

/**
 * «صباحية · 8س», «مسائية · 8س», «دبل · 12س», or «جارية — صباحية» for a shift still out.
 *
 * `running` comes from the caller because only the caller knows the shift's STATE: an `unknown`
 * pattern on the live board is a shift in progress, while on the history screen it is a cancelled
 * or pre-window row that must not be presented as running.
 *
 * A forgotten close keeps its slot's name but loses the target — it is never judged against one.
 */
export function shiftPatternLabel(
  worked: LabelledWorked | null | undefined,
  labels: ShiftPatternLabels,
  running = false,
): string {
  const name: Record<ShiftSlot | 'full', string> = {
    day: labels.patternDay,
    evening: labels.patternEvening,
    full: labels.patternFull,
  }
  if (!worked || worked.pattern === 'unknown') {
    if (!running) return labels.patternUnknown
    const slot = worked?.slot ?? null
    return slot === null ? labels.running : labels.runningSlot.replace('{slot}', name[slot])
  }
  const label = name[worked.pattern]
  const target = SHIFT_TARGET_MINUTES[worked.pattern]
  if (worked.abandoned === true || target === null) return label
  return labels.patternWithTarget.replace('{pattern}', label).replace('{h}', String(target / 60))
}

/** A double stands out; everything else — including a shift not yet classified — reads neutral. */
export function shiftPatternTone(worked: LabelledWorked | null | undefined): 'info' | 'neutral' {
  return worked?.pattern === 'full' ? 'info' : 'neutral'
}
