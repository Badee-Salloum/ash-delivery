import { type ReactNode, useCallback, useEffect, useState } from 'react'
import type { BatteryReadingInput } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Button, Card, Field, TextInput } from '../ui.tsx'
import { PhotoSlot } from './PhotoSlot.tsx'

export interface FittedBattery {
  id: string
  slotNo: number | null
  capacityAh: number
  serialNo: string | null
  /** Which BMS app this pack ships with. `null` ⇒ the reader tries every profile it knows. */
  bmsProfile?: string | null
}

/**
 * One BMS screenshot and one set of numbers PER BATTERY PACK.
 *
 * The bikes carry one or two packs, so this is not a single battery field: the shift gate asks for
 * a reading per pack fitted, and a two-pack bike cannot open or close on one screenshot. The pack
 * list comes from the server (`/me/assignment`), which is the same list the gate counts — so this
 * checklist and the gate can never disagree about how many readings are owed.
 *
 * The tile opens the GALLERY, not the camera: a BMS reading is a screenshot the driver already
 * took, and forcing the camera would make him photograph one phone screen with another.
 *
 * EVERY FIGURE IS TYPEABLE. OCR pre-fills what it can and the driver corrects or completes the
 * rest. Only the percentage used to be editable, with the health figures shown as a read-only echo
 * of whatever OCR found — so on any handset where OCR struggled, the cycle count and voltage were
 * lost even though the screenshot was sitting right there.
 *
 * What OCR read is kept in `ocrRaw` and sent alongside the corrected value, so SRS D-3's "log the
 * manual edit WITH its difference from the OCR reading" is recoverable later.
 */

/** The fields, in the order a driver reads them off the screen. */
const FIELDS = [
  // `required` is the shift gate's own rule: a pack with no charge reading cannot open a shift.
  // Everything below it is pack health — worth having, never worth blocking a driver over.
  { key: 'percent', label: 'percent', unit: '%', scale: 1, decimals: 0, required: true },
  { key: 'packMillivolts', label: 'voltage', unit: 'V', scale: 1000, decimals: 2 },
  { key: 'cycleCount', label: 'cycles', unit: '', scale: 1, decimals: 0 },
  { key: 'remainCapacityDah', label: 'remainCapacity', unit: 'Ah', scale: 10, decimals: 1 },
  { key: 'fullCapacityDah', label: 'fullCapacity', unit: 'Ah', scale: 10, decimals: 1 },
  { key: 'mosTempDc', label: 'mosTemp', unit: '°C', scale: 10, decimals: 1 },
  { key: 't1Dc', label: 'temp1', unit: '°C', scale: 10, decimals: 1 },
  { key: 't2Dc', label: 'temp2', unit: '°C', scale: 10, decimals: 1 },
] as const

type FieldKey = (typeof FIELDS)[number]['key']

/** Stored scaled integer → what the driver sees. 83_370 → "83.37". */
const toText = (stored: number | null, scale: number, decimals: number): string =>
  stored === null ? '' : (stored / scale).toFixed(decimals).replace(/\.?0+$/, (m) => (decimals === 0 ? '' : m))

/** What the driver typed → the scaled integer. "83.37" → 83_370. Blank is null, never 0. */
const toStored = (text: string, scale: number): number | null => {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? Math.round(n * scale) : null
}

interface PackState {
  values: Record<FieldKey, string>
  /** The OCR reading as produced, before any correction — the D-3 baseline. */
  ocrRaw: unknown
  outcome: 'idle' | 'reading' | 'ok' | 'timeout' | 'unavailable' | 'no_fields'
  fieldsFound: number
  /** What the reader actually saw, shown behind a tap when it failed. */
  text: string
}

const EMPTY: PackState = {
  values: {
    percent: '', packMillivolts: '', cycleCount: '', remainCapacityDah: '',
    fullCapacityDah: '', mosTempDc: '', t1Dc: '', t2Dc: '',
  },
  ocrRaw: null,
  outcome: 'idle',
  fieldsFound: 0,
  text: '',
}

