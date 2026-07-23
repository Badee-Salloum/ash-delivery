/**
 * On-device OCR (SRS §D, assisted variant).
 *
 * Tesseract.js runs entirely in the browser — no photo leaves the phone, no cloud, and it works on
 * the Damascus network once the assets are cached. The whole library (worker + wasm core +
 * traineddata) is loaded ONLY through a lazy `import()`, so it never touches the ~70 KB entry
 * bundle; the assets are self-hosted under `/tesseract/` (staged by scripts/copy-tesseract.mjs).
 *
 * Two readers, two very different jobs:
 *
 *   readDashboard  a PHOTOGRAPH of an e-bike dash — a few big glyphs, no labels worth reading.
 *                  Digits-only whitelist, sparse layout, "find the biggest number" heuristics.
 *
 *   readBms        a SCREENSHOT of the battery's BMS app — a dense, regular label/value table.
 *                  Labels are the whole point: «Cycle Count: 8» means nothing without the words,
 *                  so the digits-only whitelist that helps the dashboard makes this impossible.
 *                  It needs letters, a block layout, and real line boxes so a right-to-left
 *                  Arabic app (value first, label second) can still be paired up.
 *
 * Both are ASSISTED, never automatic: they PRE-FILL fields the driver then corrects.
 *
 * ── EVERY FAILURE IS REPORTED, NEVER SWALLOWED ────────────────────────────────────────────
 * These used to return `null` for a missing asset, a dead worker, a timeout and a clean read that
 * matched nothing — all four alike. The driver watched a spinner stop and nothing happen; nobody,
 * including whoever was debugging it, could learn which of the four had occurred. An `OcrOutcome`
 * carries the reason out, so the screen can say "timed out, type them in" instead of going quiet.
 */

export interface OcrReading {
  battery: number | null
  odometer: number | null
}

/**
 * A BMS readout. Scaled INTEGERS, never floats — millivolts, deci-amp-hours, deci-Celsius — so
 * 83.37 V is 83_370 and 50.0 Ah is 500. Same reasoning as money: a value that gates whether a bike
 * is fit to ride should not be carried by IEEE-754.
 */
export interface BmsReading {
  percent: number | null
  packMillivolts: number | null
  cycleCount: number | null
  remainCapacityDah: number | null
  fullCapacityDah: number | null
  mosTempDc: number | null
  t1Dc: number | null
  t2Dc: number | null
}

/** Why a read produced nothing. Each one wants a different response from the driver. */
export type OcrFailure =
  /** The worker or its assets would not load — offline on first use, or a wasm OOM. */
  | 'unavailable'
  /** Recognition ran past its deadline. On a slow handset this is the common one. */
  | 'timeout'
  /** Recognition finished and matched no field at all. The image or the labels are the problem. */
  | 'no_fields'

export type OcrOutcome<T> =
  | { ok: true; reading: T; fieldsFound: number; ms: number; text: string }
  | { ok: false; reason: OcrFailure; ms: number; text: string }

