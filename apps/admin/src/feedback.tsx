import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from './app-context.tsx'
import { Button } from './ui.tsx'

/**
 * The feedback layer: transient toasts and a promise-returning confirm dialog, rendered once at the
 * app root. Before this, eight screens each hand-rolled an inline `<p>` (in two clashing reds) and
 * destructive actions fired with no confirmation and swallowed errors. This is the single place a
 * success or failure is announced, and the single gate before an irreversible action.
 */

// ── Toasts ──────────────────────────────────────────────────────────────────────────────────
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
  if (!ctx) throw new Error('useToast must be used inside <FeedbackProvider>')
  return ctx
}

// ── Confirm ─────────────────────────────────────────────────────────────────────────────────
interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}
type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>
const ConfirmCtx = createContext<ConfirmFn | null>(null)

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmCtx)
  if (!ctx) throw new Error('useConfirm must be used inside <FeedbackProvider>')
  return ctx
}

export function FeedbackProvider({ children }: { children: ReactNode }): ReactNode {
  const { t } = useApp()

  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const pushToast = useCallback((kind: ToastItem['kind'], msg: string) => {
    const id = nextId.current++
    setToasts((list) => [...list, { id, kind, msg }])
    // Auto-dismiss; errors linger a little longer than confirmations.
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500)
  }, [])
  const toastApi = useMemo<ToastApi>(
    () => ({ success: (m) => pushToast('success', m), error: (m) => pushToast('error', m) }),
    [pushToast],
  )

  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)
  const confirm = useCallback<ConfirmFn>(
    (options) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  )
  const settle = useCallback(
    (value: boolean) => {
      setPending((cur) => {
        cur?.resolve(value)
        return null
      })
    },
    [],
  )

  // Esc cancels the dialog — a modal you can't dismiss with the keyboard is a trap.
  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') settle(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, settle])

  return (
    <ToastCtx.Provider value={toastApi}>
      <ConfirmCtx.Provider value={confirm}>
        {children}

        {/* Toast stack — bottom-centre, symmetric insets so it reads the same in RTL and LTR. */}
        <div
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4"
        >
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role="status"
              className={`pointer-events-auto max-w-sm rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-lg ${
                toast.kind === 'error' ? 'bg-red-600' : 'bg-emerald-600'
              }`}
            >
              {toast.msg}
            </div>
          ))}
        </div>

        {/* Confirm dialog */}
        {pending ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
            onClick={() => settle(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={pending.title}
              className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-base font-bold text-slate-800">{pending.title}</h2>
              {pending.body ? <p className="mt-2 text-sm text-slate-500">{pending.body}</p> : null}
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => settle(false)}>
                  {pending.cancelLabel ?? t.common.cancel}
                </Button>
                <Button
                  variant={pending.danger ? 'danger' : 'primary'}
                  autoFocus
                  onClick={() => settle(true)}
                >
                  {pending.confirmLabel ?? t.common.confirm}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  )
}
