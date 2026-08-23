import type { ReactNode } from 'react'
import { useApp } from '../app-context.tsx'

/**
 * «تقفل الضغط عالشاشة طالما نحن بانتظار رد على قراءة» — hold the screen while a read is running.
 *
 * Asked for after a start package where the driver kept tapping during a read. Everything he taps
 * mid-read either fights the reader for the same field or arrives before the answer does: he types
 * a charge, the reading lands and does not overwrite it because his typing wins, and the manager's
 * review then reports a manual edit for a number he only pre-empted.
 *
 * A cover, not a modal. It sits over the content, states what is happening and how long it usually
 * takes, and gets out of the way the moment the read lands. On end-shift BMS reads the driver can
 * cancel only the reader and continue manually; the uploaded evidence and draft remain untouched.
 *
 * `pointer-events` on the cover is the whole mechanism: it swallows the taps rather than disabling
 * a hundred controls one by one. The browser deadline or manual escape clears `active`, so a request
 * whose transport never returns cannot leave the controls covered forever.
 */
export function ReadingLock({
  active,
  children,
  onContinueManually,
}: {
  active: boolean
  children: ReactNode
  /** End-shift escape hatch. Cancels only the reader; the already uploaded evidence stays attached. */
  onContinueManually?: () => void
}): ReactNode {
  const { t } = useApp()
  return (
    <div className="relative">
      {children}
      {active ? (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl bg-white/75 backdrop-blur-[1px]"
          role="status"
          aria-live="polite"
          // A tap that lands here is a tap the driver meant for a field underneath. Swallow it
          // rather than letting it through to a control whose value is about to be replaced.
          onClickCapture={(e) => {
            // The one intentional action on this cover must remain clickable. Everything below the
            // cover is still protected from a tap intended for a field the reader may fill.
            if ((e.target as HTMLElement).closest('[data-reading-lock-action]')) return
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          <span className="inline-block size-3 animate-pulse rounded-full bg-sky-500 motion-reduce:animate-none" />
          <p className="px-4 text-center text-sm font-medium text-slate-700">{t.shift.cloudReading}</p>
          <p className="px-4 text-center text-xs text-slate-500">{t.shift.readingMayTake}</p>
          {onContinueManually ? (
            <button
              type="button"
              data-reading-lock-action
              onClick={onContinueManually}
              className="mt-1 min-h-11 rounded-xl bg-amber-100 px-4 text-sm font-semibold text-amber-900"
            >
              {t.shift.continueManually}
            </button>
          ) : null}
          {onContinueManually ? (
            <p className="px-4 text-center text-xs font-medium text-emerald-800">
              {t.shift.continueManuallyHint}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
