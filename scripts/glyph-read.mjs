#!/usr/bin/env node
/**
 * The WHOLE reader, end to end, against the real screenshots — every field it produces.
 *
 *   node scripts/glyph-read.mjs
 *
 * This replicates `readOrders`' decision exactly, through the APP'S OWN functions (imported from
 * apps/driver/src): Tesseract-text-first where the build prints Western digits, the glyph reader
 * where it prints Arabic-Indic — and it measures all four fields of every row: the FEE, the CLOCK,
 * the DATE and the ROUTE. Amounts alone was how a broken clock shipped without a number moving.
 *
 * A refused field is a SUCCESS of a different kind — the driver types that one. A WRONG field is
 * the only real failure: the exit code is 1 if any MONEY field reads wrongly, and label wrongs are
 * held at a ratchet (see the bottom of this file).
 *
 * ── READ THIS BEFORE TRUSTING A GREEN RUN ────────────────────────────────────────────────────
 *
 * A pass here means the reader is correct AT THE FIXTURES' OWN SCALE. It is not a statement about a
 * phone, and the difference is measurable: Tesseract reports the «SYP» cap height as 17–23 px on
 * every fixture the templates were harvested from, and 32 px on a real 1080×2400 screenshot. The
 * bank has never seen ink at that density. Scale-free FEATURES do not save it, because segmentation
 * runs first and segmentation is pixel-density work — which is why `canonFactorFor` now resamples
 * out-of-band screenshots down into the learnt band before any glyph is cut out.
 *
 * `--scale N` re-runs everything on a resampled copy, and IT STILL FAILS. Read that carefully
 * before believing it: at 1.25× the failing file's cap height is ~22, INSIDE the learnt band, so no
 * normalisation happens and the ink is simply blurrier than any real screenshot — an upscaled
 * compressed JPEG is soft in a way a native capture never is. The sweep therefore measures BLUR as
 * much as SIZE, and is a pessimistic proxy, not a verdict on the phone.
 *
 * What it does prove is that the reader has no margin against degraded ink, and that is real. The
 * honest gate remains an original full-resolution Arabic screenshot, which no fixture here is:
 * every one arrived through a chat app's photo compression at roughly 562–720 px wide. Until one
 * exists, `pnpm check:glyphs` guards the calibrated scale and nothing here licenses the sentence
 * "the reader is correct on a phone".
 *
 * Route truth is a SUBSTRING the read label must contain (Tesseract's Arabic spelling wobbles at
 * the edges of a line; the middle is stable). `null` route truth means "not checkable here" — a
 * cut-off card or Arabic-Indic coordinates — and whatever is read there is accepted uncounted.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TRUTH as SHARED_TRUTH } from './ocr-truth.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const driver = join(root, 'apps', 'driver')
const fixtures = join(driver, 'test', 'fixtures', 'ocr')
const from = (s) => import(pathToFileURL(createRequire(join(driver, 'package.json')).resolve(s)).href)
const { createCanvas, loadImage } = await from('@napi-rs/canvas')
const { createWorker, OEM } = await from('tesseract.js')
const g = await import(pathToFileURL(join(driver, 'src', 'glyphs.ts')).href)
const ocr = await import(pathToFileURL(join(driver, 'src', 'ocr.ts')).href)
const { GLYPH_TEMPLATES, CLOCK_TEMPLATES } = await import(pathToFileURL(join(driver, 'src', 'glyph-templates.ts')).href)

const templates = g.unpackTemplates(GLYPH_TEMPLATES)
const clockTemplates = g.unpackTemplates(CLOCK_TEMPLATES)
const YEAR = 2026
const TODAY = new Date('2026-08-08T12:00:00')

/**
 * `--scale N` re-samples every fixture before reading it.
 *
 * The committed fixtures are Telegram-compressed copies, roughly 1080 wide. A phone scans the
 * ORIGINAL, which is larger and sharper, and larger ink segments differently: strokes that merge at
 * one scale separate at another, and a glyph the templates have never seen at that size refuses —
 * or, before this work, was split into digits nobody ever printed. Upscaling a fixture is not the
 * same as having the original, but it does exercise the ≥2000px downscale path and a font size the
 * template bank was not harvested at, which is where «1105» came from.
 *
 * The floors apply at 1× only; at every other scale the bar is simply ZERO WRONG. Refusing more at
 * an unfamiliar size is correct behaviour — the driver types those.
 */