/** Per-purpose parameters. `setParameters` is per-call, so one worker serves both readers. */
interface Profile {
  whitelist: string
  psm: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Worker = any

let workerPromise: Promise<Worker> | null = null

/**
 * The worker, created once and reused.
 *
 * The cached promise is CLEARED on rejection. Holding a rejected promise here meant one transient
 * failure — assets not yet cached and the phone briefly offline, a wasm OOM on a cheap Android —
 * disabled OCR for the rest of the app session, silently, with no retry: `??=` never re-runs,
 * because a rejected promise is not null.
 *
 * `eng+ara` because the client uses both the English and the Arabic BMS app. Arabic costs roughly
 * another 0.7 MB on first use, fetched once and then cached forever by the service worker.
 */
async function getWorker(): Promise<Worker> {
  workerPromise ??= (async () => {
    const { createWorker, OEM } = await import('tesseract.js')
    return createWorker(['eng', 'ara'], OEM.LSTM_ONLY, {
      workerPath: '/tesseract/worker.min.js',
      corePath: '/tesseract/',
      langPath: '/tesseract/',
    })
  })().catch((err: unknown) => {
    workerPromise = null // let the next attempt rebuild it
    throw err
  })
  return workerPromise
}

/**
 * Download the models and instantiate the wasm, before any deadline starts counting.
 *
 * First use pulls ~9.6 MB over a Damascus connection. Charging that against the recognition
 * timeout made the very first read the one most likely to fail — exactly the read that decides
 * whether a driver ever trusts the feature. Callers show "preparing, first time only" around this.
 */
export async function warmUpOcr(): Promise<boolean> {
  try {
    await getWorker()
    return true
  } catch {
    return false
  }
}

/** One line of recognised text, with the boxes its words came from. */
export interface OcrLine {
  text: string
  words: Array<{ text: string; x0: number; x1: number }>
}

/**
 * Pull real lines out of a v7 result.
 *
 * tesseract.js v7 returns `{ text }` and nothing else unless `blocks` is asked for, and its `Page`
 * has NO top-level `words` — they live at `blocks[].paragraphs[].lines[].words[]`. Reading
 * `data.words` (as this module used to) therefore always produced `[]`, so the geometric pairing
 * written for the Arabic app's right-to-left layout had never executed even once.
 *
 * Lines carry their own text and their words carry x-boxes, which is everything the two-column
 * English layout and the RTL Arabic layout each need — and it beats splitting `data.text`, whose
 * line breaks in a two-column readout are not to be trusted.
 */
function linesOf(data: { text?: string; blocks?: unknown }): OcrLine[] {
  const out: OcrLine[] = []
  const blocks = (data.blocks ?? []) as Array<{
    paragraphs?: Array<{ lines?: Array<{ text?: string; words?: Array<{ text?: string; bbox?: { x0: number; x1: number } }> }> }>
  }>
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        out.push({
          text: line.text ?? '',
          words: (line.words ?? []).map((w) => ({
            text: w.text ?? '',
            x0: w.bbox?.x0 ?? 0,
            x1: w.bbox?.x1 ?? 0,
          })),
        })
      }
    }
  }
  // No blocks (an older core, or a page with no layout): fall back to the flat text.
  if (out.length === 0) {
    for (const line of (data.text ?? '').split(/\r?\n/)) {
      if (line.trim() !== '') out.push({ text: line, words: [] })
    }
  }
  return out
}

/**
 * Shrink a screenshot to something Tesseract can chew, WITHOUT throwing away the glyphs.
 *
 * PNG, not JPEG: ringing lands on precisely the thin high-contrast strokes a BMS readout is made
 * of. And only ever downscale — a 1080-wide screenshot is already about right, and enlarging it
 * would cost time for no accuracy. Falls back to the original file wherever canvas is unavailable.
 */
const OCR_MAX_DIMENSION = 2000

export async function prepareForOcr(file: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return file
  try {
    const bitmap = await createImageBitmap(file)
    const longest = Math.max(bitmap.width, bitmap.height)
    if (longest <= OCR_MAX_DIMENSION) return file

    const scale = OCR_MAX_DIMENSION / longest
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await canvas.convertToBlob({ type: 'image/png' })
  } catch {
    return file
  }
}

/**
 * Recognise with a profile, under a deadline that starts AFTER warm-up.
 *
 * The timeout rejects and clears its own timer. The abandoned `recognize` cannot be cancelled —
 * wasm has no interrupt — but the timer no longer fires unobserved after every successful read.
 */
