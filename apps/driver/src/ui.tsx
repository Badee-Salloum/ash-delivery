import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/**
 * The driver PWA's own primitives — hand-written Tailwind, no component library. The whole app
 * is designed for a cheap Android held in one hand: big tap targets, high contrast, logical
 * properties only so RTL is free.
 */

export function Money({ value, className = '' }: { value: string; className?: string }): ReactNode {
  // `.num` isolates the run and forces Western tabular digits, so a figure never reorders inside
  // an Arabic sentence.
  return <span className={`num ${className}`}>{value}</span>
}

export function Button({
  variant = 'primary',
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'success' }): ReactNode {
  const styles: Record<string, string> = {
    primary: 'bg-slate-900 text-white active:bg-slate-700',
    ghost: 'bg-slate-100 text-slate-900 active:bg-slate-200',
    danger: 'bg-red-600 text-white active:bg-red-700',
    success: 'bg-emerald-600 text-white active:bg-emerald-700',
  }
  return (
    <button
      className={`min-h-14 rounded-2xl px-5 text-lg font-semibold disabled:opacity-40 ${styles[variant]} ${className}`}
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

export function Screen({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }): ReactNode {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header className="sticky top-0 z-10 bg-slate-900 px-4 py-3 text-white">
        <h1 className="text-xl font-bold">{title}</h1>
      </header>
      <main className="flex flex-1 flex-col gap-4 p-4 pb-28">{children}</main>
      {footer ? (
        <footer className="fixed inset-x-0 bottom-0 mx-auto max-w-md border-t border-slate-200 bg-white/95 p-3 backdrop-blur">
          {footer}
        </footer>
      ) : null}
    </div>
  )
}
