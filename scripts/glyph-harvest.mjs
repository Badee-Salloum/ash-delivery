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
const MIN_PIXELS = 3

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
  // Folder 4: the same Yallago face at two other display scales. The features are scale-free, so
  // these pool with the 0804 samples — and they are rich in «٢» and «٣», the pair whose thin
  // margin causes every refusal the reader currently makes.
  'orders-0806-lg.jpg': ['170', '130', '330', '525', '135'],
  'orders-0807-sm.jpg': ['275', '345', '165', '300'],
  // ── Harvested from the rest of folder 4, transcribed off magnified crops ──────────────────
  // Read at 5x from the amount box itself, because at native size «٥» (a small circle) and «٠»
  // (a dot) are the same shape to a tired eye, and a mislabelled glyph teaches the reader a lie.
  // A row whose crop caught part of the «SYP» is left EMPTY rather than guessed — the loop skips
  // a zero-length label, so an uncertain row costs nothing and risks nothing.
  'orders-h1.jpg': ['205', '500', '435', '155'],
  'orders-h2.jpg': ['155', '250', '485', '300'],
  'orders-h3.jpg': ['130', '130', '400', '250'],
  'orders-h4.jpg': ['130', '150', '750', '350'],
  'orders-h5.jpg': ['130', '455', '265', '275'],
  'log-h1.jpg': ['+97', '+250', '-1,875.87', '+85', '', '', '-100'],
  'log-h2.jpg': ['-87', '+135', '-31', '-50', '+437', '-97', '-150', '-60', '+213', '-63', '+155'],
  'log-h3.jpg': ['-31', '', '-88', '', '-120', '', '-355', '+26', '+79', ''],
  'log-h4.jpg': ['-2,067.30', '-229.70', '+51', '+695', '-150', '+221', '-70', '-185', '-26', '+74'],
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

/**
 * The WHOLE right-hand cluster of each row, glyph by glyph, left to right.
 *
 * It reads «م  H:MM  MM/DD» on the log and «م  H:MM» on the orders screen, so the labels are the
 * marker, then the time including its colon, then the date. This is what teaches the alphabet the
 * COLON and the two half-day marks — «م» and «ص» — which the amounts never contain and without
 * which an order has no identity but the fee somebody happened to charge.
 *
 * A row whose glyph count does not match its label count is REPORTED and skipped, never guessed
 * at: a mislabelled colon poisons every time the reader will ever produce.
 */
const TIME_CLUSTERS = {
  'log-0804-a.jpg': [
    ['م', '6:06'], ['م', '6:06'], ['م', '5:42'], ['م', '5:42'], ['م', '5:22'], ['م', '5:22'],
    ['م', '5:07'], ['م', '5:07'], ['م', '4:50'], ['م', '4:16'], ['م', '4:16'],
  ],
  'log-0804-b.jpg': [
    ['م', '3:51'], ['م', '3:51'], ['م', '3:19'], ['م', '1:39'], ['م', '1:39'], ['م', '1:10'],
    ['ص', '9:24'], ['ص', '9:24'], ['ص', '3:23'], ['م', '6:33'], ['م', '6:29'],
  ],
  // The orders screen carries no date per row — it sits in a header above the day's rows — so the
  // cluster is the marker and the time alone. The cancelled 3:22 row has no «SYP» and no anchor.
  'orders-0804-a.jpg': [['م', '6:06'], ['م', '5:42'], ['م', '5:22'], ['م', '5:07'], ['م', '4:50']],
  'orders-0804-b.jpg': [['م', '4:16'], ['م', '3:51'], ['م', '3:19'], ['م', '1:39']],
  'orders-0804-c.jpg': [['م', '3:19'], ['م', '1:39'], ['م', '1:10']],
  'orders-0806-lg.jpg': [['م', '1:55'], ['م', '1:36'], ['م', '12:56'], ['م', '12:22'], ['ص', '11:14']],
  'orders-0807-sm.jpg': [['م', '1:57'], ['م', '12:59'], ['م', '12:21'], ['ص', '11:53']],
  // Orders screens only. The LOG rows carry a date in the same cluster and their own truth format,
  // and a mislabelled colon or half-day mark poisons every clock the reader will ever produce —
  // so the new logs contribute their amounts and nothing else.
  'orders-h1.jpg': [['ص', '2:15'], ['ص', '1:21'], ['م', '11:46'], ['م', '10:09']],
  'orders-h2.jpg': [['م', '10:09'], ['م', '9:29'], ['م', '8:35'], ['م', '7:44']],
  'orders-h3.jpg': [['م', '10:31'], ['م', '9:48'], ['م', '9:22'], ['م', '8:28']],
  'orders-h4.jpg': [['م', '2:20'], ['ص', '1:16'], ['ص', '12:32'], ['م', '11:16']],
  'orders-h5.jpg': [['م', '2:13'], ['ص', '12:57'], ['م', '11:30'], ['م', '10:49']],
}