async function recognize(
  image: Blob,
  profile: Profile,
  timeoutMs: number,
): Promise<{ text: string; lines: OcrLine[] }> {
  const worker = await getWorker()
  await worker.setParameters({
    tessedit_char_whitelist: profile.whitelist,
    tessedit_pageseg_mode: String(profile.psm),
    preserve_interword_spaces: '1',
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      // `blocks: true` is REQUIRED. The default output is `{ text: true }` and nothing else, which
      // is why every previous attempt to read line geometry got an empty array.
      worker.recognize(image, {}, { text: true, blocks: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ocr timeout')), timeoutMs)
      }),
    ])
    const data = (result as { data: { text?: string; blocks?: unknown } }).data
    return { text: data.text ?? '', lines: linesOf(data) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const toBlob = (image: Blob | Uint8Array): Blob =>
  image instanceof Uint8Array ? new Blob([image as BlobPart], { type: 'image/jpeg' }) : image

/** Wall time without `Date.now()` in a hot path — `performance.now()` where it exists. */
const now = (): number => (typeof performance === 'object' ? performance.now() : 0)

/**
 * A dense two-language page is slow work on a cheap Android. 25 s is generous on purpose: the
 * previous 12 s was set at the same moment the job got several times heavier (full-resolution
 * image, full layout analysis, two models), and a timeout that fires silently is worse than a
 * driver waiting a few more seconds for a result he can see.
 */
const BMS_TIMEOUT_MS = 25_000
const DASH_TIMEOUT_MS = 15_000

// ── The e-bike dashboard photo ────────────────────────────────────────────────────────────

/** Battery % + odometer from a dashboard photo. */
export async function readDashboard(image: Blob | Uint8Array, timeoutMs = DASH_TIMEOUT_MS): Promise<OcrOutcome<OcrReading>> {
  const started = now()
  let text = ''
  try {
    // Digits only, sparse layout: a dash has a handful of large glyphs and no useful words.
    const prepared = await prepareForOcr(toBlob(image))
    const result = await recognize(prepared, { whitelist: '0123456789%.', psm: 11 }, timeoutMs)
    text = result.text
    const reading = parseReading(text)
    const fieldsFound = [reading.battery, reading.odometer].filter((v) => v !== null).length
    if (fieldsFound === 0) return { ok: false, reason: 'no_fields', ms: now() - started, text }
    return { ok: true, reading, fieldsFound, ms: now() - started, text }
  } catch (err) {
    const reason: OcrFailure = err instanceof Error && err.message === 'ocr timeout' ? 'timeout' : 'unavailable'
    return { ok: false, reason, ms: now() - started, text }
  }
}

/**
 * Pull the two numbers out of the recognised text.
 * - battery: the number just before a `%`, clamped to 0–100.
 * - odometer: the longest run of digits — on an e-bike dash the odometer is the largest figure
 *   (speed/trip/clock are all shorter), so this is a good-enough first guess for the driver to fix.
 */
export function parseReading(text: string): OcrReading {
  const batteryMatch = text.match(/(\d{1,3})\s*%/)
  const battery = batteryMatch ? Math.min(100, Number(batteryMatch[1])) : null

  // Compare by POSITION, not by digit string. An odometer that happens to read 100 beside a 100%
  // battery used to be discarded as "the battery again", and the next-longest run — a clock or a
  // trip meter — was offered in its place.
  const skipAt = batteryMatch?.index
  let odometer: number | null = null
  let longest = ''
  for (const m of text.matchAll(/\d+/g)) {
    if (skipAt !== undefined && m.index === skipAt) continue
    if (m[0].length > longest.length) longest = m[0]
  }
  if (longest) odometer = Number(longest)

  return { battery, odometer }
}

// ── The BMS app screenshot ────────────────────────────────────────────────────────────────

/**
 * Every label that can identify a field, in both apps.
 *
 * Matched against a normalised, space-stripped, lowercased line, so `Remain Battery` and
 * `remainbattery` are the same key and an Arabic label survives whatever spacing the OCR invents.
 * Order matters: `remaincapacity` is tried before `batterycapacity` so the more specific label
 * claims its line first.
 */
const BMS_FIELDS: ReadonlyArray<{
  key: keyof BmsReading
  labels: readonly string[]
  /** The reading as printed → the scaled integer we store. */
  scale: (n: number) => number
  max: number
}> = [
  { key: 'remainCapacityDah', labels: ['remaincapacity', 'السعةالمتبقية'], scale: (n) => Math.round(n * 10), max: 100_000 },
  { key: 'fullCapacityDah', labels: ['batterycapacity', 'fullcapacity', 'السعةالكلية'], scale: (n) => Math.round(n * 10), max: 100_000 },
  { key: 'percent', labels: ['remainbattery', 'soc', 'الطاقةالمتبقية', 'نسبةالشحن'], scale: (n) => Math.round(n), max: 100 },
  { key: 'cycleCount', labels: ['cyclecount', 'عددالدورات', 'الدورات'], scale: (n) => Math.round(n), max: 100_000 },
  { key: 'mosTempDc', labels: ['mostemp', 'حرارةmos', 'mos'], scale: (n) => Math.round(n * 10), max: 2_000 },
  { key: 't1Dc', labels: ['batteryt1', 't1'], scale: (n) => Math.round(n * 10), max: 2_000 },
  { key: 't2Dc', labels: ['batteryt2', 't2'], scale: (n) => Math.round(n * 10), max: 2_000 },
]

const normalise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\s:_]/g, '')
    // Arabic-Indic digits, in case the app renders numerals in them.
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))

