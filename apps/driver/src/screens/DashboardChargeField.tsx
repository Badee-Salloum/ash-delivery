import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { parseNonNegativeInteger } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Field, TextInput } from '../ui.tsx'
import { SourceMark, sourceOf } from './ReadingSource.tsx'

export function dashboardPercent(value: string): number | null {
  const parsed = parseNonNegativeInteger(value)
  return parsed !== null && parsed <= 100 ? parsed : null
}

/** The odometer attachment proves both figures; no second battery image is requested. */
export function DashboardChargeField({
  shiftId, pkg, batteryId, mediaId, persisted, value, ocrValue, humanEdited, onChange, onReady,
}: {
  shiftId: string
  pkg: 'start' | 'end'
  batteryId: string | null
  mediaId: string | null
  persisted: { mediaId: string; percent: number } | null
  value: string
  ocrValue: number | null
  humanEdited: boolean
  onChange(value: string): void
  onReady(ready: boolean): void
}): ReactNode {
  const { api, t } = useApp()
  const [error, setError] = useState(false)
  const desired = useRef<{ mediaId: string; percent: number; batteryId: string; source: 'ocr' | 'manual'; ocrValue: number | null } | null>(null)
  const saved = useRef(persisted)
  const running = useRef(false)
  const mounted = useRef(true)
  const readyCallback = useRef(onReady)
  readyCallback.current = onReady
  const percent = dashboardPercent(value)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const flush = useCallback(async (): Promise<void> => {
    if (running.current) return
    running.current = true
    try {
      while (desired.current !== null) {
        const target = desired.current
        try {
          await api.putBatteryReadings(shiftId, pkg, [{
            batteryId: target.batteryId,
            percent: target.percent,
            source: target.source,
            expectedMediaId: target.mediaId,
            ocrRaw: target.ocrValue === null ? null : { percent: String(target.ocrValue) },
          }])
        } catch {
          if (mounted.current && desired.current === target) setError(true)
          if (desired.current === target) return
          continue
        }
        if (desired.current === target) {
          saved.current = { mediaId: target.mediaId, percent: target.percent }
          if (mounted.current) readyCallback.current(true)
          return
        }
        saved.current = { mediaId: target.mediaId, percent: target.percent }
      }
    } finally {
      running.current = false
    }
  }, [api, shiftId, pkg])

  useEffect(() => {
    onReady(false)
    setError(false)
    desired.current = !batteryId || !mediaId || percent === null ? null : {
      batteryId, mediaId, percent, ocrValue,
      source: !humanEdited && percent === ocrValue ? 'ocr' : 'manual',
    }
    if (desired.current && saved.current?.mediaId === desired.current.mediaId &&
        saved.current.percent === desired.current.percent) {
      if (!running.current) onReady(true)
      return
    }
    void flush()
  }, [batteryId, mediaId, percent, ocrValue, humanEdited, onReady, flush])

  return (
    <div className="flex flex-col gap-1">
      <Field label={t.battery.percent}>
        <TextInput
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
      <SourceMark source={sourceOf({ ocrValue, hadImage: mediaId !== null, value })} />
      {error ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-danger-ink">{t.common.actionFailed}</p>
          <button type="button" onClick={() => { setError(false); void flush() }} className="text-sm underline">
            {t.common.retry}
          </button>
        </div>
      ) : null}
    </div>
  )
}
