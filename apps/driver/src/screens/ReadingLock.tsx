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
 * takes, and gets out of the way the moment the read lands. Nothing is cancelled and nothing is
 * lost — the upload underneath keeps running, which is the part BR5 gates on.
 *
 * `pointer-events` on the cover is the whole mechanism: it swallows the taps rather than disabling
 * a hundred controls one by one, and it cannot leave a control stuck disabled if a read never
 * returns, because it unmounts with `active`.
 */
export function ReadingLock({ active, children }: { active: boolean; children: ReactNode }): ReactNode {
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
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          <span className="inline-block size-3 animate-pulse rounded-full bg-sky-500 motion-reduce:animate-none" />
          <p className="px-4 text-center text-sm font-medium text-slate-700">{t.shift.cloudReading}</p>
          <p className="px-4 text-center text-xs text-slate-500">{t.shift.readingMayTake}</p>
        </div>
      ) : null}
    </div>
  )
}