const numberIn = (s: string): number | null => {
  const normalised = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/,/g, '')
  const m = normalised.match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : null
}

/**
 * Read a BMS app screenshot.
 *
 * Feed this the ORIGINAL file, not the compressed upload. `compressImage` caps the long edge at
 * 1280 px and drops JPEG quality to 0.4, which puts a 1080×2400 screenshot's body text at roughly
 * 10–13 px of x-height — under the LSTM's recognition floor, with ringing on exactly the thin,
 * high-contrast glyphs this depends on. No tesseract parameter compensates for that.
 */
export async function readBms(image: Blob | Uint8Array, timeoutMs = BMS_TIMEOUT_MS): Promise<OcrOutcome<BmsReading>> {
  const started = now()
  let text = ''
  try {
    const prepared = await prepareForOcr(toBlob(image))
    const result = await recognize(
      prepared,
      {
        // Letters are mandatory: without them no label survives, and label-anchored parsing is not
        // merely unimplemented — it is impossible. An empty whitelist means "no restriction",
        // which is also what Arabic needs; a whitelist containing Arabic script is a known source
        // of LSTM garbage.
        whitelist: '',
        // A dense, regular two-column readout. SPARSE_TEXT (11) does no layout analysis and would
        // scramble the row grouping the pairing depends on; 6 is a uniform block of text.
        psm: 6,
      },
      timeoutMs,
    )
    text = result.text
    const reading = parseBms(result.lines)
    const fieldsFound = Object.values(reading).filter((v) => v !== null).length
    if (fieldsFound === 0) return { ok: false, reason: 'no_fields', ms: now() - started, text }
    return { ok: true, reading, fieldsFound, ms: now() - started, text }
  } catch (err) {
    const reason: OcrFailure = err instanceof Error && err.message === 'ocr timeout' ? 'timeout' : 'unavailable'
    return { ok: false, reason, ms: now() - started, text }
  }
}

/**
 * Split a recognised line into its columns.
 *
 * The English app is a TWO-COLUMN readout: one visual row carries two complete label/value pairs,
 * e.g. `Remain Battery: 100%      MOS Temp: 33.9C`. Taking the first number on the line would give
 * MOS Temp a reading of 100 °C. The column gutter is a run of whitespace much wider than the
 * single spaces inside a label, so splitting on it recovers the two cells.
 */
const columnsOf = (line: string): string[] =>
  line
    .split(/\s{3,}|\t+|\u2502/)
    .map((c) => c.trim())
    .filter((c) => c !== '')

