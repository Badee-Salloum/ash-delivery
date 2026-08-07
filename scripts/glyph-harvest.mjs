#!/usr/bin/env node
/**
 * Cut every labelled glyph out of the sample screenshots and write them to JSON.
 *
 *   node scripts/glyph-harvest.mjs           # → apps/driver/test/fixtures/ocr/glyphs.json
 *
 * Two sources, deliberately, because one is not enough:
 *
 *   • THE AMOUNTS, in the large font, labelled by the amount strings.
 *   • THE DATE, in the SMALLER font of the right-hand column, labelled «٠٨/٠٤». On 4 August the
 *     amounts contain no «٨» at all — the digit exists only here — and «٩» only in the «٩:٢٤»
 *     hour. Without these two the reader would refuse roughly a quarter of all real rows.
 *
 * Pooling two font sizes is the whole reason the features below are SCALE-FREE: a shape stretched
 * into a fixed grid, an aspect ratio, a height relative to the tallest glyph beside it, and a
 * vertical position within its own group. Nothing is measured in pixels, so a template learnt from
 * a 12-pixel date digit matches the same digit printed at 19 pixels in an amount.
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const driver = join(root, 'apps', 'driver')
const fixtures = join(driver, 'test', 'fixtures', 'ocr')
const from = (s) => import(pathToFileURL(createRequire(join(driver, 'package.json')).resolve(s)).href)
const { createCanvas, loadImage } = await from('@napi-rs/canvas')
const { createWorker, OEM } = await from('tesseract.js')

export const GW = 12
export const GH = 16
const INK = 170
const MIN_PIXELS = 5

/**
 * The amounts, top to bottom, exactly as drawn — the thousands mark included.
 * `.` is the decimal mark, `,` the thousands mark, whatever glyph draws each.
 */
const AMOUNTS = {
  'log-0804-a.jpg': ['-165.50', '-47', '+153', '-42', '-22', '-26', '+95', '-27', '-34', '+215', '-52'],
  'log-0804-b.jpg': ['-177', '-27', '-24', '+100', '-47', '-24', '+250', '+130', '+300', '-1,155.65', '-416'],
  'orders-0804-a.jpg': ['235', '210', '130', '135', '170'],
  'orders-0804-b.jpg': ['260', '135', '120', '235'],
  'orders-0804-c.jpg': ['120', '235', '120'],
}

/**
 * The right-hand column of the LOG rows, which reads «م  H:MM  MM/DD» left to right.
 *
 * `date` is its last five glyphs and is unambiguous. `hour` is the digit immediately after «م»,
 * given only where it is worth harvesting — the «٩» rows. The minutes and the colon are skipped:
 * a colon renders as one component or two depending on how the dots fall, and a truth that has to
 * guess which is a truth that will mislabel.
 */
const CLUSTERS = {
  'log-0804-a.jpg': { date: '08/04', rows: 11 },
  // Rows 0-8 are 08/04; the last two crossed midnight into the previous day, 08/03.
  'log-0804-b.jpg': { date: '08/04', lastRowsDate: { count: 2, date: '08/03' }, rows: 11, hours: { 6: '9', 7: '9' } },
}

const worker = await createWorker(['eng'], OEM.LSTM_ONLY, { langPath: join(driver, 'public', 'tesseract'), gzip: true })
await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' })

/** Connected components (8-neighbour) inside a box, ordered left to right. */
function componentsIn(grey, x0, y0, x1, y1) {
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return []
  const ink = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ink[y * w + x] = grey(x0 + x, y0 + y) < INK ? 1 : 0

  const seen = new Uint8Array(w * h)
  const out = []
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const start = sy * w + sx
      if (!ink[start] || seen[start]) continue
      let minX = sx, maxX = sx, minY = sy, maxY = sy, n = 0
      const stack = [start]
      seen[start] = 1
      while (stack.length > 0) {
        const p = stack.pop()
        const y = (p / w) | 0
        const x = p % w
        n++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
            const q = ny * w + nx
            if (ink[q] && !seen[q]) {
              seen[q] = 1
              stack.push(q)
            }
          }
        }
      }
      if (n >= MIN_PIXELS) out.push({ minX, maxX, minY, maxY, ink, w })
    }
  }
  return out.sort((a, b) => a.minX - b.minX)
}

/**
 * A glyph as the classifier sees it. Every feature is SCALE-FREE, so the small date font and the
 * large amount font describe the same digit the same way.
 */
