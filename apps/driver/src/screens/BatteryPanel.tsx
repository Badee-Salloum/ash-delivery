import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { type BatteryReadingInput, checkStartBattery, plural, readInCloud } from '@ash/client'
import { useApp } from '../app-context.tsx'
import { Button, Card, Field, TextInput } from '../ui.tsx'
import { CloudReadStatus } from './CloudReadStatus.tsx'
import { ReadingLock } from './ReadingLock.tsx'
import { type CloudReadEvent, PhotoSlot } from './PhotoSlot.tsx'
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
 * What a BMS app might call each field, in either language.
 *
 * The prompt now PINS the keys to `percent` / `cycles`, so the first entry in each list is what
 * should arrive. The rest is belt and braces, and it was earned: the first version matched only
 * an exact `percent`, the model faithfully returned the app's own «Remain Battery» and «الطاقة
 * المتبقية», and two live reads filled zero fields at full price.
 *
 * `remaincapacity` is deliberately ABSENT from `percent`. It reads «50.0Ah» — a capacity, which
 * cleans to a plausible «50» and would report a full pack as half empty.
 */
export const BMS_ALIASES: Record<FieldKey, readonly string[]> = {
  percent: ['percent', 'remainbattery', 'remainingbattery', 'batterylevel', 'batterypercent', 'soc', 'الطاقةالمتبقية', 'الشحنالمتبقية', 'نسبةالشحن'],
  cycleCount: ['cycles', 'cyclecount', 'cyclecounts', 'الدورات', 'عدددورات', 'عددالدورات'],
}

/**
 * Normalise a label for comparison, keeping ARABIC letters.
 *
 * The bug this replaces stripped with `[^a-z]`, which turns «الطاقة المتبقية» into the empty
 * string — so every Arabic BMS screen matched nothing, silently.
 */
const normaliseLabel = (s: string): string => s.toLowerCase().replace(/[^a-z؀-ۿ]/g, '')

export function pickBmsField(fields: Record<string, string | null>, key: FieldKey): string | null {
  const aliases = BMS_ALIASES[key]
  for (const [label, value] of Object.entries(fields)) {
    if (value == null) continue
    if (aliases.includes(normaliseLabel(label))) return value
  }
  return null
}

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
 * Start a retake without carrying machine-prefilled values over from the previous screenshot.
 * Human corrections survive; values that still equal the old OCR baseline are cleared so a failed
 * new read cannot silently pair the old number with the new evidence.
 */
export function packForNewEvidence(current: PackState): PackState {
  const raw = (current.ocrRaw as Partial<Record<FieldKey, number | null>> | null) ?? null
  const values = { ...EMPTY_PACK.values, ...current.values }
  for (const field of FIELDS) {
    const prior = raw?.[field.key]
    if (prior !== null && prior !== undefined && toStored(values[field.key], field.scale) === prior) {
      values[field.key] = ''
    }
  }
  return { ...current, values, ocrRaw: null, outcome: 'reading', fieldsFound: 0, text: '' }
}

/** File object identity is the ownership token for every asynchronous read of a pack. */
export function isCurrentEvidenceFile(
  files: Readonly<Record<string, File>>,
  batteryId: string,
  file: File,
): boolean {
  return files[batteryId] === file
}

/**
 * One locally selected BMS evidence generation.
 *
 * `uploadedMediaId` is set only after this exact File has become the slot's server attachment;
 * `persistedMediaId` is set only after the reading write succeeds with that media id as its
 * optimistic lock. Keeping the two facts separate is what makes an upload failure (or a reading
 * write failure after a successful upload) remain visibly incomplete.
 */
export interface BmsEvidenceProgress {
  /** NULL after a remount: the server attachment is known even though the browser File is gone. */
  file: File | null
  uploadedMediaId: string | null
  persistedMediaId: string | null
}

/** Rehydrate the server-confirmed evidence generations without manufacturing browser Files. */
export function restoreBmsEvidenceProgress(
  mediaIds: Readonly<Record<string, string | null>>,
): Record<string, BmsEvidenceProgress> {
  return Object.fromEntries(
    Object.entries(mediaIds).map(([batteryId, mediaId]) => [
      batteryId,
      { file: null, uploadedMediaId: mediaId, persistedMediaId: mediaId },
    ]),
  )
}

