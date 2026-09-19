import {
  cloneElement,
  isValidElement,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
} from 'react'
import { groupThousands } from '@ash/client'
import type { Currency } from '@ash/domain'
import { useApp } from './app-context.tsx'

/** Admin console primitives — desktop/tablet, denser than the driver app, logical properties only. */

/**
 * A shared keyboard-focus ring, applied to every interactive control so tabbing is visible.
 *
 * `ring-focus` rather than `ring-brand/40`: a 40%-alpha navy ring is invisible against the dark
 * theme's navy surfaces, and the ring is the only thing a keyboard user has. The offset is what
 * separates it from a button of the same hue.
 */
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card'

/**
 * The ASH Delivery mark: a hexagon around an ascending bar chart, navy rising to blue. Drawn in the
 * brand CSS variables so it recolours with the theme and stays crisp at any size — no raster asset.
 */
export function Logo({ size = 40, className = '' }: { size?: number; className?: string }): ReactNode {
  const { t } = useApp()
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label={t.glossary.brand.product} className={className}>
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
  const { t } = useApp()
  return (
    <div className="flex items-center gap-2.5">
      <Logo size={size} />
      <div className="leading-tight">
        <div className="text-base font-extrabold tracking-tight text-brand">{t.glossary.brand.product}</div>
        <div className="text-[9px] font-semibold tracking-[0.16em] text-ink-faint">{t.glossary.brand.group}</div>
      </div>
    </div>
  )
}

export function Money({
  value,
  className = '',
  currency,
}: {
  value: string
  className?: string
  /**
   * Say which currency the figure is in — «ل.س» or «$». Omitted, the figure is shown bare, as every
   * branch screen always has: the branch ledger is new lira only. «صندوق الشركة» holds dollars too
   * (C1), and there a bare number is ambiguous, so its screens pass this.
   */
  currency?: Currency
}): ReactNode {
  // GROUPED. Seven-digit figures were read by counting zeros — «1500000.00» against «150000.00» —
  // at the moment a manager decides whether a shift balances. Display only: the wire string the
  // caller holds is untouched, and every parse still happens on that.
  if (currency === undefined) return <span className={`num ${className}`}>{groupThousands(value)}</span>
  return (
    <span className={`num ${className}`}>
      {groupThousands(value)}
      <CurrencyMark currency={currency} />
    </span>
  )
}

/** The currency mark, from the catalog (`currency.SYP_NEW` / `currency.USD`). */
function CurrencyMark({ currency }: { currency: Currency }): ReactNode {
  const { t } = useApp()
  return <span className="ms-1 text-[0.85em] font-normal text-ink-muted">{t.currency[currency]}</span>
}

/** An amount that carries its currency on the wire: `{ currency, amount }`. */
export function CurrencyMoney({
  value,
  className = '',
}: {
  value: { currency: Currency; amount: string }
  className?: string
}): ReactNode {
  return <Money value={value.amount} currency={value.currency} className={className} />
}