export function BatteryPanel({
  shiftId,
  pkg,
  batteries,
  slots,
  onSlotUploaded,
  onReadingsChanged,
}: {
  shiftId: string
  pkg: 'start' | 'end'
  batteries: readonly FittedBattery[]
  /** Which evidence slots have actually uploaded, so a tile can show its taken state. */
  slots: ReadonlySet<string>
  onSlotUploaded(slot: string): void
  onReadingsChanged?(complete: boolean): void
}): ReactNode {
  const { api, t } = useApp()
  const [packs, setPacks] = useState<Record<string, PackState>>({})
  const [files, setFiles] = useState<Record<string, File>>({})

  const slotOf = (b: FittedBattery, i: number): number => b.slotNo ?? i + 1
  const stateOf = (id: string): PackState => packs[id] ?? EMPTY

  const complete = batteries.every((b, i) => stateOf(b.id).values.percent.trim() !== '' && slots.has(`bms_${slotOf(b, i)}`))
  useEffect(() => onReadingsChanged?.(complete), [complete, onReadingsChanged])

  /** Push one pack's reading. A retake corrects that pack's row rather than adding a second. */
  const push = useCallback(
    async (batteryId: string, state: PackState): Promise<void> => {
      const percent = toStored(state.values.percent, 1)
      if (percent === null) return // the gate needs a charge; the rest is optional detail

      const scaled = (key: FieldKey): number | null => {
        const field = FIELDS.find((f) => f.key === key)!
        return toStored(state.values[key], field.scale)
      }
      const body: BatteryReadingInput = {
        batteryId,
        percent,
        packMillivolts: scaled('packMillivolts'),
        cycleCount: scaled('cycleCount'),
        remainCapacityDah: scaled('remainCapacityDah'),
        fullCapacityDah: scaled('fullCapacityDah'),
        mosTempDc: scaled('mosTempDc'),
        t1Dc: scaled('t1Dc'),
        t2Dc: scaled('t2Dc'),
        // `ocr` only while every field still holds exactly what the reader produced. The moment
        // the driver corrects one it is `manual` — which is what makes the ocrRaw delta a real
        // record of a human disagreeing with the machine (SRS D-3) rather than decoration.
        source: state.outcome === 'ok' && matchesOcr(state) ? 'ocr' : 'manual',
        ocrRaw: state.ocrRaw,
      }

      // Swallowed on purpose: the gate re-reads the stored rows at submit time, so a dropped write
      // shows up as an honest "reading missing", never as a false success.
      await api.putBatteryReadings(shiftId, pkg, [body]).catch(() => undefined)
    },
    [api, shiftId, pkg],
  )

  const setPack = useCallback(
    (batteryId: string, next: PackState): void => {
      setPacks((cur) => ({ ...cur, [batteryId]: next }))
      void push(batteryId, next)
    },
    [push],
  )

  const runOcr = useCallback(
    async (battery: FittedBattery, file: File): Promise<void> => {
      setPacks((cur) => ({ ...cur, [battery.id]: { ...(cur[battery.id] ?? EMPTY), outcome: 'reading' } }))
      const { readBms } = await import('../ocr.ts')
      // The pack's own app profile: the right label spellings, layout rule and segmentation for
      // THIS battery, rather than one reader guessing at every app at once.
      const result = await readBms(file, { profileId: battery.bmsProfile ?? null })

      setPacks((cur) => {
        const prev = cur[battery.id] ?? EMPTY
        if (!result.ok) return { ...cur, [battery.id]: { ...prev, outcome: result.reason, text: result.text } }

        // Only fill a field the driver has not already answered — his typing always wins.
        const values = { ...prev.values }
        for (const f of FIELDS) {
          const read = result.reading[f.key]
          if (values[f.key].trim() === '' && read !== null) values[f.key] = toText(read, f.scale, f.decimals)
        }
        const next: PackState = {
          values,
          ocrRaw: result.reading,
          outcome: 'ok',
          fieldsFound: result.fieldsFound,
          text: result.text,
        }
        void push(battery.id, next)
        return { ...cur, [battery.id]: next }
      })
    },
    [push],
  )

  if (batteries.length === 0) {
    return (
      <Card>
        <p className="text-center text-sm text-amber-700">{t.battery.noneFitted}</p>
      </Card>
    )
  }

  return (
    <>
      {batteries.map((battery, i) => {
        const slotNo = slotOf(battery, i)
        const state = stateOf(battery.id)
        return (
          <div key={battery.id} className="flex flex-col gap-3">
            <PhotoSlot
              shiftId={shiftId}
              pkg={pkg}
              slot={`bms_${slotNo}`}
              label={`${t.battery.bmsShot} ${slotNo} · ${battery.capacityAh}Ah`}
              onUploaded={onSlotUploaded}
              onImage={(file) => {
                setFiles((cur) => ({ ...cur, [battery.id]: file }))
                void runOcr(battery, file)
              }}
              source="gallery"
            />

            <OcrStatus
              state={state}
              onRetry={files[battery.id] ? () => void runOcr(battery, files[battery.id]!) : undefined}
            />

            <Card className="flex flex-col gap-3">
              <p className="text-sm text-slate-400">{t.battery.bmsHint}</p>
              <p className="text-xs text-slate-400">{t.battery.requiredHint}</p>
              {FIELDS.map((f) => (
                <Field
                  key={f.key}
                  label={`${t.battery[f.label]}${f.unit ? ` (${f.unit})` : ''}${'required' in f ? ' *' : ''}`}
                >
                  <TextInput
                    inputMode="decimal"
                    value={state.values[f.key]}
                    onChange={(e) =>
                      setPack(battery.id, { ...state, values: { ...state.values, [f.key]: e.target.value } })
                    }
                  />
                </Field>
              ))}
            </Card>
          </div>
        )
      })}
    </>
  )
}

