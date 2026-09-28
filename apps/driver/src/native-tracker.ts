/** The Android shell owns capture and its durable SQLite upload queue. */

export interface NativePreflight {
  ready: boolean
  reason?: 'permission_denied' | 'location_disabled' | 'no_recent_fix' | 'poor_accuracy' | 'provider_error'
  capturedAtMs?: number
  accuracyM?: number
  nativeVersionCode?: number
  platform?: 'android'
}

export interface NativeTrackerStatus {
  available: boolean
  permission: boolean
  permissionState?: 'precise' | 'approximate' | 'denied'
  nativeVersionCode?: number
  locationEnabled?: boolean
  network?: 'online' | 'offline' | 'unknown'
  backgroundPermission?: boolean
  notificationPermission?: boolean
  serviceRunning?: boolean
  activeShiftId?: string | null
  lastCapturedAtMs?: number | null
  lastUploadedAtMs?: number | null
  pendingCount?: number
  queueAvailable?: boolean
  rejectedCount?: number
  rejectionReasons?: Record<string, number>
  droppedExpired?: number
  droppedCapacity?: number
  storageFailedCount?: number
  lastFailureReason?: string | null
}

interface AshTrackerPlugin {
  preflight?(): Promise<NativePreflight>
  setupReliability?(): Promise<{ backgroundPermission: boolean; notificationPermission: boolean }>
  start(options: { shiftId: string; origin: string; provisional?: boolean }): Promise<{ started: boolean; reason?: string }>
  stop(): Promise<void>
  status(): Promise<NativeTrackerStatus>
  retryUploads?(): Promise<void>
}

interface CapacitorGlobal {
  Capacitor?: { Plugins?: { AshTracker?: AshTrackerPlugin } }
}

function plugin(): AshTrackerPlugin | null {
  try {
    return (globalThis as CapacitorGlobal).Capacitor?.Plugins?.AshTracker ?? null
  } catch {
    return null
  }
}

export function nativeTrackerAvailable(): boolean {
  return plugin() !== null
}

/** Null means a browser or an older shell. The server rollout gate handles older shells. */
export async function preflightNativeTracker(): Promise<NativePreflight | null> {
  const tracker = plugin()
  if (!tracker?.preflight) return null
  try {
    return await tracker.preflight()
  } catch {
    return { ready: false, reason: 'provider_error' }
  }
}

export async function nativeTrackerStatus(): Promise<NativeTrackerStatus | null> {
  const tracker = plugin()
  if (!tracker) return null
  try {
    return await tracker.status()
  } catch {
    return null
  }
}

export async function setupNativeTrackingReliability(): Promise<void> {
  const tracker = plugin()
  if (tracker?.setupReliability) await tracker.setupReliability()
}

export async function retryNativeUploads(): Promise<void> {
  try { await plugin()?.retryUploads?.() } catch { /* The periodic worker still retries. */ }
}

/** A failed start is returned so the driver can see the tracking fault.
 * A provisional start captures to SQLite before server confirmation, but withholds upload until
 * the shift is confirmed. Calling start again without provisional activates the same service.
 */
export async function syncNativeTracking(
  shiftId: string | null,
  options: { provisional?: boolean } = {},
): Promise<{ started: boolean; reason?: string } | null> {
  const tracker = plugin()
  if (!tracker) return null
  try {
    if (shiftId === null) {
      await tracker.stop()
      return null
    }
    return await tracker.start({ shiftId, origin: globalThis.location?.origin ?? '', provisional: options.provisional ?? false })
  } catch {
    return { started: false, reason: 'service_start_failed' }
  }
}