export function Button({
  variant = 'primary',
  children,
  className = '',
  size = 'md',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'success'
  /**
   * `sm` exists because it was already in use — call sites were patching the default down with
   * `min-h-8 px-2 text-xs`, four times in one Treasury column alone. A size the component knows
   * about stays consistent; a size bolted on at the call site drifts.
   */
  size?: 'sm' | 'md'
}): ReactNode {
  const styles: Record<string, string> = {
    primary: 'bg-brand text-on-brand shadow-sm hover:bg-brand-700',
    ghost: 'bg-surface-card text-brand border border-line-strong hover:border-brand hover:bg-surface-muted',
    danger: 'bg-danger-solid text-on-danger hover:bg-danger-solid-hover',
    success: 'bg-success-solid text-on-success hover:bg-success-solid-hover',
  }
  const sizes: Record<string, string> = {
    sm: 'min-h-8 px-2.5 text-label',
    md: 'min-h-10 px-4 text-body',
  }
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizes[size]} ${FOCUS_RING} ${styles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <input
      className={`min-h-10 rounded-lg border border-line-strong bg-surface-card px-3 text-sm text-ink outline-none transition-colors focus:border-brand ${FOCUS_RING} ${className}`}
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
      className={`min-h-10 rounded-lg border border-line-strong bg-surface-card px-2 text-sm text-ink outline-none transition-colors focus:border-brand ${FOCUS_RING} ${className}`}
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
        className={`num min-h-10 rounded-lg border border-line-strong bg-surface-card px-3 text-sm text-ink outline-none transition-colors focus:border-brand ${FOCUS_RING}`}
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
  type ControlProps = {
    id?: string
    'aria-describedby'?: string
    'aria-invalid'?: boolean | 'true' | 'false'
  }
  const generatedId = useId()
  const control = isValidElement<ControlProps>(children) ? children : null
  const fieldId = control?.props.id ?? htmlFor ?? generatedId
  const hintId = hint ? `${fieldId}-hint` : undefined
  const errorId = error ? `${fieldId}-error` : undefined
  const describedBy = [control?.props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined
  const controlProps: ControlProps = { id: control?.props.id ?? fieldId }
  if (error) controlProps['aria-invalid'] = true
  else if (control?.props['aria-invalid'] !== undefined) controlProps['aria-invalid'] = control.props['aria-invalid']
  if (describedBy !== undefined) controlProps['aria-describedby'] = describedBy
  const labelledChild: ReactNode = control
    ? cloneElement(control as ReactElement<ControlProps>, controlProps)
    : children
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={fieldId} className="text-label font-medium text-ink-muted">
        {label}
      </label>
      {labelledChild}
      {hint ? <span id={hintId} className="text-label text-ink-muted">{hint}</span> : null}
      {/* `role="alert"` so a validation failure is ANNOUNCED. A red line a screen-reader user never
          hears is not an error message. */}
      {error ? (
        <span id={errorId} role="alert" className="text-label font-medium text-danger-ink">
          {error}
        </span>
      ) : null}
    </div>
  )
}

/**
 * A labelled READ-ONLY figure inside a `<dl>` — not to be confused with `Field` above, which wraps
 * an input.
 *
 * `dir="ltr"` plus `.num`: every value here is a figure (money, a percentage, «+12 كم»), numbers
 * read left-to-right in both languages, and without the isolation a sign or a unit lands on the
 * wrong side of the number in RTL.
 */
export function Figure({
  label,
  value,
  tone,
  size = 'md',
}: {
  label: string
  /**
   * A node, not a string. It was `string`, which is why Dashboard and Treasury could not use this
   * component at all — they hold `<Money>` — and hand-rolled their own `<dt>/<dd>` pairs instead.
   */
  value: ReactNode
  /** `green`/`red` are the original spellings, kept so existing call sites keep compiling. */
  tone?: 'success' | 'danger' | 'green' | 'red'
  /** `lg` is for the one figure a screen is actually about. Most figures are not that figure. */
  size?: 'md' | 'lg'
}): ReactNode {
  const good = tone === 'success' || tone === 'green'
  const bad = tone === 'danger' || tone === 'red'
  return (
    <div>
      <dt className="text-label text-ink-muted">{label}</dt>
      <dd
        dir="ltr"
        className={`num font-semibold ${size === 'lg' ? 'text-figure' : 'text-title'} ${
          good ? 'text-success-ink' : bad ? 'text-danger-ink' : 'text-ink'
        }`}
      >
        {value}
      </dd>
    </div>
  )
}

/**
 * A section of a screen.
 *
 * The title used to be `text-sm font-bold text-slate-500` — a muted grey, SMALLER and FAINTER than
 * the body text beneath it. With one card style used 71 times at every level of the hierarchy, that
 * made section boundaries invisible: on the approval screen nothing distinguished the deductions
 * table from the orders table from the battery-swap table except reading a grey line. The title is
 * now the strongest text in its own card, which is the entire job of a title.
 *
 * `subtitle` and `actions` exist because call sites were already doing both by hand, inconsistently.
 */
