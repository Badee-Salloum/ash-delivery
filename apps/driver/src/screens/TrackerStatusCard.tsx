import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { formatDateTimeSeconds, formatGpsFailureReason } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { nativeTrackerStatus, openNativeTrackingSettings, setupNativeTrackingReliability, syncNativeTracking, type NativeTrackerStatus } from '../native-tracker.ts'
import { Button, Card } from '../ui.tsx'

/** Phone-local health remains useful when the network is down. No coordinates enter diagnostics. */
export function TrackerStatusCard({ shiftId }: { shiftId: string }): ReactNode {
  const { lang, t } = useApp()
  const [status, setStatus] = useState<NativeTrackerStatus | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(() => {
    void nativeTrackerStatus().then(setStatus)
    setOnline(typeof navigator === 'undefined' || navigator.onLine)
    setNow(Date.now())
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 15_000)
    const visible = (): void => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', refresh)
      window.removeEventListener('offline', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh])

  if (!status) return null
  const stale = status.lastCapturedAtMs != null && now - status.lastCapturedAtMs > 5 * 60_000
  const alert = failure ?? (status.queueAvailable === false ? t.gpsTracking.queueUnavailable :
    status.serviceRunning === false ? t.gpsTracking.serviceStopped :
    !status.permission || status.locationEnabled === false ? t.gpsTracking.noRecentCapture :
    stale ? t.gpsTracking.noRecentCapture : null)
  const stamp = (time: number | null | undefined): string =>
    time == null ? t.gpsTracking.never : formatDateTimeSeconds(new Date(time).toISOString(), lang)
  const lastFailure = status.lastFailureReason ?? null
  const sessionExpired = lastFailure === 'auth_expired' || lastFailure === 'unauthorized' ||
    lastFailure === 'session_expired' || lastFailure === 'session_required'
  const reasons = Object.entries(status.rejectionReasons ?? {}).filter(([, count]) => count > 0)

  return (
    <Card>
      <h2 className="mb-2 font-semibold">{t.gpsTracking.title}</h2>
      {alert ? <p role="alert" className="mb-2 rounded-lg border border-danger-line bg-danger-surface p-2 text-sm font-semibold text-danger-ink">{alert}</p> : null}
      {sessionExpired ? <p role="alert" className="mb-2 text-sm font-semibold text-danger-ink">{t.gpsTracking.loginRequired}</p> : null}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt>{t.gpsTracking.permission}</dt><dd>{status.permissionState === 'precise' ? t.gpsTracking.precise : status.permissionState === 'approximate' ? t.gpsTracking.approximate : status.permissionState === 'denied' ? t.gpsTracking.denied : status.permission ? t.gpsTracking.enabled : t.gpsTracking.unknown}</dd>
        <dt>{t.gpsTracking.service}</dt><dd>{status.serviceRunning === true ? t.gpsTracking.enabled : status.serviceRunning === false ? t.gpsTracking.disabled : t.gpsTracking.unknown}</dd>
        <dt>{t.gpsTracking.network}</dt><dd>{status.network === 'unknown' ? t.gpsTracking.unknown : (status.network ?? (online ? 'online' : 'offline')) === 'online' ? t.gpsTracking.online : t.gpsTracking.offline}</dd>
        {status.backgroundPermission !== undefined ? <><dt>{t.gpsTracking.backgroundPermission}</dt><dd>{status.backgroundPermission ? t.gpsTracking.enabled : t.gpsTracking.disabled}</dd></> : null}
        {status.notificationPermission !== undefined ? <><dt>{t.gpsTracking.notificationPermission}</dt><dd>{status.notificationPermission ? t.gpsTracking.enabled : t.gpsTracking.disabled}</dd></> : null}
        {status.batteryOptimizationExempt !== undefined ? <><dt>{t.gpsTracking.batteryOptimization}</dt><dd>{status.batteryOptimizationExempt ? t.gpsTracking.enabled : t.gpsTracking.disabled}</dd></> : null}
        {status.autostartGuidanceRequired ? <><dt>{t.gpsTracking.autostartStatus}</dt><dd>{status.autostartAcknowledged ? t.gpsTracking.autostartDeclared : t.gpsTracking.autostartNotDeclared}</dd></> : null}
        <dt>{t.gpsTracking.lastCapture}</dt><dd className="num">{stamp(status.lastCapturedAtMs)}</dd>
        <dt>{t.gpsTracking.lastUpload}</dt><dd className="num">{stamp(status.lastUploadedAtMs)}</dd>
      </dl>
      {status.queueAvailable !== false ? <p className="mt-2 text-sm">{t.gpsTracking.pending.replace('{n}', String(status.pendingCount ?? 0))}</p> : null}
      {(status.pendingCount ?? 0) >= 48_000 ? <p role="alert" className="mt-1 text-sm font-semibold text-warning-ink">{t.gpsTracking.nearCapacity}</p> : null}
      {(status.rejectedCount ?? 0) > 0 ? <p className="mt-1 text-sm text-warning-ink">{t.gpsTracking.rejected.replace('{n}', String(status.rejectedCount))}</p> : null}
      {reasons.length > 0 ? <p className="mt-1 text-sm text-warning-ink">{t.gpsTracking.rejectionReasons.replace('{reasons}', reasons.map(([reason, count]) => `${formatGpsFailureReason(reason, t.gpsTracking)}: ${count}`).join(' · '))}</p> : null}
      {(status.droppedExpired ?? 0) + (status.droppedCapacity ?? 0) > 0 ? (
        <p role="alert" className="mt-1 text-sm font-semibold text-danger-ink">
          {t.gpsTracking.lost.replace('{expired}', String(status.droppedExpired ?? 0)).replace('{capacity}', String(status.droppedCapacity ?? 0))}
        </p>
      ) : null}
      {(status.storageFailedCount ?? 0) > 0 ? <p role="alert" className="mt-1 text-sm font-semibold text-danger-ink">{t.gpsTracking.storageFailed.replace('{n}', String(status.storageFailedCount))}</p> : null}
      {lastFailure && !sessionExpired ? <p className="mt-1 text-xs text-warning-ink">{t.gpsTracking.failure.replace('{reason}', formatGpsFailureReason(lastFailure, t.gpsTracking))}</p> : null}
      {(status.backgroundPermission === false || status.notificationPermission === false || status.batteryOptimizationExempt === false) ? (
        <Button className="mt-2" onClick={() => void setupNativeTrackingReliability().then(async (readiness) => {
          if (readiness?.backgroundPermission === false) await openNativeTrackingSettings('background')
          else if (readiness?.notificationPermission === false) await openNativeTrackingSettings('notifications')
          else if (readiness?.batteryOptimizationExempt === false) await openNativeTrackingSettings('battery')
          refresh()
        }).catch(refresh)}>{t.gpsTracking.setupReliability}</Button>
      ) : null}
      {alert ? (
        <Button className="mt-2" onClick={() => {
          setFailure(null)
          void syncNativeTracking(shiftId).then((result) => {
            if (result?.started === false) setFailure(result.reason ?? t.gpsTracking.service_start_failed)
            refresh()
          })
        }}>{t.gpsTracking.restart}</Button>
      ) : null}
    </Card>
  )
}
