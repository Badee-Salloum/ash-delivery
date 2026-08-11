import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { type BatteryReadingInput, checkStartBattery, plural } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Button, Card, Field, TextInput } from '../ui.tsx'
import { PhotoSlot } from './PhotoSlot.tsx'
import { SourceMark, sourceOf } from './ReadingSource.tsx'

export interface FittedBattery {
  id: string
  slotNo: number | null
  capacityAh: number
  serialNo: string | null
  /**
   * «الرقم التمييزي» — the number marked on the pack itself.
   *
   * The slot number says which socket it sits in, not which pack it is; the serial comes off the
   * BMS app and is unreadable without pairing. This is the one a driver photographing two packs can
   * match against what is in his hand, which is what stops slot 1's screenshot being uploaded for
   * slot 2 and a shift's battery evidence describing the wrong pack.
   */
  groundNo?: string | null
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

/**
 * The two figures captured per pack, in the order a driver reads them off the screen. Shared with
 * the swap panel. The product tracks only the remaining charge (which the shift gate requires) and
 * the lifetime cycle count; voltage / capacity / temperatures are no longer captured.
 */
export const FIELDS = [
  // `required` is the shift gate's own rule: a pack with no charge reading cannot open a shift.
  { key: 'percent', label: 'percent', unit: '%', scale: 1, decimals: 0, required: true },
  { key: 'cycleCount', label: 'cycles', unit: '', scale: 1, decimals: 0 },
] as const

type FieldKey = (typeof FIELDS)[number]['key']

/**
 * Stored scaled integer → what the driver sees. 83_370 → "83.37", 500 → "50" (50.0 Ah).
 *
 * The trailing-zero trim is ONLY for decimal fields, to turn "50.0" into "50". Its logic used to
 * be inverted: it stripped trailing zeros from WHOLE numbers and left decimals alone, so a
 * correctly-read charge of 100 was formatted as "1" — the "100 read as 1" reported from the phone
 * over four rounds was this line, not the OCR. An integer field is already clean and must be left
 * exactly as `toFixed(0)` produced it.
 */
export const toText = (stored: number | null, scale: number, decimals: number): string => {
  if (stored === null) return ''
  const fixed = (stored / scale).toFixed(decimals)
  return decimals === 0 ? fixed : fixed.replace(/\.?0+$/, '')
}

/** What the driver typed → the scaled integer. "83.37" → 83_370. Blank is null, never 0. */
export const toStored = (text: string, scale: number): number | null => {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? Math.round(n * scale) : null
}

export interface PackState {
  values: Record<FieldKey, string>
  /** The OCR reading as produced, before any correction — the D-3 baseline. */
  ocrRaw: unknown
  outcome: 'idle' | 'reading' | 'ok' | 'timeout' | 'unavailable' | 'no_fields'
  fieldsFound: number
  /** What the reader actually saw, shown behind a tap when it failed. */
  text: string
}

/** Exported so a caller restoring readings builds a REAL `PackState` instead of a lookalike. */
export const EMPTY_PACK: PackState = {
  values: { percent: '', cycleCount: '' },
  ocrRaw: null,
  outcome: 'idle',
  fieldsFound: 0,
  text: '',
}

/**
 * Rebuild the panel's state from readings the server already holds, on a resumed shift.
 *
 * A FUNCTION RATHER THAN AN INLINE OBJECT, because the inline version was wrong for weeks and
 * TypeScript was told to stop asking. `Shift.tsx` built `{ ...prior, percent: '41' }` — the charge
 * at the TOP level instead of inside `values` — and closed the hole with `as EndDraft['packs']`.
 * `stateOf` is `packs[id] ?? EMPTY_PACK`, so the malformed entry was truthy, the fallback never ran,
 * and reading `.values.percent` threw «Cannot read properties of undefined (reading 'percent')» the
 * instant the close screen rendered. The driver saw the «ASH» splash and nothing else.
 *
 * Prior local state wins on every field EXCEPT the charge, which is what the server just confirmed.
 */
export function restorePacks(
  stored: readonly { batteryId: string; percent: number | null }[],
  prior: Readonly<Record<string, PackState>>,
): Record<string, PackState> {
  const out: Record<string, PackState> = { ...prior }
  for (const reading of stored) {
    if (reading.percent === null) continue
    const held = prior[reading.batteryId] ?? EMPTY_PACK
    out[reading.batteryId] = {
      ...held,
      values: { ...EMPTY_PACK.values, ...held.values, percent: String(reading.percent) },
    }
  }
  return out
}

export function BatteryPanel({
  shiftId,
  pkg,
  batteries,
  slots,
  onSlotUploaded,
  onReadingsChanged,
  initialPacks,
  onPacksChanged,
}: {
  shiftId: string
  pkg: 'start' | 'end'
  batteries: readonly FittedBattery[]
  /** Which evidence slots have actually uploaded, so a tile can show its taken state. */
  slots: ReadonlySet<string>
  onSlotUploaded(slot: string): void
  onReadingsChanged?(complete: boolean): void
  /**
   * Readings to start from, when the caller kept them across the screen being left and re-entered.
   *
   * Every reading is pushed to the server as it is typed, so nothing was ever LOST on unmount — but
   * the fields came back blank and `complete` came back false, so the driver had to retype numbers
   * the system already held before it would let him submit. Omitted ⇒ the panel starts empty.
   */
  initialPacks?: Record<string, PackState>
  /** Hand the readings back so they can outlive this mount. Must be a stable callback. */
  onPacksChanged?(packs: Record<string, PackState>): void
}): ReactNode {
  const { api, t } = useApp()
  const [packs, setPacks] = useState<Record<string, PackState>>(() => initialPacks ?? {})
  useEffect(() => onPacksChanged?.(packs), [packs, onPacksChanged])
  const [files, setFiles] = useState<Record<string, File>>({})
  /**
   * Packs the driver has declared he cannot read on his own phone.
   *
   * Local to this mount on purpose: the server is the record (`unavailable` on the reading row), and
   * this only decides what the screen shows him next.
   */
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(new Set())
  /**
   * Packs whose surprising charge the driver has looked at and stood by.
   *
   * Confirming IS the answer, not a step towards refusing. Every one of these can genuinely be true,
   * and a value a human has asserted is worth more than a quiet one.
   */
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set())

