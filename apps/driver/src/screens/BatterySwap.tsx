import { type ReactNode, useState } from 'react'
import type { BatteryReadingInput } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { useToast } from '../feedback.tsx'
import { Button, Card, Field, TextInput } from '../ui.tsx'
import { FIELDS, type FittedBattery, toStored } from './BatteryPanel.tsx'

type Reading = Omit<BatteryReadingInput, 'batteryId'>

/** A ready spare on the branch shelf, offered as the pack going on. */
export interface SpareBattery {
  id: string
  capacityAh: number
  serialNo: string | null
  bmsProfile?: string | null
}

type Vals = Record<string, string>
const EMPTY: Vals = { percent: '', cycleCount: '' }

/** One pack's reading, built from the typed (or scanned) fields — charge + cycles only. */
function readingOf(vals: Vals, ocrRaw: unknown): Reading {
  const scaled = (key: string): number | null => {
    const field = FIELDS.find((f) => f.key === key)!
    return toStored(vals[key] ?? '', field.scale)
  }
  return {
    percent: scaled('percent'),
    cycleCount: scaled('cycleCount'),
    source: ocrRaw ? 'ocr' : 'manual',
    ocrRaw: ocrRaw ?? undefined,
  }
}

/**
 * «تبديل بطارية» — a mid-shift battery swap (SRS §L seam).
 *
 * At a charging stop the driver takes a depleted pack off a slot and fits a charged spare. Both
 * packs' BMS readings are captured — the outgoing pack's final state and the incoming pack's first
 * — so per-pack health history is unbroken. The server re-fits the bike and hands back the new
 * fitted set, which the close screen then reads instead of the pack that just came off.
 */
export function BatterySwap({
  shiftId,
  fitted,
  spares,
  onSwapped,
}: {
  shiftId: string
  fitted: readonly FittedBattery[]
  spares: readonly SpareBattery[]
  onSwapped(fitted: FittedBattery[]): void
}): ReactNode {
  const { api, t } = useApp()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [slotNo, setSlotNo] = useState('')
  const [inId, setInId] = useState('')
  const [outVals, setOutVals] = useState<Vals>(EMPTY)
  const [inVals, setInVals] = useState<Vals>(EMPTY)
  const [outOcr, setOutOcr] = useState<unknown>(null)
  const [inOcr, setInOcr] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const outgoing = fitted.find((b) => String(b.slotNo ?? '') === slotNo) ?? null
  const incoming = spares.find((s) => s.id === inId) ?? null
  const ready = slotNo !== '' && inId !== '' && (outVals.percent ?? '').trim() !== '' && (inVals.percent ?? '').trim() !== ''

  const reset = (): void => {
    setSlotNo('')
    setInId('')
    setOutVals(EMPTY)
    setInVals(EMPTY)
    setOutOcr(null)
    setInOcr(null)
  }

  const submit = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setErr(null)
    try {
      const res = await api.swapBattery(shiftId, {
        slotNo: Number(slotNo),
        inBatteryId: inId,
        outReading: readingOf(outVals, outOcr),
        inReading: readingOf(inVals, inOcr),
      })
      onSwapped(res.batteries as FittedBattery[])
      reset()
      setOpen(false)
      toast.success(t.battery.swap.done)
    } catch (e) {
      const code = (e as { error?: string }).error
      setErr((code && (t.errors as Record<string, string>)[code]) || t.common.actionFailed)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {t.battery.swap.title}
      </Button>
    )
  }

  return (
    <Card className="flex flex-col gap-3">
      <p className="text-sm font-medium">{t.battery.swap.title}</p>
      <p className="text-xs text-slate-400">{t.battery.swap.hint}</p>

      <Field label={t.battery.swap.slot}>
        <BareSelect value={slotNo} onChange={setSlotNo}>
          <option value="">—</option>
          {fitted.map((b, i) => {
            const n = b.slotNo ?? i + 1
            return (
              <option key={b.id} value={String(n)}>
                {t.battery.swap.slotLabel.replace('{{n}}', String(n))} · {b.capacityAh}Ah{b.serialNo ? ` · ${b.serialNo}` : ''}
              </option>
            )
          })}
        </BareSelect>
      </Field>

      <Field label={t.battery.swap.incoming}>
        {spares.length === 0 ? (
          <p className="text-sm text-amber-700">{t.battery.swap.noSpares}</p>
        ) : (
          <BareSelect value={inId} onChange={setInId}>
            <option value="">—</option>
            {spares.map((s) => (
              <option key={s.id} value={s.id}>
                {s.serialNo ?? s.id.slice(0, 8)} · {s.capacityAh}Ah
              </option>
            ))}
          </BareSelect>
        )}
      </Field>

      <BmsMiniForm
        title={t.battery.swap.outReading}
        profileId={outgoing?.bmsProfile ?? null}
        values={outVals}
        onValues={setOutVals}
        onOcr={setOutOcr}
      />
      <BmsMiniForm
        title={t.battery.swap.inReading}
        profileId={incoming?.bmsProfile ?? null}
        values={inVals}
        onValues={setInVals}
        onOcr={setInOcr}
      />

      {err ? <p className="text-sm text-red-600">{err}</p> : null}
      <div className="flex gap-2">
        <Button variant="success" className="flex-1" disabled={!ready || busy} onClick={submit}>
          {busy ? t.common.loading : t.battery.swap.confirm}
        </Button>
        <Button
          variant="ghost"
          className="flex-1"
          onClick={() => {
            reset()
            setOpen(false)
          }}
        >
          {t.common.cancel}
        </Button>
      </div>
    </Card>
  )
}

