import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { groupThousands } from '@ash/client'

/**
 * The driver PWA's own primitives — hand-written Tailwind, no component library. The whole app
 * is designed for a cheap Android held in one hand: big tap targets, high contrast, logical
 * properties only so RTL is free.
 */

/** The ASH GROUP mark — hexagon around an ascending bar chart, in the brand CSS variables. */
export function Logo({ size = 40, className = '' }: { size?: number; className?: string }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="ASH GROUP" className={className}>
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

export function Button({
  variant = 'primary',
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'success' }): ReactNode {
  const styles: Record<string, string> = {
    primary: 'bg-brand text-white active:bg-brand-700',
    ghost: 'bg-slate-100 text-brand active:bg-slate-200',
    danger: 'bg-red-600 text-white active:bg-red-700',
    success: 'bg-emerald-600 text-white active:bg-emerald-700',
  }
  return (
    <button
      className={`min-h-14 rounded-2xl px-5 text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-40 ${styles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-slate-600">{label}</span>
      {children}
      {hint ? <span className="text-xs text-slate-400">{hint}</span> : null}
    </label>
  )
}

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <input
      className={`min-h-14 rounded-2xl border border-slate-300 bg-white px-4 text-lg outline-none focus:border-slate-900 ${className}`}
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

export function Card({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return <div className={`rounded-3xl bg-white p-4 shadow-sm ${className}`}>{children}</div>
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
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header className="sticky top-0 z-10 flex items-center gap-2.5 bg-brand px-4 py-3 text-white">
        {back ? (
          <button
            type="button"
            onClick={back.onBack}
            // -ms-2 pulls it to the header's own padding so the tap target reaches the screen edge,
            // where a thumb lands, without moving the title.
            className="-ms-2 min-h-11 rounded-xl bg-white/10 px-3 text-sm font-semibold active:bg-white/25"
          >
            {back.label}
          </button>
        ) : (
          <Logo size={26} className="text-white" />
        )}
        <h1 className="text-xl font-bold">{title}</h1>
      </header>
      {/* pb-44 rather than pb-28: the footer GROWS — the BR1 banner, the «ناقص» checklist and the
          live difference all live in it — and at 112px it began covering the last battery field. */}
      <main className="flex flex-1 flex-col gap-4 p-4 pb-44">{children}</main>
      {footer ? (
        /* viewport-fit=cover is set in index.html, so on a gesture-navigation Android the bottom of
           the primary button sat UNDER the home indicator: the driver's tap dismissed the app
           instead of submitting his shift. */
        <footer
          className="fixed inset-x-0 bottom-0 mx-auto max-w-md border-t border-slate-200 bg-white/95 p-3 backdrop-blur"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
          {footer}
        </footer>
      ) : null}
    </div>
  )
}
