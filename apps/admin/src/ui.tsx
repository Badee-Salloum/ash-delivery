import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId } from 'react'

/** Admin console primitives — desktop/tablet, denser than the driver app, logical properties only. */

/** A shared keyboard-focus ring, applied to every interactive control so tabbing is visible. */
export const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40'

/**
 * The ASH GROUP mark: a hexagon around an ascending bar chart, navy rising to blue. Drawn in the
 * brand CSS variables so it recolours with the theme and stays crisp at any size — no raster asset.
 */
export function Logo({ size = 40, className = '' }: { size?: number; className?: string }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="ASH GROUP" className={className}>
      <path
        d="M24 3 L43 13.5 L43 34.5 L24 45 L5 34.5 L5 13.5 Z"
        fill="none"
        stroke="var(--color-brand)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <rect x="14.5" y="26" width="4.6" height="10" rx="1.1" fill="var(--color-brand)" />
      <rect x="21.7" y="20" width="4.6" height="16" rx="1.1" fill="var(--color-brand-700)" />
      <rect x="28.9" y="14" width="4.6" height="22" rx="1.1" fill="var(--color-accent)" />
    </svg>
  )
}

/** Mark + wordmark, for the header rail and the login card. */
export function Wordmark({ size = 34 }: { size?: number }): ReactNode {
  return (
    <div className="flex items-center gap-2.5">
      <Logo size={size} />
      <div className="leading-tight">
        <div className="text-base font-extrabold tracking-tight text-brand">
          ASH <span className="text-accent">GROUP</span>
        </div>
        <div className="text-[9px] font-semibold tracking-[0.22em] text-slate-400">FINANCIAL SERVICES</div>
      </div>
    </div>
  )
}

export function Money({ value, className = '' }: { value: string; className?: string }): ReactNode {
  return <span className={`num ${className}`}>{value}</span>
}

export function Button({
  variant = 'primary',
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'success' }): ReactNode {
  const styles: Record<string, string> = {
    primary: 'bg-brand text-white shadow-sm hover:bg-brand-700',
    ghost: 'bg-white text-brand border border-slate-300 hover:border-brand hover:bg-slate-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700',
  }
  return (
    <button
      className={`inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold transition-colors disabled:opacity-40 ${FOCUS_RING} ${styles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <input
      className={`min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/15 ${className}`}
      {...rest}
    />
  )
}

export function MoneyInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <TextInput inputMode="decimal" className={`num text-end ${className}`} {...rest} />
}

/**
 * A native `<select>` styled to match `TextInput` — same height, border and focus ring — so inline
 * form rows stop mixing a 40px input with a 28px raw select. Give it an `aria-label` (or wrap it in
 * a `Field`) so it has an accessible name.
 */
export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select
      className={`min-h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/15 ${className}`}
      {...rest}
    >
      {children}
    </select>
  )
}

/**
 * A labelled date input. A native `type="date"` in an RTL page mirrors its own segments and can't
 * be localized, so it is pinned to `dir="ltr"` and `.num` (tabular Western digits) — the value
 * reads as a stable `YYYY-MM-DD` in both directions — and carries a real, visible label instead of
 * the `title=` tooltip these fields used to rely on.
 */
export function DateField({
  label,
  value,
  onChange,
  className = '',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  className?: string
}): ReactNode {
  const id = useId()
  return (
    <Field label={label} htmlFor={id} className={className}>
      <input
        id={id}
        type="date"
        dir="ltr"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="num min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/15"
      />
    </Field>
  )
}

/**
 * A labelled form field: a real `<label>` (tied to the control via `htmlFor`), an optional hint,
 * and an error slot. Wrapping inputs/selects in this is what gives ~20 placeholder-only controls a
 * programmatic name and a place to show validation.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className = '',
}: {
  label: string
  htmlFor?: string
  hint?: string
  error?: string | null
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-slate-500">
        {label}
      </label>
      {children}
      {hint ? <span className="text-xs text-slate-400">{hint}</span> : null}
      {error ? <span className="text-xs font-medium text-red-600">{error}</span> : null}
    </div>
  )
}

export function Card({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }): ReactNode {
  return (
    <section className={`rounded-xl bg-white p-4 shadow-sm ${className}`}>
      {title ? <h2 className="mb-3 text-sm font-bold text-slate-500">{title}</h2> : null}
      {children}
    </section>
  )
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }): ReactNode {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-400">{sub}</div> : null}
    </div>
  )
}

/**
 * A table. Pass `empty` and, when there are no `children` rows, it renders one muted full-width row
 * instead of a bare header — so an empty list reads as "nothing here yet", not as a broken screen.
 */
export function Table({
  head,
  children,
  empty,
  isEmpty,
}: {
  head: string[]
  children: ReactNode
  empty?: ReactNode
  isEmpty?: boolean
}): ReactNode {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-start text-xs text-slate-500">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 text-start font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {isEmpty && empty !== undefined ? (
            <tr>
              <td colSpan={head.length} className="px-3 py-6 text-center text-slate-400">
                {empty}
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  )
}

export function Badge({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'slate' | 'sky'; children: ReactNode }): ReactNode {
  const tones: Record<string, string> = {
    green: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800',
    slate: 'bg-slate-100 text-slate-700',
    sky: 'bg-sky-100 text-sky-800',
  }
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
}

/**
 * What a screen shows before it has data — either still loading, or why it never will.
 *
 * A failed fetch used to leave the screen's state `null`, which rendered "جارِ التحميل…" forever.
 * The user saw an eternal spinner and the actual HTTP error never surfaced: in practice a 422
 * `branch_required`, because the general manager and the system admin have no branch on their
 * session. Showing the code is the difference between "this app is broken" and "pick a branch".
 */
export function Pending({
  error,
  loadingLabel,
  errorLabel,
  onRetry,
  retryLabel,
}: {
  error: string | null
  loadingLabel: string
  errorLabel: string
  onRetry?: (() => void) | undefined
  retryLabel?: string | undefined
}): ReactNode {
  if (!error) {
    return (
      <Card>
        <p className="py-6 text-center text-slate-400">{loadingLabel}</p>
      </Card>
    )
  }
  return (
    <Card>
      <p className="text-center font-medium text-red-600">{errorLabel}</p>
      <p className="mt-1 text-center text-xs text-slate-400">{error}</p>
      {onRetry ? (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" onClick={onRetry}>
            {retryLabel ?? '↻'}
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
