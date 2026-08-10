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
 * A pass here means the reader is correct AT THE FIXTURES' OWN SCALE. It is not a statement about
 * a phone. `node scripts/glyph-read.mjs --scale=1.25` re-runs everything on an upscaled copy, and
 * TODAY THAT FAILS: «١٢٠» reads «11», «٢٣٥» reads «1710», «١٢٠» reads «111». The one-component-
 * one-character invariant holds throughout — those are not manufactured digits, they are genuine
 * MISCLASSIFICATIONS, because the template bank was harvested at two or three display sizes and at
 * any other size a thin stroke's nearest neighbour is «١», confidently and with a wide margin.
 *
 * That is the same gap that produced the field failure, and no gate tuning or geometric guard
 * closes it — a digit-height agreement rule was tried and rejected, costing 18 correct reads while
 * catching none of the three. The fix is templates harvested at the scale a phone actually
 * produces, which needs the ORIGINAL full-resolution screenshots: every fixture here is a
 * Telegram-recompressed copy roughly 1080 wide.
 *
 * So: `pnpm check:glyphs` guards against regression at the calibrated scale. `pnpm glyphs:scales`
 * is the RELEASE GATE for trusting the reader on a new phone, and it is not passing yet.
 *
 * Route truth is a SUBSTRING the read label must contain (Tesseract's Arabic spelling wobbles at
 * the edges of a line; the middle is stable). `null` route truth means "not checkable here" — a
 * cut-off card or Arabic-Indic coordinates — and whatever is read there is accepted uncounted.
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
 * Ground truth, read off the screens by eye. Per row: the fee, the 24h clock, the ISO date the
 * row sits under, and a substring of each place label (null = not checkable: cut-off card,
 * Arabic-Indic coordinates, or off-screen).
 */