export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}): ReactNode {
  const titleId = useId()
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className={`rounded-xl border border-line-subtle bg-surface-card p-4 shadow-sm dark:shadow-none ${className}`}
    >
      {title ? (
        <div className="mb-3 flex items-start gap-3 border-b border-line-subtle pb-2">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-title font-semibold text-ink">
              {title}
            </h2>
            {subtitle ? <p className="mt-0.5 text-label text-ink-muted">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/**
 * The single page-level heading contract. Cards own `<h2>` titles; a screen gets exactly one
 * `<h1>` here, with an optional explanation and actions aligned consistently in RTL and LTR.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  className = '',
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
}): ReactNode {
  return (
    <header className={`mb-4 flex flex-wrap items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <h1 className="text-page font-bold text-ink">{title}</h1>
        {subtitle ? <p className="mt-1 text-body text-ink-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export function Stat({
  label,
  value,
  sub,
  href,
  tone,
  lead = false,
  className = '',
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  /** Makes the tile a link. A count of work waiting for YOU that cannot be acted on is a tease. */
  href?: string
  tone?: 'success' | 'warning' | 'danger'
  /**
   * The one tile that answers the question the screen is open for.
   *
   * Thirteen dashboard tiles were all `text-2xl font-bold`, so a count of three vehicles carried
   * the same weight as the day's revenue and nothing led. `lead` is deliberately a single tile's
   * job — if two tiles lead, neither does.
   */
  lead?: boolean
  /** Treasury and Approval hand-rolled 49 tile divs because this had no escape hatch. */
  className?: string
}): ReactNode {
  const ink =
    tone === 'success'
      ? 'text-success-ink'
      : tone === 'warning'
        ? 'text-warning-ink'
        : tone === 'danger'
          ? 'text-danger-ink'
          : 'text-ink'
  const body = (
    <>
      <div className="text-label font-medium text-ink-muted">{label}</div>
      <div className={`num mt-1 font-bold ${lead ? 'text-figure-lg' : 'text-figure'} ${ink}`}>{value}</div>
      {sub ? <div className="mt-1 text-label text-ink-muted">{sub}</div> : null}
    </>
  )
  const cls = `block rounded-xl border bg-surface-card p-4 shadow-sm dark:shadow-none ${
    lead ? 'border-brand/30' : 'border-line-subtle'
  } ${className}`
  return href ? (
    <a href={href} className={`${cls} transition-colors hover:bg-surface-muted ${FOCUS_RING}`}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  )
}

/**
 * A table. Pass `empty` and, when there are no `children` rows, it renders one muted full-width row
 * instead of a bare header — so an empty list reads as "nothing here yet", not as a broken screen.
 */
/** A column. A bare string is still accepted, so every existing call site compiles untouched. */
export type Column = string | { label: string; numeric?: boolean }

const columnLabel = (c: Column): string => (typeof c === 'string' ? c : c.label)

export function Table({
  head,
  children,
  empty,
  isEmpty,
  reflow = true,
}: {
  head: readonly Column[]
  children: ReactNode
  empty?: ReactNode
  isEmpty?: boolean
  /**
   * Below 40rem each row becomes its own card and every cell grows its column's label. Turn it off
   * for a matrix — the permission grid and the battery-swap grid mean nothing stacked, because
   * their columns are the data.
   */
  reflow?: boolean
}): ReactNode {
  /*
   * The column labels ride to CSS as custom properties on the table.
   *
   * The rows here are hand-written `<tr><td>` in the screens — 158 cells across the console — so
   * the usual `data-label` on every cell would mean editing all of them, and the next cell anyone
   * adds would silently forget it. The header array is already known HERE, exactly once, so the
   * labels are published once and `td:nth-child(n)::before` picks the right one up. No DOM
   * mutation, no effect, nothing to keep in sync.
   */
  const labels = Object.fromEntries(
    head.map((c, i) => [`--ash-th-${i + 1}`, JSON.stringify(columnLabel(c))]),
  ) as Record<string, string>

  return (
    <div className="overflow-x-auto">
      <table
        style={labels}
        className={`w-full text-body ${reflow ? 'ash-table-reflow' : ''}`}
      >
        <thead>
          <tr className="text-start text-label text-ink-muted">
            {head.map((c, i) => (
              // Indexed key: two columns can legitimately carry the same label — Treasury only
              // avoided a duplicate-key collision by concatenating kind and channel into one string.
              <th
                key={`${columnLabel(c)}-${i}`}
                className={`px-3 py-2 font-medium ${
                  typeof c !== 'string' && c.numeric ? 'text-end' : 'text-start'
                }`}
              >
                {columnLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-subtle">
          {isEmpty && empty !== undefined ? (
            <tr>
              <td colSpan={head.length} className="px-3 py-6 text-center text-ink-muted">
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

/** What a badge MEANS. */
export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

/**
 * The original colour-named spellings.
 *
 * @deprecated Say what the state IS, not what colour it happens to be. Kept because `tone` is not
 * confined to this component — the union is annotated in eight other files and consumed by three
 * further components that take the same prop, so renaming it in one step would break all of them at
 * once for no functional gain.
 */
export type LegacyTone = 'green' | 'amber' | 'red' | 'slate' | 'sky'

const NORMALISE: Record<Tone | LegacyTone, Tone> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  neutral: 'neutral',
  green: 'success',
  amber: 'warning',
  red: 'danger',
  slate: 'neutral',
  sky: 'info',
}

export function Badge({ tone, children }: { tone: Tone | LegacyTone; children: ReactNode }): ReactNode {
  // A bordered pill rather than a bare tint. At table density the border is what separates one
  // status from the next, and a `-100` background alone carries no meaning once the theme flips.
  const tones: Record<Tone, string> = {
    success: 'bg-success-surface text-success-ink border-success-line',
    warning: 'bg-warning-surface text-warning-ink border-warning-line',
    danger: 'bg-danger-surface text-danger-ink border-danger-line',
    info: 'bg-info-surface text-info-ink border-info-line',
    neutral: 'bg-surface-muted text-ink-secondary border-line',
  }
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-label font-medium ${tones[NORMALISE[tone]]}`}
    >
      {children}
    </span>
  )
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
  /*
   * NOT wrapped in a Card any more.
   *
   * Treasury calls this four times from inside Cards, which produced a white `p-4 rounded-xl` box
   * inside another one — doubled padding, a second surface on the same surface, and on a slow
   * branch connection a screen that was a stack of nested empty boxes. The caller owns the frame;
   * this owns what goes in it.
   */
  if (!error) {
    return (
      // A skeleton the shape of the content it replaces, so nothing jumps when the data lands.
      // `animate-pulse` is Tailwind's, which already honours prefers-reduced-motion.
      <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-2 py-2">
        <span className="sr-only">{loadingLabel}</span>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-4 animate-pulse rounded bg-surface-muted motion-reduce:animate-none" style={{ inlineSize: `${90 - i * 18}%` }} />
        ))}
      </div>
    )
  }
  return (
    // `role="alert"`: a failed load must be announced, not merely coloured.
    <div role="alert" className="rounded-lg border border-danger-line bg-danger-surface p-3">
      <p className="text-body font-semibold text-danger-ink">{errorLabel}</p>
      {/* The raw cause stays visible. It is what a manager reads down the phone to whoever can fix it. */}
      <p className="mt-1 text-label text-ink-secondary">{error}</p>
      {onRetry ? (
        <div className="mt-3">
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {retryLabel ?? '↻'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