/** The media lock an ordinary edit should send for the active evidence generation. */
export function expectedBmsMediaId(
  progress: BmsEvidenceProgress | undefined,
  selectedFile: File | undefined,
): string | null {
  if (progress === undefined || progress.file !== (selectedFile ?? null)) return null
  return progress.uploadedMediaId
}

/** The UI gate for one pack, exported so the replacement lifecycle is executable in unit tests. */
export function isBmsPackReady(input: {
  unavailable: boolean
  hasPercent: boolean
  slotUploaded: boolean
  progress?: BmsEvidenceProgress
}): boolean {
  if (
    input.progress !== undefined &&
    (input.progress.uploadedMediaId === null ||
      input.progress.persistedMediaId !== input.progress.uploadedMediaId)
  ) {
    return false
  }
  return input.unavailable || (input.hasPercent && input.slotUploaded)
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
  initialMediaIds,
  onPacksChanged,
  onMediaIdChanged,
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
  /** Exact media links returned by `/state`, including NULL for an intentionally staged row. */
  initialMediaIds?: Readonly<Record<string, string | null>>
  /** Hand the readings back so they can outlive this mount. Must be a stable callback. */
  onPacksChanged?(packs: Record<string, PackState>): void
  /** Preserve a newly uploaded generation when this panel is temporarily unmounted. */
  onMediaIdChanged?(batteryId: string, mediaId: string): void
}): ReactNode {
  const { api, t } = useApp()
  const [packs, setPacks] = useState<Record<string, PackState>>(() => initialPacks ?? {})
  /** Upload completion must persist the newest reading, not the render that began the upload. */
  const packsRef = useRef<Record<string, PackState>>(initialPacks ?? {})
  useEffect(() => {
    packsRef.current = packs
  }, [packs])
  const updatePacks = useCallback(
    (updater: (current: Record<string, PackState>) => Record<string, PackState>): void => {
      // Ref first: an upload response can arrive before React has rendered the queued state.
      const next = updater(packsRef.current)
      packsRef.current = next
      setPacks(next)
    },
    [],
  )
  useEffect(() => onPacksChanged?.(packs), [packs, onPacksChanged])
  const [files, setFiles] = useState<Record<string, File>>({})
  /** The current evidence per pack; async readers must prove they still belong to it. */
  const filesRef = useRef<Record<string, File>>({})
  /** Upload and reading-persistence state for the exact File currently selected for each pack. */
  const [evidenceProgress, setEvidenceProgress] = useState<Record<string, BmsEvidenceProgress>>(() =>
    restoreBmsEvidenceProgress(initialMediaIds ?? {}),
  )
  const evidenceProgressRef = useRef<Record<string, BmsEvidenceProgress>>(evidenceProgress)
  const updateEvidenceProgress = useCallback(
    (
      batteryId: string,
      updater: (current: BmsEvidenceProgress | undefined) => BmsEvidenceProgress | undefined,
    ): void => {
      const next = { ...evidenceProgressRef.current }
      const updated = updater(next[batteryId])
      if (updated === undefined) delete next[batteryId]
      else next[batteryId] = updated
      evidenceProgressRef.current = next
      setEvidenceProgress(next)
    },
    [],
  )
  /** A late successful request may not mark a newer value/evidence generation as persisted. */
  const syncVersions = useRef<Record<string, number>>({})
  /** What the cloud reader is doing, per pack. Shown beside the pack's own OCR status. */
  const [cloudEvents, setCloudEvents] = useState<Record<string, CloudReadEvent>>({})
  /**
   * Packs the cloud has already answered for.
   *
   * A REF, not state, because the local read consults it inside a `setPacks` updater that must see
   * the newest value rather than the one captured when its callback was built.
   */
  const cloudAnswered = useRef<Set<string>>(new Set())
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
  const complete = batteries.every((b, i) =>
    isBmsPackReady({
      unavailable: unavailable.has(b.id),
      hasPercent: stateOf(b.id).values.percent.trim() !== '',
      slotUploaded: slots.has(`bms_${slotOf(b, i)}`),
      ...(evidenceProgress[b.id] === undefined ? {} : { progress: evidenceProgress[b.id] }),
    }),
  )
  useEffect(() => onReadingsChanged?.(complete), [complete, onReadingsChanged])

  /** Push one pack's reading. A retake corrects that pack's row rather than adding a second. */
  const push = useCallback(
    async (batteryId: string, state: PackState): Promise<boolean> => {
      const version = (syncVersions.current[batteryId] ?? 0) + 1
      syncVersions.current[batteryId] = version
      const selectedFile = filesRef.current[batteryId]
      const generationFile = selectedFile ?? null
      const selectedProgress = evidenceProgressRef.current[batteryId]
      const lockedMediaId = expectedBmsMediaId(selectedProgress, selectedFile)

      // A restored generation has `file: null` + the media id returned by `/state`; an ordinary edit
      // locks to that id. A newly selected File resets the id to NULL and therefore cannot write
      // until THAT generation uploads. Local/cloud OCR and typing all share this path.
      if (
        selectedProgress !== undefined &&
        (selectedProgress.file !== generationFile || lockedMediaId === null)
      ) {
        return false
      }
      if (selectedFile !== undefined && selectedProgress === undefined) return false

      if (selectedProgress !== undefined) {
        updateEvidenceProgress(batteryId, (current) =>
          current?.file === generationFile ? { ...current, persistedMediaId: null } : current,
        )
      }
      const percent = toStored(state.values.percent, 1)
      if (percent === null) return false // the gate needs a charge; the rest is optional detail

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
        ...(lockedMediaId === null ? {} : { expectedMediaId: lockedMediaId }),
      }

      try {
        await api.putBatteryReadings(shiftId, pkg, [body])
        if (
          selectedProgress !== undefined &&
          syncVersions.current[batteryId] === version &&
          (filesRef.current[batteryId] ?? null) === generationFile
        ) {
          updateEvidenceProgress(batteryId, (current) =>
            current?.file === generationFile && current.uploadedMediaId === lockedMediaId
              ? { ...current, persistedMediaId: lockedMediaId }
              : current,
          )
        }
        return true
      } catch {
        // Most callers are best-effort while the driver types. The upload-completion caller checks
        // this boolean and keeps its tile retryable until the evidence-linked write succeeds.
        return false
      }
    },
    [api, shiftId, pkg, updateEvidenceProgress],
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
      updatePacks((cur) => ({ ...cur, [batteryId]: next }))
      void push(batteryId, next)
    },
    [push, updatePacks],
  )

  const runOcr = useCallback(
    async (battery: FittedBattery, file: File): Promise<void> => {
      updatePacks((cur) => ({ ...cur, [battery.id]: { ...(cur[battery.id] ?? EMPTY_PACK), outcome: 'reading' } }))
      const { readBms } = await import('../ocr.ts')
      // The pack's own app profile: the right label spellings, layout rule and segmentation for
      // THIS battery, rather than one reader guessing at every app at once.
      const result = await readBms(file, { profileId: battery.bmsProfile ?? null })

      // A retake superseded this read while it was running. Never write old values under new media.
      if (!isCurrentEvidenceFile(filesRef.current, battery.id, file)) return

      updatePacks((cur) => {
        const prev = cur[battery.id] ?? EMPTY_PACK
        if (!result.ok) return { ...cur, [battery.id]: { ...prev, outcome: result.reason, text: result.text } }

        /*
         * THE CLOUD ALREADY ANSWERED — stay out of both the values AND the baseline.
         *
         * The two readers raced and neither waited for the other, so whichever finished last won —
         * and they won DIFFERENT HALVES. This local read replaces `ocrRaw` wholesale while only
         * filling BLANK values, so arriving second it left the cloud's 66% in the field and its own
         * 11% as the baseline. `matchesOcr` then reported a mismatch, the row shipped as
         * `source: 'manual'`, and the manager's review announced
         * «مُعدّل يدوياً · الطاقة المتبقية: 11 → 66» about a number no human had touched.
         *
         * A false audit record is worse than a missing one: D-3 exists so a manager can see where a
         * human disagreed with a machine, and this was inventing disagreements.
         *
         * `text` still updates — it is what the PHONE saw, shown behind «تفاصيل تقنية للدعم», and
         * that is true whoever ended up filling the field.
         */
        if (cloudAnswered.current.has(battery.id)) {
          return { ...cur, [battery.id]: { ...prev, text: result.text } }
        }

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
    [push, updatePacks],
  )

  /**
   * The BMS screen read in the CLOUD.
   *
   * Unlike the money screens, nothing here reaches BR1 — a battery percentage is telemetry, and a
   * misread costs a manager a second look rather than a ledger that will not balance. What it does
   * carry is a GATE: `batteryGaps` refuses to open a shift on a pack whose percent is null,
   * deliberately, because "the driver uploaded the screenshot and the OCR came back empty is
   * exactly the case a gate must catch rather than wave through". So a cloud read that fills the
   * field must be as trustworthy as one the driver typed — which is why it still only PREFILLS,
   * and `matchesOcr` still decides whether the row is recorded as `ocr` or `manual`.
   *
   * These screens are English/Latin-digit and regularly laid out, so this is the easiest of the
   * five for either reader. The cloud earns its place here mostly on the Arabic-light variant.
   */
  /**
   * Read this pack's screenshot again after a timeout, from the file already in hand.
   *
   * Worth a button here specifically because `batteryGaps` treats a null charge as a missing
   * reading and refuses to open the shift on it — so a pack whose read timed out is a pack the
   * driver is blocked on, and sending him back to the gallery for a photo the app is still
   * holding would be the app wasting his time.
   */
  const retryCloud = useCallback(
    async (battery: FittedBattery, file: File): Promise<void> => {
      setCloudEvents((cur) => ({ ...cur, [battery.id]: { status: 'reading' } }))
      const res = await readInCloud(api, shiftId, 'bms', file)
      cloudRead(
        battery,
        res === null
          ? { status: 'failed', reason: 'unavailable' }
          : res.ok
            ? { status: 'read', response: res }
            : { status: 'failed', reason: res.reason ?? 'unavailable' },
        file,
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cloudRead is declared below; both are
    // stable for the lifetime of the panel and referencing it here would be a cycle.
    [api, shiftId],
  )

  const cloudRead = useCallback(
    (battery: FittedBattery, e: CloudReadEvent, file: File): void => {
      if (!isCurrentEvidenceFile(filesRef.current, battery.id, file)) return
      // Every event, not only the successful one. A pack whose cloud read is still running, or
      // timed out, is a pack the driver may be waiting on before he can start the shift.
      setCloudEvents((cur) => ({ ...cur, [battery.id]: e }))
      if (e.status !== 'read') return
      // Claim this pack before writing, so a local read still in flight leaves it alone.
      cloudAnswered.current.add(battery.id)
      updatePacks((cur) => {
        const prev = cur[battery.id] ?? EMPTY_PACK
        const values = { ...prev.values }
        const priorRaw = (prev.ocrRaw as Record<string, number | null> | null) ?? null
        const raw: Record<string, number | null> = { ...(priorRaw ?? {}) }
        let filled = 0

        for (const f of FIELDS) {
          const said = pickBmsField(e.response.fields, f.key)
          if (said === null) continue
          const cleaned = said.replace(/[^\d.]/g, '')
          if (cleaned === '') continue
          // A percentage that is not a percentage is the one wrong answer worth refusing outright:
          // «Remain Capacity 50.0Ah» cleans to a perfectly plausible «50» on a pack that is full.
          if (f.key === 'percent' && Number(cleaned) > 100) continue

          /*
           * WHOSE VALUE IS ALREADY IN THE BOX? Three cases, and only one of them is untouchable.
           *
           *   empty                          → fill it
           *   exactly what the phone read     → the cloud is the better reader; replace it
           *   anything else                   → the DRIVER typed it. Never overwrite him.
           *
           * The middle case is why `priorRaw` is consulted rather than just checking for blank: the
           * on-device read fires first and usually lands, so deferring to a non-empty field would
           * mean the cloud reader never got to correct anything on this screen.
           */
          const held = values[f.key].trim()
          const asPhoneRead = toText(priorRaw?.[f.key] ?? null, f.scale, f.decimals)
          if (held === '' || held === asPhoneRead) values[f.key] = cleaned

          /*
           * RECORD WHAT THE MACHINE SAID. Leaving this out was a false record, not a missing one.
           *
           * `matchesOcr` reads `ocrRaw` to decide whether the row is stored as `source: 'ocr'` or
           * `'manual'`, and `sourceOf` reads it to pick the mark beside the field. With `ocrRaw`
           * null, a charge gpt-5.5 had just read shipped to the server as MANUAL and told the
           * driver «لم يستطع التطبيق قراءتها — أنت كتبتها» — the app could not read it, you typed
           * it. Both statements were untrue, and D-3's whole purpose is that the manager can see
           * what the machine said beside what the human confirmed.
           */
          raw[f.key] = toStored(cleaned, f.scale)
          filled += 1
        }

        if (filled === 0) return cur
        const next: PackState = {
          ...prev,
          values,
          ocrRaw: raw,
          outcome: 'ok',
          // Never report FEWER fields than the phone had already found on its own.
          fieldsFound: Math.max(prev.fieldsFound, filled),
        }
        void push(battery.id, next)
        return { ...cur, [battery.id]: next }
      })
    },
    [push, updatePacks],
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
          // Each pack holds only ITSELF while its read runs: two packs are read one after the
          // other, and covering the whole panel for the second would freeze the first he has
          // already finished with.
          <ReadingLock key={battery.id} active={cloudEvents[battery.id]?.status === 'reading'}>
          <div className="flex flex-col gap-3">
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
                  onUploaded={async (uploadedSlot, result, file) => {
                    /*
                     * The first OCR write can finish before its evidence upload, so the server has
                     * no media id to attach yet. Re-persist after attachment and only then let the
                     * parent mark the slot complete; this closes that ordering race for local,
                     * cloud and manually entered values alike.
                     */
                    if (
                      result === undefined ||
                      file === undefined ||
                      !isCurrentEvidenceFile(filesRef.current, battery.id, file)
                    ) {
                      throw new Error('battery_evidence_generation_changed')
                    }
                    updateEvidenceProgress(battery.id, (current) =>
                      current?.file === file
                        ? { ...current, uploadedMediaId: result.mediaId, persistedMediaId: null }
                        : current,
                    )
                    onMediaIdChanged?.(battery.id, result.mediaId)
                    const held = packsRef.current[battery.id]
                    if (held?.values.percent.trim() && !(await push(battery.id, held))) {
                      throw new Error('battery_reading_persist_failed')
                    }
                    onSlotUploaded(uploadedSlot)
                  }}
                  onImage={(file) => {
                    // Close the parent gate in this same interaction; do not leave one render in
                    // which the old slot + old persisted reading can still enable submit.
                    onReadingsChanged?.(false)
                    filesRef.current = { ...filesRef.current, [battery.id]: file }
                    syncVersions.current[battery.id] = (syncVersions.current[battery.id] ?? 0) + 1
                    updateEvidenceProgress(battery.id, () => ({
                      file,
                      uploadedMediaId: null,
                      persistedMediaId: null,
                    }))
                    cloudAnswered.current.delete(battery.id)
                    setCloudEvents((cur) => {
                      const next = { ...cur }
                      delete next[battery.id]
                      return next
                    })
                    updatePacks((cur) => ({
                      ...cur,
                      [battery.id]: packForNewEvidence(cur[battery.id] ?? EMPTY_PACK),
                    }))
                    setFiles((cur) => ({ ...cur, [battery.id]: file }))
                    void runOcr(battery, file)
                  }}
                  ocrField="bms"
                  onCloudRead={(e, file) => {
                    if (file) cloudRead(battery, e, file)
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
            {/* The cloud read runs alongside the phone's and finishes at its own pace, so it gets
                its own line rather than fighting `OcrStatus` for one. A pack with no charge
                reading cannot open a shift — `batteryGaps` refuses it — so a cloud read still
                running is something the driver is genuinely waiting on. */}
            <CloudReadStatus
              event={cloudEvents[battery.id] ?? null}
              {...(files[battery.id]
                ? { onRetry: () => void retryCloud(battery, files[battery.id]!) }
                : {})}
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
          </ReadingLock>
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
