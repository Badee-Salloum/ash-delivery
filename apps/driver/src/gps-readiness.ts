/** Retry only a rejected capture timestamp. Never rewrite it or replay the rejected fix. */
export async function confirmReadinessWithFreshFix<Fix extends { capturedAtMs: number }>(input: {
  read: (forceFresh: boolean) => Promise<Fix | null>
  confirm: (fix: Fix) => Promise<unknown>
  onRefreshing: () => void
  forceFresh?: boolean
}): Promise<boolean> {
  const first = await input.read(input.forceFresh ?? false)
  if (first === null) return false
  try {
    await input.confirm(first)
    return true
  } catch (error) {
    if (!isGpsTimingRejection(error)) throw error
    input.onRefreshing()
    const fresh = await input.read(true)
    if (fresh === null) return false
    // Older Android shells may ignore forceFresh. Repeating the same timestamp is not a new fix.
    if (fresh.capturedAtMs === first.capturedAtMs) throw error
    await input.confirm(fresh)
    return true
  }
}

export function isGpsTimingRejection(error: unknown): boolean {
  return error !== null && typeof error === 'object' &&
    (error as { error?: unknown }).error === 'gps_fix_not_fresh'
}

export interface GpsTimingFailureCopy {
  fixTooOld: string
  fixInFuture: string
  fixTimingRejected: string
}

/** The difference is the age of a fix, not a proven measurement of the phone's clock drift. */
export function describeGpsTimingFailure(error: unknown, copy: GpsTimingFailureCopy): string | null {
  if (!isGpsTimingRejection(error)) return null
  const detail = (error as { detail?: unknown }).detail
  if (detail === null || typeof detail !== 'object') return copy.fixTimingRejected
  const { reason, ageMs } = detail as { reason?: unknown; ageMs?: unknown }
  if (typeof ageMs !== 'number' || !Number.isSafeInteger(ageMs)) return copy.fixTimingRejected
  const seconds = String(Math.ceil(Math.abs(ageMs) / 1_000))
  if (reason === 'stale' && ageMs > 0) return copy.fixTooOld.replace('{seconds}', seconds)
  if (reason === 'future' && ageMs < 0) return copy.fixInFuture.replace('{seconds}', seconds)
  return copy.fixTimingRejected
}