const SCALE = Number(process.argv.find((a) => a.startsWith('--scale='))?.slice(8) ?? '1')
if (!Number.isFinite(SCALE) || SCALE <= 0) {
  console.error(`--scale must be a positive number, got «${SCALE}»`)
  process.exit(2)
}

/**
 * Ground truth now lives in `ocr-truth.mjs`, because a second harness scores PAID OCR providers
 * against the very same screens. Two copies of the answer key is how a benchmark quietly starts
 * grading two different exams.
 */
const TRUTH = SHARED_TRUTH

const worker = await createWorker(['eng', 'ara'], OEM.LSTM_ONLY, { langPath: join(driver, 'public', 'tesseract'), gzip: true })
await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' })

/** tesseract.js blocks → the OcrLine shape ocr.ts works on. */
function linesOf(data) {
  const out = []
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs ?? [])
      for (const l of p.lines ?? [])
        out.push({
          text: l.text ?? '',
          y0: l.bbox?.y0 ?? 0,
          y1: l.bbox?.y1 ?? 0,
          words: (l.words ?? []).map((w) => ({
            text: w.text ?? '',
            x0: w.bbox?.x0 ?? 0,
            x1: w.bbox?.x1 ?? 0,
            y0: w.bbox?.y0 ?? l.bbox?.y0 ?? 0,
            y1: w.bbox?.y1 ?? l.bbox?.y1 ?? 0,
          })),
        })
  return out
}

const anchorsIn = ocr.anchorsIn

const tally = { fee: { read: 0, refused: 0, wrong: 0 }, clock: { read: 0, refused: 0, wrong: 0 }, date: { read: 0, refused: 0, wrong: 0 }, route: { read: 0, refused: 0, wrong: 0 } }
/**
 * Arabic spelling that differs only in orthography is the SAME WORD.
 *
 * «إنكليزى» and «إنكليزي» differ by one letter — alef maqsura for ya — and Yallago's own screen is
 * not consistent about it either. Scoring that as a wrong route says the reader failed when it read
 * the word correctly, which buries the failures that are real. Mirrors the reader's own `foldAr`.
 */
const foldAr = (t) =>
  t
    .replace(/[ً-ْـ‎‏]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()

const judge = (field, want, got, contains = false) => {
  if (want === null || want === undefined) return ''
  if (got === null || got === '' || got === undefined) {
    tally[field].refused++
    return `${field} REFUSED`
  }
  const ok = contains ? foldAr(got).includes(foldAr(want)) : got === want
  if (ok) {
    tally[field].read++
    return ''
  }
  tally[field].wrong++
  return `${field} WRONG «${got}»`
}

/**
 * The APP'S OWN preparation, applied to a fixture — greyscale + 5–95% contrast stretch, downscaled
 * only past the cap, never upscaled.
 *
 * Until this existed the harness read RAW fixture pixels and handed Tesseract the raw file, while
 * `prepareWithPixels` gave the app something else entirely. So the harness could report zero wrong
 * on the exact screenshots whose originals misread on a phone, and both numbers were honest: they
 * were measurements of different images. A calibration harness that does not measure the app's
 * input is measuring nothing.
 *
 * `scale` re-samples first, which is how a ~1080-wide fixture is made to exercise the ≥2000px path
 * a full-resolution phone screenshot takes.
 */
async function prepared(file, scale = 1, invert = false) {
  const img = await loadImage(join(fixtures, file))
  const wanted = { w: Math.round(img.width * scale), h: Math.round(img.height * scale) }
  const longest = Math.max(wanted.w, wanted.h)
  const cap = ocr.OCR_MAX_DIMENSION ?? 2000
  const shrink = longest > cap ? cap / longest : 1
  const width = Math.max(1, Math.round(wanted.w * shrink))
  const height = Math.max(1, Math.round(wanted.h * shrink))

  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, width, height)

  // EXPERIMENT: mask from PRE-stretch pixels of the same (downscaled) canvas.
  const raw = ctx.getImageData(0, 0, width, height).data
  const image = ctx.getImageData(0, 0, width, height)
  // NO CONTRAST STRETCH — mirroring what the Yallago list readers now ask for.
  // The stretch arrived with the BMS work, for white-on-orange battery cards, and the order and
  // payments-log readers inherited it by sharing one prepare function. On these eight fixtures it
  // costs FOURTEEN fee reads and causes THREE wrong ones, by degrading Tesseract's anchoring on an
  // already high-contrast phone screenshot.  restores it for comparison.
  if (process.env.STRETCH === '1' && ocr.stretchContrast(image.data, width, height, invert)) ctx.putImageData(image, 0, 0)
  // Tesseract must see the SAME pixels the mask is built from — it reports word boxes in the
  // coordinates of whatever it was given, so reading ink from one image and locating «SYP» in
  // another lands the fee of one row beside the clock of the next.
  return { px: ctx.getImageData(0, 0, width, height).data, raw, width, height, canvas, buffer: canvas.toBuffer('image/png') }
}

