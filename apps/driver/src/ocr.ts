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
// Statically imported, unlike tesseract.js: this is a few kilobytes of pure arithmetic with no
// wasm behind it, and the amounts cannot be read without it.
import { type Box, CANON_CAP_HEIGHT, canonFactorFor, CLOCK_ALPHABET, type Mask, maskFromPixels, readDigitRun, readGlyphRow, resampleRgba, type Template, unpackTemplates } from './glyphs.ts'
import { CLOCK_TEMPLATES } from './glyph-templates.ts'
import { GLYPH_TEMPLATES } from './glyph-templates.ts'

export interface OcrReading {
  odometer: number | null
}

/**
 * A BMS readout — only the two figures the operation tracks per pack: the remaining charge and the
 * lifetime charge cycles. Scaled INTEGERS, never floats (the cycle count is whole; the percent is
 * whole), same reasoning as money — a value that gates whether a bike is fit to ride is not carried
 * by IEEE-754. Voltage / capacity / temperatures used to be read here too; the product now captures
 * only charge + cycles, so the reader stops hunting for the rest.
 */
export interface BmsReading {
  percent: number | null
  cycleCount: number | null
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
  | {
      ok: true
      reading: T
      fieldsFound: number
      /**
       * How many rows the page HAD, when that is knowable — the glyph reader counts «SYP» anchors.
       *
       * Reported beside `fieldsFound` because the two together are the honest sentence: thirty
       * read of thirty-four is a good read with four rows to type, and saying «٣٠» alone hides
       * the four the driver still owes.
       */
      rowsSeen?: number
      /**
       * Cards the bottom of the screen sliced in half, which are NOT offered.
       *
       * Their fee and clock read fine — those sit on the fully-drawn price row — but their place
       * lines are half-rendered, and a half-rendered line is read as something confident and wrong
       * («جامع الحمود Al Beirouni Street» → «Al Dajeniin; Ctraat innttc.|. نكم»). Offering the row
       * would point a real delivery at a place it never went, so it is withheld.
       *
       * Reported, never silent: the driver is told to add that one by hand. Usually the next
       * screenshot shows the same card whole and it arrives by itself.
       */
      cutOff?: number
      ms: number
      text: string
    }
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
/**
 * The contrast stretch, as pure arithmetic over RGBA bytes — no canvas, no DOM.
 *
 * Extracted so the CALIBRATION HARNESS can apply it. That is not tidiness: `scripts/glyph-read.mjs`
 * measured raw fixture pixels while the app measured downscaled, contrast-stretched ones, so the
 * harness had never once seen the input the app actually reads. It reported zero wrong on the very
 * screenshots whose full-resolution originals produced «1105» on a driver's phone, and both numbers
 * were honest — they were measuring different images.
 *
 * Mutates `px` in place. Returns whether it stretched: a span narrower than 24 levels is left
 * completely alone, INCLUDING the greyscale conversion, because amplifying a flat image turns noise
 * into solid black. The caller must not write the buffer back when this returns false.
 */
export function stretchContrast(px: Uint8ClampedArray, width: number, height: number, invert = false): boolean {
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
  if (high - low < 24) return false

  const scale = 255 / (high - low)
  for (let i = 0; i < px.length; i += 4) {
    const stretched = (px[i]! - low) * scale
    const clamped = stretched < 0 ? 0 : stretched > 255 ? 255 : stretched
    const level = invert ? 255 - clamped : clamped
    px[i] = level
    px[i + 1] = level
    px[i + 2] = level
  }
  return true
}

function normaliseContrast(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  invert = false,
): void {
  const image = ctx.getImageData(0, 0, width, height)
  if (stretchContrast(image.data, width, height, invert)) ctx.putImageData(image, 0, 0)
}

/**
 * Prepare a screenshot for recognition: greyscale, contrast-stretched, and downscaled only if it
 * is larger than the cap.
 *
 * PNG, not JPEG: ringing lands on precisely the thin high-contrast strokes a BMS readout is made
 * of. Never upscales — a 1080-wide screenshot is already about right and enlarging costs time for
 * no accuracy. Falls back to the original file wherever canvas is unavailable.
 */
export async function prepareForOcr(file: Blob, invert = false, stretch = true): Promise<Blob> {
  return (await prepareWithPixels(file, invert, stretch))?.blob ?? file
}

/**
 * The same preparation, but handing back the PIXELS as well as the image.
 *
 * The glyph reader needs both, and they must be the same image: Tesseract reports word boxes in
 * the coordinates of whatever it was given, so measuring ink from the original file while locating
 * «SYP» in a downscaled copy would read the ink beside the wrong row. One canvas, two outputs.
 */
export async function prepareWithPixels(
  file: Blob,
  invert = false,
  stretch = true,
): Promise<{ blob: Blob; pixels: Uint8ClampedArray; width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null
  try {
    const bitmap = await createImageBitmap(file)
    const longest = Math.max(bitmap.width, bitmap.height)
    const scale = longest > OCR_MAX_DIMENSION ? OCR_MAX_DIMENSION / longest : 1

    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    if (stretch || invert) normaliseContrast(ctx, canvas.width, canvas.height, invert)
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return {
      blob: await canvas.convertToBlob({ type: 'image/png' }),
      pixels: image.data,
      width: canvas.width,
      height: canvas.height,
    }
  } catch {
    return null
  }
}

/**
 * Cut a horizontal band out of an already-prepared image, as its own PNG.
 *
 * For re-reading one card that the full-page pass lost. Given to `recognize` on its own the band
 * is a small, simple picture, and the layout analyser is far more willing to find lines in it than
 * in a dense two-language page — which is exactly the failure being repaired.
 */
/**
 * The fee's own strip of pixels, kept as a PNG so a real shift can teach the reader.
 *
 * The classifier has ~500 hand-transcribed glyphs behind it, and a day spent transcribing 25 more
 * screenshots measurably made it WORSE — averaged prototypes dilute. What it has never had is
 * volume from real phones. That flows through the system every day and is thrown away: the driver
 * scans, the reader proposes, the driver corrects, the manager approves. That approved figure is
 * ground truth, verified by two people, and it arrives free.
 *
 * THE STRIP, NOT THE SCREENSHOT, and the difference is the whole design:
 *   • The stored evidence image is NOT what the reader saw — `compressImage` re-encodes it to
 *     ~300 KB, 1280 px, JPEG quality as low as 0.4. At 12×16 pixels per glyph that destroys exactly
 *     the strokes a model would learn. This is cut from the ORIGINAL pixels, losslessly.
 *   • «٢٣٥ SYP» contains no customer address, no name, no map pin. The place lines do, which is why
 *     the strip stops at the amount box and never widens to the card.
 *   • It stays a strip rather than individual glyphs so the cut points can be revisited. Freezing
 *     the segmentation into the training data would bake in the very decisions that produced
 *     «1105».
 *
 * ~2 KB a row, so a hundred bikes cost a megabyte a month.
 */
async function stripBlob(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  box: Box,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'function') return null
  const x0 = Math.max(0, Math.floor(box.x0))
  const y0 = Math.max(0, Math.floor(box.y0))
  const w = Math.min(Math.ceil(box.x1), width) - x0
  const h = Math.min(Math.ceil(box.y1), height) - y0
  if (w <= 0 || h <= 0) return null
  try {
    const whole = new OffscreenCanvas(width, height)
    const wctx = whole.getContext('2d')
    if (!wctx) return null
    wctx.putImageData(new ImageData(Uint8ClampedArray.from(pixels), width, height), 0, 0)
    const cut = new OffscreenCanvas(w, h)
    const ctx = cut.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(whole, x0, y0, w, h, 0, 0, w, h)
    return await cut.convertToBlob({ type: 'image/png' })
  } catch {
    return null
  }
}

/** A PNG as a data URL, or null. Small by construction — see `stripBlob`. */
async function asDataUrl(blob: Blob | null): Promise<string | null> {
  if (!blob) return null
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return `data:image/png;base64,${btoa(binary)}`
  } catch {
    return null
  }
}

