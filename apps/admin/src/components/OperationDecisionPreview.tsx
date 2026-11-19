import { useRef, useState, type ReactNode } from 'react'
import { Button } from '../ui.tsx'
import { decisionReasonReady, operationDecisionCopy, operationDecisionPreview, type OperationDecisionRow } from '../operation-decision.ts'

/** This is a confirmation, never an automatic selection or a financial write on mount. */
export function OperationDecisionPreview({ rows, reason, lang, disabled, onApply, onCancel }: {
  rows: OperationDecisionRow[]
  reason: string
  lang: 'ar' | 'en'
  disabled: boolean
  onApply(): Promise<void>
  onCancel?(): void
}): ReactNode {
  const copy = operationDecisionCopy(lang)
  const preview = operationDecisionPreview(rows)
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const apply = async (): Promise<void> => {
    if (disabled || inFlight.current || !preview.changed || !decisionReasonReady(reason)) return
    inFlight.current = true
    setSaving(true)
    try { await onApply() } finally { inFlight.current = false; setSaving(false) }
  }
  return (
    <section aria-label={copy.title} className="mt-3 min-w-0 rounded-lg border border-line-strong bg-surface-card p-3 text-xs text-ink">
      <p className="font-bold">{copy.title}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.key} className="min-w-0 rounded-md bg-surface-muted p-2">
            <p className="font-semibold">{row.kind === 'order' ? copy.order : copy.deduction} · {row.proposedIncluded ? copy.included : copy.excluded} · <bdi className="num">{row.amount} {copy.currency}</bdi></p>
            <p><bdi>{row.date || copy.unknown} · {row.minute || copy.unknown}</bdi></p>
            {row.route ? <p className="break-words">{row.route}</p> : null}
          </li>
        ))}
      </ul>
      <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div><dt>{copy.orderDelta}</dt><dd dir="ltr" className="num font-bold">{preview.orderDelta} {copy.currency}</dd></div>
        <div><dt>{copy.deductionDelta}</dt><dd dir="ltr" className="num font-bold">{preview.deductionDelta} {copy.currency}</dd></div>
      </dl>
      {preview.unknownIncluded ? <p role="note" className="mt-2 rounded-md border border-line-strong bg-surface-muted p-2 font-semibold">{copy.unknownWarning}</p> : null}
      <p className="mt-2 break-words">{copy.reason}: {decisionReasonReady(reason) ? reason : copy.reasonRequired}</p>
      <p className="mt-2 text-ink-muted">{copy.recalculation}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" disabled={disabled || saving || !preview.changed || !decisionReasonReady(reason)} onClick={() => void apply()}>{copy.apply}</Button>
        {onCancel ? <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>{copy.cancel}</Button> : null}
      </div>
    </section>
  )
}
