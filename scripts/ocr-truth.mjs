/**
 * Ground truth for the OCR fixtures — ONE copy, shared by every harness that scores a reader.
 *
 * Read off the screens by eye. Per row: the fee, the 24h clock, the ISO date the row sits under, and
 * a substring of each place label (null = not checkable: cut-off card, Arabic-Indic coordinates, or
 * off-screen).
 *
 * It lives here rather than inside `glyph-read.mjs` because a second harness now scores PAID OCR
 * providers against the same screens (`ocr-bench.mjs`). Two copies of the answer key is how a
 * benchmark quietly starts grading two different exams.
 */
export const TRUTH = {
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
      // The bottom card is cut by the screen edge; its B line is half a glyph tall, so the app
      // WITHHOLDS the whole card and tells the driver to add it. Fee and clock still read.
      ['170', '16:50', '2026-08-04', null, null],
    ],
    cutOff: [4],
  },
  'orders-0804-b.jpg': {
    rows: [
      ['260', '16:16', '2026-08-04', 'الدجاج', 'عارف الشهابي'],
      // B is Arabic-Indic GPS coordinates — digits Tesseract garbles; not checkable. The cancelled
      // «تم إلغاؤه» card sits inside this row's band and must NOT leak into it (unit-tested).
      ['135', '15:51', '2026-08-04', 'مأكولات الشام', null],
      ['120', '15:19', '2026-08-04', 'صيدلية سلمى', 'جامع الرحمن'],
      // Also sliced by the screen edge — «إنكليزي» comes back «انكلنء». Withheld; the same order
      // appears whole on orders-0804-c.jpg, which is where it actually gets added from.
      ['235', '13:39', '2026-08-04', null, null],
    ],
    cutOff: [3],
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

/** Which fixtures print their amounts in ARABIC-INDIC digits — the thing Tesseract cannot read. */
export const ARABIC_INDIC_FIXTURES = new Set([
  'log-0804-a.jpg',
  'log-0804-b.jpg',
  'orders-0804-a.jpg',
  'orders-0804-b.jpg',
  'orders-0804-c.jpg',
  'orders-0806-lg.jpg',
  'orders-0807-sm.jpg',
])

/** Arabic-Indic → Western, plus the Arabic thousands «٬» and decimal «٫» marks. */
export function foldDigits(text) {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٬/g, ',')
    .replace(/٫/g, '.')
}

/** «−١٬١٥٥٫٦٥» → «-1155.65». Comparable to the TRUTH strings. */
export function normaliseAmount(raw) {
  const folded = foldDigits(String(raw))
    .replace(/[−–—]/g, '-')
    .replace(/[\s ]/g, '')
    .replace(/,/g, '')
  const m = folded.match(/[-+]?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  if (!Number.isFinite(n)) return null
  // Trailing «.00» and «.50» must survive: -165.50 and -165 are different money.
  return m[0].replace(/^\+?(-?)0*(\d)/, '$1$2')
}
