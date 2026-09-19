import { cloneElement, forwardRef, isValidElement, useEffect, useId, useRef } from 'react'
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react'
import { groupThousands } from '@ash/client'

/**
 * The driver PWA's own primitives — hand-written Tailwind, no component library. The whole app
 * is designed for a cheap Android held in one hand: big tap targets, high contrast, logical
 * properties only so RTL is free.
 */

/** The ASH Delivery mark — hexagon around an ascending bar chart, in the brand CSS variables. */
export function Logo({ size = 40, className = '' }: { size?: number; className?: string }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="ASH Delivery" className={className}>
      <path
        d="M24 3 L43 13.5 L43 34.5 L24 45 L5 34.5 L5 13.5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <rect x="14.5" y="26" width="4.6" height="10" rx="1.1" fill="currentColor" />
      <rect x="21.7" y="20" width="4.6" height="16" rx="1.1" fill="currentColor" opacity="0.85" />
      <rect x="28.9" y="14" width="4.6" height="22" rx="1.1" fill="currentColor" opacity="0.7" />
    </svg>
  )
}

export function Money({ value, className = '' }: { value: string; className?: string }): ReactNode {
  // `.num` isolates the run and forces Western tabular digits, so a figure never reorders inside
  // an Arabic sentence; grouping is display-only, so the wire string is never altered.
  return <span className={`num ${className}`}>{groupThousands(value)}</span>
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'success'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'primary',
  children,
  className = '',
  ...rest
}, ref) {
  const styles: Record<string, string> = {
    primary: 'bg-brand text-on-brand active:bg-brand-700',
    ghost: 'bg-surface-muted text-ink-secondary active:bg-surface-sunken',
    danger: 'bg-danger-solid text-on-danger active:bg-danger-solid-hover',
    success: 'bg-success-solid text-on-success active:bg-success-solid-hover',
  }
  return (
    <button
      ref={ref}
      className={`inline-flex min-h-14 items-center justify-center rounded-2xl px-5 text-center text-lg font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none ${styles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
})

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}): ReactNode {
  const inputId = useId()
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`
  type FieldControlProps = {
    id?: string
    'aria-describedby'?: string
    'aria-invalid'?: boolean | 'true' | 'false'
  }
  const control = isValidElement<FieldControlProps>(children) ? children : null
  const controlId = control?.props.id ?? inputId
  const describedBy = [
    control?.props['aria-describedby'],
    hint ? hintId : null,
    error ? errorId : null,
  ].filter((id): id is string => Boolean(id)).join(' ')
  const accessibilityProps: FieldControlProps = { id: controlId }
  if (describedBy) accessibilityProps['aria-describedby'] = describedBy
  if (error) accessibilityProps['aria-invalid'] = true
  else if (control?.props['aria-invalid'] !== undefined) {
    accessibilityProps['aria-invalid'] = control.props['aria-invalid']
  }
  const accessibleControl = control
    ? cloneElement(control, accessibilityProps)
    : children

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={control ? controlId : undefined} className="text-sm font-medium text-ink-secondary">
        {label}
      </label>
      {accessibleControl}
      {hint ? <span id={hintId} className="text-xs text-ink-secondary">{hint}</span> : null}
      {error ? <span id={errorId} role="alert" className="text-sm font-medium text-danger-ink">{error}</span> : null}
    </div>
  )
}

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <input
      className={`min-h-14 rounded-2xl border border-line-strong bg-surface-card px-4 text-lg text-ink outline-none placeholder:text-ink-muted focus:border-brand focus:ring-2 focus:ring-focus focus:ring-offset-2 focus:ring-offset-surface-card disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted ${className}`}
      {...rest}
    />
  )
}

/** Numeric-keypad-first input for money — the driver types digits, nothing else. */
export function MoneyInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <TextInput inputMode="decimal" pattern="[0-9.]*" className={`num text-end ${className}`} {...rest} />
  )
}

/** A native select with the same touch target, focus treatment, and disabled state as TextInput. */
export function Select({ className = '', ...rest }: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select
      className={`min-h-14 w-full rounded-2xl border border-line-strong bg-surface-card px-4 text-lg text-ink outline-none focus:border-brand focus:ring-2 focus:ring-focus focus:ring-offset-2 focus:ring-offset-surface-card disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted ${className}`}
      {...rest}
    />
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return <div className={`rounded-3xl border border-line-subtle bg-surface-card p-4 shadow-sm dark:shadow-none ${className}`}>{children}</div>
}

export type ThemePreference = 'light' | 'dark' | 'system'

