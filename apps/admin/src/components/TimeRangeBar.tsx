import { type ReactNode, useCallback, useEffect, useId, useState } from 'react'
import {
  type DateRange,
  type RangeSelection,
  addDays,
  canGoNextWeek,
  shiftWeek,
  validateCustom,
  weekStartFor,
} from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { FOCUS_RING, Button, DateField } from '../ui.tsx'
import {
  type RangeMeta,
  SIMPLE_PRESETS,
  dayStartLabel,
  resolveSelection,
} from '../time-range.ts'

/**
 * «فلتر الوقت» — the shared time filter (P2, mockup «فلتر الوقت»).
 *
 * Pills for the presets, a week navigator (weeks start on SUNDAY, «التالي» stops at the current
 * week), a custom from/to form, and a caption that says which dates are actually shown and that the
 * business day starts at 04:00. Every date comes from `GET /dashboard/meta`; the component never
 * asks the browser what day it is.
 *
 * Presentation only: the owner of the selection (the screen) persists it and writes it to the URL.
 */

/** `GET /dashboard/meta`, reloaded when the branch changes. */
export function useRangeMeta(): { meta: RangeMeta | null; error: string | null; retry(): void } {
  const { api, branchId } = useApp()
  const [meta, setMeta] = useState<RangeMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setError(null)
    void api
      .get<RangeMeta>('/dashboard/meta', { cache: 'no-store', signal: controller.signal })
      .then((next) => {
        if (active) setMeta(next)
      })
      .catch((cause: { name?: string; error?: string }) => {
        if (!active || cause.name === 'AbortError') return
        setError(cause.error ?? 'error')
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [api, branchId, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { meta, error, retry }
}

/**
 * Put figures into a sentence as isolated LTR runs. A bare `2026-09-17` inside Arabic text is
 * reordered by the bidi algorithm into something that reads like a different date.
 */
function fillTemplate(template: string, values: Readonly<Record<string, string>>): ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, index) => {
    const match = /^\{(\w+)\}$/.exec(part)
    const value = match ? values[match[1] ?? ''] : undefined
    return value === undefined ? (
      part
    ) : (
      <bdi key={index} dir="ltr" className="num">
        {value}
      </bdi>
    )
  })
}

const pillClass = (on: boolean): string =>
  `shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-label font-medium outline-none transition-colors ${FOCUS_RING} ${
    on
      ? 'border-brand bg-brand text-ink-inverse'
      : 'border-line bg-surface-card text-ink-secondary hover:bg-surface-raised'
  }`

export function TimeRangeBar({
  selection,
  onChange,
  meta,
  metaError,
  onRetryMeta,
  maxDays,
}: {
  selection: RangeSelection
  onChange(selection: RangeSelection): void
  meta: RangeMeta | null
  metaError?: string | null
  onRetryMeta?: () => void
  /** When a screen caps its range, the custom form refuses anything longer. */
  maxDays?: number
}): ReactNode {
  const { t } = useApp()
  const labels = t.timeRange
  const groupId = useId()
  const [customOpen, setCustomOpen] = useState(selection.preset === 'custom')
  const [from, setFrom] = useState(selection.preset === 'custom' ? selection.from : '')
  const [to, setTo] = useState(selection.preset === 'custom' ? selection.to : '')
  const [customError, setCustomError] = useState<string | null>(null)

  const range: DateRange | null = meta ? resolveSelection(selection, meta) : null
  const weekMode =
    selection.preset === 'this_week' || selection.preset === 'last_week' || selection.preset === 'week'
  const shownWeek = range ? weekStartFor(range.from) : null

  const openCustom = (): void => {
    // Start the form from what is on screen, so «مخصّص» edits the current range instead of a blank.
    if (range) {
      setFrom(range.from)
      setTo(range.to)
    }
    setCustomError(null)
    setCustomOpen((open) => !open)
  }

  const applyCustom = (): void => {
    const checked = validateCustom(from, to, maxDays)
    if (!checked.ok) {
      setCustomError(
        checked.code === 'dates_required'
          ? labels.datesRequired
          : checked.code === 'date_order'
            ? labels.dateOrder
            : labels.rangeTooLarge.replace('{n}', String(maxDays ?? '')),
      )
      return
    }
    setCustomError(null)
    onChange({ preset: 'custom', from: checked.from, to: checked.to })
  }

  const goWeek = (delta: number): void => {
    if (!meta || shownWeek === null) return
    onChange({ preset: 'week', week: shiftWeek(shownWeek, delta) })
  }

  return (
    <div className="flex flex-col gap-2">
      {/* One row that scrolls sideways on a phone rather than wrapping into a wall of pills. */}
      <div
        role="group"
        aria-labelledby={groupId}
        className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1"
      >
        <span id={groupId} className="sr-only">
          {labels.label}
        </span>
        {SIMPLE_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={selection.preset === preset}
            className={pillClass(selection.preset === preset)}
            onClick={() => {
              setCustomOpen(false)
              onChange({ preset })
            }}
          >
            {labels.presets[preset]}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={selection.preset === 'custom'}
          aria-expanded={customOpen}
          className={pillClass(selection.preset === 'custom')}
          onClick={openCustom}
        >
          {labels.presets.custom} ▾
        </button>
      </div>

      {weekMode && meta && shownWeek !== null ? (
        <div role="group" aria-label={labels.weekNavigator} className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => goWeek(-1)}>
            › {labels.previousWeek}
          </Button>
          <span className="rounded-full border border-line bg-surface-muted px-3 py-1 text-label text-ink-secondary">
            {fillTemplate(labels.weekOf, { from: shownWeek, to: addDays(shownWeek, 6) })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={!canGoNextWeek(shownWeek, meta.today)}
            onClick={() => goWeek(1)}
          >
            {labels.nextWeek} ‹
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onChange({ preset: 'this_week' })}>
            {labels.currentWeek}
          </Button>
        </div>
      ) : null}

      {customOpen ? (
        <div className="flex flex-wrap items-end gap-3">
          <DateField label={labels.from} value={from} onChange={setFrom} />
          <DateField label={labels.to} value={to} onChange={setTo} />
          <Button variant="primary" onClick={applyCustom}>
            {labels.apply}
          </Button>
          {customError ? (
            <p role="alert" className="basis-full text-label font-medium text-danger-ink">
              {customError}
            </p>
          ) : null}
        </div>
      ) : null}

      {metaError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-label text-danger-ink">
          <span>{labels.metaError}</span>
          {onRetryMeta ? (
            <Button variant="ghost" size="sm" onClick={onRetryMeta}>
              {t.common.retry}
            </Button>
          ) : null}
        </div>
      ) : range && meta ? (
        <p className="text-label text-ink-muted">
          {fillTemplate(labels.caption, {
            from: range.from,
            to: range.to,
            dayStart: dayStartLabel(meta.dayStartMinutes),
          })}
          {meta.goLiveBusinessDate !== null ? ` · ${labels.beforeGoLive}` : null}
        </p>
      ) : (
        <p role="status" className="text-label text-ink-muted">
          {labels.loading}
        </p>
      )}
    </div>
  )
}