  const slotOf = (b: FittedBattery, i: number): number => b.slotNo ?? i + 1

  /**
   * TOTAL BY CONSTRUCTION. `packs[id] ?? EMPTY_PACK` was not enough: a caller that handed back a
   * half-built entry produced something truthy, so the fallback never ran and `.values.percent`
   * threw on a resumed shift — the driver saw only the «ASH» splash. `initialPacks` crosses a
   * component boundary and has already been wrong once; merging is cheap and this screen is the
   * last gate before a shift can close.
   */
  const stateOf = (id: string): PackState => {
    const held = packs[id]
    if (!held) return EMPTY_PACK
    return { ...EMPTY_PACK, ...held, values: { ...EMPTY_PACK.values, ...held.values } }
  }

  // A declared pack counts as done FOR HIM. The server's gate still wants the manager's reading —
  // that is `awaiting_manager_reading`, and it blocks the approval, not the driver.
  const complete = batteries.every(
    (b, i) => unavailable.has(b.id) || (stateOf(b.id).values.percent.trim() !== '' && slots.has(`bms_${slotOf(b, i)}`)),
  )
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
        cycleCount: scaled('cycleCount'),
        // Voltage / capacity / temperatures are no longer captured; they stay nullable seams on the
        // wire and default to null when omitted.
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

