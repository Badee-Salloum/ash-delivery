/** Coordinate-free decision inputs for an identified, offline GPS batch. */
export interface IdentifiedGpsFix {
  pointId: string
  lat: number
  lng: number
  accuracyM: number | null
  capturedAtMs: number
}

export interface GpsCaptureWindow {
  startedAtMs: number
  endedAtMs: number | null
}

export interface GpsPointReceipt {
  pointId: string
  status: 'stored' | 'duplicate' | 'rejected'
  reason?: string
}

export interface GpsBatchReceipts {
  results: GpsPointReceipt[]
  accepted: number
  duplicates: number
  rejected: number
}

/** Prefer the transition log. Old shifts can use the server-stamped shift bounds. */
export function effectiveGpsCaptureWindows(
  recorded: readonly GpsCaptureWindow[],
  fallbackStartMs: number,
  fallbackEndMs: number,
  trackingActive: boolean,
): GpsCaptureWindow[] {
  const candidates = recorded.length > 0 ? recorded :
    Number.isFinite(fallbackStartMs) && (trackingActive || Number.isFinite(fallbackEndMs))
      ? [{ startedAtMs: fallbackStartMs, endedAtMs: Number.isFinite(fallbackEndMs) ? fallbackEndMs : null }]
      : []
  return candidates.flatMap((window) => {
    const end = window.endedAtMs ??
      (trackingActive ? null : Number.isFinite(fallbackEndMs) ? fallbackEndMs : null)
    if (!trackingActive && end === null) return []
    return [{ startedAtMs: window.startedAtMs, endedAtMs: end }]
  }).sort((a, b) => a.startedAtMs - b.startedAtMs)
}

export interface GpsIngestPlan {
  selected: IdentifiedGpsFix[]
  considered: { fix: IdentifiedGpsFix; reason: string | null }[]
  known: ReadonlySet<string>
}

/** Decide eligibility after the repository has locked the shift's tracking boundary. */
export function planIdentifiedGpsIngest(input: {
  fixes: readonly IdentifiedGpsFix[]
  windows: readonly GpsCaptureWindow[]
  knownIds: readonly string[]
  storedCount: number
  maxStored: number
  nowMs: number
  retentionMs: number
}): GpsIngestPlan {
  const { fixes, windows, storedCount, maxStored, nowMs, retentionMs } = input
  const known = new Set(input.knownIds)
  const considered = fixes.map((fix) => {
    let reason: string | null = null
    if (windows.length === 0) reason = 'tracking_window_unavailable'
    else if (fix.capturedAtMs < nowMs - retentionMs) reason = 'older_than_7_days'
    else if (fix.capturedAtMs > nowMs + 5 * 60_000) reason = 'future_capture_time'
    else if (!windows.some((window) => fix.capturedAtMs >= window.startedAtMs &&
      (window.endedAtMs === null || fix.capturedAtMs <= window.endedAtMs))) {
      const last = windows[windows.length - 1]!
      reason = fix.capturedAtMs < windows[0]!.startedAtMs ? 'before_driver_confirmation'
        : last.endedAtMs !== null && fix.capturedAtMs > last.endedAtMs
          ? 'after_tracking_ended' : 'outside_tracking_window'
    }
    return { fix, reason }
  })
  const eligible = considered.filter((entry) => entry.reason === null && !known.has(entry.fix.pointId))
  const capacity = Math.max(0, maxStored - storedCount)
  const selected: IdentifiedGpsFix[] = []
  const selectedIds = new Set<string>()
  for (const entry of eligible) {
    if (selectedIds.has(entry.fix.pointId)) continue
    if (selected.length >= capacity) { entry.reason = 'shift_point_quota'; continue }
    selectedIds.add(entry.fix.pointId)
    selected.push(entry.fix)
  }
  selected.sort((a, b) => a.capturedAtMs - b.capturedAtMs)
  return { selected, considered, known }
}

/** Convert insert RETURNING IDs to receipts without dropping any rejected point. */
export function gpsIngestReceipts(plan: GpsIngestPlan, insertedIds: readonly string[]): GpsBatchReceipts {
  const inserted = new Set(insertedIds)
  const selected = new Set(plan.selected)
  const firstStored = new Set<string>()
  const results: GpsPointReceipt[] = plan.considered.map(({ fix, reason }) => {
    if (plan.known.has(fix.pointId)) return { pointId: fix.pointId, status: 'duplicate' }
    if (reason !== null) return { pointId: fix.pointId, status: 'rejected', reason }
    if (selected.has(fix) && inserted.has(fix.pointId) && !firstStored.has(fix.pointId)) {
      firstStored.add(fix.pointId)
      return { pointId: fix.pointId, status: 'stored' }
    }
    if (inserted.has(fix.pointId)) return { pointId: fix.pointId, status: 'duplicate' }
    // A concurrent insert outside this batch won the UUID uniqueness race.
    return { pointId: fix.pointId, status: 'duplicate' }
  })
  return {
    results,
    accepted: results.filter((receipt) => receipt.status === 'stored').length,
    duplicates: results.filter((receipt) => receipt.status === 'duplicate').length,
    rejected: results.filter((receipt) => receipt.status === 'rejected').length,
  }
}