const g = await import(pathToFileURL(join(driver, 'src', 'glyphs.ts')).href)
const ocr = await import(pathToFileURL(join(driver, 'src', 'ocr.ts')).href)

// Arabic too: `anchorsIn` filters «SYP» candidates by height against the page median, and an
// English-only pass on an Arabic screen reports a different set of words to measure that against.
const worker = await createWorker(['eng', 'ara'], OEM.LSTM_ONLY, { langPath: join(driver, 'public', 'tesseract'), gzip: true })
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
  return mergeStacked(out.sort((a, b) => a.minX - b.minX))
}

/**
 * Rejoin stacked pieces of one glyph — the smaller fonts print the colon as two disjoint dots.
 * Mirrors `mergeStacked` in apps/driver/src/glyphs.ts; `ink` spans the whole region, so the
 * widened bounding box samples both pieces without any copying.
 */
function mergeStacked(comps) {
  const out = []
  for (const c of comps) {
    const prev = out[out.length - 1]
    if (prev) {
      const overlap = Math.min(prev.maxX, c.maxX) - Math.max(prev.minX, c.minX) + 1
      const narrower = Math.min(prev.maxX - prev.minX, c.maxX - c.minX) + 1
      // Stacked means vertically disjoint — «م»'s tail under a digit must NOT merge them.
      const yOverlap = Math.min(prev.maxY, c.maxY) - Math.max(prev.minY, c.minY) + 1
      const shorter = Math.min(prev.maxY - prev.minY, c.maxY - c.minY) + 1
      if (overlap >= narrower * 0.6 && yOverlap <= shorter * 0.3) {
        prev.minX = Math.min(prev.minX, c.minX)
        prev.maxX = Math.max(prev.maxX, c.maxX)
        prev.minY = Math.min(prev.minY, c.minY)
        prev.maxY = Math.max(prev.maxY, c.maxY)
        continue
      }
    }
    out.push(c)
  }
  return out
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

/**
 * SEGMENT EXACTLY AS THE READER DOES.
 *
 * This loop used to cut its own crops with its own fixed ink threshold, and the result was a
 * training set describing ink the reader never sees. On the newly added screenshots it split «٢٠٥»
 * into four shapes and «١٥٥» into seven, so every one of them was rejected — and on an EXISTING
 * fixture it had been quietly losing rows the same way («٢٧٥» as two glyphs).
 *
 * A template must describe the ink the classifier will actually be handed, so the anchors, the
 * boxes, the Otsu mask, the rule-stripping and the stacked-glyph merge are all the app's own —
 * imported, not re-implemented. A mismatch reported here is now a real disagreement between the
 * label and what the reader sees, which is exactly what a harvest should be checking.
 */
for (const [file, amounts] of Object.entries(AMOUNTS)) {
  const img = await loadImage(join(fixtures, file))
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const raw = ctx.getImageData(0, 0, img.width, img.height).data

  const { data } = await worker.recognize(canvas.toBuffer('image/png'), {}, { text: true, blocks: true })
  const lines = []
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? [])
        lines.push({
          text: l.text ?? '',
          y0: l.bbox?.y0 ?? 0,
          y1: l.bbox?.y1 ?? 0,
          words: (l.words ?? []).map((w) => ({ text: w.text ?? '', x0: w.bbox?.x0 ?? 0, x1: w.bbox?.x1 ?? 0, y0: w.bbox?.y0 ?? 0, y1: w.bbox?.y1 ?? 0 })),
        })
  const anchors = ocr.anchorsIn(lines)
  if (anchors.length === 0) { console.log(`!! ${file}: no anchors`); continue }
  /*
   * THE WHOLE FILE IS REFUSED IF THE ROW COUNTS DISAGREE.
   *
   * Labels are matched to rows by INDEX, so one extra or missing anchor shifts every label onto its
   * neighbour's glyphs. The per-row length check does not catch that — «-70» and «+51» are both
   * three glyphs, so a shifted pair passes silently and teaches the classifier two lies. A file
   * whose count does not match its truth is not partially usable; it is unusable.
   */
  if (anchors.length !== amounts.length) {
    console.log(`!! ${file}: ${anchors.length} anchors vs ${amounts.length} labels — WHOLE FILE SKIPPED (labels would shift)`)
    continue
  }

  // The reader normalises an out-of-band screenshot to the scale its templates were learnt at.
  // Harvesting must do the same, or the samples describe a size the classifier never meets.
  const caps = anchors.map((a) => a.y1 - a.y0).sort((x, y) => x - y)
  const factor = g.canonFactorFor(caps[Math.floor(caps.length / 2)])
  const canon = factor !== 1 ? g.resampleRgba(raw, img.width, img.height, factor) : { data: raw, width: img.width, height: img.height }
  const scaleBox = (b) => (factor === 1 ? b : { x0: Math.round(b.x0 * factor), x1: Math.round(b.x1 * factor), y0: Math.round(b.y0 * factor), y1: Math.round(b.y1 * factor) })
  const mask = g.maskFromPixels(canon.data, canon.width, canon.height)
  const cut = (box) => g.mergeStacked(mask, g.withoutRules(g.componentsIn(mask, box)))
  // The app returns `bits` as a Uint8Array, which JSON writes as an OBJECT rather than an array —
  // silently unreadable to the template builder. Normalised here, at the one place it is produced.
  const featuresOfApp = (c, group) => { const f = g.featuresOf(c, group); return { ...f, bits: Array.from(f.bits) } }

  const cluster = CLUSTERS[file]
  anchors.forEach((a, i) => {
    // ── The amount, to the LEFT of «SYP» ──────────────────────────────────────────────────
    rowsSeen++
    const want = [...(amounts[i] ?? '')]
    const comps = cut(ocr.amountBoxFor(scaleBox(a), canon.height))
    if (comps.length === want.length && want.length > 0) {
      rowsUsable++
      const group = g.groupMetrics(comps)
      comps.forEach((c, j) => samples.push({ label: want[j], font: 'amount', file, ...featuresOfApp(c, group) }))
    } else if (want.length > 0) {
      console.log(`!! ${file} row ${i} «${amounts[i]}»: ${comps.length} glyphs, expected ${want.length}`)
    }

    // ── The cluster to the RIGHT: the marker, the time, and (on the log) the date ─────────
    const timeRow = TIME_CLUSTERS[file]?.[i]
    if (!timeRow) return
    const right = cut(ocr.clockBoxFor(scaleBox(a), canon.width, canon.height))
    if (right.length === 0) return
    const late = cluster?.lastRowsDate && i >= cluster.rows - cluster.lastRowsDate.count
    const dateStr = cluster ? (late ? cluster.lastRowsDate.date : cluster.date) : ''
    const labels = [timeRow[0], ...timeRow[1], ...dateStr]
    if (right.length !== labels.length) {
      console.log(`!! ${file} row ${i} cluster «${labels.join('')}»: ${right.length} glyphs, expected ${labels.length}`)
      return
    }
    const group = g.groupMetrics(right)
    right.forEach((c, j) => samples.push({ label: labels[j], font: 'date', file, ...featuresOfApp(c, group) }))
  })
}
await worker.terminate()

const byClass = new Map()
for (const s of samples) byClass.set(s.label, (byClass.get(s.label) ?? 0) + 1)
console.log(`\namount rows fully segmented: ${rowsUsable}/${rowsSeen}`)
console.log(`glyphs harvested: ${samples.length}`)
console.log('\nclass  n   (a = amount font, d = date font)')
for (const label of [...'0123456789', '-', '+', '.', ',', '/', ':', 'م', 'ص']) {
  const a = samples.filter((s) => s.label === label && s.font === 'amount').length
  const d = samples.filter((s) => s.label === label && s.font === 'date').length
  const flag = a + d === 0 ? '   NEVER SEEN' : a + d < 3 ? '   thin' : ''
  console.log(`  ${label}   ${String(a + d).padStart(3)}   a=${String(a).padStart(2)} d=${String(d).padStart(2)}${flag}`)
}

const out = join(fixtures, 'glyphs.json')
writeFileSync(out, JSON.stringify({ gw: GW, gh: GH, samples }))
console.log(`\nwritten: ${out}`)
