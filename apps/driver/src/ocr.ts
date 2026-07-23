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
 *                  Labels are the whole point here: «Cycle Count: 8» is only meaningful if the
 *                  words come through, so the digits-only whitelist that helps the dashboard makes
 *                  this one impossible. It needs letters, a block layout, and per-word boxes so a
 *                  right-to-left Arabic app (value first, label second) can still be paired up.
 *
 * Both are ASSISTED, never automatic: they PRE-FILL fields the driver then corrects, and every
 * path is wrapped so ANY failure resolves to `null` and the screen falls back to manual entry.
 * OCR can only ever help, never block.
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
 * The language set is `eng+ara` because the client uses both the English and the Arabic BMS app.
 * Arabic costs roughly another 0.7–1 MB on first use, fetched once and then cached forever.
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

interface OcrWord {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

/**
 * Recognise with a profile, under a hard deadline.
 *
 * The timeout rejects AND clears its own timer. The abandoned `recognize` cannot be cancelled —
 * wasm has no interrupt — but at least the timer no longer fires unobserved after every successful
 * read. 12 s keeps the whole call inside the SRS's 15 s per-image budget with room for the worker
 * handoff; the old 20 s exceeded it outright.
 */
async function recognize(image: Blob, profile: Profile, timeoutMs: number): Promise<{ text: string; words: OcrWord[] }> {
  const worker = await getWorker()
  await worker.setParameters({
    tessedit_char_whitelist: profile.whitelist,
    tessedit_pageseg_mode: String(profile.psm),
    preserve_interword_spaces: '1',
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      worker.recognize(image),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ocr timeout')), timeoutMs)
      }),
    ])
    const data = (result as { data: { text?: string; words?: OcrWord[] } }).data
    return { text: data.text ?? '', words: data.words ?? [] }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const toBlob = (image: Blob | Uint8Array): Blob =>
  image instanceof Uint8Array ? new Blob([image as BlobPart], { type: 'image/jpeg' }) : image

// ── The e-bike dashboard photo ────────────────────────────────────────────────────────────

/** Battery % + odometer from a dashboard photo. Returns null on ANY failure. */
export async function readDashboard(image: Blob | Uint8Array, timeoutMs = 12_000): Promise<OcrReading | null> {
  try {
    // Digits only, sparse layout: a dash has a handful of large glyphs and no useful words.
    const { text } = await recognize(toBlob(image), { whitelist: '0123456789%.', psm: 11 }, timeoutMs)
    return parseReading(text)
  } catch {
    return null
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
 * Read a BMS app screenshot. Returns null on ANY failure — the driver then types the numbers.
 *
 * Feed this the ORIGINAL file, not the compressed upload. `compressImage` caps the long edge at
 * 1280 px and drops JPEG quality to 0.4, which puts a 1080×2400 screenshot's body text at roughly
 * 10–13 px of x-height — under the LSTM's recognition floor, with ringing on exactly the thin,
 * high-contrast glyphs this depends on. No tesseract parameter compensates for that.
 */
export async function readBms(image: Blob | Uint8Array, timeoutMs = 12_000): Promise<BmsReading | null> {
  try {
    const { text, words } = await recognize(
      toBlob(image),
      {
        // Letters are mandatory: without them no label survives, and label-anchored parsing is not
        // merely unimplemented — it is impossible. An empty whitelist means "no restriction",
        // which is also what Arabic needs; a whitelist containing Arabic script is a known source
        // of LSTM garbage.
        whitelist: '',
        // A dense, regular two-column readout. SPARSE_TEXT (11) does no layout analysis and would
        // scramble the row grouping the pairing below depends on; 6 is a uniform block of text.
        psm: 6,
      },
      timeoutMs,
    )
    return parseBms(text, words)
  } catch {
    return null
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
 * Pair labels with values.
 *
 * Line-based, then column-based, because both apps put one field per cell. Where word boxes are
 * available the rows are ALSO re-derived geometrically, which is what makes the Arabic app work:
 * it prints the value to the LEFT of its label, so "the number after the label" is wrong while
 * "the number in the same cell" is right in both directions.
 */
export function parseBms(text: string, words: readonly OcrWord[] = []): BmsReading {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')

  // OCR line breaks in a two-column layout are unreliable; vertical position is not.
  if (words.length > 0) {
    const rows = new Map<number, OcrWord[]>()
    for (const w of words) {
      if (!w.bbox) continue
      // 12 px buckets: tight enough to keep two stacked fields apart, loose enough that a
      // superscript unit stays on its own row.
      const bucket = Math.round((w.bbox.y0 + w.bbox.y1) / 2 / 12)
      rows.set(bucket, [...(rows.get(bucket) ?? []), w])
    }
    for (const [, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      // Rebuild the column gutter from the horizontal gaps, so `columnsOf` can still find it.
      // Joining every word with one space would fuse two columns into one cell and hand the
      // right-hand field the left-hand field's number.
      const ordered = [...row].sort((a, b) => a.bbox.x0 - b.bbox.x0)
      let text = ''
      let prevEnd: number | null = null
      for (const w of ordered) {
        const gap = prevEnd === null ? 0 : w.bbox.x0 - prevEnd
        text += prevEnd === null ? w.text : (gap > 40 ? '   ' : ' ') + w.text
        prevEnd = w.bbox.x1
      }
      lines.push(text)
    }
  }

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
