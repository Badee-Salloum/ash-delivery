#!/usr/bin/env node
/**
 * Cut the amounts on the Yallago screenshots into labelled GLYPHS, and measure how well they can be
 * told apart by shape and size.
 *
 *   node scripts/glyph-lab.mjs            # coverage + leave-one-out accuracy
 *
 * WHY THIS EXISTS. Tesseract cannot read Arabic-Indic digits. Not the model we ship
 * (`tessdata_fast`), not the standard one, not `script/Arabic`, and `tessdata_best` will not run in
 * tesseract.js at all — its float kernels are missing from the WASM core. Every page-segmentation
 * mode, every preprocessing variant, an isolated amount column at 4x and a single amount at 5x were
 * tried. «٤٧» comes back «tv», «٥٢» comes back «oY», and — fatally — «٢» and «٣» BOTH come back «Y»
 * while «١» and «٦» both come back «\». No table recovers −26 from −36. See scripts/ocr-calibrate.mjs.
 *
 * WHAT WORKS INSTEAD. Tesseract finds «SYP» perfectly — 11 of 11 rows, every pass, because it is
 * plain ASCII. So it is used for LAYOUT only: «SYP» anchors the row, gives the font size for free
 * (its own cap height), and the amount is the run of ink immediately to its left. Those glyphs are
 * then segmented as connected components and classified against templates. On the sample day that
 * segmentation is exact on 16 of 16 rows — including «−١٦٥٫٥٠», which splits into all seven pieces.
 *
 * WHAT THIS SCRIPT IS FOR. Templates must be learnt from real screenshots, and one day of one
 * phone is not enough to trust with money. Point this at every new sample: it reports which digits
 * are still unseen and how well the ones it has separate. `٨` in particular never appears in an
 * amount on 4 August — it exists only in the date «٠٨/٠٤», in a smaller font.
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const driver = join(root, 'apps', 'driver')
const fixtures = join(driver, 'test', 'fixtures', 'ocr')
const from = (s) => import(pathToFileURL(createRequire(join(driver, 'package.json')).resolve(s)).href)
const { createCanvas, loadImage } = await from('@napi-rs/canvas')
const { createWorker, OEM } = await from('tesseract.js')

/**
 * The amounts on each screenshot, top to bottom, read off the screen by eye — glyph i of a row is
 * character i of its amount, which labels every sample without anyone boxing anything by hand.
 *
 * Write them EXACTLY as drawn, including the thousands mark: «−١٬١٥٥٫٦٥» is `-1,155.65`, nine
 * glyphs. Getting that wrong shows up immediately as a glyph-count mismatch.
 */
const TRUTH = {
  'log-0804-a.jpg': ['-165.50', '-47', '+153', '-42', '-22', '-26', '+95', '-27', '-34', '+215', '-52'],
  'log-0804-b.jpg': ['-177', '-27', '-24', '+100', '-47', '-24', '+250', '+130', '+300', '-1,155.65', '-416'],
  'orders-0804-a.jpg': ['235', '210', '130', '135', '170'],
  'orders-0804-b.jpg': ['260', '135', '120', '235'],
  'orders-0804-c.jpg': ['120', '235', '120'],
}

/** Every character a Yallago amount can be made of. Anything unseen here cannot yet be read. */
const ALPHABET = [...'0123456789', '-', '+', '.', ',']

const GW = 12
const GH = 16
/** Ink threshold. The screens are dark text on white; anything clearly darker than the page. */
const INK = 170
/** Components smaller than this are speckle, not glyphs — but «٠» is a 3x3 dot, so it stays low. */
const MIN_PIXELS = 5

/** Connected components (8-neighbour) inside a box of the greyscale image, ordered left to right. */
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
 * A glyph as the classifier sees it: its shape stretched into a fixed grid (scale-free), plus its
 * size and its height on the line measured against the «SYP» cap height of the SAME row.
 *
 * The size features are not decoration. Normalised to a grid, «٠» (a dot) and «−» (a dash) are both
 * a solid rectangle and indistinguishable; what separates them is that one is 0.19 of the cap
 * height tall and the other 0.13, and one sits mid-line while the other is a fifth of it wide.
 */
function featuresOf(c, unit, bandTop, anchorTop) {
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
  return { bits, relW: gw / unit, relH: gh / unit, relTop: (bandTop + c.minY - anchorTop) / unit }
}

const worker = await createWorker(['eng'], OEM.LSTM_ONLY, { langPath: join(driver, 'public', 'tesseract'), gzip: true })
await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' })

/** Every amount row on one screenshot: its glyphs, in reading order. */
async function rowsOf(file) {
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

  return words
    .filter((w) => /SYP/i.test(w.text))
    .sort((a, b) => a.y0 - b.y0)
    .map((a) => {
      const unit = a.y1 - a.y0
      const pad = Math.round(unit * 0.45)
      const bandTop = Math.max(0, a.y0 - pad)
      const box = [Math.max(0, a.x0 - Math.round(unit * 12)), bandTop, a.x0 - 4, Math.min(img.height, a.y1 + pad)]
      return componentsIn(grey, ...box).map((c) => featuresOf(c, unit, bandTop, a.y0))
    })
}