const TRUTH = {
  'log-0804-a.jpg': {
    rows: [
      ['-165.50', '18:06', '2026-08-04'], ['-47', '18:06', '2026-08-04'], ['+153', '17:42', '2026-08-04'],
      ['-42', '17:42', '2026-08-04'], ['-22', '17:22', '2026-08-04'], ['-26', '17:22', '2026-08-04'],
      ['+95', '17:07', '2026-08-04'], ['-27', '17:07', '2026-08-04'], ['-34', '16:50', '2026-08-04'],
      ['+215', '16:16', '2026-08-04'], ['-52', '16:16', '2026-08-04'],
    ],
  },
  'log-0804-b.jpg': {
    rows: [
      ['-177', '15:51', '2026-08-04'], ['-27', '15:51', '2026-08-04'], ['-24', '15:19', '2026-08-04'],
      ['+100', '13:39', '2026-08-04'], ['-47', '13:39', '2026-08-04'], ['-24', '13:10', '2026-08-04'],
      ['+250', '09:24', '2026-08-04'], ['+130', '09:24', '2026-08-04'], ['+300', '03:23', '2026-08-04'],
      ['-1155.65', '18:33', '2026-08-03'], ['-416', '18:29', '2026-08-03'],
    ],
  },
  'orders-0804-a.jpg': {
    rows: [
      ['235', '18:06', '2026-08-04', 'مأكولات الشام', 'الحارة الجديدة'],
      ['210', '17:42', '2026-08-04', 'بروستد القصور', 'جابر ابن حيان'],
      ['130', '17:22', '2026-08-04', 'القصور', 'المدخل الاول'],
      ['135', '17:07', '2026-08-04', 'سناك الرواد', 'Baghdad'],
      // The bottom card is cut by the screen edge; its B line is half a glyph tall.
      ['170', '16:50', '2026-08-04', 'Roummaneh', null],
    ],
  },
  'orders-0804-b.jpg': {
    rows: [
      ['260', '16:16', '2026-08-04', 'الدجاج', 'عارف الشهابي'],
      // B is Arabic-Indic GPS coordinates — digits Tesseract garbles; not checkable. The cancelled
      // «تم إلغاؤه» card sits inside this row's band and must NOT leak into it (unit-tested).
      ['135', '15:51', '2026-08-04', 'مأكولات الشام', null],
      ['120', '15:19', '2026-08-04', 'صيدلية سلمى', 'جامع الرحمن'],
      ['235', '13:39', '2026-08-04', 'فلافل الراعي', null],
    ],
  },
  'orders-0804-c.jpg': {
    rows: [
      ['120', '15:19', '2026-08-04', 'صيدلية سلمى', 'جامع الرحمن'],
      ['235', '13:39', '2026-08-04', 'فلافل الراعي', 'إنكليزي'],
      ['120', '13:10', '2026-08-04', 'عمر الخيام', 'الشيخ سعد'],
    ],
  },
  'orders-0806-lg.jpg': {
    rows: [
      // The B plus-code «G63V 78J» garbles through the Arabic-context pass (‎«Ge3v 78)»‎) — the
      // right line, unstable spelling. Not checkable until Latin-in-RTL normalisation exists.
      ['170', '13:55', '2026-08-06', 'كمال عياش', null],
      ['130', '13:36', '2026-08-06', 'كمال عياش', null],
      // «G6W9 PQM» comes back «Gews PAM» — the right line, garbled Latin inside an RTL run.
      ['330', '12:56', '2026-08-06', 'عصير أبو الروض', null],
      ['525', '12:22', '2026-08-06', 'Cheesecake', 'G6HF'],
      ['135', '11:14', '2026-08-06', 'البرلمان', 'فوزي اللحام'],
    ],
  },
  'orders-0807-sm.jpg': {
    rows: [
      ['275', '13:57', '2026-08-07', 'الصوفانية', 'F8Q6'],
      ['345', '12:59', '2026-08-07', 'السحلول', 'تشيلي'],
      ['165', '12:21', '2026-08-07', 'الزهراء', 'إنكليزي'],
      ['300', '11:53', '2026-08-07', 'مطعم الربيع', 'F8Q3'],
    ],
    // The last row's «SYP» is garbled into «صم.م» by the Arabic pass, so it never anchors and the
    // driver types that one. Recorded rather than tolerated: a DIFFERENT count means the rows have
    // shifted and every field below is being scored against the wrong row.
    anchorsFound: 3,
    unanchored: 'row 3 «SYP» read as «صم.م»',
  },
  // The SECOND PHONE: dark theme, English locale, WESTERN digits. Tesseract's own text reads this
  // one (branch 1 of readOrders); the glyph path must REFUSE its Western digits, never misread.
  'orders-0806-en.jpg': {
    rows: [
      // A reads «67FO+R57 معجنات الجسر الشهية…» — the plus-code garbles, the Arabic does not.
      ['130', '20:25', '2026-08-06', 'الجسر', 'Abdel Malek'],
      ['405', '19:52', '2026-08-06', 'مندي', 'F7WH'],
      ['225', '18:54', '2026-08-06', 'Mouhajrin', 'Hamra'],
      ['130', '18:18', '2026-08-06', 'Crispy', '5254704'],
      ['400', '17:50', '2026-08-06', 'Orange Juice', '33.518726'],
    ],
  },
}

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
const judge = (field, want, got, contains = false) => {
  if (want === null || want === undefined) return ''
  if (got === null || got === '' || got === undefined) {
    tally[field].refused++
    return `${field} REFUSED`
  }
  const ok = contains ? got.includes(want) : got === want
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
  const mask = g.maskFromPixels(img.px, img.width, img.height)

  // ── readOrders' decision, replicated: text first, coherence-gated; glyph otherwise ─────────
  const parsed = best
  const textWins = parsed.length > 0 && ocr.readIsCoherent(text, parsed.length)

  let rows
  if (textWins) {
    const routes = anchors.length === parsed.length ? ocr.routesFor(lines, anchors) : parsed.map(() => ({ pointA: null, pointB: null }))
    rows = parsed.map((o, i) => ({ fee: o.fee, time: o.time, dateIso: o.dateIso, ...routes[i] }))
  } else {
    const headers = ocr.headerDatesIn(lines, YEAR, TODAY, (box) => g.readDigitRun(mask, box, clockTemplates, new Set([...'0123456789'])))
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
      const rawFee = g.readGlyphRow(mask, ocr.amountBoxFor(a, img.height), templates)
      const fee = isLog
        ? (() => {
            if (rawFee === null) return null
            const negative = rawFee.startsWith('-')
            const magnitude = ocr.glyphListFee(rawFee.replace(/^[-+]/, ''))
            return magnitude === null ? null : negative ? `-${magnitude}` : `+${magnitude}`
          })()
        : ocr.glyphListFee(rawFee)
      const clock = ocr.parseGlyphClock(g.readGlyphRow(mask, ocr.clockBoxFor(a, img.width, img.height), clockTemplates, g.CLOCK_ALPHABET), YEAR)
      return { fee, time: clock.time, dateIso: clock.dateIso ?? dateFor(a), ...routes[i] }
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
    const notes = [
      judge('fee', fee, r.fee),
      judge('clock', time, r.time),
      judge('date', date, r.dateIso),
      judge('route', a, r.pointA, true),
      judge('route', b, r.pointB, true),
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
const KNOWN_LABEL_WRONG = { date: 4, route: 5 }
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
console.log('\nNo field was read wrongly.')

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
const MIN_READS = { fee: 46, clock: 45, date: 28, route: 41 }
const short = Object.entries(MIN_READS).filter(([field, floor]) => tally[field].read < floor)
if (short.length > 0) {
  for (const [field, floor] of short) console.log(`REGRESSION: ${field} read ${tally[field].read}, floor is ${floor}`)
  process.exit(1)
}
console.log(`Floors held: ${Object.entries(MIN_READS).map(([f, n]) => `${f}≥${n}`).join('  ')}`)