/** True while every filled field still matches exactly what OCR produced. */
function matchesOcr(state: PackState): boolean {
  const raw = state.ocrRaw as Record<string, number | null> | null
  if (!raw) return false
  return FIELDS.every((f) => state.values[f.key] === toText(raw[f.key] ?? null, f.scale, f.decimals))
}

/**
 * What OCR did, in words.
 *
 * This is the whole point of the rework. Every failure used to resolve to `null` and the screen
 * said nothing at all — a missing asset, a dead worker, a timeout and a clean read that matched no
 * field were indistinguishable, to the driver and to anyone debugging it. Now the driver knows
 * whether to wait, retry, or just type; and a report of "it didn't autofill" arrives with a reason
 * attached.
 */
function OcrStatus({ state, onRetry }: { state: PackState; onRetry?: (() => void) | undefined }): ReactNode {
  const { t } = useApp()
  if (state.outcome === 'idle') return null

  if (state.outcome === 'reading') {
    return <p className="text-center text-sm text-slate-400">{t.shift.reading}…</p>
  }
  if (state.outcome === 'ok') {
    return (
      <p className="text-center text-sm font-medium text-emerald-700">
        {t.battery.ocrOk.replace('{{n}}', String(state.fieldsFound))}
      </p>
    )
  }

  const message =
    state.outcome === 'timeout'
      ? t.battery.ocrTimeout
      : state.outcome === 'unavailable'
        ? t.battery.ocrUnavailable
        : t.battery.ocrNoFields

  return (
    <div className="flex flex-col gap-2">
      <p className="text-center text-sm font-medium text-amber-700">{message}</p>
      {onRetry ? (
        <Button variant="ghost" onClick={onRetry}>
          {t.battery.ocrRetry}
        </Button>
      ) : null}
      {/*
        What the reader actually saw. Collapsed, so a driver only meets it if he goes looking —
        but present, because a report of "it didn't fill" with this attached is a diagnosis, and
        without it is a guess. It is the difference between one more round and five.
      */}
      {state.text.trim() !== '' ? (
        <details className="rounded-lg bg-slate-100 px-3 py-2">
          <summary className="cursor-pointer text-xs text-slate-500">{t.battery.ocrSawTitle}</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-600">
            {state.text}
          </pre>
        </details>
      ) : null}
    </div>
  )
}
