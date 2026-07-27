import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useApp } from './app-context.tsx'

/**
 * The bell (SRS A-6) — «جرس بعداد». Until now the platform only surfaced an unread COUNT on the
 * Queue tab; the document-expiry alerts from Section B rang a bell with no face. This is that face:
 * a dropdown listing every notification kind, translated, newest-first, click-to-read-and-go.
 */
export interface Notif {
  id: number
  kind: string
  payload: Record<string, unknown>
  read: boolean
  createdAt: string
}

/** «منذ …» / «… ago» — a light relative time; the exact timestamp is not what the bell is for. */
function relTime(iso: string, nowMs: number, ago: (n: number, unit: 'm' | 'h' | 'd') => string): string {
  const diff = Math.max(0, nowMs - new Date(iso).getTime())
  const min = Math.floor(diff / 60000)
  if (min < 60) return ago(min, 'm')
  const hr = Math.floor(min / 60)
  if (hr < 24) return ago(hr, 'h')
  return ago(Math.floor(hr / 24), 'd')
}

export function NotificationBell({
  notifications,
  onMarkRead,
  onNavigate,
}: {
  notifications: Notif[]
  onMarkRead(id: number): void
  onNavigate(n: Notif): void
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const unread = notifications.filter((n) => !n.read).length

  // Close on an outside click — a dropdown that only closes by re-clicking the trigger feels stuck.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const nowMs = Date.now()
  const ago = (n: number, unit: 'm' | 'h' | 'd'): string => t.common.ago.replace('{n}', String(n)).replace('{u}', t.common.units[unit])
  const label = (kind: string): string => (t.notifications.kinds as Record<string, string>)[kind] ?? kind

  return (
    <div ref={ref} className="relative">
      <button
        aria-label={t.common.notifications}
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-lg p-2 text-slate-600 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {unread > 0 ? (
          <span className="absolute -top-0.5 end-0 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-bold leading-4 text-white">
            {unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute end-0 top-full z-50 mt-2 max-h-96 w-72 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl">
          <div className="px-3 py-2 text-xs font-bold text-slate-500">{t.notifications.title}</div>
          {notifications.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-slate-400">{t.notifications.empty}</p>
          ) : (
            notifications.slice(0, 20).map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  onMarkRead(n.id)
                  onNavigate(n)
                  setOpen(false)
                }}
                className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-start outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  n.read ? 'text-slate-500' : 'font-semibold text-slate-800'
                }`}
              >
                <span className="flex items-center gap-2">
                  {n.read ? null : <span className="inline-block size-2 rounded-full bg-red-500" aria-hidden="true" />}
                  {label(n.kind)}
                </span>
                <span className="text-xs font-normal text-slate-400">{relTime(n.createdAt, nowMs, ago)}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
