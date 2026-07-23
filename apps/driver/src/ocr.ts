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
 * Throw the worker away.
 *
 * `getWorker`'s catch only ever covered CREATION. Once creation succeeded the cached promise stayed
 * resolved for the whole session, so a worker that died afterwards — a wasm abort, an OOM on a
 * phone with little free memory, an error inside recognize — was handed out again on every
 * subsequent call, which rejected, and OCR reported "unavailable" forever. Pressing «إعادة القراءة»
 * could never recover it.
 *
 * A timeout leaves the worker in the same state for a different reason: the abandoned job keeps
 * running inside it, so the next job simply queues behind work nobody is waiting for.
 */
async function discardWorker(): Promise<void> {
  const dying = workerPromise
  workerPromise = null
  if (!dying) return
  try {
    const worker = await dying
    await worker.terminate()
  } catch {
    // It was already broken; that is why we are here.
  }
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

/** One line of recognised text, with the boxes it and its words came from. */
export interface OcrLine {
  text: string
  /** The line's own box. `y` is what lets a label be paired with the value ABOVE it. */
  y0: number
  y1: number
  /** Word boxes: `x` for the column a caption sits under, `y` for how big the glyphs are. */
  words: Array<{ text: string; x0: number; x1: number; y0: number; y1: number }>
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
  type RawBox = { x0: number; y0: number; x1: number; y1: number }
  const blocks = (data.blocks ?? []) as Array<{
    paragraphs?: Array<{
      lines?: Array<{ text?: string; bbox?: RawBox; words?: Array<{ text?: string; bbox?: RawBox }> }>
    }>
  }>
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        out.push({
          text: line.text ?? '',
          y0: line.bbox?.y0 ?? 0,
          y1: line.bbox?.y1 ?? 0,
          words: (line.words ?? []).map((w) => ({
            text: w.text ?? '',
            x0: w.bbox?.x0 ?? 0,
            x1: w.bbox?.x1 ?? 0,
            y0: w.bbox?.y0 ?? line.bbox?.y0 ?? 0,
            y1: w.bbox?.y1 ?? line.bbox?.y1 ?? 0,
          })),
        })
      }
    }
  }
  // No blocks (an older core, or a page with no layout): fall back to the flat text. Vertical
  // pairing needs boxes, so it simply finds nothing here — the same-line pass still works.
  if (out.length === 0) {
    for (const [i, line] of (data.text ?? '').split(/\r?\n/).entries()) {
      if (line.trim() !== '') out.push({ text: line, y0: i * 10, y1: i * 10 + 10, words: [] })
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

/**
 * Flatten a colourful app screenshot into something Tesseract can binarise.
 *
 * It thresholds before it recognises, and a BMS app is white and pale-grey text on a saturated
 * cyan panel — after a naive greyscale that is bright-on-slightly-less-bright, which thresholds to
 * a blank page. Converting to luminance and then stretching the 5th–95th percentile to full range
 * pulls those apart. A page that is already black on white has nothing to stretch and comes out
 * unchanged, so this is safe for both apps.
 */
function normaliseContrast(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  invert = false,
): void {
  const image = ctx.getImageData(0, 0, width, height)
  const px = image.data
  const histogram = new Uint32Array(256)

  for (let i = 0; i < px.length; i += 4) {
    // Rec. 601 luma — cheap, and closer to perceived brightness than a flat average, which is what
    // decides whether white-on-cyan survives.
    const y = (px[i]! * 299 + px[i + 1]! * 587 + px[i + 2]! * 114) / 1000
    const level = y < 0 ? 0 : y > 255 ? 255 : Math.round(y)
    px[i] = level
    px[i + 1] = level
    px[i + 2] = level
    histogram[level] = (histogram[level] ?? 0) + 1
  }

  const total = width * height
  const percentile = (fraction: number): number => {
    let seen = 0
    const target = total * fraction
    for (let level = 0; level < 256; level++) {
      seen += histogram[level] ?? 0
      if (seen >= target) return level
    }
    return 255
  }
  const low = percentile(0.05)
  const high = percentile(0.95)
  // Nothing to gain from stretching an image that already spans the range, and a degenerate
  // span would amplify noise into solid black.
  if (high - low < 24) return

  const scale = 255 / (high - low)
  for (let i = 0; i < px.length; i += 4) {
    const stretched = (px[i]! - low) * scale
    const clamped = stretched < 0 ? 0 : stretched > 255 ? 255 : stretched
    const level = invert ? 255 - clamped : clamped
    px[i] = level
    px[i + 1] = level
    px[i + 2] = level
  }
  ctx.putImageData(image, 0, 0)
}

/**
 * Prepare a screenshot for recognition: greyscale, contrast-stretched, and downscaled only if it
 * is larger than the cap.
 *
 * PNG, not JPEG: ringing lands on precisely the thin high-contrast strokes a BMS readout is made
 * of. Never upscales — a 1080-wide screenshot is already about right and enlarging costs time for
 * no accuracy. Falls back to the original file wherever canvas is unavailable.
 */
export async function prepareForOcr(file: Blob, invert = false): Promise<Blob> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return file
  try {
    const bitmap = await createImageBitmap(file)
    const longest = Math.max(bitmap.width, bitmap.height)
    const scale = longest > OCR_MAX_DIMENSION ? OCR_MAX_DIMENSION / longest : 1

    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    normaliseContrast(ctx, canvas.width, canvas.height, invert)
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
async function recognizeOnce(
  image: Blob,
  profile: Profile,
  timeoutMs: number,
): Promise<{ text: string; lines: OcrLine[] }> {
  const worker = await getWorker()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await worker.setParameters({
      tessedit_char_whitelist: profile.whitelist,
      tessedit_pageseg_mode: String(profile.psm),
      preserve_interword_spaces: '1',
    })
    const result = await Promise.race([
      // `blocks: true` is REQUIRED. The default output is `{ text: true }` and nothing else, which
      // is why every earlier attempt to read line geometry got an empty array.
      worker.recognize(image, {}, { text: true, blocks: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ocr timeout')), timeoutMs)
      }),
    ])
    const data = (result as { data: { text?: string; blocks?: unknown } }).data
    return { text: data.text ?? '', lines: linesOf(data) }
  } catch (err) {
    // Whatever went wrong, this worker is not trustworthy afterwards: a crash leaves it dead, and
    // a timeout leaves it chewing on a job nobody is waiting for. Drop it either way.
    await discardWorker()
    throw err
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Recognise, rebuilding the worker once if the first attempt kills it.
 *
 * The retry is here rather than left to the driver because the common case is a single transient
 * failure, and a driver should not have to understand «إعادة القراءة» to get past one.
 */
async function recognize(
  image: Blob,
  profile: Profile,
  timeoutMs: number,
): Promise<{ text: string; lines: OcrLine[] }> {
  try {
    return await recognizeOnce(image, profile, timeoutMs)
  } catch (err) {
    // A timeout is a real answer — the page is too slow for the budget — so it is not retried.
    // Anything else is a broken worker, and the next one is fresh.
    if (err instanceof Error && err.message === 'ocr timeout') throw err
    return await recognizeOnce(image, profile, timeoutMs)
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

/** One field the reader knows how to find, and how to turn what it read into what we store. */
export interface BmsField {
  key: keyof BmsReading
  labels: readonly string[]
  /** The reading as printed → the scaled integer we store. */
  scale: (n: number) => number
  max: number
}

/**
 * A BMS app, described.
 *
 * The packs do not all come with the same app, and the apps do not agree on anything: one is a
 * dense two-column table in English on white, another is a card grid in Arabic on cyan with the
 * caption UNDER its reading. A single universal parser has to guess at all of it; a named profile
 * per battery type does not.
 *
 * `auto` is what runs when a pack has no profile assigned yet — every label from every profile,
 * both layout strategies, both segmentation modes. It is the slowest and the least certain, which
 * is exactly why assigning the real profile is worth doing.
 */
export interface BmsProfile {
  id: string
  /** Shown in the admin when picking a profile for a battery. */
  nameAr: string
  nameEn: string
  fields: readonly BmsField[]
  /**
   * `inline`  label and value share a line — «Cycle Count: 8»
   * `cards`   value on one line, caption on the next, in columns
   * `both`    try inline first, then columns
   */
  layout: 'inline' | 'cards' | 'both'
  /** Page segmentation to try, in order. 3 = automatic page, 6 = one uniform block. */
  psm: readonly number[]
}

const dah = (n: number): number => Math.round(n * 10)
const whole = (n: number): number => Math.round(n)

/** Fields shared by every app seen so far; a profile adds its own label spellings on top. */
const COMMON_FIELDS: readonly BmsField[] = [
  { key: 'remainCapacityDah', labels: ['remaincapacity', 'السعةالمتبقية'], scale: dah, max: 100_000 },
  { key: 'fullCapacityDah', labels: ['batterycapacity', 'fullcapacity', 'السعةالكلية'], scale: dah, max: 100_000 },
  { key: 'percent', labels: ['remainbattery', 'soc', 'الطاقةالمتبقية', 'نسبةالشحن'], scale: whole, max: 100 },
  { key: 'cycleCount', labels: ['cyclecount', 'عددالدورات', 'الدورات'], scale: whole, max: 100_000 },
  { key: 'packMillivolts', labels: ['totalvoltage', 'إجماليالجهد', 'الجهدالكلي'], scale: (n) => Math.round(n * 1000), max: 2_000_000 },
  { key: 'mosTempDc', labels: ['mostemp', 'حرارةmos', 'mos'], scale: dah, max: 2_000 },
  { key: 't1Dc', labels: ['batteryt1', 't1'], scale: dah, max: 2_000 },
  { key: 't2Dc', labels: ['batteryt2', 't2'], scale: dah, max: 2_000 },
]

export const BMS_PROFILES: readonly BmsProfile[] = [
  {
    id: 'auto',
    nameAr: 'تلقائي',
    nameEn: 'Automatic',
    fields: COMMON_FIELDS,
    layout: 'both',
    // Automatic page segmentation first: a card grid with a gauge and a nav bar is not one block,
    // and PSM 6 forces it to be read as though it were.
    psm: [3, 6],
  },
  {
    // The dark English table: «Remain Battery: 100%   MOS Temp: 33.9C», two columns per row.
    id: 'table_en',
    nameAr: 'تطبيق إنجليزي (جدول)',
    nameEn: 'English table app',
    fields: COMMON_FIELDS,
    layout: 'inline',
    psm: [6, 3],
  },
  {
    // The cyan Arabic app: readings in cards with the caption underneath, right to left.
    id: 'cards_ar',
    nameAr: 'تطبيق عربي (بطاقات)',
    nameEn: 'Arabic card app',
    fields: COMMON_FIELDS,
    layout: 'cards',
    psm: [3, 6],
  },
]

export const profileById = (id: string | null | undefined): BmsProfile =>
  BMS_PROFILES.find((p) => p.id === id) ?? BMS_PROFILES[0]!

/**
 * Flatten a label or a cell to one canonical spelling.
 *
 * The Arabic folding matters as much as the digits do. «الطاقة المتبقية» is written with ة, but
 * ة/ه, أ/إ/آ/ا and ى/ي are routinely interchanged by writers AND confused by OCR — and a label
 * that misses by one letter misses entirely. Tatweel (ـ) is decoration and carries no meaning.
 */
const normalise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\s:_]/g, '')
    // Arabic-Indic digits, in case the app renders numerals in them.
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/ـ/g, '') // tatweel — a stretching mark, never part of a word
    .replace(/[ً-ْ]/g, '') // harakat, which OCR invents and drops at random
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')

/**
 * Fold the characters OCR reliably confuses, so a label still matches when it is misread.
 *
 * From a real phone: of «MOS: 36.9℃  T1: 33.7℃  T2: 33.6℃» only **T2** was found. `2` is an
 * unambiguous glyph; `1` is the most confused character there is (`l`, `I`, `|`) and `O`/`0` is
 * the second. So `T1` came back as `TI` and `MOS` as `M0S`, and neither matched a label spelled
 * with the digit.
 *
 * Applied ONLY when testing whether a label is present. The mapping is one character to one
 * character, so an index found in the folded string still points at the same place in the
 * original — which is what lets the number be extracted from the untouched text.
 */
const CONFUSABLE: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'l',
  i: 'l',
  '|': 'l',
  '!': 'l',
  '5': 's',
  '8': 'b',
}

const fold = (s: string): string => s.replace(/[01i|!58]/g, (c) => CONFUSABLE[c] ?? c)

/**
 * The number belonging to `label` inside `cell`.
 *
 * Searching the whole cell from the start breaks the moment one line carries several labelled
 * values — `MOS: 36.9℃  T1: 33.7℃  T2: 33.6℃` gave T1 a reading of 36.9, because that is simply
 * the first number in the row. And the label cannot merely be deleted first: with spaces stripped,
 * «t1» and «33.7» fuse into `t133.7`, which reads as one hundred and thirty-three.
 *
 * So: cut at the label, look FORWARD first (a left-to-right «label: value»), then BACKWARD (the
 * Arabic layout, where the value precedes its caption).
 */
/**
 * A label reduced to the one spelling everything is compared in.
 *
 * BOTH sides must go through this. The field table writes «الطاقة المتبقية» the natural way, with
 * ة; `normalise` folds a recognised cell's ة to ه. Comparing a raw label against a folded cell
 * would never match — the label would be correct, the text would be correct, and the reading would
 * silently be lost.
 */
const canon = (label: string): string => fold(normalise(label))

const numberForLabel = (cell: string, label: string): number | null => {
  const needle = canon(label)
  // `cell` is already normalised by the caller, so folding it here keeps both sides in the same
  // space — and the fold is length-preserving, so the index still points into `cell` itself.
  const at = fold(cell).indexOf(needle)
  if (at < 0) return null
  const forward = numberIn(cell.slice(at + needle.length))
  if (forward !== null) return forward
  return lastNumberIn(cell.slice(0, at))
}

/** Does this cell mention the label, allowing for the glyphs and letters OCR confuses? */
const hasLabel = (cell: string, label: string): boolean => fold(cell).includes(canon(label))

const lastNumberIn = (s: string): number | null => {
  const normalised = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/,/g, '')
  const all = [...normalised.matchAll(/-?\d+(?:\.\d+)?/g)]
  const last = all[all.length - 1]
  return last ? Number(last[0]) : null
}

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
export async function readBms(
  image: Blob | Uint8Array,
  options: { profileId?: string | null; timeoutMs?: number } = {},
): Promise<OcrOutcome<BmsReading>> {
  const profile = profileById(options.profileId)
  const timeoutMs = options.timeoutMs ?? BMS_TIMEOUT_MS
  const started = now()
  const source = toBlob(image)
  let text = ''

  // Findings are MERGED across passes rather than taken from the first that works, because a page
  // can need two of them. On the Arabic app everything on the white cards — voltage, cycles,
  // temperatures — reads on the first pass, and everything on the cyan panel reads on none of
  // them: light text on a darker background is INVERTED, and Tesseract wants dark on light. The
  // charge lives on that panel, which is exactly why a phone came back with three fields and no
  // charge. An inverted pass reads the panel and loses the cards, so neither pass alone is enough.
  const merged: BmsReading = {
    percent: null,
    packMillivolts: null,
    cycleCount: null,
    remainCapacityDah: null,
    fullCapacityDah: null,
    mosTempDc: null,
    t1Dc: null,
    t2Dc: null,
  }
  const absorb = (reading: BmsReading): void => {
    for (const key of Object.keys(merged) as Array<keyof BmsReading>) {
      if (merged[key] === null && reading[key] !== null) merged[key] = reading[key]
    }
  }
  const found = (): number => Object.values(merged).filter((v) => v !== null).length

  try {
    // Normal first, for every segmentation the profile lists; then inverted, which is only worth
    // its time when the charge — the one field the shift gate requires — is still missing.
    const passes: Array<{ psm: number; invert: boolean }> = [
      ...profile.psm.map((psm) => ({ psm, invert: false })),
      { psm: profile.psm[0] ?? 3, invert: true },
      // Sparse text, inverted, as the last word on the charge. PSM 11 does no layout analysis and
      // simply hunts for text anywhere on the page — which is what a big isolated number inside a
      // ring is. Page segmentation tends to write that ring off as a graphic and never look in it.
      { psm: 11, invert: true },
    ]

    for (const pass of passes) {
      if (pass.invert && merged.percent !== null) break
      // A profile's later segmentation modes are a fallback, not a routine second pass: if the
      // first one already read the page there is nothing to gain and a driver waiting.
      if (!pass.invert && pass.psm !== passes[0]!.psm && found() > 0) continue

      const prepared = await prepareForOcr(source, pass.invert)
      const result = await recognize(prepared, { whitelist: '', psm: pass.psm }, timeoutMs)
      // «ما قرأه النظام» shows the pass that read the most, which is the one worth looking at.
      if (result.text.length > text.length) text = result.text
      absorb(parseBms(result.lines, profile))
      if (found() === Object.keys(merged).length) break
    }

    if (found() === 0) return { ok: false, reason: 'no_fields', ms: now() - started, text }
    return { ok: true, reading: merged, fieldsFound: found(), ms: now() - started, text }
  } catch (err) {
    const reason: OcrFailure = err instanceof Error && err.message === 'ocr timeout' ? 'timeout' : 'unavailable'
    // A pass that timed out after earlier passes succeeded should not throw those findings away.
    if (found() > 0) return { ok: true, reading: merged, fieldsFound: found(), ms: now() - started, text }
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
export function parseBms(input: readonly OcrLine[] | string, profile: BmsProfile = BMS_PROFILES[0]!): BmsReading {
  const lines: OcrLine[] =
    typeof input === 'string'
      ? input
          .split(/\r?\n/)
          .filter((l) => l.trim() !== '')
          .map((text, i) => ({ text, y0: i * 10, y1: i * 10 + 10, words: [] }))
      : input.filter((l) => l.text.trim() !== '')

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
  const text = lines.map((l) => l.text).join('\n')

  const store = (key: keyof BmsReading, field: BmsField, value: number): void => {
    const scaled = field.scale(value)
    // A label matched but the number is impossible — that is a misread, not a reading. Leaving it
    // null makes the gate ask for it, which is right; storing it would look like an answer.
    if (scaled < 0 || scaled > field.max) return
    out[key] = scaled
  }

  // ── Pass 1: label and value in the same cell ────────────────────────────────────────────
  // The English app's layout, and the Arabic app's temperature row.
  if (profile.layout !== 'cards') {
    for (const line of lines) {
      for (const cell of columnsOf(withGutters(line))) {
        const flat = normalise(cell)
        for (const field of profile.fields) {
          if (out[field.key] !== null) continue
          const label = field.labels.find((l) => hasLabel(flat, l))
          if (label === undefined) continue
        // Take the number from what is LEFT after removing the label. Several labels contain a
        // digit of their own — «Battery T2», «T1» — and reading the first number in the raw cell
        // turned `Battery T2: 32.5C` into a temperature of 2 °C.
          const value = numberForLabel(flat, label)
          if (value === null) continue
          store(field.key, field, value)
        }
      }
    }
  }

  // ── Pass 2: the value sits on the line ABOVE (or below) its label ───────────────────────
  //
  // The Arabic app is a CARD GRID, not a list: the reading is on one line and its caption on the
  // next, in columns —
  //
  //     81.48V        0A        0.00W       1
  //   إجمالي الجهد    التيار     الطاقة    الدورات
  //
  // so a label and its value are never in the same cell and pass 1 finds nothing at all. Pairing
  // by column — nearest line vertically, overlapping horizontally — is what reads this layout.
  if (profile.layout !== 'inline') {
    for (const field of profile.fields) {
      if (out[field.key] !== null) continue
      const found = valueNearLabel(lines, field.labels)
      if (found !== null) store(field.key, field, found)
    }
  }

  // Pack voltage is the one figure both apps show WITHOUT a nearby label — it is the headline
  // number. Take the largest plausible pack voltage on screen (a 20S lithium pack sits around
  // 60–90 V), which beats anchoring on a label that may not be there.
  if (out.packMillivolts === null) {
    const volts = [...text.matchAll(/(\d{2,3}[.,]\d{1,2})\s*V/gi)].map((m) => Number(m[1]!.replace(',', '.')))
    const pack = volts.filter((v) => v >= 20 && v <= 200).sort((a, b) => b - a)[0]
    if (pack !== undefined) out.packMillivolts = Math.round(pack * 1000)
  }

  // An unlabelled percentage is still worth having: both apps show exactly one "100%", and it is
  // always the state of charge.
  if (out.percent === null) {
    const pct = text.match(/(\d{1,3})\s*%/)
    if (pct) {
      const n = Number(pct[1])
      if (n >= 0 && n <= 100) out.percent = n
    }
  }

  // Last resort, and the one that matters most: the charge is the only field the shift gate
  // actually requires, and on both apps it is the HEADLINE number — a big figure in a ring, with
  // the «%» a small superscript that OCR often drops, which is exactly how a phone came back with
  // voltage, cycles and a temperature but no charge. Size is the signal the layout cannot hide.
  if (out.percent === null) {
    const gauge = biggestPercentage(lines)
    if (gauge !== null) out.percent = gauge
  }

  return out
}

/**
 * The state of charge, found by how big it is printed.
 *
 * Constrained hard, because "the biggest number" is a blunt instrument: a WHOLE number 0–100 (a
 * charge is never written 81.48, which rules out the pack voltage), and printed at least 1.6× the
 * median glyph height on the page, which rules out every figure sitting in an ordinary card.
 */
function biggestPercentage(lines: readonly OcrLine[]): number | null {
  const words = lines.flatMap((l) => l.words)
  const heights = words.map((w) => w.y1 - w.y0).filter((h) => h > 0).sort((a, b) => a - b)
  if (heights.length < 4) return null
  const median = heights[Math.floor(heights.length / 2)]!

  let best: { value: number; height: number } | null = null
  for (const word of words) {
    const height = word.y1 - word.y0
    if (height < median * 1.6) continue
    // A whole number only: `100`, `85`, and optionally the % the recogniser may have caught.
    const match = /^(\d{1,3})%?$/.exec(normalise(word.text))
    if (!match) continue
    const value = Number(match[1])
    if (value < 0 || value > 100) continue
    if (!best || height > best.height) best = { value, height }
  }
  return best?.value ?? null
}

/**
 * Find the number belonging to a label that has none of its own.
 *
 * Looks for a cell containing the label, then for the nearest line above or below whose words
 * overlap that cell horizontally — the column the caption sits under. Above is preferred, because
 * every card layout seen so far puts the reading on top and the caption beneath it.
 */
function valueNearLabel(lines: readonly OcrLine[], labels: readonly string[]): number | null {
  for (const line of lines) {
    const label = labels.find((l) => hasLabel(normalise(line.text), l))
    if (label === undefined) continue

    // Where the label sits horizontally. With no word boxes the whole line is the span, which
    // still works for a single-column layout.
    const span = spanOfLabel(line, label)

    // Candidates ranked the way the apps are laid out: the reading ABOVE its caption first — the
    // product owner's own description of the gauge, «القيمة فوق الكلمة» — then below, then by how
    // close it is.
    const candidates = lines
      .filter((other) => other !== line)
      .map((other) => ({ other, gap: verticalGap(line, other), above: other.y1 <= line.y0 }))
      .filter((c) => c.gap <= adjacencyLimit(line, c.other))
      .sort((a, b) => (a.above === b.above ? a.gap - b.gap : a.above ? -1 : 1))

    for (const candidate of candidates) {
      const value = numberInSpan(candidate.other, span)
      if (value !== null) return value
    }
  }
  return null
}

/**
 * The blank space between two lines — EDGE to edge, not centre to centre.
 *
 * Centre-to-centre grows with the size of the text, so the gauge — a number printed four times the
 * height of the caption beneath it — measured as "far away" and was skipped, while two lines of
 * ordinary card text measured as "close". Edge-to-edge is the thing that actually means adjacent,
 * whatever size either line is printed at.
 */
function verticalGap(a: OcrLine, b: OcrLine): number {
  if (b.y1 <= a.y0) return a.y0 - b.y1
  if (b.y0 >= a.y1) return b.y0 - a.y1
  return 0 // they overlap vertically; nothing sits between them
}

/** Adjacent means within a line's own height of blank space. Two rows apart is another card. */
function adjacencyLimit(a: OcrLine, b: OcrLine): number {
  return Math.max(a.y1 - a.y0, b.y1 - b.y0, 8) * 1.2
}

/** The x-range the label occupies, or null when the line carries no word boxes. */
function spanOfLabel(line: OcrLine, label: string): { x0: number; x1: number } | null {
  const hits = line.words.filter((w) => canon(w.text) !== '' && canon(label).includes(canon(w.text)))
  if (hits.length === 0) return null
  return { x0: Math.min(...hits.map((w) => w.x0)), x1: Math.max(...hits.map((w) => w.x1)) }
}

/** The first number on `line` whose word overlaps `span`. A null span accepts the whole line. */
function numberInSpan(line: OcrLine, span: { x0: number; x1: number } | null): number | null {
  if (span === null || line.words.length === 0) return numberIn(line.text)
  for (const word of line.words) {
    const overlaps = word.x0 <= span.x1 && word.x1 >= span.x0
    if (!overlaps) continue
    const value = numberIn(word.text)
    if (value !== null) return value
  }
  return null
}
