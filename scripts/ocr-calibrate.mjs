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
]

// file:// URLs, not bare paths — a Windows absolute path is not a valid ESM specifier. The two
// libraries are the DRIVER's dependencies (this script lives at the repo root), so they are
// resolved from there rather than from here.
const from = (specifier) => import(pathToFileURL(createRequire(join(driver, 'package.json')).resolve(specifier)).href)

const { parseBms, parseReading, profileById } = await import(pathToFileURL(join(driver, 'src', 'ocr.ts')).href)
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
      const { data } = await worker.recognize(image)
      const text = data.text ?? ''
      const read =
        fixture.kind === 'bms' ? parseBms(text, profileById(fixture.profile)) : parseReading(text)
      const wrong = Object.entries(read).some(
        ([key, value]) => value !== null && value !== fixture.expect[key],
      )
      console.log(
        `  ${variant.padEnd(19)} psm ${String(psm).padEnd(3)} ${JSON.stringify(read)}${wrong ? '   ← WRONG (worse than blank)' : ''}`,
      )
      if (wrong) failures++
    }
  }
}
await worker.terminate()

console.log(
  failures === 0
    ? '\nNo pass produced a wrong value. A blank field is a driver typing; a wrong one is a lie.'
    : `\n${failures} pass(es) produced a WRONG value — fix the parser before shipping.`,
)
process.exit(failures === 0 ? 0 : 1)