/**
 * Rebuild a line's column gutter from where its words actually sit.
 *
 * Recognised line text collapses a wide gutter to ordinary spaces, which would fuse two columns
 * into one cell and hand the right-hand field the left-hand field's number. A gap much wider than
 * a word space is a column boundary, so it is re-inserted as one `columnsOf` can find.
 */
function withGutters(line: OcrLine): string {
  if (line.words.length === 0) return line.text
  const ordered = [...line.words].sort((a, b) => a.x0 - b.x0)
  const widths = ordered.map((w) => w.x1 - w.x0).filter((w) => w > 0)
  // Scale the threshold to the text size rather than hardcoding pixels: the same screenshot at
  // 1080 px and at 2000 px must split in the same places.
  const typical = widths.length > 0 ? widths.reduce((a, b) => a + b, 0) / widths.length : 20
  const gutter = Math.max(24, typical * 1.5)

  let text = ''
  let prevEnd: number | null = null
  for (const w of ordered) {
    if (prevEnd === null) text = w.text
    else text += (w.x0 - prevEnd > gutter ? '   ' : ' ') + w.text
    prevEnd = w.x1
  }
  return text
}

/**
 * Pair labels with values.
 *
 * Line-based, then column-based, because both apps put one field per cell. Taking LINES from the
 * recogniser rather than splitting `data.text` is what makes the Arabic app work: it prints the
 * value to the LEFT of its label, so "the number after the label" is wrong, while "the number in
 * the same cell" is right in both directions — and a line's own box is the only reliable way to
 * know what "the same cell" means.
 */
export function parseBms(input: readonly OcrLine[] | string): BmsReading {
  const lines: string[] =
    typeof input === 'string'
      ? input.split(/\r?\n/).filter((l) => l.trim() !== '')
      : input.map(withGutters).filter((l) => l.trim() !== '')

  const out: BmsReading = {
    percent: null,
    packMillivolts: null,
    cycleCount: null,
    remainCapacityDah: null,
    fullCapacityDah: null,
    mosTempDc: null,
    t1Dc: null,
    t2Dc: null,
  }
  const text = lines.join('\n')

  for (const line of lines) {
    for (const cell of columnsOf(line)) {
      const flat = normalise(cell)
      for (const field of BMS_FIELDS) {
        if (out[field.key] !== null) continue
        const label = field.labels.find((l) => flat.includes(l))
        if (label === undefined) continue
        // Take the number from what is LEFT after removing the label. Several labels contain a
        // digit of their own — «Battery T2», «T1» — and reading the first number in the raw cell
        // turned `Battery T2: 32.5C` into a temperature of 2 °C.
        const value = numberIn(flat.replace(label, ' '))
        if (value === null) continue
        const scaled = field.scale(value)
        // A label matched but the number is impossible — that is a misread, not a reading.
        // Leaving it null makes the gate ask for it, which is right; storing it would look like
        // an answer the driver gave.
        if (scaled < 0 || scaled > field.max) continue
        out[field.key] = scaled
      }
    }
  }

  // Pack voltage is the one figure both apps show WITHOUT a nearby label — it is the headline
  // number. Take the largest plausible pack voltage on screen (a 20S lithium pack sits around
  // 60–90 V), which beats anchoring on a label that is not there.
  const volts = [...text.matchAll(/(\d{2,3}\.\d{1,2})\s*V/gi)].map((m) => Number(m[1]))
  const pack = volts.filter((v) => v >= 20 && v <= 200).sort((a, b) => b - a)[0]
  if (pack !== undefined) out.packMillivolts = Math.round(pack * 1000)

  // An unlabelled percentage is still worth having: both apps show exactly one large "100%", and
  // it is always the state of charge.
  if (out.percent === null) {
    const pct = text.match(/(\d{1,3})\s*%/)
    if (pct) {
      const n = Number(pct[1])
      if (n >= 0 && n <= 100) out.percent = n
    }
  }

  return out
}
