import { useId, useRef, useState, type ReactNode } from 'react'
import { normalizeDecimalDigits } from '@ash/client'
import { formatMinor, parseMinor, sub } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { useConfirm } from '../feedback.tsx'
import { Button, Field, Money, MoneyInput, TextInput } from '../ui.tsx'

interface CashFloatCorrectionProps {
  currentTotal: string
  disabled: boolean
  editing: boolean
  onEditing(value: boolean): void
  onSave(input: { expectedCurrentTotal: string; targetTotal: string; occurrenceKey: string; reason: string }): Promise<boolean>
}

/** Uses the existing audited reduction command, including its optimistic total and replay key. */
export function CashFloatCorrection({ currentTotal, disabled, editing, onEditing, onSave }: CashFloatCorrectionProps): ReactNode {
  const { t } = useApp()
  const confirm = useConfirm()
  const copy = t.approval.cashFloatCorrection
  const amountId = useId()
  const reasonId = useId()
  const [amount, setAmount] = useState(currentTotal)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const operation = useRef<{ signature: string; key: string } | null>(null)
  const inFlight = useRef(false)
  const target = normalizeDecimalDigits(amount).trim()
  let reduction: string | null = null
  if (/^\d+(?:\.\d{1,2})?$/.test(target)) {
    try {
      const delta = sub(parseMinor(currentTotal), parseMinor(target))
      if (delta > 0n) reduction = formatMinor(delta)
    } catch { /* Invalid money keeps the save button disabled. */ }
  }
  const reasonReady = /[^\p{White_Space}\p{Cf}]/u.test(reason)
  const locked = disabled || saving

  async function save(): Promise<void> {
    if (locked || inFlight.current || reduction === null || !reasonReady) return
    inFlight.current = true
    setSaving(true)
    try {
      const accepted = await confirm({
        title: copy.confirm,
        body: `${currentTotal} → ${target} · ${copy.impact} ${reduction}`,
        confirmLabel: t.common.save,
      })
      if (!accepted) return
      const input = { expectedCurrentTotal: currentTotal, targetTotal: target, reason: reason.trim() }
      const signature = JSON.stringify(input)
      if (operation.current?.signature !== signature) operation.current = { signature, key: crypto.randomUUID() }
      if (await onSave({ ...input, occurrenceKey: operation.current.key })) onEditing(false)
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return <section className="rounded-xl border border-line bg-surface-card p-3" aria-label={copy.edit}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold">{t.shift.cashFloat} <Money value={currentTotal} currency="SYP_NEW" /></p>
      {!editing ? <Button variant="ghost" size="sm" disabled={locked} onClick={() => {
        setAmount(currentTotal)
        setReason('')
        operation.current = null
        onEditing(true)
      }}>{copy.edit}</Button> : null}
    </div>
    {editing ? <form className="mt-3 flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <p className="text-xs text-ink-muted">{copy.hint}</p>
      <Field label={copy.target} htmlFor={amountId}>
        <MoneyInput id={amountId} value={amount} disabled={locked} aria-invalid={reduction === null} onChange={(event) => setAmount(event.target.value)} />
      </Field>
      {reduction === null ? <p className="text-xs text-danger-ink">{copy.invalid}</p> : <p className="text-sm">{copy.impact} <Money value={reduction} currency="SYP_NEW" /></p>}
      <Field label={copy.reason} htmlFor={reasonId}>
        <TextInput id={reasonId} value={reason} maxLength={500} disabled={locked} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={locked || reduction === null || !reasonReady}>{saving ? t.common.loading : t.common.save}</Button>
        <Button type="button" variant="ghost" disabled={locked} onClick={() => onEditing(false)}>{t.common.cancel}</Button>
      </div>
    </form> : null}
  </section>
}