/** Three deliberate appearance choices, not a toggle whose state is ambiguous on a shared phone. */
export function ThemeChoiceGroup({
  value,
  onChange,
  label,
  labels,
  tone = 'surface',
  className = '',
}: {
  value: ThemePreference
  onChange(value: ThemePreference): void
  label: string
  labels: Record<ThemePreference, string>
  tone?: 'surface' | 'header'
  className?: string
}): ReactNode {
  const styles = tone === 'header'
    ? {
        active: 'bg-white text-brand',
        idle: 'bg-white/10 text-on-brand active:bg-white/20',
        focus: 'focus-visible:ring-white focus-visible:ring-offset-brand-700',
      }
    : {
        active: 'bg-brand text-on-brand',
        idle: 'bg-surface-muted text-ink-secondary active:bg-surface-sunken',
        focus: 'focus-visible:ring-focus focus-visible:ring-offset-surface-card',
      }

  return (
    <div role="group" aria-label={label} className={`grid grid-cols-3 gap-1 ${className}`}>
      {(['system', 'light', 'dark'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={`min-h-11 rounded-xl px-2 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transition-none ${styles.focus} ${
            value === option ? styles.active : styles.idle
          }`}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  )
}

/**
 * A panel that rises from the BOTTOM of the screen — the driver app's first and only overlay.
 *
 * The driver has both this non-destructive panel and a central confirmation dialog. The operations
 * list needed a panel because a delivery cannot be both a small block in a grid
 * AND carry its route, its fee editor and its provenance inline. The block is the summary; this is
 * where the detail lives.
 *
 * BOTTOM, not centre, for two reasons. It is where a thumb already is on a phone held one-handed,
 * and `translate-y` is direction-neutral — a side drawer needs paired `ltr:`/`rtl:` transforms and
 * this app is Arabic-first. It also clears the home indicator the same way `Screen`'s footer does;
 * without that the primary button sits under a gesture bar and the tap dismisses the app.
 *
 * Closing is deliberately easy — backdrop, Escape, and the button — because nothing here is
 * destructive: every edit has already been applied to the row as it was typed.
 */
export function Sheet({
  title,
  open,
  onClose,
  children,
  footer,
  closeLabel = 'Close',
}: {
  title: string
  open: boolean
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  /** Supply the translated common “Close” label from the calling screen. */
  closeLabel?: string
}): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const onCloseRef = useRef(onClose)
  const titleId = useId()

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusPanel = (): HTMLElement[] => {
      const panel = panelRef.current
      if (!panel) return []
      return Array.from(panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((node) => !node.hasAttribute('hidden') && node.getClientRects().length > 0)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const controls = focusPanel()
      if (controls.length === 0) {
        e.preventDefault()
        panelRef.current?.focus()
        return
      }
      const first = controls[0]!
      const last = controls[controls.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    // The page behind must not scroll under the sheet — on a phone that reads as the app losing
    // its place, and the driver comes back to a list scrolled somewhere else.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus())
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
      window.cancelAnimationFrame(frame)
      opener?.focus()
    }
  }, [open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-scrim/40" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        // Stop a tap inside the panel from reaching the backdrop's close handler.
        onClick={(e) => e.stopPropagation()}
        className="mx-auto max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface-card p-4"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        {/* The grab handle is decorative, but it is the thing that makes a panel read as draggable-
            from-the-bottom rather than as an error that appeared. */}
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong" />
        <div className="flex items-center gap-2">
          <h2 id={titleId} className="flex-1 text-lg font-bold text-ink">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="min-h-11 rounded-xl bg-surface-muted px-4 text-sm font-semibold text-ink-secondary outline-none transition-colors active:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card motion-reduce:transition-none"
          >
            ✕
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-3">{children}</div>
        {footer ? <div className="mt-4">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Screen({
  title,
  children,
  footer,
  back,
}: {
  title: string
  children: ReactNode
  footer?: ReactNode
  /**
   * The way out of this screen. It sits in the STICKY header, not in the body: the closing package
   * is a long scroll, and a control the driver has to scroll back up to find is one he does not
   * have. It replaces the logo — a sub-screen is not the place for branding.
   *
   * Passed only where going back is genuinely safe. A screen that cannot undo what it has already
   * sent must not offer to.
   */
  back?: { label: string; onBack(): void }
}): ReactNode {
  return (
    <div className="mx-auto flex min-h-dvh w-full min-w-0 max-w-md flex-col overflow-x-hidden">
      <header className="sticky top-0 z-10 flex items-center gap-2.5 bg-brand px-4 py-3 text-on-brand">
        {back ? (
          <button
            type="button"
            onClick={back.onBack}
            // -ms-2 pulls it to the header's own padding so the tap target reaches the screen edge,
            // where a thumb lands, without moving the title.
            className="-ms-2 min-h-11 rounded-xl bg-white/10 px-3 text-sm font-semibold outline-none transition-colors active:bg-white/25 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand motion-reduce:transition-none"
          >
            {back.label}
          </button>
        ) : (
          <Logo size={26} className="text-on-brand" />
        )}
        <h1 className="text-xl font-bold">{title}</h1>
      </header>
      {/* pb-44 rather than pb-28: the footer GROWS — the BR1 banner, the «ناقص» checklist and the
          live difference all live in it — and at 112px it began covering the last battery field. */}
      <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 pb-44">{children}</main>
      {footer ? (
        /* viewport-fit=cover is set in index.html, so on a gesture-navigation Android the bottom of
           the primary button sat UNDER the home indicator: the driver's tap dismissed the app
           instead of submitting his shift. */
        <footer
          className="fixed inset-x-0 bottom-0 mx-auto w-full min-w-0 max-w-md overflow-x-hidden border-t border-line bg-surface-card p-3"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
          {footer}
        </footer>
      ) : null}
    </div>
  )
}