async function bandBlob(
  pixels: Uint8ClampedArray,
  width: number,
  y0: number,
  y1: number,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'function') return null
  const top = Math.max(0, Math.floor(y0))
  const height = Math.min(Math.ceil(y1), Math.floor(pixels.length / 4 / width)) - top
  if (height <= 0) return null
  try {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const slice = new ImageData(pixels.slice(top * width * 4, (top + height) * width * 4), width, height)
    ctx.putImageData(slice, 0, 0)
    return await canvas.convertToBlob({ type: 'image/png' })
  } catch {
    return null
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

/** The odometer km from a dashboard photo — the only figure read off the dash. */
export async function readDashboard(image: Blob | Uint8Array, timeoutMs = DASH_TIMEOUT_MS): Promise<OcrOutcome<OcrReading>> {
  const started = now()
  let text = ''
  try {
    // Digits only, sparse layout: a dash has a handful of large glyphs and no useful words.
    const prepared = await prepareForOcr(toBlob(image))
    const result = await recognize(prepared, { whitelist: '0123456789%.', psm: 11 }, timeoutMs)
    text = result.text
    const reading = parseReading(text)
    const fieldsFound = reading.odometer !== null ? 1 : 0
    if (fieldsFound === 0) return { ok: false, reason: 'no_fields', ms: now() - started, text }
    return { ok: true, reading, fieldsFound, ms: now() - started, text }
  } catch (err) {
    const reason: OcrFailure = err instanceof Error && err.message === 'ocr timeout' ? 'timeout' : 'unavailable'
    return { ok: false, reason, ms: now() - started, text }
  }
}

/**
 * Pull the odometer km out of the recognised text — the ONLY thing read off the dash now.
 *
 * A photographed dash is the hardest target in this app by a distance: it is a low-contrast LCD
 * behind glass, shot outdoors, carrying the sky and the rider's own reflection. On the client's own
 * photo the recogniser returned `ono B48 km` for «ODO 02611 km» — the label survived, the digits did
 * not. The old rule («the longest run of digits») then read that as an odometer of **48**: a
 * plausible, confident, wrong number that a driver could submit without noticing.
 *
 * So the bar is deliberately high, and a read that cannot clear it returns NULL — the driver types
 * the number, which is what he did before this feature existed, and the photo remains the evidence:
 *  • at least MIN_ODOMETER_DIGITS digits — a real odometer is never one or two;
 *  • never a clock («1 00:00» is not 100 km), so a run touching a `:` is rejected;
 *  • a battery percentage is skipped by POSITION, so an odometer that happens to equal the charge
 *    is not discarded as "the battery again".
 * A run on the `ODO`-labelled line wins over a longer one elsewhere, since that label is the most
 * reliably recognised thing on the panel.
 */
const MIN_ODOMETER_DIGITS = 3

export function parseReading(text: string): OcrReading {
  const batteryAt = text.match(/(\d{1,3})\s*%/)?.index

  const bestOn = (haystack: string): string => {
    let longest = ''
    for (const m of haystack.matchAll(/\d+/g)) {
      // A clock reads as digits either side of a colon; neither half is a distance.
      const before = haystack[m.index - 1]
      const after = haystack[m.index + m[0].length]
      if (before === ':' || after === ':') continue
      // Skip the charge itself, compared by position rather than by digit string.
      if (batteryAt !== undefined && haystack === text && m.index === batteryAt) continue
      if (m[0].length > longest.length) longest = m[0]
    }
    return longest
  }

  // The «ODO» row first — even a mangled label («ono», «obo», «0D0») pins the right line.
  const odoLine = text
    .split(/\r?\n/)
    .find((line) => /\b[o0][dbn][o0]\b/i.test(line) || /ODO/i.test(line))
  const candidate = (odoLine !== undefined ? bestOn(odoLine) : '') || bestOn(text)

  // `000` clears the digit-count bar but reads as zero, and a bike that has travelled no distance
  // at all is not a reading anybody needs pre-filled — the calibration script produced exactly that
  // from the glare. Blank, and the driver types it.
  const value = candidate.length >= MIN_ODOMETER_DIGITS ? Number(candidate) : null
  return { odometer: value === null || value <= 0 ? null : value }
}

// ── The Yallago wallet screenshot (SRS D-2) ─────────────────────────────────────────────────

/** The wallet balance from the «المحفظة» screenshot, as a money decimal string to pre-fill the field. */
export async function readWallet(image: Blob | Uint8Array, timeoutMs = DASH_TIMEOUT_MS): Promise<OcrOutcome<{ amountText: string }>> {
  const started = now()
  let text = ''
  try {
    // White digits on a solid orange card ⇒ invert. Whitelist money digits (both scripts) + the
    // separator marks + the "SYP" tag; a uniform block reads better than sparse here.
    const prepared = await prepareForOcr(toBlob(image), true)
    const result = await recognize(prepared, { whitelist: '0123456789٠١٢٣٤٥٦٧٨٩،٬٫., SYPsyp', psm: 6 }, timeoutMs)
    text = result.text
    const amountText = parseWallet(text)
    if (amountText === null) return { ok: false, reason: 'no_fields', ms: now() - started, text }
    return { ok: true, reading: { amountText }, fieldsFound: 1, ms: now() - started, text }
  } catch (err) {
    const reason: OcrFailure = err instanceof Error && err.message === 'ocr timeout' ? 'timeout' : 'unavailable'
    return { ok: false, reason, ms: now() - started, text }
  }
}

/**
 * Parse a wallet balance into a money decimal string (`moneySchema`-shaped), or `null` if there is
 * no number to read. String ops only — never `Number()`/`parseFloat`, which is both wrong for money
 * and what the wire-money guard bans.
 *
 * Money 2-dp rule: a separator followed by exactly one or two digits at the very end is the fraction
 * (grouping separators always leave 3-digit groups); everything else is integer grouping, dropped.
 * Sample: «٧٦،٥٠٩٬٥٥ SYP» → "76509.55".
 */
export function parseWallet(text: string): string | null {
  const ascii = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  // Keep only digits and the separator marks (Arabic comma/thousands/decimal + Latin , .).
  const cleaned = ascii.replace(/[^0-9،٬٫.,]/g, '')
  if (cleaned.replace(/[^0-9]/g, '') === '') return null
  const frac = cleaned.match(/[،٬٫.,](\d{1,2})$/)
  if (frac) {
    const intPart = cleaned.slice(0, frac.index).replace(/[^0-9]/g, '')
    if (intPart === '') return null
    return `${intPart}.${frac[1]}`
  }
  return cleaned.replace(/[^0-9]/g, '')
}

/**
 * A row's amount, or nothing — the strict form used by the two LIST screens.
 *
 * `parseWallet` is forgiving by design: it is pointed at a balance the driver can see and correct.
 * A row in a list is different. Calibration against real screenshots showed the bundled `ara`/`eng`
 * models transliterate Arabic-Indic digits into Latin lookalikes — «٥٢» came back as «oY», «٩٥» as
 * «40» — and where that debris happened to contain ASCII digits, the forgiving parser turned it
 * into a confident number: −52 read as −07, +153 as +017. Money invented out of noise.
 *
 * So: the token must be digits and separators ONLY, and must not carry a leading zero. Neither
 * screen ever shows «07 SYP», and a leading zero is the clearest signature of a glyph that was
 * guessed rather than read.
 */
function listAmount(token: string): string | null {
  const ascii = asciiDigits(token)
  if (!/^\d[\d.,،٬٫]*$/.test(ascii)) return null
  if (/^0\d/.test(ascii)) return null
  return parseWallet(ascii)
}

/**
 * The same guard, applied to a GLYPH-read fee before it is ever offered as money.
 *
 * `readPaymentsLog` has always put its glyph output through `listAmount` (see the movements branch
 * below); `readOrders` did not. That asymmetry is how «1105» reached a driver's fee field — the
 * orders path returned the classifier's raw concatenation verbatim, with no rule about what a fee
 * may even look like. The rules cost nothing and refuse the shapes a mis-segmentation produces:
 * a leading zero, a stray sign, an alphabet character that is not a digit or a separator.
 *
 * Deliberately NOT a length or range cap. «١٬١٠٥» is a real fare, and a rule that says "fees have
 * three digits" would refuse a real one the day the fleet raises prices. The structural invariant
 * in `readGlyphRow` — one component, one character — is what bounds the digits; this bounds the
 * shape.
 */
export function glyphListFee(raw: string | null): string | null {
  if (raw === null) return null
  if (/^[-+]/.test(raw)) return null
  return listAmount(raw)
}

/**
 * How many rows on this page CLAIM to be money — they carry the currency — whether or not their
 * amount could be read.
 *
 * The reader needs this to tell a partly-successful read from a failed one that got lucky. Three
 * amounts parsed out of eleven rows is not a page two-thirds read; it is a page that was not read,
 * where three pieces of debris happened to look numeric. Pre-filling BR1 from those three is worse
 * than pre-filling nothing, because nobody re-reads a field the machine has already answered.
 */
export const moneyRowCount = (text: string): number =>
  text.split(/\r?\n/).filter((line) => /SYP/i.test(line)).length

/**
 * A read is only offered when it accounts for ALMOST EVERY row it can see.
 *
 * The bar is this high because of what the alternative looks like. On the real screenshots a
 * lenient bar let two rows out of three through on the orders list, and those two were «11» and
 * «11» for fees of 120 and 235 — a page nobody read, presented as a page mostly read. One row the
 * reader cannot account for means the page is not being read, it is being guessed at, and the
 * remedy (re-shoot it, or type three numbers) costs the driver far less than a wrong fee costs
 * everyone at the review.
 */
export const READ_COHERENCE = 0.9
export const readIsCoherent = (text: string, parsed: number): boolean => {
  const claimed = moneyRowCount(text)
  return claimed === 0 || parsed >= claimed * READ_COHERENCE
}

// ── The Yallago «Recent orders» screenshot (SRS D-1) ────────────────────────────────────────

export interface OcrOrder {
  /** The day the order sits under (from a «Monday, 27 July» header), or null if none was read. */
  dateIso: string | null
  /** «HH:MM». */
  time: string
  /**
   * The delivery fee as a money decimal string (BR1's number), or **null when it was refused**.
   *
   * Null is not a failure to report — it is the reader saying "this delivery happened, and I will
   * not guess what it cost". The row still carries its clock and route, so the driver gets a card
   * with an empty fee field to type into instead of a delivery that silently never appeared.
   */
  fee: string | null
  /** The dropoff area, best-effort — often absent or a GPS pair. */
  zone: string | null
  /**
   * Where the order went: «A» the pickup, «B» the dropoff, as written on the screen.
   *
   * These come from Tesseract's own text, not the glyph reader — its failure is confined to
   * Arabic-Indic DIGITS, and a place name is Arabic words, which it reads well. The screen has no
   * order number, so the value, the clock and this route are everything an order actually is.
   */
  pointA?: string | null
  pointB?: string | null
  /**
   * The fee's own pixels as a small PNG data URL — training data, not evidence.
   *
   * Kept so a real shift can teach the reader what a day of hand-transcription could not. Contains
   * the amount and nothing else: no address, no name, no map pin.
   */
  feeStrip?: string | null
  /**
   * A «تم إلغاؤه» card: cancelled on the screen, so it has no price and no clock — only its route.
   *
   * It is reported rather than skipped so the driver can see the reader accounted for it, and check
   * it if he was paid something anyway.
   */
  cancelled?: boolean
}

const ORDERS_TIMEOUT_MS = 20_000
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/**
 * The same twelve months in Arabic, in BOTH namings the region uses: the transliterated Gregorian
 * set the Yallago app shows («يوليو») and the Levantine set a Syrian build may show instead
 * («تموز»). Index is the month number − 1, so either table answers the same question.
 */
const MONTHS_AR = [
  ['يناير', 'كانونالثاني'],
  ['فبراير', 'شباط'],
  ['مارس', 'اذار', 'آذار'],
  ['ابريل', 'أبريل', 'نيسان'],
  ['مايو', 'ايار', 'أيار'],
  ['يونيو', 'حزيران'],
  ['يوليو', 'تموز'],
  ['اغسطس', 'أغسطس', 'اب', 'آب'],
  ['سبتمبر', 'ايلول', 'أيلول'],
  ['اكتوبر', 'أكتوبر', 'تشرينالاول', 'تشرينالأول'],
  ['نوفمبر', 'تشرينالثاني'],
  ['ديسمبر', 'كانونالاول', 'كانونالأول'],
]

/** Arabic-Indic (٠-٩) and extended/Persian (۰-۹) digits → ASCII. Both appear on Android builds. */
export const asciiDigits = (s: string): string =>
  s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))

