import type { ReactNode } from 'react'
import { useApp } from '../app-context.tsx'
import type { CloudReadEvent } from './PhotoSlot.tsx'

/**
 * What the cloud reader is doing, said out loud.
 *
 * It said nothing at all until now. `PhotoSlot` has always emitted `reading` and `failed` — every
 * consumer opened with `if (e.status !== 'read') return`, so both were thrown away. In practice
 * that meant the wallet and odometer tiles sat blank for up to twenty-five seconds while a model
 * read the photo, and when it timed out they sat blank permanently. The driver could not tell a
 * slow read from a dead one, and the only honest thing he could do was wait and hope.
 *
 * THREE OUTCOMES, DELIBERATELY DISTINGUISHED, because the right response differs:
 *
 *   timeout      it answered too slowly. Trying again often works — so there is a button.
 *   unavailable  no reader reached: offline, switched off, or the shift's cost cap is spent.
 *                Nothing to retry; the phone's own reading is already in the field.
 *   no_fields    it looked and found no number. Retrying the same pixels will not change that.
 *
 * A success is shown quietly and only where the value is not already obvious — the point is to
 * explain a WAIT and a FAILURE, not to congratulate the app for working.
 *
 * `null` renders nothing, which is the state the tile spends almost all of its life in.
 */
export function CloudReadStatus({
  event,
  onRetry,
}: {
  event: CloudReadEvent | null
  /** Offered only for a timeout. Omit it and the timeout is stated without a button. */
  onRetry?: () => void
}): ReactNode {
  const { t } = useApp()
  if (event === null) return null

  if (event.status === 'reading') {
    return (
      <p className="flex items-center gap-2 text-center text-sm text-slate-500" aria-live="polite">
        {/* A pulse rather than a spinner: this runs for tens of seconds, and a spinner that long
            reads as stuck. `motion-reduce` stops it for anyone who has asked it to. */}
        <span className="inline-block size-2 shrink-0 animate-pulse rounded-full bg-sky-500 motion-reduce:animate-none" />
        {t.shift.cloudReading}
      </p>
    )
  }

  if (event.status === 'read') return null

  const message =
    event.reason === 'timeout'
      ? t.shift.cloudTimeout
      : event.reason === 'no_fields'
        ? t.shift.cloudNoFields
        : event.reason === 'refused'
          ? t.shift.cloudRefused
          : t.shift.cloudUnavailable

  return (
    <div className="flex flex-col items-start gap-1" aria-live="polite">
      {/* Amber, not red. Nothing is broken and nothing is lost — the phone's own reading is in the
          field and the driver can type over it. Red would say "your shift is in trouble". */}
      <p className="text-sm font-medium text-amber-800">{message}</p>
      {event.reason === 'timeout' && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-amber-100 px-3 py-1 text-sm font-medium text-amber-900"
        >
          {t.shift.cloudRetry}
        </button>
      ) : null}
    </div>
  )
}
