#!/usr/bin/env node
/**
 * The WHOLE reader, end to end, against the real screenshots.
 *
 *   node scripts/glyph-read.mjs
 *
 * Tesseract finds «SYP»; the ink to its left is segmented and classified against the shipped
 * templates; the result is compared to the amounts read off the screen by eye. This is the only
 * measurement that answers the question the driver actually asks, which is not "how accurate is
 * the classifier" but "did my screenshot turn into my day".
 *
 * A refused row is a SUCCESS of a different kind — it means the driver types that one — so the
 * two outcomes that matter are counted separately. A WRONG row is the only real failure, and the
 * whole design exists to make that number zero.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const driver = join(root, 'apps', 'driver')
const fixtures = join(driver, 'test', 'fixtures', 'ocr')
const from = (s) => import(pathToFileURL(createRequire(join(driver, 'package.json')).resolve(s)).href)
const { createCanvas, loadImage } = await from('@napi-rs/canvas')
const { createWorker, OEM } = await from('tesseract.js')
const { componentsIn, featuresOf, groupMetrics, maskFromPixels, readGlyphRow, unpackTemplates, nearestTemplate, classifyGlyph, withoutRules } =
  await import(pathToFileURL(join(driver, 'src', 'glyphs.ts')).href)
const { GLYPH_TEMPLATES } = await import(pathToFileURL(join(driver, 'src', 'glyph-templates.ts')).href)

const templates = unpackTemplates(GLYPH_TEMPLATES)

/** What each row really says, top to bottom — the same truth the harvester is labelled from. */
const TRUTH = {
  'log-0804-a.jpg': ['-165.50', '-47', '+153', '-42', '-22', '-26', '+95', '-27', '-34', '+215', '-52'],
  'log-0804-b.jpg': ['-177', '-27', '-24', '+100', '-47', '-24', '+250', '+130', '+300', '-1,155.65', '-416'],
  'orders-0804-a.jpg': ['235', '210', '130', '135', '170'],
  'orders-0804-b.jpg': ['260', '135', '120', '235'],
  'orders-0804-c.jpg': ['120', '235', '120'],
}

const worker = await createWorker(['eng'], OEM.LSTM_ONLY, { langPath: join(driver, 'public', 'tesseract'), gzip: true })
await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' })

let read = 0
let refused = 0
let wrong = 0
let rows = 0

for (const [file, truth] of Object.entries(TRUTH)) {
  const img = await loadImage(join(fixtures, file))
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const { data: px } = ctx.getImageData(0, 0, img.width, img.height)
  const mask = maskFromPixels(px, img.width, img.height)

  const { data } = await worker.recognize(join(fixtures, file), {}, { text: true, blocks: true })
  const words = []
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? [])
        for (const w of l.words ?? []) words.push({ text: w.text ?? '', ...w.bbox })
  const anchors = words.filter((w) => /SYP/i.test(w.text)).sort((a, b) => a.y0 - b.y0)

  console.log(`\n=== ${file} — ${anchors.length} rows`)
  anchors.forEach((a, i) => {
    rows++
    const unit = a.y1 - a.y0
    const pad = Math.round(unit * 0.45)
    const box = {
      x0: Math.max(0, a.x0 - Math.round(unit * 12)),
      y0: Math.max(0, a.y0 - pad),
      x1: a.x0 - 4,
      y1: Math.min(img.height, a.y1 + pad),
    }
    const want = truth[i] ?? '?'
    const got = readGlyphRow(mask, box, templates)

    if (got === null) {
      refused++
      // Say WHY, per glyph — a refusal nobody can explain is a refusal nobody can fix.
      const comps = withoutRules(componentsIn(mask, box))
      const group = groupMetrics(comps)
      const why = comps
        .map((c) => {
          const f = featuresOf(c, group)
          const near = nearestTemplate(f, templates)
          if (!near) return '?'
          const ok = classifyGlyph(f, templates)
          return ok ? near.label : `[${near.label}:${near.score.toFixed(2)}/m${near.margin.toFixed(2)}]`
        })
        .join('')
      console.log(`  row ${String(i).padStart(2)}  want ${want.padEnd(10)} REFUSED   ${why}`)
      return
    }
    const same = got === want
    if (same) read++
    else wrong++
    console.log(`  row ${String(i).padStart(2)}  want ${want.padEnd(10)} got ${got.padEnd(10)} ${same ? 'ok' : '← WRONG'}`)
  })
}
await worker.terminate()

console.log(`\nrows ${rows}   read ${read}   refused ${refused}   WRONG ${wrong}`)
console.log(
  wrong === 0
    ? `\nNo row was read wrongly. ${read}/${rows} filled in automatically; the other ${refused} the driver types.`
    : `\n${wrong} row(s) READ WRONGLY — that is the one outcome this design exists to prevent. Do not ship.`,
)
process.exit(wrong === 0 ? 0 : 1)