/** Fold an Arabic word to one spelling so a month matches despite hamza, ta-marbuta and spacing. */
const foldAr = (s: string): string =>
  s
    .replace(/[\s‏‎_]/g, '')
    .replace(/ـ/g, '')
    .replace(/[ً-ْ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')

/**
 * «Monday, 27 July» or «الأربعاء, ٢٩ يوليو» → «2026-07-29», using the supplied year (the app has a
 * clock; the parser stays pure).
 *
 * When the line also NAMES its weekday, that name is used as a checksum on the day number.
 *
 * It used to be ignored, on the reasoning that it carries no information the day number does not.
 * That is true only while the day number is right. On the dark-theme English screenshot «Thursday,
 * August 6» the day came back as 9, and with nothing to contradict it three orders were filed under
 * a day they did not happen on — which moves them across the daily tier band, and can move them
 * across the Sunday that seals the week. The weekday is the one thing on the line that can catch
 * exactly that, and it is free.
 *
 * A mismatch tries LAST year before refusing — a January screenshot still showing «٣١ ديسمبر» is a
 * real page, not a misread. When no weekday is legible there is no checksum and the day number
 * stands, which is the same bargain as before.
 */
function orderDateHeader(line: string, year: number): string | null {
  const iso = orderDateDigits(line, year)
  if (iso === null) return null
  const weekday = weekdayOnLine(line)
  if (weekday === -1 || new Date(`${iso}T12:00:00`).getDay() === weekday) return iso
  const lastYear = `${year - 1}${iso.slice(4)}`
  return new Date(`${lastYear}T12:00:00`).getDay() === weekday ? lastYear : null
}

function orderDateDigits(line: string, year: number): string | null {
  const ascii = asciiDigits(line)
  // Both English orders: «27 July» and — what the dark-theme build actually prints — «August 6».
  const en = ascii.match(/(\d{1,2})\s+([A-Za-z]{3,})/) ?? ascii.match(/([A-Za-z]{3,})[,\s]+(\d{1,2})\b/)
  if (en) {
    const [a, b] = [en[1]!, en[2]!]
    const day = Number(/^\d/.test(a) ? a : b)
    const month = MONTHS.indexOf((/^\d/.test(a) ? b : a).toLowerCase())
    if (month !== -1 && day >= 1 && day <= 31) {
      return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }
  // Arabic: «٢٩ يوليو». The day may precede or follow the month name depending on how the RTL line
  // was serialised, so the number is taken from the line and the month matched anywhere in it.
  const folded = foldAr(ascii)
  const monthIndex = MONTHS_AR.findIndex((names) => names.some((n) => folded.includes(foldAr(n))))
  if (monthIndex === -1) return null
  const dayM = folded.match(/(\d{1,2})/)
  if (!dayM) return null
  const day = Number(dayM[1])
  if (day < 1 || day > 31) return null
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * «٦:١٠ م» → «18:10»; «11:54 ص» → «11:54»; «23:46» → «23:46».
 *
 * The Arabic screens are 12-hour with «م»/«ص», and without the conversion an afternoon order and a
 * morning one collapse onto the same time — which then collides in the order key the driver's app
 * generates from it, so two real orders become one.
 */
export function parseClock(line: string): string | null {
  const ascii = asciiDigits(line)
  // ONLY a real colon separates a clock. Accepting the decimal marks too — «٫» or «.» — makes the
  // amount itself look like a time: «−١٤٤٫١٥ SYP … ٧:٢٩ م» matched «4٫15» first and reported 16:15
  // for a row that happened at 19:29. A separator the recogniser mangled must leave the time BLANK,
  // which the matcher can see, rather than a plausible wrong one, which it cannot.
  const m = ascii.match(/([0-2]?\d)\s*:\s*([0-5]\d)/)
  if (!m) return null
  let hour = Number(m[1])
  if (hour > 23) return null
  const pm = /م(?![ا-ي])/.test(line) || /\bPM\b/i.test(line)
  const am = /ص(?![ا-ي])/.test(line) || /\bAM\b/i.test(line)
  if (pm && hour < 12) hour += 12
  if (am && hour === 12) hour = 0
  return `${String(hour).padStart(2, '0')}:${m[2]}`
}

/** The weekday names as the Arabic screen writes them, folded; index = JS `Date#getDay()`. */
const WEEKDAYS_AR = ['الاحد', 'الاثنين', 'الثلاثاء', 'الاربعاء', 'الخميس', 'الجمعه', 'السبت']
const WEEKDAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** The weekday a header line names, in either language — or -1 when none is legible. */
const weekdayOnLine = (text: string): number => {
  const tokens = foldedTokens(text)
  const ar = WEEKDAYS_AR.findIndex((n) => tokens.includes(n))
  if (ar !== -1) return ar
  const lower = text.toLowerCase()
  return WEEKDAYS_EN.findIndex((n) => lower.includes(n))
}

/** A day-of-month is digits and nothing else — no separators, no half-day marks. */
const DAY_ALPHABET: ReadonlySet<string> = new Set([...'0123456789'])

// ── The glyph reader's row geometry, pure and shared with the measurement harness ──────────
//
// «SYP»'s own cap height IS the font size, handed over for free — every band and reach is
// measured in it, so the same numbers work at any screenshot resolution. These are exported so
// scripts/glyph-read.mjs measures EXACTLY the boxes the app reads, not a near-copy that drifts.

type AnchorBox = { x0: number; x1: number; y0: number; y1: number }

/** The amount: the ink immediately LEFT of «SYP», up to 12 cap-heights away. */
export const amountBoxFor = (a: AnchorBox, height: number): Box => {
  const unit = a.y1 - a.y0
  const pad = Math.round(unit * 0.45)
  return {
    x0: Math.max(0, a.x0 - Math.round(unit * 12)),
    y0: Math.max(0, a.y0 - pad),
    x1: a.x0 - 4,
    y1: Math.min(height, a.y1 + pad),
  }
}

/** The clock cluster: everything RIGHT of «SYP» on the same band — «م H:MM», plus «MM/DD» on the log. */
export const clockBoxFor = (a: AnchorBox, width: number, height: number): Box => {
  const unit = a.y1 - a.y0
  const pad = Math.round(unit * 0.45)
  return {
    x0: a.x1 + 4,
    y0: Math.max(0, a.y0 - pad),
    x1: Math.min(width, a.x1 + Math.round(unit * 26)),
    y1: Math.min(height, a.y1 + pad),
  }
}

/**
 * «م3:19» → 15:19; «ص9:24 08/04» → 09:24 on 4 August. The whole cluster must parse or nothing is
 * offered — extra ink in the band means the reader was looking at something else too.
 */
export function parseGlyphClock(raw: string | null, year: number): { time: string; dateIso: string | null } {
  const m = raw?.match(/^([مص])(\d{1,2}):([0-5]\d)(?:(\d{2})\/(\d{2}))?$/)
  if (!m) return { time: '', dateIso: null }
  // «م» is the afternoon and «ص» the morning; twelve is the hour that moves, in both directions.
  let hour = Number(m[2])
  if (hour > 12) return { time: '', dateIso: null }
  if (m[1] === 'م' && hour < 12) hour += 12
  if (m[1] === 'ص' && hour === 12) hour = 0
  const time = `${String(hour).padStart(2, '0')}:${m[3]}`
  // The log writes MM/DD. The year is not on the screen at all, so it comes from the clock the
  // phone already has — the driver is photographing today's work, not an archive.
  const dateIso = m[4] && m[5] ? `${year}-${m[4]}-${m[5]}` : null
  return { time, dateIso }
}

/**
 * The tokens of a line, folded and stripped of the junk OCR glues to their edges — punctuation,
 * RTL marks, and stray Latin or digits («1أغسطس» is the month word with the day's «٦» misread
 * into it). Matching months and weekdays happens on these, and on WHOLE TOKENS only: substring
 * matching classified «مقابل مشفى العين» as a date header, because «اب» — August's short form —
 * hides inside ordinary Arabic words, and the header cut then beheaded the route under it.
 */
const foldedTokens = (text: string): string[] =>
  text
    .split(/\s+/)
    .map((t) => foldAr(t).replace(/^[^ء-ي]+|[^ء-ي]+$/g, ''))
    .filter((t) => t !== '')

const monthOnLine = (text: string): number => {
  const tokens = foldedTokens(text)
  const ar = MONTHS_AR.findIndex((names) => names.some((n) => tokens.includes(foldAr(n))))
  if (ar !== -1) return ar
  const lower = text.toLowerCase()
  return MONTHS.findIndex((m) => lower.includes(m))
}

/**
 * A line that announces a new day — «الخميس, ٦ أغسطس» / «Thursday, August 6».
 *
 * Even when the day NUMBER is unreadable the line still matters: it CUTS the page. Rows below it
 * belong to another day, and a place line never crosses it.
 */
export const isHeaderLine = (text: string): boolean => monthOnLine(text) !== -1

/**
 * «تم إلغاؤه» / «Cancelled» — the card below this line is not a delivery and has no anchor.
 *
 * `foldAr` has already mapped «إ»→«ا» and stripped tatweel and spacing, so «تم إلغاؤه» arrives as
 * «تمالغاؤه». The extra stems catch the forms the same word takes when the recogniser drops a
 * letter or the app words it differently — «ملغاة», «ملغي», «إلغاء» — because everything downstream
 * depends on this ONE line being recognised: miss it and the cancelled card's address is silently
 * attached to the order above as its dropoff.
 */
export const isCancelLine = (text: string): boolean => /الغا|الغي|ملغ|لغاء/.test(foldAr(text)) || /cancel/i.test(text)

/**
 * Is this token the «A»/«B» BADGE rather than part of the place name?
 *
 * The badges are coloured circles with a letter in them, and Tesseract renders them as whatever it
 * feels like: «©», «@», «&», «CA]», «[A]», «EP», «(P». The reader used to strip only a bare «A» or
 * «B», so every one of those survived and was glued onto the address — «صيدلية سلمى الوليد بن عبد
 * الملك ©», «عمر الخيام[ CA».
 *
 * The test is what a badge CANNOT be: it carries no Arabic letter and at most two Latin ones, with
 * punctuation around them ignored. That admits every rendering above and refuses every real label
 * on the sample screens — «F8Q6», «P92», «G6W9», «Baghdad», «33.518726», «تشيلي» — because a real
 * label is either Arabic or longer.
 *
 * With one exception, added after «Al» and «St» started disappearing from English addresses: a bare
 * TWO-letter token counts as a badge only when both letters are capitals. A badge is a single
 * capital in a circle, so every real rendering of one («EP», «CA», «(P») is upper-case; «Al Jalaa»
 * and «St Michel» are not, and losing that word leaves an address that names the wrong place.
 * A one-letter token stays a badge whatever its case — no address is one letter.
 */
export const isBadgeToken = (text: string): boolean => {
  const t = text.trim()
  if (t === '') return false
  if (/[؀-ۿ]/.test(t)) return false
  if (!/^[^\p{L}\p{N}]*[A-Za-z]{0,2}[^\p{L}\p{N}]*$/u.test(t)) return false
  const letters = t.replace(/[^A-Za-z]/g, '')
  return letters.length < 2 || letters === letters.toUpperCase()
}

/** A badge whose one legible letter is «B» — the dropoff, wherever the layout put it. */
const isBadgeB = (text: string): boolean => isBadgeToken(text) && /^[^\p{L}]*[Bb][^\p{L}]*$/u.test(text.trim())

/**
 * The «SYP» anchor words of a page.
 *
 * Two rules, each bought with a measured failure:
 *
 * 1. The word's LATIN LETTERS must be exactly «syp» — not merely contain it (junk transliteration
 *    once made a three-row page report «20 صفوف»), and not the earlier boundary regex either: the
 *    Arabic model glues RTL marks and neighbouring characters onto the word, and «SYP‎م» must
 *    still anchor its row or the row silently vanishes.
 * 2. The candidates must AGREE GEOMETRICALLY. Every real anchor on a page is the same word in the
 *    same font, so its height matches the median; a mangled Arabic cluster that happens to strip
 *    to «syp» sits at a different scale. One such impostor shifted every amount on a log page down
 *    a row — the fee of one order offered as the fee of the next.
 */
export const anchorsIn = (lines: readonly OcrLine[]): Array<{ text: string; x0: number; x1: number; y0: number; y1: number }> => {
  const candidates = lines
    .flatMap((l) => l.words)
    .filter((w) => w.text.replace(/[^A-Za-z]/g, '').toLowerCase() === 'syp')
    .sort((a, b) => a.y0 - b.y0)
  if (candidates.length <= 1) return candidates
  const heights = candidates.map((w) => w.y1 - w.y0).sort((a, b) => a - b)
  const median = heights[Math.floor(heights.length / 2)]!
  return candidates.filter((w) => {
    const h = w.y1 - w.y0
    return h >= median * 0.6 && h <= median * 1.6
  })
}

/**
 * The route of every order on the page: «A» the pickup, «B» the dropoff, from Tesseract's OWN text.
 *
 * That is not a compromise. Its failure is confined to Arabic-Indic DIGITS; the place lines are
 * Arabic WORDS, which it reads as reliably as it reads «SYP». The layout does the splitting, not
 * the badge letters: a card is the lines below its price row, cut at the next order, a day header,
 * a cancelled card, or a vertical gap wider than lines within a card ever have. The «A» place may
 * wrap onto several lines; «B» is always the final single line — a plus-code, a coordinate pair,
 * or a street. Where Tesseract DID read a standalone «B» badge, that line starts the B block and
 * overrides the last-line rule.
 */
export function routesFor(
  lines: readonly OcrLine[],
  anchors: readonly { x0: number; x1: number; y0: number; y1: number }[],
): Array<{ pointA: string | null; pointB: string | null; pointBIsPin?: boolean }> {
  const sorted = [...lines].sort((x, y) => x.y0 - y.y0)
  return anchors.map((a, i) =>
    routeOfBand(bandBelow(sorted, a.y1, Math.max(1, a.y1 - a.y0), anchors[i + 1]?.y0 ?? Infinity)),
  )
}

interface BandLine {
  readonly text: string
  readonly hasB: boolean
  /** Kept so a caller can tell a whole line from one the screen cut in half. */
  readonly y0: number
  readonly y1: number
}

/** One card's place lines: everything below `y1` until the card demonstrably ends. */
function bandBelow(
  sorted: readonly OcrLine[],
  y1: number,
  unit: number,
  to: number,
): BandLine[] {
  const from = y1 - Math.round(unit * 0.2)
  const band: BandLine[] = []
  let prevY1 = y1
  let first = true
  for (const line of sorted) {
    if (line.y0 < from || line.y0 >= to) continue
    if (isHeaderLine(line.text) || isCancelLine(line.text)) break
    // Lines within a card sit tight. A wide gap means the card ended and whatever follows is
    // another card's fragment or page chrome — without this, the LAST card on a screenshot
    // swept up the navigation bar and called it a dropoff. The card's own padding between the
    // price row and the first place line is wider than between place lines, hence two limits.
    if (line.y0 - prevY1 > unit * (first ? 4 : 3)) break
    first = false
    prevY1 = Math.max(prevY1, line.y1)
    const words = line.words.filter((w) => w.text.trim() !== '')
    const hasB = words.some((w) => isBadgeB(w.text))
    // Stripped WHEREVER it lands, not just at the ends. The badge is supposed to sit at the
    // line's right-hand edge, but on a mixed Arabic/Latin line the recogniser reorders freely
    // and drops it in the middle — «Glass (P الصوفانية», «G6HF RVH,) المدخل». A one- or
    // two-letter Latin token inside a Damascus address is never the address.
    const kept = words.filter((w) => !isBadgeToken(w.text))
    // Only strip Latin scraps where there is Arabic for them to be scraps OF.
    const arabicHere = kept.some((w) => hasArabic(w.text))
    const text = trimEdgeNoise(
      kept
        .filter((w) => !(arabicHere && isLatinScrap(w.text)))
        .map((w) => w.text.trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    if (text !== '') band.push({ text, hasB, y0: line.y0, y1: line.y1 })
  }
  return band
}

/**
 * Is this card only HALF ON THE SCREEN?
 *
 * The last card of a screenshot is nearly always sliced by the bottom of the phone's screen, and a
 * sliced line is not a line: half its ink is missing, so Tesseract returns whatever the surviving
 * strokes resemble. «جامع الحمود Al Beirouni Street» came back as «Al Dajeniin; Ctraat innttc.|.
 * نكم», and «إنكليزي» as «انكلنء» — confident, and nowhere near right.
 *
 * The fee and the clock of such a card are usually FINE, because they sit on the price row at the
 * top of the card, fully rendered. Only the places below are cut. So this is not detectable from
 * the text — it is detectable from the geometry, which is why the band carries its coordinates.
 *
 * Two signals, either one enough:
 *   • the band's last line runs into the bottom edge of the image, or
 *   • that line is markedly shorter than the row's own «SYP» cap height — the signature of a line
 *     whose lower half was never drawn.
 */
export function isTruncatedBand(band: readonly BandLine[], unit: number, imageHeight: number): boolean {
  const last = band[band.length - 1]
  if (!last) return false
  if (last.y1 >= imageHeight - Math.round(unit * 0.5)) return true
  return last.y1 - last.y0 < unit * 0.6
}

/** Which cards on this page are sliced by the bottom of the screen. Same shape as `routesFor`. */
export function truncatedCards(
  lines: readonly OcrLine[],
  anchors: readonly { y0: number; y1: number }[],
  imageHeight: number,
): boolean[] {
  const sorted = [...lines].sort((x, y) => x.y0 - y.y0)
  return anchors.map((a, i) => {
    const unit = Math.max(1, a.y1 - a.y0)
    return isTruncatedBand(bandBelow(sorted, a.y1, unit, anchors[i + 1]?.y0 ?? Infinity), unit, imageHeight)
  })
}

/**
 * Leading/trailing punctuation debris the recogniser leaves on a bidirectional line.
 *
 * «المدخل الاول» came back as «!المد» — the «!» is not in the address, it is the RTL run's edge
 * rendered as ink. Stripping it changes no real label: no Damascus address begins or ends with
 * ASCII punctuation. The interior is left alone, where a real «,» or «-» separates a place from
 * its district.
 */
const trimEdgeNoise = (text: string): string => text.replace(/^[^\p{L}\p{N}(]+/u, '').replace(/[^\p{L}\p{N})]+$/u, '')

/**
 * A short lower-case Latin scrap sitting inside an Arabic address is not part of the address.
 *
 * When the recogniser meets an Arabic word it cannot resolve it sometimes emits a Latin lookalike of
 * the strokes: «عالم» came back as «alle», and «جابر» as «ve». Left in, they are printed to the
 * driver as though they were part of the place name — «الجلاء alle ,الدجاج» — which reads as
 * corruption and makes the whole label look untrustworthy, including the parts that are right.
 *
 * The tell is CASE. Every real Latin name on these screens is capitalised — «Baghdad», «Crispy»,
 * «Chicken World», «Abou Roummaneh», «Al Jalaa» — while every scrap the recogniser invents comes
 * back lower-case: «alle», «ve», «gale», «gil», «ate», «ssl». So a short all-lower-case token, on a
 * line that also carries Arabic, is debris; anything capitalised is a name and is kept.
 */
const isLatinScrap = (token: string): boolean => /^[a-z]{1,5}$/.test(token.replace(/[^A-Za-z]/g, ''))

const isLatinWord = (token: string): boolean => /^[A-Za-z]+$/.test(token)
const hasArabic = (text: string): boolean => /[؀-ۿ]/.test(text)

/**
 * A destination that is a DROPPED PIN rather than a place — «(٣٦٫٢٩٦٩٨٧٥٠٦٧, ٣٣٫٥١٥٧٧٥٠٠٢)».
 *
 * The customer placed a marker on the map instead of typing an address, so the screen prints a
 * coordinate pair in Arabic-Indic digits. Tesseract cannot read those digits — that is the entire
 * reason the glyph reader exists — so what comes back is debris: «(YLYATAAVO-AV ¥Y,cloWvo--¥)».
 *
 * Reading the digits properly is not possible with today's templates: the line contains «(», «)»
 * and the Arabic comma «،» (U+060C — a different glyph from the thousands mark the «,» template was
 * harvested from), none of which have a template, and `readGlyphRow` refuses a whole row if any one
 * component is unclassifiable. Adding them means new harvest work for a field a driver reads off
 * the map anyway.
 *
 * So the line is RECOGNISED rather than read. Saying «موقع على الخريطة» is not a placeholder — it is
 * exactly what the screen says, and it is true. Printing the debris would not be.
 *
 * The test is structural, and deliberately NOT a digit count — that was tried and it fails, because
 * Tesseract renders the Arabic-Indic digits as Latin LETTERS: «(٣٦٫٢٩٦٩…)» arrives as
 * «(YLYATAAVO-AV ¥Y,cloWvo--¥)», which is 70% alphabetic. What survives the garbling is the SHAPE —
 * the brackets the coordinate pair is printed inside, and the complete absence of Arabic.
 *
 * A real address is never bracketed and always brings Arabic letters, so it cannot match; a Latin
 * address («Baghdad Avenue») and a plus-code («G6HF RVH») are not bracketed either.
 */
export const isCoordinateLine = (text: string): boolean => {
  const t = text.trim()
  if (t.length < 8) return false
  if (!/^[([]/.test(t) || !/[)\]]$/.test(t)) return false
  if (hasArabic(t.replace(/[٠-٩٫٬،]/g, ''))) return false
  // ONLY when the digits did not survive. The English build of the same app prints its coordinates
  // in WESTERN digits, which Tesseract reads perfectly — «(33.518726, 36.276…)» is a real, useful
  // dropoff and replacing it with «map location» would be throwing away a good read. A run of four
  // or more digits anywhere is proof something numeric came through; its absence is proof of debris.
  return !/\d{4,}/.test(t)
}

/** Split one card's band into pickup and dropoff. */
function routeOfBand(band: ReadonlyArray<BandLine>): { pointA: string | null; pointB: string | null; pointBIsPin?: boolean } {
  if (band.length === 0) return { pointA: null, pointB: null }

  const joined = (part: ReadonlyArray<{ text: string }>): string | null =>
    part.length === 0 ? null : part.map((l) => l.text).join(' ').slice(0, 120)

  const bAt = band.findIndex((l) => l.hasB)
  // A single line with no read badge is the A place of a card whose bottom the screenshot cut.
  if (bAt === -1 && band.length === 1) return { pointA: joined(band), pointB: null }

  // ── A's own name, wrapped, is not a destination ──────────────────────────────────────────
  //
  // With no «B» badge read, the last line is taken as the dropoff. That is right for «المدخل
  // الاول» and for a plus-code, and wrong for a pickup whose LATIN name wrapped: «القصور, ساحة
  // القصور, Crispy Way» broke after «Crispy», and the driver's card announced he had delivered to
  // «Way». A destination is not one bare English word continuing an English word on the line above.
  //
  // Narrow on purpose. It fires only when the band is otherwise Arabic (so the card is an Arabic
  // one), the last line is nothing but Latin letters, and the line above ENDS in a Latin word — the
  // signature of a wrap. «Baghdad Avenue» under an Arabic pickup keeps its B (the line above ends
  // Arabic); a GPS pair or plus-code keeps it (they carry digits); an all-Latin card keeps it (no
  // Arabic line). When it fires, B is null rather than a guess, and the psm-4 second look gets its
  // chance to find the real one.
  if (bAt === -1 && band.length >= 2) {
    const last = band[band.length - 1]!.text
    const prev = band[band.length - 2]!.text
    const prevTail = prev.split(/\s+/).filter((t) => t !== '').pop() ?? ''
    const bandIsArabic = band.slice(0, -1).some((l) => hasArabic(l.text))
    if (bandIsArabic && last.split(/\s+/).every(isLatinWord) && isLatinWord(prevTail)) {
      return { pointA: joined(band), pointB: null }
    }
  }

  const cut = bAt !== -1 ? bAt : band.length - 1
  const pointA = joined(band.slice(0, cut))
  const pointB = joined(band.slice(cut))
  // A dropped pin is reported as a pin, never as the debris its digits become. See isCoordinateLine.
  if (pointB !== null && isCoordinateLine(pointB)) return { pointA, pointB: null, pointBIsPin: true }
  // A dropoff that is NOTHING BUT a lower-case Latin scrap is not a place — «إنكليزي» came back as
  // «ssl». Alone on its line there is no Arabic beside it to mark it as debris, so it survives the
  // token filter and would be printed as the destination. Saying nothing is the honest answer.
  if (pointB !== null && isLatinScrap(pointB)) return { pointA, pointB: null }
  return { pointA, pointB }
}

/**
 * The «تم إلغاؤه» cards on a page — deliveries that were cancelled, which carry no price and so no
 * «SYP» anchor and no row of their own.
 *
 * They were invisible. Nothing counted them, nothing showed them, and the only code that knew they
 * existed was the `isCancelLine` break inside the band walk — so a cancelled card was a hole in the
 * page that the reader stepped over. That is mostly harmless and occasionally not: when the chip is
 * garbled the break never fires and the cancelled card's address becomes the PREVIOUS order's
 * dropoff, which is a real order pointed at a place it never went.
 *
 * Carved with the same rules a priced card uses, so the two agree by construction: the band is the
 * lines below the chip, stopping at the next anchor, the next day header, another chip, or a gap.
 */
export function cancelledCardsIn(
  lines: readonly OcrLine[],
  anchors: readonly { y0: number; y1: number }[],
): Array<{ y0: number; pointA: string | null; pointB: string | null }> {
  const sorted = [...lines].sort((x, y) => x.y0 - y.y0)
  const out: Array<{ y0: number; pointA: string | null; pointB: string | null }> = []
  for (const line of sorted) {
    if (!isCancelLine(line.text)) continue
    const unit = Math.max(1, line.y1 - line.y0)
    const nextAnchor = anchors.find((a) => a.y0 >= line.y1)?.y0 ?? Infinity
    const route = routeOfBand(bandBelow(sorted, line.y1, unit, nextAnchor))
    if (route.pointA === null && route.pointB === null) continue
    out.push({ y0: line.y0, ...route })
  }
  return out
}

/**
 * The day headers of a page, in order, with their dates where a date could be READ.
 *
 * `readDay` supplies the day number for the Arabic headers — Tesseract garbles Arabic-Indic
 * digits, so the caller reads the span between the month word and the weekday word off the pixels
 * (or, in tests, fakes it). The weekday word, when legible, must AGREE with the computed date:
 * a date that claims Thursday on a line that says Friday is refused, not offered.
 */
export function headerDatesIn(
  lines: readonly OcrLine[],
  year: number,
  today: Date,
  readDay: (box: { x0: number; y0: number; x1: number; y1: number }) => string | null,
): Array<{ y0: number; dateIso: string | null }> {
  const token = (s: string): string => foldAr(s).replace(/^[^ء-ي]+|[^ء-ي]+$/g, '')
  const out: Array<{ y0: number; dateIso: string | null }> = []
  for (const line of lines) {
    if (!isHeaderLine(line.text)) continue

    /*
     * TWO readings of the same header, and the weekday decides between them.
     *
     * The TEXT reading is what Tesseract made of the line; the PIXEL reading cuts the day number
     * out of the image and classifies it against the templates. Neither is trustworthy alone, and
     * — this was the bug — the text reading is not even trustworthy ENOUGH TO TRY FIRST. On
     * «الخميس, ٦ أغسطس» Tesseract emits «الخميس, 1أغسطس»: the garbled «١» is a perfectly valid
     * day, so the text path answered «1 August» and the pixel reader, which had «٦» at a margin of
     * 0.27, was never consulted. The checksum then correctly rejected 1 August — a Saturday, not a
     * Thursday — and five orders lost their date to a reading that was available all along.
     *
     * So both are computed and the FIRST that agrees with the weekday word wins.
     */
    const getDay = (iso: string): number => new Date(`${iso}T12:00:00`).getDay()
    const weekday = weekdayOnLine(line.text)

    const fromPixels = (): string | null => {
      // Whole-token matching, tolerant only at the edges: OCR glues the misread day digit onto
      // the month word itself — «1أغسطس» — so the month word's own BOX contains the day's ink.
      const monthIndex = MONTHS_AR.findIndex((names) => names.some((n) => foldedTokens(line.text).includes(foldAr(n))))
      const monthWord = line.words.find((w) => MONTHS_AR.some((names) => names.some((n) => token(w.text) === foldAr(n))))
      const weekdayWord = line.words.find((w) => WEEKDAYS_AR.includes(token(w.text)))
      if (monthIndex === -1 || !monthWord || !weekdayWord || weekdayWord.x0 <= monthWord.x1) return null
      // RTL: the weekday is rightmost, the month leftmost, the day number BETWEEN them — and
      // Tesseract does emit it as its own word, garbled to «؟» or «1» but correctly boxed.
      // Read that box: it is a handful of pixels wide and contains nothing else. Only if no such
      // word survives does this fall back to the whole span, where the month's letters have to
      // delimit the digits themselves.
      const dayWord = line.words.find((w) => w.x0 >= monthWord.x1 && w.x1 <= weekdayWord.x0 && w.x1 > w.x0)
      const span = dayWord
        ? { x0: dayWord.x0 - 2, y0: dayWord.y0 - 2, x1: dayWord.x1 + 2, y1: dayWord.y1 + 2 }
        : { x0: monthWord.x1, y0: monthWord.y0 - 2, x1: weekdayWord.x0, y1: monthWord.y1 + 2 }
      const raw = readDay(span)
      const day = raw !== null && /^\d{1,2}$/.test(raw) ? Number(raw) : null
      if (day === null || day < 1 || day > 31) return null
      return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }

    /**
     * A candidate survives only if the weekday PRINTED on the line agrees with it. The screen
     * never prints the year, so a mismatch tries last year too — a January screenshot still
     * showing «٣١ ديسمبر» — and a date landing in the future is refused outright.
     *
     * With no legible weekday there is no checksum, and a date without a checksum is a guess —
     * from EITHER path.
     *
     * The text reading used to be exempt, on the reasoning that Latin digits were never in doubt.
     * They were: on the dark-theme English screenshot «Thursday, August 6» came back with an
     * unreadable weekday and the day as 9, and the guess was accepted because nothing was left to
     * contradict it. Three orders moved to a day they did not happen on — which moves them across
     * the daily tier band, and can move them across the Sunday that seals the week.
     *
     * So both paths are checked now. A header whose weekday cannot be read yields no date, the
     * rows below it keep the shift's own day, and the driver sees that plainly.
     */
    const settle = (candidate: string | null, checked: boolean): string | null => {
      if (candidate === null) return null
      let iso = candidate
      if (weekday !== -1 && getDay(iso) !== weekday) {
        const lastYear = `${year - 1}${iso.slice(4)}`
        if (getDay(lastYear) !== weekday) return null
        iso = lastYear
      } else if (weekday === -1 && checked) {
        return null
      }
      if (new Date(`${iso}T12:00:00`).getTime() > today.getTime() + 86_400_000) {
        const lastYear = `${year - 1}${iso.slice(4)}`
        return weekday === -1 && new Date(`${lastYear}T12:00:00`).getTime() <= today.getTime() ? lastYear : null
      }
      return iso
    }

    const dateIso = settle(orderDateHeader(line.text, year), true) ?? settle(fromPixels(), true)
    out.push({ y0: line.y0, dateIso })
  }
  return out.sort((a, b) => a.y0 - b.y0)
}

/**
 * The order list from a «Recent orders» screenshot: per order the time, the delivery fee (BR1's
 * number) and the day it belongs to. The screen has no order-id and no pay-mode, so the driver
 * supplies those; this only pre-fills the fees. Anchored on a `NNN SYP` amount with the time on the
 * same row (OCR keeps them together — they share a y). Refuses to invent: a row with no readable
 * fee is dropped.
 */
export function parseOrders(text: string, year: number): OcrOrder[] {
  const out: OcrOrder[] = []
  let dateIso: string | null = null
  let pendingTime: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const dh = orderDateHeader(line, year)
    if (dh) {
      dateIso = dh
      continue
    }
    const time = parseClock(line)
    const fee = feeOnLine(line)
    if (fee) {
      out.push({ dateIso, time: time ?? pendingTime ?? '', fee, zone: null })
      pendingTime = null
    } else if (time) {
      // Time landed on its own line; hold it for the next fee.
      pendingTime = time
    }
  }
  return out
}

/**
 * The `NNN SYP` amount on one row, in either language and either word order.
 *
 * The digits are folded to ASCII first, because the Arabic build writes «٤٩٥ SYP» and a regex
 * anchored on `\d` — which is ASCII-only in JavaScript under every flag — matches none of it. And
 * the amount may sit on EITHER side of «SYP»: an RTL line can be serialised as «SYP ٤٩٥», so
 * demanding number-then-currency silently drops every row on the Arabic screen.
 */
function feeOnLine(line: string): string | null {
  const ascii = asciiDigits(line)
  /*
   * The amount must be bounded, and it must not be part of the CLOCK.
   *
   * The row is «٢٣٥ SYP … ٦:٠٦ م» and the recogniser puts both on one line, so the RTL form
   * `SYP <number>` happily matched the hour: a fee of 235 was read as 6. It only surfaced once a
   * screenshot arrived whose fee could not be read at all — until then the fee matched first and
   * hid it. A colon on either side means a time, and a time is not money.
   */
  const after = ascii.match(/(?:^|[^\w.,:])([\d.,،٬٫]+)\s*SYP/i)
  if (after) return listAmount(after[1]!)
  const before = ascii.match(/SYP\s*([\d.,،٬٫]+)(?![\w:])/i)
  return before ? listAmount(before[1]!) : null
}

// ── Reading the amounts ourselves ───────────────────────────────────────────────────────────

/**
 * Every amount on a screen, read GLYPH BY GLYPH, with Tesseract used only to find the rows.
 *
 * It locates «SYP» — plain ASCII, which it reads perfectly — and the amount is the ink immediately
 * to its left. That ink is segmented and each shape classified against templates learnt from real
 * screenshots. On the five sample screens this reads 30 of 34 rows and gets none of them wrong,
 * where every Tesseract configuration ever tried reads zero.
 *
 * A row it will not vouch for comes back `null` and is simply absent from the result: the caller
 * reports how many of how many were read, and the driver types the rest. Refusing is the feature.
 */
async function readAmountsByGlyph(
  image: Blob | Uint8Array,
  timeoutMs: number,
): Promise<{ amounts: (string | null)[]; clocks: { time: string; dateIso: string | null }[]; routes: { pointA: string | null; pointB: string | null; pointBIsPin?: boolean }[]; truncated: boolean[]; strips: (string | null)[]; cancelled: { dateIso: string | null; pointA: string | null; pointB: string | null }[]; rows: number; text: string }> {
  const prepared = await prepareWithPixels(toBlob(image), false, false)
  if (!prepared) return { amounts: [], clocks: [], routes: [], truncated: [], strips: [], cancelled: [], rows: 0, text: '' }

  const result = await recognize(prepared.blob, { whitelist: '', psm: 6 }, timeoutMs)
  // The word must BE «SYP», not merely contain it. `/SYP/` matched Tesseract's junk words too, and
  // on an Arabic page it emits plenty: a three-row screen reported twenty-one rows, so the driver
  // was told twenty of them went unread when only two had.
  const anchors = anchorsIn(result.lines)
  if (anchors.length === 0) return { amounts: [], clocks: [], routes: [], truncated: [], strips: [], cancelled: [], rows: 0, text: result.text }

  /*
   * ── BRING THE PIXELS TO THE SCALE THE TEMPLATES KNOW ──────────────────────────────────────
   *
   * Tesseract has already found the rows, and the height of the «SYP» word it found IS the screen's
   * font size, measured on this exact screenshot. The templates were learnt at a cap height of
   * 17–23; a 1080×2400 phone puts it at 32. Segmenting at 32 and classifying against 20 is what
   * misread a fare in the field — see CANON_CAP_HEIGHT for why scale-free features do not save it.
   *
   * So the image is resampled once, by the ratio between the two, and every box is scaled with it.
   * The anchors keep their meaning because they are scaled by the same number. Left alone within
   * 10%: resampling costs a little sharpness and there is nothing to buy with it near 1.
   */
  const capHeights = anchors.map((a) => a.y1 - a.y0).sort((x, y) => x - y)
  const capHeight = capHeights[Math.floor(capHeights.length / 2)] ?? CANON_CAP_HEIGHT
  const factor = canonFactorFor(capHeight)
  const rescale = factor !== 1
  const canon = rescale
    ? resampleRgba(prepared.pixels, prepared.width, prepared.height, factor)
    : { data: prepared.pixels, width: prepared.width, height: prepared.height }
  const scaleBox = <T extends { x0: number; x1: number; y0: number; y1: number }>(a: T): T =>
    rescale
      ? ({
          ...a,
          x0: Math.round(a.x0 * factor),
          x1: Math.round(a.x1 * factor),
          y0: Math.round(a.y0 * factor),
          y1: Math.round(a.y1 * factor),
        } as T)
      : a

  const mask = maskFromPixels(canon.data, canon.width, canon.height)
  const templates = unpackTemplates(GLYPH_TEMPLATES)
  // The clock is printed smaller than the amounts, so it is scored against prototypes drawn from
  // its own font — one shared set blurred both and cost real reads on each.
  const clockTemplates = unpackTemplates(CLOCK_TEMPLATES)

  /**
   * The clock, and on the log the date, from the cluster to the RIGHT of «SYP».
   *
   * This is what gives an order an IDENTITY. The screen carries no order number anywhere — the
   * previous key was invented from the fee, which is not a name, it is a coincidence — and two
   * deliveries at the same price on one day were indistinguishable. «م ٣:١٩ ٠٨/٠٤» is the row.
   */
  const clockAt = (a: { x0: number; x1: number; y0: number; y1: number }): { time: string; dateIso: string | null } =>
    parseGlyphClock(
      readGlyphRow(mask, clockBoxFor(scaleBox(a), canon.width, canon.height), clockTemplates, CLOCK_ALPHABET),
      new Date().getFullYear(),
    )

  const clocks = anchors.map(clockAt)

  /**
   * The day each row belongs to, from the «الخميس, ٦ أغسطس» headers between the day groups.
   *
   * Tesseract reads the header's Arabic WORDS; the day NUMBER is Arabic-Indic, so it is read off
   * the pixels — the span between the month word and the weekday word, against the clock-font
   * templates. A row's date is the nearest header ABOVE it; rows above the first header belong to
   * a newer day whose header scrolled off-screen, and get no date rather than a guessed one.
   */
  const headers = headerDatesIn(result.lines, new Date().getFullYear(), new Date(), (box) =>
    readDigitRun(mask, scaleBox(box), clockTemplates, DAY_ALPHABET),
  )
  const dateFor = (a: { y0: number }): string | null => {
    let seen: string | null = null
    for (const h of headers) if (h.y0 < a.y0 && h.dateIso !== null) seen = h.dateIso
    return seen
  }

  const routes = routesFor(result.lines, anchors)
  // Which of these cards the screen sliced in half. Geometry, not text — see isTruncatedBand.
  const truncated = truncatedCards(result.lines, anchors, prepared.height)

  /*
   * SECOND LOOK at a card whose places the full-page pass lost.
   *
   * On a dense two-language screen the layout analyser sometimes emits no line at all for a
   * dropoff — «عمر الخيام» came through and «الشيخ سعد» simply was not in the output, so the row
   * showed a delivery to nowhere. Read alone, that band is a small simple picture and the same
   * engine finds the line without difficulty.
   *
   * Strictly bounded: only where B is missing AND the card has the vertical room to hold a line
   * that was not read, and never more than three per screenshot — a page that failed everywhere
   * is a page to type, not one to spend a minute of a driver's evening re-reading.
   */
  const MAX_RETRIES = 3
  let retries = 0
  for (const [i, route] of routes.entries()) {
    if (retries >= MAX_RETRIES) break
    if (route.pointB !== null) continue
    const a = anchors[i]!
    const unit = Math.max(1, a.y1 - a.y0)
    const bottom = anchors[i + 1]?.y0 ?? Math.min(prepared.height, a.y1 + Math.round(unit * 9))
    // Room for at least two place lines below the price row, or there is nothing to recover.
    if (bottom - a.y1 < unit * 3) continue
    retries++
    const band = await bandBlob(prepared.pixels, prepared.width, a.y1, bottom)
    if (!band) continue
    // `psm: 4` — a single column of text of variable sizes, which is what one card is.
    const again = await recognize(band, { whitelist: '', psm: 4 }, timeoutMs).catch(() => null)
    if (!again) continue
    // The band's own coordinates are relative to its top; shift them back so `routesFor` sees the
    // same geometry it would have on the whole page, and re-run it for this ONE anchor.
    const shifted = again.lines.map((l) => ({
      ...l,
      y0: l.y0 + a.y1,
      y1: l.y1 + a.y1,
      words: l.words.map((w) => ({ ...w, y0: w.y0 + a.y1, y1: w.y1 + a.y1 })),
    }))
    const [recovered] = routesFor(shifted, [a])
    // Only ever an IMPROVEMENT, and only of the MISSING half. The first pass's pickup is kept:
    // read alone the band recognises the same line differently — «عمر الخيام» came back as «jac
    // الخيام» — and replacing a good label with a worse one is not a repair.
    if (recovered?.pointB) routes[i] = { pointA: route.pointA ?? recovered.pointA, pointB: recovered.pointB }
  }

  const amounts = anchors.map((a) => readGlyphRow(mask, amountBoxFor(scaleBox(a), canon.height), templates))
  // The fee's own pixels, kept for training — see `stripBlob`. Cut from `prepared`, the image the
  // reader was actually handed, NOT from the canon rescale and not from the compressed evidence copy.
  const strips = await Promise.all(
    anchors.map(async (a) =>
      asDataUrl(await stripBlob(prepared.pixels, prepared.width, prepared.height, amountBoxFor(a, prepared.height))),
    ),
  )
  return {
    amounts,
    strips,
    // A clock that carried its own date (the log's «MM/DD») keeps it; the orders screen prints no
    // date per row, so the day comes from the header the row sits under.
    clocks: clocks.map((c, i) => ({ time: c.time, dateIso: c.dateIso ?? dateFor(anchors[i]!) })),
    routes,
    truncated,
    // The cancelled cards, carved with the same band rules — see cancelledCardsIn.
    cancelled: cancelledCardsIn(result.lines, anchors).map((c) => ({
      dateIso: dateFor({ y0: c.y0 }),
      pointA: c.pointA,
      pointB: c.pointB,
    })),
    rows: anchors.length,
    text: result.text,
  }
}

/** Read the whole order list off a «Recent orders» / «الطلبات الحديثة» screenshot. */
export async function readOrders(image: Blob | Uint8Array, timeoutMs = ORDERS_TIMEOUT_MS): Promise<OcrOutcome<{ orders: OcrOrder[] }>> {
  const started = now()
  let text = ''
  try {
    // TESSERACT'S OWN TEXT FIRST. The app also runs in English, and that build prints WESTERN
    // digits, which Tesseract reads properly — «−1,432.40 SYP» comes straight out of the text.
    // The glyph reader has templates for Arabic-Indic shapes only, so pointing it at a Western
    // build produces confident nonsense. Whichever script is on screen, the cheap correct reader
    // is tried before the specialised one, and `readIsCoherent` decides whether it succeeded.
    let best: OcrOrder[] = []
    let bestLines: OcrLine[] = []
    for (const invert of [false, true]) {
      const prepared = await prepareForOcr(toBlob(image), invert, false)
      // No whitelist (Arabic addresses, «SYP», colons, digits all matter); a list is a uniform block.
      const result = await recognize(prepared, { whitelist: '', psm: 6 }, timeoutMs)
      if (result.text.length > text.length) text = result.text
      const orders = parseOrders(result.text, new Date().getFullYear())
      if (orders.length > best.length) {
        best = orders
        bestLines = result.lines
      }
      if (best.length > 0 && !invert) break // the usual case: the first pass read it
    }
    // Not merely "did anything parse" — did enough of the page parse to be believed. See
    // `readIsCoherent`: on the Arabic-Indic screens the models transliterate the digits, and a
    // handful of rows surviving that is luck, not a read.
    if (best.length > 0 && readIsCoherent(text, best.length)) {
      // The text gave the fees, times and dates; the line GEOMETRY gives the routes. Zipped by
      // index only when the anchor count matches the parsed rows — a mismatched page keeps its
      // fees and simply goes without routes, rather than pinning them to the wrong orders.
      const anchors = anchorsIn(bestLines)
      if (anchors.length === best.length) {
        const routes = routesFor(bestLines, anchors)
        best = best.map((o, i) => ({ ...o, pointA: routes[i]?.pointA ?? null, pointB: routes[i]?.pointB ?? null }))
      }
      return { ok: true, reading: { orders: best }, fieldsFound: best.length, ms: now() - started, text }
    }

    // Arabic-Indic, then: read the shapes ourselves.
    const byGlyph = await readAmountsByGlyph(image, timeoutMs)
    if (byGlyph.text.length > text.length) text = byGlyph.text
    // Each order carries the clock it happened at, which is the only identity the screen offers —
    // it has no order number anywhere on it.
    const glyphRows = byGlyph.amounts.map((raw, i) => {
      const clock = byGlyph.clocks[i]
      const route = byGlyph.routes[i]
      return {
        cutOff: byGlyph.truncated[i] === true,
        feeStrip: byGlyph.strips[i] ?? null,
        dateIso: clock?.dateIso ?? null,
        time: clock?.time ?? '',
        // A fee the classifier refused, or one whose SHAPE is not a fee, becomes null — not a
        // dropped row. See below for why the row still travels.
        fee: glyphListFee(raw),
        zone: null,
        pointA: route?.pointA ?? null,
        pointB: route?.pointB ?? null,
      }
    })
    // A refused fee used to delete its whole row, silently. The driver saw «N refused» under the
    // tile and had no way to know WHICH deliveries were missing — on the owner's own test the
    // ٥:٤٢ order simply was not there, and nothing on screen said so. A row the reader could not
    // price is still a delivery it can PROVE happened: it has the clock and the route off the same
    // screenshot. So it travels with `fee: null` and arrives as a card with an empty fee field.
    //
    // The one exception is a row with no identity at all — no clock, no route, nothing but a
    // refused number. That cannot be de-duplicated against anything, so re-scanning the same page
    // would add it again every time. It stays counted in `rowsSeen` and shown only as «N refused».
    // A card the screen sliced in half is withheld entirely — its places are a guess. Counted and
    // announced, never silently dropped: the driver adds that one by hand, and on a page that
    // overlaps the next one it usually arrives whole from there anyway.
    // A card the screen sliced in half keeps its FEE and its CLOCK — those sit on the price row at
    // the top of the card, fully drawn, and they read correctly. Only its PLACES are a guess, so
    // only its places are withheld. Dropping the whole card cost the driver a delivery he then had
    // to add by hand on every scan, to spare him a wrong address; this spares him both.
    const cutOff = glyphRows.filter((r) => r.cutOff).length
    const glyphOrders: OcrOrder[] = glyphRows
      .filter((r) => r.fee !== null || r.time !== '' || r.pointA !== null || r.pointB !== null)
      .map(({ cutOff: isCut, ...row }) => (isCut ? { ...row, pointA: null, pointB: null } : row))
    const priced = glyphRows.filter((r) => r.fee !== null).length
    const cancelledCards: OcrOrder[] = byGlyph.cancelled.map((c) => ({
      dateIso: c.dateIso,
      time: '',
      fee: null,
      zone: null,
      pointA: c.pointA,
      pointB: c.pointB,
      cancelled: true,
    }))
    if (glyphOrders.length === 0 && cancelledCards.length === 0) {
      return { ok: false, reason: 'no_fields', ms: now() - started, text }
    }
    return {
      ok: true,
      reading: { orders: [...glyphOrders, ...cancelledCards] },
      // How many of how many: a page where four rows of thirty-four were refused is a good read
      // with four rows to type, and saying «٣٠» without the «٣٤» hides the four. `fieldsFound`
      // counts rows whose FEE was read, so the refused counter keeps meaning "still needs a number"
      // now that refused rows are visible cards rather than absences.
      fieldsFound: priced,
      rowsSeen: byGlyph.rows,
      cutOff,
      ms: now() - started,
      text,
    }
  } catch (err) {
    const reason: OcrFailure = err instanceof Error && err.message === 'ocr timeout' ? 'timeout' : 'unavailable'
    return { ok: false, reason, ms: now() - started, text }
  }
}

// ── The Yallago payments log «سجل المدفوعات» ───────────────────────────────────────────────
//
// A LOG, not a balance — and that difference is why `parseWallet` must never be pointed at it.
// `parseWallet` collapses a whole page to one number: it strips newlines and signs and welds every
// row's digits (and every clock's digits) into a single run, then returns `ok` with a confident
// wrong answer. It cannot even fail. A log has to be read the opposite way: row by row, each with
// its own SIGN, amount and time, and rows it cannot read must simply not appear.

export interface WalletMovement {
  /** Signed money as a decimal string: «-80», «107.50». Negative = left the wallet. */
  readonly amount: string
  /** «HH:MM», 24-hour, or '' when the row's clock was not readable. */
  readonly time: string
}

/**
 * One row per movement, in screen order.
 *
 * A row counts only if it has BOTH a sign and an `SYP` amount. That is deliberately strict: an
 * unsigned number on this screen is as likely to be a clock, a date or a balance as it is money,
 * and a wrong row here becomes a wrong wallet in BR1. The «−» the app draws is U+2212, not a
 * hyphen, and Tesseract also returns it as «~» or «—» often enough to accept all of them.
 */
export function parsePaymentsLog(text: string): WalletMovement[] {
  const out: WalletMovement[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const ascii = asciiDigits(line)
    // The sign sits at the START of the amount on this screen, in both directions of the RTL run.
    const m =
      ascii.match(/([+\-−–—~])\s*([\d.,،٬٫]+)\s*SYP/i) ?? ascii.match(/SYP\s*([+\-−–—~])\s*([\d.,،٬٫]+)(?![\w:])/i)
    if (!m) continue
    const magnitude = listAmount(m[2]!)
    if (magnitude === null) continue
    const negative = m[1] !== '+'
    out.push({ amount: negative ? `-${magnitude}` : magnitude, time: parseClock(line) ?? '' })
  }
  return out
}

const WALLET_LOG_TIMEOUT_MS = 20_000

/** Read every movement off a «سجل المدفوعات» screenshot (light text on a dark page). */
export async function readPaymentsLog(
  image: Blob | Uint8Array,
  timeoutMs = WALLET_LOG_TIMEOUT_MS,
): Promise<OcrOutcome<{ movements: WalletMovement[] }>> {
  const started = now()
  let text = ''
  try {
    // Tesseract's text first, for the same reason as the orders screen: the English build prints
    // Western digits and reads perfectly, and the glyph templates would answer nonsense for them.
    let best: WalletMovement[] = []
    // Inverted FIRST: this screen is white-on-black, which Tesseract binarises poorly the other way.
    for (const invert of [true, false]) {
      const prepared = await prepareForOcr(toBlob(image), invert, false)
      const result = await recognize(prepared, { whitelist: '', psm: 6 }, timeoutMs)
      if (result.text.length > text.length) text = result.text
      const movements = parsePaymentsLog(result.text)
      if (movements.length > best.length) best = movements
      if (best.length > 0 && invert) break
    }
    if (best.length > 0 && readIsCoherent(text, best.length)) {
      return { ok: true, reading: { movements: best }, fieldsFound: best.length, ms: now() - started, text }
    }

    // Arabic-Indic. The sign is a glyph in the alphabet like any other, so a movement comes back
    // already signed and «−» never has to be inferred from anything.
    const byGlyph = await readAmountsByGlyph(image, timeoutMs)
    if (byGlyph.text.length > text.length) text = byGlyph.text
    const glyphMovements = byGlyph.amounts
      .map((raw, i) => {
        if (raw === null) return null
        const negative = raw.startsWith('-')
        const magnitude = listAmount(raw.replace(/^[-+]/, ''))
        // The clock is what pairs a movement to the order it belongs to — «سجل المدفوعات» and
        // «الطلبات الحديثة» share nothing else, and the 20% cut lands at its order's own minute.
        return magnitude === null
          ? null
          : { amount: negative ? `-${magnitude}` : magnitude, time: byGlyph.clocks[i]?.time ?? '' }
      })
      .filter((m): m is WalletMovement => m !== null)
    if (glyphMovements.length === 0) return { ok: false, reason: 'no_fields', ms: now() - started, text }
    return {
      ok: true,
      reading: { movements: glyphMovements },
      fieldsFound: glyphMovements.length,
      rowsSeen: byGlyph.rows,
      ms: now() - started,
      text,
    }
  } catch (err) {
    const reason: OcrFailure = err instanceof Error && err.message === 'ocr timeout' ? 'timeout' : 'unavailable'
    return { ok: false, reason, ms: now() - started, text }
  }
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

const whole = (n: number): number => Math.round(n)

/**
 * The two figures the reader looks for — the remaining charge and the lifetime cycle count. Every
 * app spells them differently, so each carries its known label spellings. Voltage / capacity /
 * temperatures were read here once; the product now tracks only charge + cycles per pack.
 */
const COMMON_FIELDS: readonly BmsField[] = [
  { key: 'percent', labels: ['remainbattery', 'soc', 'الطاقةالمتبقية', 'نسبةالشحن'], scale: whole, max: 100 },
  // 5 000, not 100 000: a lithium pack is worn out by ~2 000 cycles, so a five-figure "count" is
  // always a misread. The calibration script caught a temperature row parsed as 36 906 cycles — in
  // range under the old cap, absurd on a battery, and indistinguishable from a real answer once
  // stored. A tighter bound turns that into a blank the driver fills.
  { key: 'cycleCount', labels: ['cyclecount', 'عددالدورات', 'الدورات'], scale: whole, max: 5_000 },
]

export const BMS_PROFILES: readonly BmsProfile[] = [
  {
    id: 'auto',
    nameAr: 'تلقائي',
    nameEn: 'Automatic',
    fields: COMMON_FIELDS,
    layout: 'both',
    // PSM 6 FIRST, measured against the client's own two screenshots: at psm 6 the English table
    // yields «Remain Battery: 100» and «Cycle Count: 8», and the cyan Arabic app's gauge yields
    // «100»; at psm 3 the cycle count disappears from both. Automatic segmentation used to run
    // first here, which is why an unpinned pack — every pack, by default — read the page with the
    // worse of the two and filled confident wrong numbers.
    psm: [6, 3],
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
    // 6 before 3, measured on the client's own screenshot: psm 6 reads the gauge AND «الدورات»,
    // psm 3 reads neither. Automatic segmentation used to go first — it costs a whole recognition
    // pass on a phone to learn nothing, and it is the pass this app is worst served by.
    psm: [6, 3],
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
  // can need two of them. On the Arabic app the cycle count reads on the first pass, and the charge
  // reads on none of them: it lives on the cyan panel where light text on a darker background is
  // INVERTED, and Tesseract wants dark on light. An inverted pass reads the panel and loses the
  // cards, so neither pass alone is enough.
  const merged: BmsReading = { percent: null, cycleCount: null }
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

    const complete = (): boolean => merged.percent !== null && merged.cycleCount !== null

    for (const pass of passes) {
      // The inverted passes exist to rescue the CHARGE off a dark panel; once it is in hand they
      // are not worth a driver's seconds.
      if (pass.invert && merged.percent !== null) break
      // A profile's later segmentation modes are a fallback, not a routine second pass — but only
      // a COMPLETE read earns skipping them. This used to stop at "found anything", so a first
      // pass that produced the charge alone suppressed the pass that would have produced the cycle
      // count too, and the field stayed empty with a perfectly good reading one segmentation away.
      if (!pass.invert && pass.psm !== passes[0]!.psm && complete()) continue

      const prepared = await prepareForOcr(source, pass.invert)
      const result = await recognize(prepared, { whitelist: '', psm: pass.psm }, timeoutMs)
      // «ما قرأه النظام» shows the pass that read the most, which is the one worth looking at.
      if (result.text.length > text.length) text = result.text
      absorb(parseBms(result.lines, profile))
      if (complete()) break
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

  const out: BmsReading = { percent: null, cycleCount: null }
  const text = lines.map((l) => l.text).join('\n')

  const store = (key: keyof BmsReading, field: BmsField, value: number): void => {
    // BOTH figures are counts, never fractions: a charge is «100», a cycle count is «8». A value
    // that arrived with a decimal point is therefore not this field's number — it is a neighbouring
    // temperature or voltage that the layout pairing reached by mistake. Rounding it (33.7 → 34)
    // was how «عدد الدورات» came back as a plausible, confident, WRONG reading on a real phone.
    if (!Number.isInteger(value)) return
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

  // An unlabelled percentage is still worth having: both apps show exactly one "100%", and it is
  // always the state of charge.
  //
  // The «%» is one of the LEAST reliable glyphs on these screens: on the client's own cyan app the
  // gauge came back as «100/» at one segmentation and «100*» at another, and on the dark English
  // app as «100°». A rule anchored on a literal `%` therefore found no charge on any of them — the
  // one field the gate requires. PERCENT_SIGN accepts the glyphs it is actually mistaken for; the
  // 0–100 range check below is what keeps that tolerance from turning noise into a reading.
  if (out.percent === null) out.percent = unlabelledCharge(text)

  // Last resort, and the one that matters most: the charge is the only field the shift gate
  // actually requires, and on both apps it is the HEADLINE number — a big figure in a ring, with
  // the «%» a small superscript that OCR often drops, which is exactly how a phone came back with
  // voltage, cycles and a temperature but no charge. Size is the signal the layout cannot hide.
  if (out.percent === null) {
    const gauge = biggestPercentage(lines)
    // A SINGLE big digit is refused here, and that refusal is the whole point: «100» in a ring
    // whose other two glyphs were lost reads as «1», which is what a driver was actually shown for
    // a full pack. A one-digit gauge is indistinguishable from a truncated three-digit one, so it
    // is not offered at all — a pack under 10% is rare, and the driver types it.
    if (gauge !== null && gauge >= 10) out.percent = gauge
  }

  return out
}

/**
 * A charge worth offering. Zero is excluded on purpose: a genuinely flat pack cannot start a shift
 * anyway, while a «0» scavenged from noise is one of the commonest misreads — so it is left blank
 * for the driver rather than pre-filled with an answer that looks deliberate.
 */
const plausibleCharge = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 100

/**
 * The charge from an unlabelled «NN%», at two levels of trust.
 *
 * A real «%» or «٪» is unambiguous: whatever whole number precedes it is the charge, 1–100.
 *
 * The other glyphs are GUESSES. Measured, not assumed: the cyan Arabic app's gauge came back as
 * «100/» at one segmentation and «100*» at another, and the dark English app's «Remain Battery:
 * 100%» as «100°» — so refusing them loses the one field the gate requires. But accepting them
 * cheaply is how «1/» in a row of noise became a 1% charge for a pack that was full. A guessed
 * percent sign therefore has to carry a TWO-DIGIT number, which is exactly the shape a truncated
 * «100» cannot fake. A pack under 10% is rare; the driver types it.
 */
function unlabelledCharge(text: string): number | null {
  const certain = text.match(/(?<![\d.,])(\d{1,3})\s*[%٪]/)
  if (certain && plausibleCharge(Number(certain[1]))) return Number(certain[1])

  const guessed = text.match(/(?<![\d.,])(\d{2,3})\s*[°*/]/)
  if (guessed && plausibleCharge(Number(guessed[1]))) return Number(guessed[1])
  return null
}

/**
 * The state of charge, found by how big it is printed.
 *
 * Constrained hard, because "the biggest number" is a blunt instrument: a WHOLE number 0–100 (a
 * charge is never written 81.48, which rules out the pack voltage), and printed at least 1.6× the
 * median glyph height on the page, which rules out every figure sitting in an ordinary card.
 */
function biggestPercentage(lines: readonly OcrLine[]): number | null {
  const heights = lines
    .flatMap((l) => l.words)
    .map((w) => w.y1 - w.y0)
    .filter((h) => h > 0)
    .sort((a, b) => a - b)
  if (heights.length < 4) return null
  const median = heights[Math.floor(heights.length / 2)]!

  let best: { value: number; height: number } | null = null
  for (const line of lines) {
    // Big glyphs on one line, left to right. A gauge's «100» may arrive as three separate words,
    // so the run is rebuilt before it is read — otherwise the biggest number on the page is `1`.
    const big = line.words.filter((w) => w.y1 - w.y0 >= median * 1.6).sort((a, b) => a.x0 - b.x0)
    if (big.length === 0) continue

    const value = joinGlyphs(big)
    if (value === null) continue
    // A WHOLE number 0–100: a charge is never written 81.48, which is what keeps the pack voltage
    // out of this.
    if (!Number.isInteger(value) || value < 0 || value > 100) continue

    const height = Math.max(...big.map((w) => w.y1 - w.y0))
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

  const overlapping = line.words
    .filter((w) => w.x0 <= span.x1 && w.x1 >= span.x0)
    .sort((a, b) => a.x0 - b.x0)
  if (overlapping.length === 0) return null

  // Sparse-text mode returns isolated glyphs as SEPARATE words, so a gauge reading «100» arrives
  // as `1`, `0`, `0`. Taking the first word gave a charge of 1 — a plausible number, stored as a
  // real reading, with nothing to show it was wrong. Digits run left to right even on an RTL page,
  // so joining by ascending x rebuilds the figure.
  const joined = joinGlyphs(overlapping)
  if (joined !== null) return joined

  for (const word of overlapping) {
    const value = numberIn(word.text)
    if (value !== null) return value
  }
  return null
}

/**
 * Rebuild one number from a run of words, when the run is nothing BUT a number.
 *
 * Guarded on purpose: concatenating indiscriminately would fuse «T2» and «33.6» into `T233.6` and
 * read a temperature of two hundred and thirty-three. Only a run whose every character belongs to
 * a number is joined; anything else falls back to reading the words one at a time.
 */
function joinGlyphs(words: ReadonlyArray<{ text: string }>): number | null {
  const text = words.map((w) => normalise(w.text)).join('')
  if (text === '' || !/^[0-9.,%]+$/.test(text)) return null
  return numberIn(text)
}
