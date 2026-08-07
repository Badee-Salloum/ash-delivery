#!/usr/bin/env node
/**
 * Run the REAL reader against the REAL screenshots, and print what each pass produced.
 *
 * Why a script and not a test: the parser tests feed text a recogniser is supposed to have made,
 * which cannot answer the question that actually broke in the field — whether tesseract, on THESE
 * two apps, produces text the parser can use at all. That answer depends on the preprocessing and
 * the segmentation mode. It is not a vitest test because the wasm worker will not spawn reliably
 * inside vitest's own workers (it hangs); in plain Node it is dependable.
 *
 *   node scripts/ocr-calibrate.mjs
 *
 * Fixtures live in `apps/driver/test/fixtures/ocr/` with their ground truth in FIXTURES below.
 * Requires the driver's dev dependency `@napi-rs/canvas` (the browser does this work on the phone)
 * and the staged models in `apps/driver/public/tesseract/` (`pnpm --filter @ash/driver build`
 * stages them). Findings this script produced, all now pinned by tests in ocr.test.ts:
 *   • PSM 6 reads both apps; PSM 3 loses the cycle count on both → `auto` now tries 6 first.
 *   • The cyan app's gauge is ILLEGIBLE without the contrast stretch, and its «%» comes back as
 *     «/» or «*» (and «°» on the English app) → PERCENT_SIGN accepts those.
 *   • The dashboard photo yields `ono B48 km` for «ODO 02611 km» → the odometer must refuse to
 *     answer rather than offer 48.
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const driver = join(root, 'apps', 'driver')
const fixtures = join(driver, 'test', 'fixtures', 'ocr')
const MAX_DIMENSION = 2000

/** The ground truth of each fixture, read off the screen by eye. `null` = genuinely unreadable. */
const FIXTURES = [
  { file: 'bms-table-en.jpg', kind: 'bms', profile: 'table_en', expect: { percent: 100, cycleCount: 8 } },
  { file: 'bms-cards-ar.jpg', kind: 'bms', profile: 'cards_ar', expect: { percent: 100, cycleCount: 1 } },
  { file: 'dash-odometer.jpg', kind: 'dash', expect: { odometer: 2611 } },

  /*
   * Tuesday 4 August, one driver's whole day, read off the phone at full resolution — the first
   * sample of these two screens that is legible at all (the earlier set came through WhatsApp at
   * 482 px, where the digits are simply not in the pixels).
   *
   * Every order's Yallago cut is in the log at the SAME MINUTE and is exactly 20% of the fee, which
   * is what the matcher pairs on. The 3:22pm order is «تم إلغاؤه» — cancelled — and moves no money
   * at all: it must not appear as an order, and no log row answers to it.
   */
  { file: 'orders-0804-a.jpg', kind: 'orders', expect: { fees: ['235', '210', '130', '135', '170'] } },
  { file: 'orders-0804-b.jpg', kind: 'orders', expect: { fees: ['260', '135', '120', '235'] } },
  { file: 'orders-0804-c.jpg', kind: 'orders', expect: { fees: ['120', '235', '120'] } },
  {
    file: 'log-0804-a.jpg',
    kind: 'log',
    expect: { amounts: ['-165.50', '-47', '153', '-42', '-22', '-26', '95', '-27', '-34', '215', '-52'] },
  },
  {
    file: 'log-0804-b.jpg',
    kind: 'log',
    expect: { amounts: ['-177', '-27', '-24', '100', '-47', '-24', '250', '130', '300', '-1155.65', '-416'] },
  },
]

/** Fees / signed amounts the pass got, as a multiset comparison against the truth above. */
function scoreList(got, want) {
  const remaining = [...want]
  const spurious = []
  for (const g of got) {
    const at = remaining.indexOf(g)
    if (at === -1) spurious.push(g)
    else remaining.splice(at, 1)
  }
  return { missed: remaining, spurious }
}

// file:// URLs, not bare paths — a Windows absolute path is not a valid ESM specifier. The two
// libraries are the DRIVER's dependencies (this script lives at the repo root), so they are
// resolved from there rather than from here.
const from = (specifier) => import(pathToFileURL(createRequire(join(driver, 'package.json')).resolve(specifier)).href)

const { parseBms, parseOrders, parsePaymentsLog, parseReading, profileById, readIsCoherent } = await import(
  pathToFileURL(join(driver, 'src', 'ocr.ts')).href
)
const { createCanvas, loadImage } = await from('@napi-rs/canvas')
const { createWorker, OEM } = await from('tesseract.js')

/** The same greyscale + 5th–95th-percentile stretch `normaliseContrast` does, on a Node canvas. */
async function prepare(file, invert) {
  const img = await loadImage(file)
  const longest = Math.max(img.width, img.height)
  const scale = longest > MAX_DIMENSION ? MAX_DIMENSION / longest : 1
  const canvas = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale))
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const px = image.data
  const histogram = new Uint32Array(256)
  for (let i = 0; i < px.length; i += 4) {
    const y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000
    const level = y < 0 ? 0 : y > 255 ? 255 : Math.round(y)
    px[i] = px[i + 1] = px[i + 2] = level
    histogram[level]++
  }
  const total = canvas.width * canvas.height
  const percentile = (fraction) => {
    let seen = 0
    const target = total * fraction
    for (let level = 0; level < 256; level++) {
      seen += histogram[level]
      if (seen >= target) return level
    }
    return 255
  }
  const low = percentile(0.05)
  const high = percentile(0.95)
  if (high - low >= 24) {
    const factor = 255 / (high - low)
    for (let i = 0; i < px.length; i += 4) {
      const stretched = (px[i] - low) * factor
      const clamped = stretched < 0 ? 0 : stretched > 255 ? 255 : stretched
      const level = invert ? 255 - clamped : clamped
      px[i] = px[i + 1] = px[i + 2] = level
    }
  }
  ctx.putImageData(image, 0, 0)
  return canvas.toBuffer('image/png')
}