for (const [file, truth] of Object.entries(TRUTH)) {
  const isLog = file.startsWith('log-')
  // `readOrders` runs the TEXT pass twice — normal, then inverted — and keeps whichever parsed more
  // rows, breaking early when the first succeeds. The dark-theme English screenshot is read by the
  // second pass, so a harness that only ever tried the first scored its own omission as the
  // reader's error. Replicated here rather than approximated.
  let best = []
  let img = null
  let data = null
  let text = ''
  for (const invert of [false, true]) {
    const attempt = await prepared(file, SCALE, invert)
    const { data: pass } = await worker.recognize(attempt.buffer, {}, { text: true, blocks: true })
    if ((pass.text ?? '').length > text.length) text = pass.text ?? ''
    const orders = ocr.parseOrders(pass.text ?? '', YEAR)
    if (img === null || orders.length > best.length) {
      best = orders
      img = attempt
      data = pass
    }
    if (best.length > 0 && !invert) break
  }

  const lines = linesOf(data)
  const anchors = anchorsIn(lines)
  // The same scale normalisation readAmountsByGlyph performs: bring the pixels to the cap height
  // the templates were learnt at, and scale every box by the same ratio. Without this the harness
  // would once again be measuring a reader that does not ship.
  const capHeights = anchors.map((a) => a.y1 - a.y0).sort((x, y) => x - y)
  const capHeight = capHeights[Math.floor(capHeights.length / 2)] ?? g.CANON_CAP_HEIGHT
  const factor = g.canonFactorFor(capHeight)
  const rescale = factor !== 1
  const canon = rescale ? g.resampleRgba(img.px, img.width, img.height, factor) : { data: img.px, width: img.width, height: img.height }
  const scaleBox = (a) => (rescale ? { ...a, x0: Math.round(a.x0 * factor), x1: Math.round(a.x1 * factor), y0: Math.round(a.y0 * factor), y1: Math.round(a.y1 * factor) } : a)
  const mask = g.maskFromPixels(canon.data, canon.width, canon.height)
  // Which cards the bottom of the screen sliced in half. The app WITHHOLDS these — their places
  // are half-rendered and read as something confident and wrong — so the harness has to know
  // which they are, or it scores a route no driver is ever shown and calls the result green.
  const cutOff = ocr.truncatedCards(lines, anchors, img.height)

  // ── readOrders' decision, replicated: text first, coherence-gated; glyph otherwise ─────────
  const parsed = best
  const textWins = parsed.length > 0 && ocr.readIsCoherent(text, parsed.length)

  let rows
  if (textWins) {
    // Routes and cut-off flags are anchor-indexed; they only line up with the parsed rows when
    // the two counts agree. When they do not, the page keeps its fees and goes without routes
    // rather than pinning one card's places to another card.
    const aligned = anchors.length === parsed.length
    const routes = aligned ? ocr.routesFor(lines, anchors) : parsed.map(() => ({ pointA: null, pointB: null }))
    rows = parsed.map((o, i) => ({ fee: o.fee, time: o.time, dateIso: o.dateIso, ...routes[i], cutOff: aligned && cutOff[i] === true }))
  } else {
    const headers = ocr.headerDatesIn(lines, YEAR, TODAY, (box) => g.readDigitRun(mask, scaleBox(box), clockTemplates, new Set([...'0123456789'])))
    const dateFor = (a) => {
      let seen = null
      for (const h of headers) if (h.y0 < a.y0 && h.dateIso !== null) seen = h.dateIso
      return seen
    }
    const routes = ocr.routesFor(lines, anchors)

    // The SECOND LOOK, mirroring `readAmountsByGlyph`: a card whose dropoff line the full-page
    // pass never emitted is re-read on its own, where the layout analyser copes. Measured here
    // because an unmeasured recovery path is one that quietly stops working.
    let retries = 0
    for (const [i, route] of routes.entries()) {
      if (retries >= 3 || route.pointB !== null) continue
      const a = anchors[i]
      const unit = Math.max(1, a.y1 - a.y0)
      const bottom = anchors[i + 1]?.y0 ?? Math.min(img.height, a.y1 + Math.round(unit * 9))
      if (bottom - a.y1 < unit * 3) continue
      retries++
      const band = createCanvas(img.width, bottom - a.y1)
      band.getContext('2d').drawImage(img.canvas, 0, -a.y1)
      // «psm 4» — one column of text at varying sizes, which is what a single card is. Without
      // the switch the band is re-read as a uniform block (psm 6) and yields the same one line.
      await worker.setParameters({ tessedit_pageseg_mode: '4' })
      const { data: again } = await worker.recognize(band.toBuffer('image/png'), {}, { text: true, blocks: true })
      await worker.setParameters({ tessedit_pageseg_mode: '6' })
      const shifted = linesOf(again).map((l) => ({
        ...l,
        y0: l.y0 + a.y1,
        y1: l.y1 + a.y1,
        words: l.words.map((w) => ({ ...w, y0: w.y0 + a.y1, y1: w.y1 + a.y1 })),
      }))
      const [recovered] = ocr.routesFor(shifted, [a])
      if (recovered?.pointB) {
        routes[i] = { pointA: route.pointA ?? recovered.pointA, pointB: recovered.pointB }
        console.log(`  (recovered row ${i} dropoff on a second pass)`)
      }
    }

    rows = anchors.map((a, i) => {
      // Orders and the payments LOG validate a glyph fee differently, and the app is the authority:
      // `readOrders` refuses a signed value outright (an order fee is never negative), while
      // `readPaymentsLog` splits the sign off and validates the magnitude. Using the orders rule on a
      // log row refuses every «-165.50» on the page — which is a bug in the measurement, not the reader.
      const rawFee = g.readGlyphRow(mask, ocr.amountBoxFor(scaleBox(a), canon.height), templates)
      const fee = isLog
        ? (() => {
            if (rawFee === null) return null
            const negative = rawFee.startsWith('-')
            const magnitude = ocr.glyphListFee(rawFee.replace(/^[-+]/, ''))
            return magnitude === null ? null : negative ? `-${magnitude}` : `+${magnitude}`
          })()
        : ocr.glyphListFee(rawFee)
      const clock = ocr.parseGlyphClock(g.readGlyphRow(mask, ocr.clockBoxFor(scaleBox(a), canon.width, canon.height), clockTemplates, g.CLOCK_ALPHABET), YEAR)
      return { fee, time: clock.time, dateIso: clock.dateIso ?? dateFor(a), ...routes[i], cutOff: cutOff[i] === true }
    })
  }

  console.log(`\n=== ${file} — ${rows.length} rows (${textWins ? 'text' : 'glyph'} path)`)
  if (rows.length !== truth.rows.length) {
    // A row that does not ANCHOR is a row the driver types — the same refusal as an unreadable
    // fee, one level up. It is only safe to report it that way because the count is checked
    // against a written expectation: an EXTRA anchor, or a different shortfall than the one
    // recorded here, means the rows have shifted and every field is being compared to the wrong
    // row, which is the failure this guard exists to catch.
    if (truth.anchorsFound === rows.length) {
      console.log(`  ${truth.rows.length - rows.length} row(s) unanchored, as expected: ${truth.unanchored}`)
      tally.fee.refused += truth.rows.length - rows.length
      continue
    }
    console.log(`  !! ${truth.rows.length} rows on screen, ${rows.length} found — ROWS HAVE SHIFTED`)
    tally.fee.wrong++
    continue
  }
  rows.forEach((r, i) => {
    const [fee, time, date, a, b] = truth.rows[i]
    // A card the screen sliced in half is WITHHELD by the app, so its route is never shown to
    // anyone and must not be scored as though it were. Its fee and clock still are — those sit on
    // the fully-drawn price row, and the whole reason the card is withheld rather than deleted is
    // that they read correctly. The expectation is written per file, so a card that silently stops
    // being detected as cut-off shows up as a route wrong instead of passing quietly.
    const expectedCut = (truth.cutOff ?? []).includes(i)
    if (r.cutOff !== expectedCut) {
      console.log(`  row ${String(i).padStart(2)}  CUT-OFF MISMATCH — expected ${expectedCut}, got ${r.cutOff}`)
      tally.route.wrong++
    }
    const notes = [
      judge('fee', fee, r.fee),
      judge('clock', time, r.time),
      judge('date', date, r.dateIso),
      ...(r.cutOff ? [] : [judge('route', a, r.pointA, true), judge('route', b, r.pointB, true)]),
    ].filter((n) => n !== '')
    console.log(`  row ${String(i).padStart(2)}  ${fee.padEnd(9)} ${r.fee === fee ? 'ok' : (r.fee ?? '—')}  ${time} ${r.time === time ? 'ok' : (r.time || '—')}  ${notes.length > 0 ? notes.join(' · ') : ''}`)
  })
}
await worker.terminate()

