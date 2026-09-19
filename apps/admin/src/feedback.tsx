import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from './app-context.tsx'
import { Button, Field, TextInput } from './ui.tsx'

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

/** A small, accessible replacement for native `window.prompt` when an audited reason is required. */
interface TextPromptOptions {
  title: string
  label: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  initialValue?: string
}
type TextPromptFn = (options: TextPromptOptions) => Promise<string | null>
const TextPromptCtx = createContext<TextPromptFn | null>(null)

export function useTextPrompt(): TextPromptFn {
  const ctx = useContext(TextPromptCtx)
  if (!ctx) throw new Error('useTextPrompt must be used inside <FeedbackProvider>')
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
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setPending({ ...options, resolve })
      }),
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

  const [textPromptPending, setTextPromptPending] = useState<(
    TextPromptOptions & { resolve: (value: string | null) => void; value: string; error: string | null }
  ) | null>(null)
  const textPromptRef = useRef<HTMLFormElement | null>(null)
  const textPromptOpenerRef = useRef<HTMLElement | null>(null)
  const textPrompt = useCallback<TextPromptFn>(
    (options) => new Promise<string | null>((resolve) => {
      textPromptOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setTextPromptPending({ ...options, resolve, value: options.initialValue ?? '', error: null })
    }),
    [],
  )
  const settleTextPrompt = useCallback((value: string | null) => {
    setTextPromptPending((current) => {
      current?.resolve(value)
      return null
    })
  }, [])
  const submitTextPrompt = useCallback(() => {
    setTextPromptPending((current) => {
      if (!current) return current
      const value = current.value.trim()
      if (value === '') return { ...current, error: t.common.required }
      current.resolve(value)
      return null
    })
  }, [t.common.required])

  // Esc cancels the dialog — a modal you can't dismiss with the keyboard is a trap.
  useEffect(() => {
    if (!pending) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = (): HTMLElement[] =>
      [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])]
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        settle(false)
        return
      }
      if (e.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        e.preventDefault()
        dialogRef.current?.focus()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    const frame = requestAnimationFrame(() => {
      const selector = pending.danger ? '[data-confirm-cancel]' : '[data-confirm-primary]'
      ;(dialogRef.current?.querySelector<HTMLElement>(selector) ?? dialogRef.current)?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      openerRef.current?.focus()
      openerRef.current = null
    }
  }, [pending, settle])

  // Text prompts use the exact same modal contract as confirmations: Escape, focus trapping,
  // scroll lock, and returning focus to the control that opened it.
  useEffect(() => {
    if (!textPromptPending) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = (): HTMLElement[] =>
      [...(textPromptRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])]
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        settleTextPrompt(null)
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        textPromptRef.current?.focus()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    const frame = requestAnimationFrame(() => {
      textPromptRef.current?.querySelector<HTMLElement>('input')?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      textPromptOpenerRef.current?.focus()
      textPromptOpenerRef.current = null
    }
  }, [settleTextPrompt, textPromptPending])

  return (
    <ToastCtx.Provider value={toastApi}>
      <ConfirmCtx.Provider value={confirm}>
        <TextPromptCtx.Provider value={textPrompt}>
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
              className={`pointer-events-auto max-w-sm rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg ${
                toast.kind === 'error' ? 'bg-danger-solid text-on-danger' : 'bg-success-solid text-on-success'
              }`}
            >
              {toast.msg}
            </div>
            ))}
          </div>

          {/* Confirm dialog */}
          {pending ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
            onClick={() => settle(false)}
          >
            <div
              ref={dialogRef}
              role={pending.danger ? 'alertdialog' : 'dialog'}
              aria-modal="true"
              aria-labelledby="ash-confirm-title"
              aria-describedby={pending.body ? 'ash-confirm-body' : undefined}
              tabIndex={-1}
              className="w-full max-w-sm rounded-xl bg-surface-card p-5 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id="ash-confirm-title" className="text-base font-bold text-ink">{pending.title}</h2>
              {pending.body ? <p id="ash-confirm-body" className="mt-2 text-sm text-ink-muted">{pending.body}</p> : null}
              <div className="mt-5 flex justify-end gap-2">
                <Button data-confirm-cancel variant="ghost" onClick={() => settle(false)}>
                  {pending.cancelLabel ?? t.common.cancel}
                </Button>
                <Button
                  data-confirm-primary
                  variant={pending.danger ? 'danger' : 'primary'}
                  onClick={() => settle(true)}
                >
                  {pending.confirmLabel ?? t.common.confirm}
                </Button>
              </div>
            </div>
          </div>
          ) : null}

          {/* A typed reason has the same accessible contract as a confirmation, rather than the
              browser-owned `window.prompt` that varies between devices and cannot show an error. */}
          {textPromptPending ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
              onClick={() => settleTextPrompt(null)}
            >
              <form
                ref={textPromptRef}
                role={textPromptPending.danger ? 'alertdialog' : 'dialog'}
                aria-modal="true"
                aria-labelledby="ash-text-prompt-title"
                tabIndex={-1}
                className="w-full max-w-sm rounded-xl bg-surface-card p-5 shadow-xl"
                onClick={(event) => event.stopPropagation()}
                onSubmit={(event) => {
                  event.preventDefault()
                  submitTextPrompt()
                }}
              >
                <h2 id="ash-text-prompt-title" className="text-base font-bold text-ink">{textPromptPending.title}</h2>
                <Field label={textPromptPending.label} error={textPromptPending.error} className="mt-4">
                  <TextInput
                    autoFocus
                    required
                    value={textPromptPending.value}
                    onChange={(event) => setTextPromptPending((current) => current ? {
                      ...current,
                      value: event.target.value,
                      error: null,
                    } : current)}
                  />
                </Field>
                <div className="mt-5 flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => settleTextPrompt(null)}>
                    {textPromptPending.cancelLabel ?? t.common.cancel}
                  </Button>
                  <Button type="submit" variant={textPromptPending.danger ? 'danger' : 'primary'}>
                    {textPromptPending.confirmLabel ?? t.common.confirm}
                  </Button>
                </div>
              </form>
            </div>
          ) : null}
        </TextPromptCtx.Provider>
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  )
}
