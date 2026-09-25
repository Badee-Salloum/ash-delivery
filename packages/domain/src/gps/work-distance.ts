import { distanceMetres } from '../geo/haversine.ts'

/** Capture-ordered telemetry and server-owned work/break boundaries, all in milliseconds. */
export interface WorkPing {
  readonly lat: number
  readonly lng: number
  readonly accuracyM: number | null
  readonly capturedAtMs: number
}

export interface WorkBreak {
  readonly startedAtMs: number
  readonly endedAtMs: number | null
}

export type WorkPingPhase = 'before_work' | 'work' | 'break' | 'after_close'

export interface WorkDistance {
  /** Null means no usable consecutive pair was recorded. A valid stationary pair measures zero. */
  readonly distanceMetres: number | null
  /** Fraction of working time spanned by valid GPS edges, expressed as a whole percent. */
  readonly coveragePercent: number | null
  readonly validEdgeCount: number
  readonly workDurationMs: number | null
  readonly coveredDurationMs: number
  readonly phases: readonly WorkPingPhase[]
  /** An edge ends at this ping; null when it cannot safely count as work movement. */
  readonly edgeMetres: readonly (number | null)[]
}

const MAX_GAP_MS = 5 * 60_000
/** A material recording gap must be visible even when the remaining trace looks plausible. */
export const GPS_COMPLETE_COVERAGE_PERCENT = 95
const MAX_ACCURACY_M = 100
const MAX_SPEED_MPS = 120 / 3.6

/**
 * Conservatively measure only contiguous recorded work. No edge may bridge a break, the end
 * submission, a >5 minute outage, a poor fix, or a physically implausible jump.
 */
export function workDistance(input: {
  readonly pings: readonly WorkPing[]
  readonly windowOpensAtMs: number | null
  readonly submittedAtMs: number | null
  readonly asOfMs: number
  readonly breaks: readonly WorkBreak[]
}): WorkDistance {
  const { pings, windowOpensAtMs, submittedAtMs, asOfMs, breaks } = input
  const endMs = submittedAtMs ?? asOfMs
  const hasWindow = windowOpensAtMs !== null && Number.isFinite(windowOpensAtMs) && Number.isFinite(endMs) && endMs >= windowOpensAtMs
  const closedBreaks = breaks
    .map((item) => ({ start: item.startedAtMs, end: item.endedAtMs ?? endMs }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const item of closedBreaks) {
    const last = merged.at(-1)
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end)
    else merged.push({ ...item })
  }
  const phaseAt = (atMs: number): WorkPingPhase => {
    if (!hasWindow || atMs < windowOpensAtMs) return 'before_work'
    if (atMs >= endMs) return 'after_close'
    return merged.some((item) => atMs >= item.start && atMs < item.end) ? 'break' : 'work'
  }
  const phases = pings.map((ping) => phaseAt(ping.capturedAtMs))
  const edgeMetres: Array<number | null> = new Array(pings.length).fill(null)
  let metres = 0
  let coveredDurationMs = 0
  let validEdgeCount = 0
  for (let i = 1; i < pings.length; i++) {
    const prev = pings[i - 1]!
    const next = pings[i]!
    const elapsed = next.capturedAtMs - prev.capturedAtMs
    if (phases[i - 1] !== 'work' || phases[i] !== 'work' || elapsed <= 0 || elapsed > MAX_GAP_MS) continue
    if ((prev.accuracyM ?? 0) > MAX_ACCURACY_M || (next.accuracyM ?? 0) > MAX_ACCURACY_M) continue
    if (merged.some((item) => prev.capturedAtMs < item.end && next.capturedAtMs > item.start)) continue
    const edge = distanceMetres(prev, next)
    if (!Number.isFinite(edge) || edge / (elapsed / 1000) > MAX_SPEED_MPS) continue
    edgeMetres[i] = edge
    metres += edge
    coveredDurationMs += elapsed
    validEdgeCount++
  }
  let workDurationMs: number | null = null
  if (hasWindow) {
    const breakDuration = merged.reduce((sum, item) =>
      sum + Math.max(0, Math.min(item.end, endMs) - Math.max(item.start, windowOpensAtMs)), 0)
    workDurationMs = Math.max(0, endMs - windowOpensAtMs - breakDuration)
  }
  return {
    distanceMetres: validEdgeCount ? metres : null,
    coveragePercent: workDurationMs === null || workDurationMs === 0
      ? null
      : Math.min(100, Math.round(coveredDurationMs / workDurationMs * 100)),
    validEdgeCount,
    workDurationMs,
    coveredDurationMs,
    phases,
    edgeMetres,
  }
}

/** Sum the already-validated edges wholly inside a displayed ping range. */
export function workDistanceForRange(distance: WorkDistance, start: number, end: number): number | null {
  let found = false
  let metres = 0
  for (let i = start + 1; i < end; i++) {
    const edge = distance.edgeMetres[i]
    if (edge === null || edge === undefined) continue
    found = true
    metres += edge
  }
  return found ? metres : null
}