console.log('\n           read  refused  WRONG')
for (const [field, t] of Object.entries(tally)) {
  console.log(`  ${field.padEnd(6)} ${String(t.read).padStart(5)} ${String(t.refused).padStart(8)} ${String(t.wrong).padStart(6)}`)
}
/**
 * MONEY MUST BE PERFECT. Labels are held at a ceiling that cannot silently rise.
 *
 * A wrong fee or clock is money: the fee IS the driver's pay and the clock is what pairs an order
 * to its wallet movement. Zero, always, no allowance.
 *
 * Dates and routes are measured but currently imperfect, and the honest thing is to say so rather
 * than to loosen the definition of "wrong" or to leave the whole script red until someone stops
 * running it. The remaining failures are Tesseract reading an ARABIC LABEL slightly differently
 * («فوزي اللحام» → «فوني للحام») and a day number on the dark-theme English screenshot whose printed
 * weekday it cannot read, so nothing can check it. Both need the ORIGINAL full-resolution
 * screenshots to settle — the committed fixtures are Telegram-recompressed copies.
 *
 * The ceiling is a ratchet: it may only ever be lowered. If a change makes labels worse this fails.
 */
// Ratchet, lowered as each is fixed — it may only ever fall. Route came down from 5: «ssl» and a
// coordinate pair are no longer printed as destinations, and «إنكليزى» is no longer scored wrong
// for spelling «إنكليزي» with an alef maqsura. The 3 that remain are genuine partial Arabic
// reads («شارع جابر ابن» for «جابر ابن حيان»), which need the original screenshots to improve.
const KNOWN_LABEL_WRONG = { date: 4, route: 3 }
const money = tally.fee.wrong + tally.clock.wrong
if (money > 0) {
  console.log(`\n${money} MONEY FIELD(S) READ WRONGLY — the reader may not ship like this.`)
  process.exit(1)
}
const worse = Object.entries(KNOWN_LABEL_WRONG).filter(([field, ceiling]) => tally[field].wrong > ceiling)
if (worse.length > 0) {
  for (const [field, ceiling] of worse) console.log(`REGRESSION: ${field} wrong ${tally[field].wrong}, ceiling is ${ceiling}`)
  process.exit(1)
}
const labels = tally.date.wrong + tally.route.wrong
console.log(`\nMoney: 0 wrong (fee, clock). Labels: ${labels} wrong — known, ceiling ${KNOWN_LABEL_WRONG.date + KNOWN_LABEL_WRONG.route}, needs the original screenshots.`)

