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
 * the only real failure: the exit code is 1 if any field on any row reads wrongly.
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
      ['-1,155.65', '18:33', '2026-08-03'], ['-416', '18:29', '2026-08-03'],
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

for (const [file, truth] of Object.entries(TRUTH)) {
  const img = await loadImage(join(fixtures, file))
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const { data: px } = ctx.getImageData(0, 0, img.width, img.height)

  const { data } = await worker.recognize(join(fixtures, file), {}, { text: true, blocks: true })
  const lines = linesOf(data)
  const text = data.text ?? ''
  const anchors = anchorsIn(lines)
  const mask = g.maskFromPixels(px, img.width, img.height)

  // ── readOrders' decision, replicated: text first, coherence-gated; glyph otherwise ─────────
  const parsed = ocr.parseOrders(text, YEAR)
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
      band.getContext('2d').drawImage(img, 0, -a.y1)
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
      const fee = g.readGlyphRow(mask, ocr.amountBoxFor(a, img.height), templates)
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
const wrong = Object.values(tally).reduce((n, t) => n + t.wrong, 0)
if (wrong > 0) {
  console.log(`\n${wrong} FIELD(S) READ WRONGLY — the reader may not ship like this.`)
  process.exit(1)
}
console.log('\nNo field was read wrongly.')