export function featuresOf(c, group) {
  const gw = c.maxX - c.minX + 1
  const gh = c.maxY - c.minY + 1
  const bits = new Uint8Array(GW * GH)
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const sx = c.minX + Math.min(gw - 1, Math.floor((x * gw) / GW))
      const sy = c.minY + Math.min(gh - 1, Math.floor((y * gh) / GH))
      bits[y * GW + x] = c.ink[sy * c.w + sx]
    }
  }
  return {
    bits: Array.from(bits),
    /** Wide-and-flat («−») vs narrow-and-tall («١») — the cheapest discriminator there is. */
    aspect: gw / gh,
    /** Height against the tallest glyph standing beside it, so a font size cancels out. */
    relH: gh / group.tallest,
    /** Where it sits on the line: a zero is mid-height, a decimal mark hangs at the bottom. */
    relY: (c.minY + c.maxY) / 2 - group.top === 0 ? 0 : ((c.minY + c.maxY) / 2 - group.top) / group.height,
  }
}

const groupOf = (comps) => {
  const tallest = Math.max(...comps.map((c) => c.maxY - c.minY + 1))
  const top = Math.min(...comps.map((c) => c.minY))
  const bottom = Math.max(...comps.map((c) => c.maxY))
  return { tallest, top, height: Math.max(1, bottom - top) }
}

const samples = []
let rowsSeen = 0
let rowsUsable = 0

for (const [file, amounts] of Object.entries(AMOUNTS)) {
  const img = await loadImage(join(fixtures, file))
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const { data: px } = ctx.getImageData(0, 0, img.width, img.height)
  const grey = (x, y) => {
    const i = (y * img.width + x) * 4
    return (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000
  }

  const { data } = await worker.recognize(join(fixtures, file), {}, { text: true, blocks: true })
  const words = []
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? [])
        for (const w of l.words ?? []) words.push({ text: w.text ?? '', ...w.bbox })
  const anchors = words.filter((w) => /SYP/i.test(w.text)).sort((a, b) => a.y0 - b.y0)

  const cluster = CLUSTERS[file]
  anchors.forEach((a, i) => {
    const unit = a.y1 - a.y0
    const pad = Math.round(unit * 0.45)
    const top = Math.max(0, a.y0 - pad)
    const bottom = Math.min(img.height, a.y1 + pad)

    // ── The amount, to the LEFT of «SYP» ──────────────────────────────────────────────────
    rowsSeen++
    const want = [...(amounts[i] ?? '')]
    const comps = componentsIn(grey, Math.max(0, a.x0 - Math.round(unit * 12)), top, a.x0 - 4, bottom)
    if (comps.length === want.length && want.length > 0) {
      rowsUsable++
      const group = groupOf(comps)
      comps.forEach((c, j) => samples.push({ label: want[j], font: 'amount', file, ...featuresOf(c, group) }))
    } else if (want.length > 0) {
      console.log(`!! ${file} row ${i} «${amounts[i]}»: ${comps.length} glyphs, expected ${want.length}`)
    }

    // ── The date, to the RIGHT — the only place «٨» is written at all ─────────────────────
    if (!cluster) return
    const right = componentsIn(grey, a.x1 + 4, top, Math.min(img.width, a.x1 + Math.round(unit * 26)), bottom)
    if (right.length < 6) return
    const late = cluster.lastRowsDate && i >= cluster.rows - cluster.lastRowsDate.count
    const dateLabels = [...(late ? cluster.lastRowsDate.date : cluster.date)]
    const dateComps = right.slice(-dateLabels.length)
    const group = groupOf(right)
    dateComps.forEach((c, j) => samples.push({ label: dateLabels[j], font: 'date', file, ...featuresOf(c, group) }))

    // The hour digit sits immediately after «م», which is the leftmost component of the cluster.
    const hour = cluster.hours?.[i]
    if (hour && right[1]) samples.push({ label: hour, font: 'date', file, ...featuresOf(right[1], group) })
  })
}
await worker.terminate()

const byClass = new Map()
for (const s of samples) byClass.set(s.label, (byClass.get(s.label) ?? 0) + 1)
console.log(`\namount rows fully segmented: ${rowsUsable}/${rowsSeen}`)
console.log(`glyphs harvested: ${samples.length}`)
console.log('\nclass  n   (a = amount font, d = date font)')
for (const label of [...'0123456789', '-', '+', '.', ',', '/']) {
  const a = samples.filter((s) => s.label === label && s.font === 'amount').length
  const d = samples.filter((s) => s.label === label && s.font === 'date').length
  const flag = a + d === 0 ? '   NEVER SEEN' : a + d < 3 ? '   thin' : ''
  console.log(`  ${label}   ${String(a + d).padStart(3)}   a=${String(a).padStart(2)} d=${String(d).padStart(2)}${flag}`)
}

const out = join(fixtures, 'glyphs.json')
writeFileSync(out, JSON.stringify({ gw: GW, gh: GH, samples }))
console.log(`\nwritten: ${out}`)