/*
 * THE FLOOR. Zero-wrong was the only rule, and it is satisfied by a reader that refuses
 * everything: refusing is safe, and safe is not the same as useful. These are what the reader
 * achieves today, and a change that reads fewer has to say so out loud rather than pass quietly.
 *
 * Raise them when a change earns it. Lowering one is a decision, not a fix — write down why.
 */
// Re-baselined when the harness stopped measuring raw fixture pixels and started measuring what
// the app really reads. The old numbers (fee 44, clock 43, date 44, route 38) described an image
// no phone has ever produced. Fees and clocks are HIGHER now; dates are lower because a day
// number whose weekday cannot be read is refused rather than guessed.
// Route falls from 41 to 40 because two cards the screen slices in half are now WITHHELD rather
// than routed — their four route fields are no longer scored, and two genuine reads on the other
// cards replaced them. A lower number here is the reader offering less and being right more.
const MIN_READS = { fee: 46, clock: 45, date: 28, route: 40 }
const short = Object.entries(MIN_READS).filter(([field, floor]) => tally[field].read < floor)
if (short.length > 0) {
  for (const [field, floor] of short) console.log(`REGRESSION: ${field} read ${tally[field].read}, floor is ${floor}`)
  process.exit(1)
}
console.log(`Floors held: ${Object.entries(MIN_READS).map(([f, n]) => `${f}≥${n}`).join('  ')}`)