/**
 * The same line/word boxes `linesOf` builds inside the reader. v7 hides them at
 * `blocks[].paragraphs[].lines[].words[]`, and they are what the card-grid pairing runs on.
 */
function linesOf(data) {
  const out = []
  for (const block of data.blocks ?? []) {
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
  if (out.length === 0) {
    for (const [i, line] of (data.text ?? '').split(/\r?\n/).entries()) {
      if (line.trim() !== '') out.push({ text: line, y0: i * 10, y1: i * 10 + 10, words: [] })
    }
  }
  return out
}

const present = readdirSync(fixtures).filter((f) => /\.(jpe?g|png)$/i.test(f))
if (present.length === 0) {
  console.error(`no fixtures in ${fixtures}`)
  process.exit(1)
}

const worker = await createWorker(['eng', 'ara'], OEM.LSTM_ONLY, {
  langPath: join(driver, 'public', 'tesseract'),
  gzip: true,
})

let failures = 0
for (const fixture of FIXTURES) {
  if (!present.includes(fixture.file)) continue
  console.log(`\n=== ${fixture.file} — expecting ${JSON.stringify(fixture.expect)} ===`)

  for (const variant of ['raw', 'stretched', 'stretched+inverted']) {
    const image =
      variant === 'raw'
        ? join(fixtures, fixture.file)
        : await prepare(join(fixtures, fixture.file), variant.endsWith('inverted'))

    for (const psm of [6, 3, 11]) {
      await worker.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1' })
      // `blocks: true`, exactly as readBms asks for it. The Arabic app is a CARD GRID whose value
      // sits above its caption, so it can only be paired by column geometry — feeding the parser
      // the flat text (which is what this script did at first) silently withholds the very input
      // «الدورات» needs, and reports a null the real app would not produce.
      const { data } = await worker.recognize(image, {}, { text: true, blocks: true })
      const text = data.text ?? ''

      // The two LIST screens are scored as multisets, not field-by-field: what matters is which
      // rows were read and, far more, which rows were INVENTED. A spurious fee is money BR1 will
      // demand the driver account for, out of a screenshot nobody re-reads.
      if (fixture.kind === 'orders' || fixture.kind === 'log') {
        const got =
          fixture.kind === 'orders'
            ? parseOrders(text, 2026).map((o) => o.fee)
            : parsePaymentsLog(text).map((m) => m.amount)
        const want = fixture.expect.fees ?? fixture.expect.amounts
        const { missed, spurious } = scoreList(got, want)
        if (missed.length === 0 && spurious.length === 0) (fixture.readBy ??= new Set()).add('rows')
        // What the READER would do with this pass. A pass that parses three rows out of eleven is
        // refused wholesale, so those three never reach a field — that is the difference between a
        // wrong number in BR1 and an honest "could not read".
        const offered = readIsCoherent(text, got.length)
        if (spurious.length > 0 && offered) failures++
        console.log(
          `  ${variant.padEnd(19)} psm ${String(psm).padEnd(3)} ${got.length}/${want.length} rows` +
            `${offered ? '' : '  [refused: incoherent]'}` +
            `${missed.length ? `  missed ${missed.length}` : ''}` +
            `${spurious.length ? `   ${offered ? '← INVENTED' : 'debris'} ${JSON.stringify(spurious)}` : ''}`,
        )
        continue
      }

      const read = fixture.kind === 'bms' ? parseBms(linesOf(data), profileById(fixture.profile)) : parseReading(text)
      const wrong = Object.entries(read).some(
        ([key, value]) => value !== null && value !== fixture.expect[key],
      )
      // Every field this pass got exactly right — so the run as a whole can be judged on whether
      // ANY pass reads each figure, not merely on nobody being wrong. A reader that is silently
      // blank everywhere would otherwise look like a pass.
      for (const [key, value] of Object.entries(read)) {
        if (value !== null && value === fixture.expect[key]) (fixture.readBy ??= new Set()).add(key)
      }
      console.log(
        `  ${variant.padEnd(19)} psm ${String(psm).padEnd(3)} ${JSON.stringify(read)}${wrong ? '   ← WRONG (worse than blank)' : ''}`,
      )
      if (wrong) failures++
    }
  }

  // What no pass could read. Reported, not failed: the dashboard genuinely cannot be read through
  // that glare, and pretending otherwise would only invite a guess.
  const unread =
    fixture.kind === 'orders' || fixture.kind === 'log'
      ? fixture.readBy?.has('rows')
        ? []
        : ['every row exactly']
      : Object.keys(fixture.expect).filter((key) => !fixture.readBy?.has(key))
  if (unread.length > 0) console.log(`  → never read by any pass: ${unread.join(', ')} (driver types these)`)
}
await worker.terminate()

console.log(
  failures === 0
    ? '\nNo pass produced a wrong value. A blank field is a driver typing; a wrong one is a lie.'
    : `\n${failures} pass(es) produced a WRONG value — fix the parser before shipping.`,
)
process.exit(failures === 0 ? 0 : 1)