/**
 * One pack's BMS figures for the swap: an optional scan that pre-fills, then every field typeable
 * (percent required). Mirrors BatteryPanel's rules but writes into the swap request, not a shift
 * reading — the swap has no evidence-media slot, so the screenshot is read on-device and discarded.
 */
function BmsMiniForm({
  title,
  profileId,
  values,
  onValues,
  onOcr,
}: {
  title: string
  profileId: string | null
  values: Vals
  onValues(v: Vals): void
  onOcr(raw: unknown): void
}): ReactNode {
  const { t } = useApp()
  const [reading, setReading] = useState(false)

  const scan = async (file: File): Promise<void> => {
    setReading(true)
    try {
      const { readBms } = await import('../ocr.ts')
      const result = await readBms(file, { profileId })
      if (!result.ok) return
      const next = { ...values }
      for (const f of FIELDS) {
        const read = result.reading[f.key]
        if ((next[f.key] ?? '').trim() === '' && read !== null) {
          next[f.key] = read === null ? '' : String(read / f.scale)
        }
      }
      onValues(next)
      onOcr(result.reading)
    } finally {
      setReading(false)
    }
  }

  return (
    <Card className="flex flex-col gap-2">
      <p className="text-sm font-medium">{title}</p>
      <label className="cursor-pointer rounded-lg border border-dashed border-slate-300 px-3 py-2 text-center text-sm text-slate-500">
        {reading ? `${t.shift.reading}…` : t.battery.swap.scan}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void scan(file)
          }}
        />
      </label>
      {FIELDS.map((f) => (
        <Field key={f.key} label={`${t.battery[f.label]}${f.unit ? ` (${f.unit})` : ''}${'required' in f ? ' *' : ''}`}>
          <TextInput
            inputMode="decimal"
            value={values[f.key] ?? ''}
            onChange={(e) => onValues({ ...values, [f.key]: e.target.value })}
          />
        </Field>
      ))}
    </Card>
  )
}

/** A native select styled to match the app's inputs; the driver ui has no Select of its own. */
function BareSelect({
  value,
  onChange,
  children,
}: {
  value: string
  onChange(v: string): void
  children: ReactNode
}): ReactNode {
  return (
    <select
      className="min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  )
}