// ── Collect ────────────────────────────────────────────────────────────────────────────────
const present = new Set(readdirSync(fixtures))
const byClass = new Map()
let rowsSeen = 0
let rowsUsable = 0

for (const [file, truth] of Object.entries(TRUTH)) {
  if (!present.has(file)) continue
  const rows = await rowsOf(file)
  if (rows.length !== truth.length) console.log(`!! ${file}: ${rows.length} «SYP» rows, ${truth.length} expected`)
  rows.forEach((glyphs, i) => {
    rowsSeen++
    const want = [...(truth[i] ?? '')]
    if (glyphs.length !== want.length) {
      console.log(`!! ${file} row ${i} «${truth[i]}»: segmented ${glyphs.length} glyphs, expected ${want.length}`)
      return
    }
    rowsUsable++
    want.forEach((ch, j) => {
      if (!byClass.has(ch)) byClass.set(ch, [])
      byClass.get(ch).push(glyphs[j])
    })
  })
}
await worker.terminate()

console.log(`\nsegmentation: ${rowsUsable}/${rowsSeen} rows split into exactly the glyphs their amount has`)

// ── Coverage ───────────────────────────────────────────────────────────────────────────────
console.log('\nclass  n   relW         relH         relTop')
const range = (samples, f) => {
  const v = samples.map(f)
  return `${Math.min(...v).toFixed(2)}-${Math.max(...v).toFixed(2)}`
}
for (const ch of ALPHABET) {
  const s = byClass.get(ch)
  if (!s) {
    console.log(`  ${ch}    -   NEVER SEEN — no amount in the samples contains it`)
    continue
  }
  console.log(
    `  ${ch}   ${String(s.length).padStart(2)}   ${range(s, (g) => g.relW).padEnd(12)} ${range(s, (g) => g.relH).padEnd(12)} ${range(s, (g) => g.relTop)}`,
  )
}

// ── Leave-one-out ──────────────────────────────────────────────────────────────────────────
// Honest accuracy: every sample is classified against templates built WITHOUT it. A template
// averaged over its own test sample flatters itself, and flattery here ends in a wrong fee.
const W_SHAPE = 1
const W_H = 0.8
// Width carries as much as height, and for one pair it carries everything: stretched into a grid,
// «٠» and «−» are both a solid block and their shapes are identical. What tells a dot from a dash
// is that one is a fifth of the cap height wide and the other two thirds. Under-weighting it read
// a zero as a minus sign — which is not a misread digit, it is a sign flip on somebody's money.
const W_W = 1
const W_TOP = 0.8

function templateOf(samples) {
  const acc = new Float64Array(GW * GH)
  for (const s of samples) for (let i = 0; i < acc.length; i++) acc[i] += s.bits[i]
  const mean = (f) => samples.reduce((t, x) => t + f(x), 0) / samples.length
  return {
    bits: Uint8Array.from(acc, (v) => (v / samples.length > 0.5 ? 1 : 0)),
    relW: mean((g) => g.relW),
    relH: mean((g) => g.relH),
    relTop: mean((g) => g.relTop),
  }
}

function distance(t, g) {
  let differing = 0
  for (let i = 0; i < t.bits.length; i++) if (t.bits[i] !== g.bits[i]) differing++
  return (
    (differing / (GW * GH)) * W_SHAPE +
    Math.abs(t.relH - g.relH) * W_H +
    Math.abs(t.relW - g.relW) * W_W +
    Math.abs(t.relTop - g.relTop) * W_TOP
  )
}

let correct = 0
let total = 0
let worstRight = 0
let bestWrong = Infinity
for (const [ch, samples] of byClass) {
  samples.forEach((held, k) => {
    const rest = samples.filter((_, i) => i !== k)
    if (rest.length === 0) return // a class with one sample cannot be tested against itself
    total++
    let best = null
    for (const [c, s] of byClass) {
      const pool = c === ch ? rest : s
      const d = distance(templateOf(pool), held)
      if (!best || d < best.d) best = { c, d }
    }
    if (best.c === ch) {
      correct++
      worstRight = Math.max(worstRight, best.d)
    } else {
      bestWrong = Math.min(bestWrong, best.d)
      console.log(`  MISREAD «${ch}» as «${best.c}» (distance ${best.d.toFixed(3)})`)
    }
  })
}

console.log(`\nleave-one-out: ${correct}/${total} correct`)
if (correct === total) {
  console.log(`  worst correct match scored ${worstRight.toFixed(3)} — a refusal threshold sits above that`)
}
const unseen = ALPHABET.filter((c) => !byClass.has(c))
const thin = ALPHABET.filter((c) => (byClass.get(c)?.length ?? 0) === 1)
if (unseen.length > 0) console.log(`\nNEVER SEEN: ${unseen.join(' ')} — these cannot be read until a screenshot contains them`)
if (thin.length > 0) console.log(`ONE SAMPLE ONLY: ${thin.join(' ')} — too thin to trust with money`)
