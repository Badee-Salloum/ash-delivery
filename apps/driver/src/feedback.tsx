import { type ReactNode, createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useApp } from './app-context.tsx'
import { Button } from './ui.tsx'

/** Transient results belong in a toast; a choice that can abandon or replace work belongs in a modal. */
interface ToastItem {
  id: number
  kind: 'success' | 'error'
  msg: string
}

interface ToastApi {
  success(msg: string): void
  error(msg: string): void
}

export interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

interface PendingConfirm extends ConfirmOptions {
  resolve(value: boolean): void
}

const ToastCtx = createContext<ToastApi | null>(null)
const ConfirmCtx = createContext<ConfirmFn | null>(null)

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx)
  if (!ctx) throw new Error('useToast must be used inside <FeedbackProvider>')
  return ctx
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmCtx)
  if (!ctx) throw new Error('useConfirm must be used inside <FeedbackProvider>')
  return ctx
}

function dialogControls(dialog: HTMLElement | null): HTMLElement[] {
  if (!dialog) return []
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((node) => !node.hasAttribute('hidden') && node.getClientRects().length > 0)
}

/**
 * The one feedback surface for the driver app. It does not use browser prompts: those are
 * unstyled, cannot explain the risk, and do not reliably restore focus on Android WebView.
 */
export function FeedbackProvider({ children }: { children: ReactNode }): ReactNode {
  const { t } = useApp()
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextToastId = useRef(1)
  const toastTimers = useRef<Map<number, number>>(new Map())

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimers.current.get(id)
    if (timer) window.clearTimeout(timer)
    toastTimers.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const pushToast = useCallback((kind: ToastItem['kind'], msg: string) => {
    const id = nextToastId.current++
    setToasts((current) => [...current, { id, kind, msg }])
    const timer = window.setTimeout(() => dismissToast(id), kind === 'error' ? 6000 : 3500)
    toastTimers.current.set(id, timer)
  }, [dismissToast])

  useEffect(() => () => {
    for (const timer of toastTimers.current.values()) window.clearTimeout(timer)
    toastTimers.current.clear()
  }, [])

  const toastApi = useMemo<ToastApi>(
    () => ({ success: (msg) => pushToast('success', msg), error: (msg) => pushToast('error', msg) }),
    [pushToast],
  )

  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const pendingRef = useRef<PendingConfirm | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()
  const bodyId = useId()

  const confirm = useCallback<ConfirmFn>((options) => new Promise<boolean>((resolve) => {
    // A second request replaces the first rather than leaving an unresolved promise behind.
    pendingRef.current?.resolve(false)
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const next: PendingConfirm = { ...options, resolve }
    pendingRef.current = next
    setPending(next)
  }), [])

  const settle = useCallback((value: boolean) => {
    const current = pendingRef.current
    pendingRef.current = null
    setPending(null)
    current?.resolve(value)
  }, [])

  useEffect(() => () => {
    const current = pendingRef.current
    pendingRef.current = null
    current?.resolve(false)
  }, [])

  useEffect(() => {
    if (!pending) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus())
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        settle(false)
        return
      }
      if (event.key !== 'Tab') return
      const controls = dialogControls(dialogRef.current)
      if (controls.length === 0) {
        event.preventDefault()
        dialogRef.current?.focus()
        return
      }
      const first = controls[0]!
      const last = controls[controls.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      openerRef.current?.focus()
    }
  }, [pending, settle])

  return (
    <ToastCtx.Provider value={toastApi}>
      <ConfirmCtx.Provider value={confirm}>
        {children}

        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4" style={{ paddingBottom: 'calc(6rem + env(safe-area-inset-bottom))' }}>
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role={toast.kind === 'error' ? 'alert' : 'status'}
              aria-atomic="true"
              className={`pointer-events-auto flex max-w-sm items-center gap-3 rounded-2xl px-4 py-3 text-base font-semibold shadow-lg ${
                toast.kind === 'error' ? 'bg-danger-solid text-on-danger' : 'bg-success-solid text-on-success'
              }`}
            >
              <span className="min-w-0 flex-1">{toast.msg}</span>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                aria-label={t.common.close}
                className="min-h-11 min-w-11 rounded-xl px-2 text-lg outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {pending ? (
          <div className="fixed inset-0 z-[70] flex items-end bg-scrim/50 p-4 sm:items-center" onClick={() => settle(false)}>
            <div
              ref={dialogRef}
              role={pending.danger ? 'alertdialog' : 'dialog'}
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={pending.body ? bodyId : undefined}
              tabIndex={-1}
              onClick={(event) => event.stopPropagation()}
              className="mx-auto w-full max-w-md rounded-3xl border border-line-subtle bg-surface-card p-5 shadow-xl"
              style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
            >
              <h2 id={titleId} className="text-title font-bold text-ink">{pending.title}</h2>
              {pending.body ? <p id={bodyId} className="mt-2 text-body text-ink-secondary">{pending.body}</p> : null}
              <div className="mt-5 grid grid-cols-2 gap-2">
                <Button ref={cancelRef} type="button" variant="ghost" onClick={() => settle(false)}>
                  {pending.cancelLabel ?? t.common.cancel}
                </Button>
                <Button type="button" variant={pending.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
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

/** Backwards-compatible name for earlier driver-only callers. */
export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  return <FeedbackProvider>{children}</FeedbackProvider>
}
