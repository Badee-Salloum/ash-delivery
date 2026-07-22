import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/** Admin console primitives — desktop/tablet, denser than the driver app, logical properties only. */

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
    primary: 'bg-slate-900 text-white hover:bg-slate-700',
    ghost: 'bg-white text-slate-900 border border-slate-300 hover:bg-slate-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700',
  }
  return (
    <button
      className={`inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold disabled:opacity-40 ${styles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <input
      className={`min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-slate-900 ${className}`}
      {...rest}
    />
  )
}

export function MoneyInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <TextInput inputMode="decimal" className={`num text-end ${className}`} {...rest} />
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

export function Table({ head, children }: { head: string[]; children: ReactNode }): ReactNode {
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
        <tbody className="divide-y divide-slate-100">{children}</tbody>
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