  /**
   * «التطبيق لا يعمل على جهازي».
   *
   * Some phones simply will not run the BMS app — an old Android, a device its manufacturer's app
   * refuses, Bluetooth that will not pair. Before this the driver was stuck at the gate being asked
   * for a screenshot his hardware cannot produce, and the only way past it was to photograph
   * something else, which turns a hardware problem into false evidence.
   */
  const declareUnavailable = useCallback(
    async (batteryId: string): Promise<void> => {
      setUnavailable((cur) => new Set(cur).add(batteryId))
      await api
        .putBatteryReadings(shiftId, pkg, [{ batteryId, percent: null, unavailable: true, source: 'manual' }])
        .catch(() => undefined)
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
      setPacks((cur) => ({ ...cur, [battery.id]: { ...(cur[battery.id] ?? EMPTY_PACK), outcome: 'reading' } }))
      const { readBms } = await import('../ocr.ts')
      // The pack's own app profile: the right label spellings, layout rule and segmentation for
      // THIS battery, rather than one reader guessing at every app at once.
      const result = await readBms(file, { profileId: battery.bmsProfile ?? null })

      setPacks((cur) => {
        const prev = cur[battery.id] ?? EMPTY_PACK
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
        const label =
          battery.groundNo == null || battery.groundNo === ''
            ? `${t.battery.bmsShot} ${slotNo} · ${battery.capacityAh}Ah`
            : `${t.battery.bmsShot} ${slotNo} · ${t.fleet.groundNo} ${battery.groundNo} · ${battery.capacityAh}Ah`
        return (
          <div key={battery.id} className="flex flex-col gap-3">
            {/* The long name is a HEADING now, not the tile's label. «صورة تطبيق البطارية ١ ·
                الرقم على الأرض D14 · 50Ah» is the longest string in the app, and inside a
                `justify-between` flex with no truncation it wrapped to four lines and squeezed the
                tile's own ✓ off the end. */}
            <div className="flex items-center gap-3">
              <div className="w-20 shrink-0">
                <PhotoSlot
                  shiftId={shiftId}
                  pkg={pkg}
                  slot={`bms_${slotNo}`}
                  label={label}
                  badge={String(slotNo)}
                  variant="tile"
                  uploaded={slots.has(`bms_${slotNo}`)}
                  onUploaded={onSlotUploaded}
                  onImage={(file) => {
                    setFiles((cur) => ({ ...cur, [battery.id]: file }))
                    void runOcr(battery, file)
                  }}
                />
              </div>
              <p className="min-w-0 flex-1 text-sm font-medium text-slate-700">{label}</p>
            </div>
            <OcrStatus
              state={state}
              missing={FIELDS.filter((f) => state.values[f.key].trim() === '').length}
              onRetry={files[battery.id] ? () => void runOcr(battery, files[battery.id]!) : undefined}
            />

            {unavailable.has(battery.id) ? (
              /* Declared. Say plainly what happens next, so he is not left wondering whether he has
                 broken something — the shift proceeds and the branch manager reads this pack. */
              <Card className="flex flex-col gap-2">
                <p className="text-sm font-medium text-amber-800">{t.battery.unavailableDeclared}</p>
                <p className="text-xs text-slate-600">{t.battery.unavailableNext}</p>
              </Card>
            ) : (
              <Card className="flex flex-col gap-3">
                <p className="text-sm text-slate-600">{t.battery.bmsHint}</p>
                <p className="text-xs text-slate-600">{t.battery.requiredHint}</p>
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
                    {/* PER FIELD, not per pack. `matchesOcr` is all-or-nothing, so correcting the
                        cycle count silently reclassified a perfectly-read charge as «manual» — the
                        driver could never see which of the two the machine had actually produced. */}
                    <SourceMark
                      source={sourceOf({
                        ocrValue: (state.ocrRaw as Record<string, unknown> | null)?.[f.key] ?? null,
                        hadImage: files[battery.id] !== undefined || state.outcome !== 'idle',
                        value: state.values[f.key],
                      })}
                    />
                  </Field>
                ))}
                {/* «هل هذا صحيح؟» — the reading that started all of this. A pack was recorded at 1%
                    at the START of a shift, straight from OCR, and nothing questioned it; a driver
                    does not set off on a flat battery, so that is the reader mistaking «100» for «1».
                    It never blocks: a pack really can be flat because a charger tripped overnight,
                    and refusing would teach him to type whatever gets past the gate — which is how
                    the 1% became evidence. A CONFIRMED odd value is the best training label there is. */}
                {pkg === 'start' && !confirmed.has(battery.id) && checkStartBattery(toStored(state.values.percent, 1)) ? (
                  <div className="flex flex-col gap-2 rounded-xl bg-amber-50 p-3">
                    <p className="text-sm font-medium text-amber-900">{t.battery.lowAtStart}</p>
                    <Button
                      variant="ghost"
                      className="self-start"
                      onClick={() => setConfirmed((cur) => new Set(cur).add(battery.id))}
                    >
                      {t.battery.yesCorrect}
                    </Button>
                  </div>
                ) : null}
                {/* The way out for a phone that cannot run the app at all. Deliberately quiet and at
                    the bottom: it is the exception, and it must not look like the easy path past a
                    gate. It never blocks him and it never hides the pack — it hands it to the manager. */}
                <button
                  type="button"
                  onClick={() => void declareUnavailable(battery.id)}
                  className="min-h-11 self-start text-sm text-slate-500 underline"
                >
                  {t.battery.appWontRun}
                </button>
              </Card>
            )}
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
function OcrStatus({
  state,
  missing,
  onRetry,
}: {
  state: PackState
  /** How many figures are still blank. A read is only really done when this is zero. */
  missing: number
  onRetry?: (() => void) | undefined
}): ReactNode {
  const { t, lang } = useApp()
  if (state.outcome === 'idle') return null

  if (state.outcome === 'reading') {
    return <p className="text-center text-sm text-slate-600">{t.shift.reading}…</p>
  }

  const failed = state.outcome !== 'ok'
  const message = failed
    ? state.outcome === 'timeout'
      ? t.battery.ocrTimeout
      : state.outcome === 'unavailable'
        ? t.battery.ocrUnavailable
        : t.battery.ocrNoFields
    : plural(state.fieldsFound, t.battery.ocrOk, lang)

  return (
    <div className="flex flex-col gap-2">
      <p className={`text-center text-sm font-medium ${failed ? 'text-amber-700' : 'text-emerald-700'}`}>{message}</p>

      {/*
        Retry is offered whenever anything is still blank — NOT only on total failure. Every real
        read has been a PARTIAL success: figures found, the charge missing, `outcome === 'ok'`, and
        an early return that hid the control. The one case anybody needed was the one with none.
      */}
      {failed || missing > 0 ? (
        onRetry ? (
          <Button variant="ghost" onClick={onRetry}>
            {t.battery.ocrRetry}
          </Button>
        ) : null
      ) : null}

      {/*
        The recognised text is ALWAYS available, not only when the read failed. A read that succeeds
        with the WRONG number looks identical to a right one on the glass, and it is the dangerous
        case — so the evidence for what the machine actually saw cannot be hidden behind failure.
        Collapsed, so it costs a driver nothing, and one tap for whoever is diagnosing a bad field.
      */}
      <details className="rounded-lg bg-slate-100 px-3 py-2">
        <summary className="cursor-pointer text-xs text-slate-500">{t.battery.ocrSawTitle}</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-600">
          {/* An empty result is itself the answer: the glyphs were never recognised, and no
              parser change can reach that. Say so rather than rendering nothing. */}
          {state.text.trim() === '' ? t.battery.ocrSawNothing : state.text}
        </pre>
      </details>
    </div>
  )
}
