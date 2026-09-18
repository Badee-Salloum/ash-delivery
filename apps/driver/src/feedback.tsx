import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

/**
 * A toast for the driver PWA. A driver in the field can't read a console or retry a curl — when a
 * package upload or a shift action fails, the failure has to be visible on the glass. This is that
 * surface: bottom-of-screen, above the footer, auto-dismissing, high-contrast.
 */
interface ToastItem {
  id: number
  kind: 'success' | 'error'
  msg: string
}
interface ToastApi {
  success(msg: string): void
  error(msg: string): void
}
const ToastCtx = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const push = useCallback((kind: ToastItem['kind'], msg: string) => {
    const id = nextId.current++
    setToasts((list) => [...list, { id, kind, msg }])
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500)
  }, [])
  const api = useMemo<ToastApi>(() => ({ success: (m) => push('success', m), error: (m) => push('error', m) }), [push])

  return (
    <ToastCtx.Provider value={api}>
      {children}
      {/* ABOVE the footer. Both were fixed to bottom-0, so a failed submit put a red banner on top
          of the submit button for six seconds — the driver read "action failed", reached to retry,
          and tapped the toast instead. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4"
        style={{ paddingBottom: 'calc(6rem + env(safe-area-inset-bottom))' }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={`pointer-events-auto max-w-sm rounded-2xl px-5 py-3 text-base font-semibold text-white shadow-lg ${
              toast.kind === 'error' ? 'bg-danger-solid' : 'bg-success-solid'
            }`}
          >
            {toast.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
