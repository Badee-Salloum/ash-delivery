/**
 * The CORPUS — «داتا التجريب», 48 screenshots, keyed by CONTENT HASH.
 *
 * Why a hash and not a filename: all 24 files in `apps/driver/test/fixtures/ocr/` are byte-identical
 * to 24 of these 48 images — that folder is where the fixtures were cut from. The same screen
 * therefore has two names (`log-0804-b.jpg` and `3/photo_1_2026-08-10_15-23-32.jpg`), and a
 * filename-keyed answer key would grade it twice, or grade it once and silently miss the other half
 * of the corpus. sha1 makes the two names one entry.
 *
 * This file DELIBERATELY does not modify `scripts/ocr-truth.mjs`. That module's `TRUTH` and
 * `normaliseAmount` are what `glyph-read.mjs` scores the shipped reader against inside
 * `pnpm check:glyphs`, with floors and a ratchet calibrated to exactly those 8 files. Adding keys
 * there would require the shipped reader to read 16 fixtures it has never been calibrated on, and
 * `pnpm check` would fail for reasons that have nothing to do with the reader getting worse.
 *
 * ── ON THE DATA ──────────────────────────────────────────────────────────────────────────────
 * These screenshots carry real customer addresses, named businesses and metre-level GPS. The owner
 * decided on 2026-08-13 to send them to Gemini's FREE tier, whose terms state that submitted content
 * is used to improve Google's products and that human reviewers may read it. Recorded here because
 * `ocr-bench.mjs:384` states the opposite principle («no customer address leaving the country») and
 * a future reader deserves to know the difference was a decision and not an oversight.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { TRUTH } from './ocr-truth.mjs'

/** Short sha1 — 12 hex chars. 48 images, all mutually distinct; collision risk is not a concern. */
export const shaOf = (bytes) => createHash('sha1').update(bytes).digest('hex').slice(0, 12)

/**
 * Every corpus image, hash → where it lives and which fixture it is.
 *
 * Generated once and committed rather than computed at import: it is an ASSERTION. A fixture that
 * silently changes bytes stops matching, and the loader says so instead of quietly grading a
 * different screen against the old answer key.
 */
export const INDEX = {
  'f410aa3f1d02': { corpus: '1/WhatsApp Image 2026-07-29 at 22.55.38 (1).jpeg', fixture: 'wallet-log-ar-2.jpeg' },
  'f8e16d053837': { corpus: '1/WhatsApp Image 2026-07-29 at 22.55.38 (2).jpeg', fixture: 'orders-ar-1.jpeg' },
  '43fbfbc8fb6d': { corpus: '1/WhatsApp Image 2026-07-29 at 22.55.38 (3).jpeg', fixture: 'orders-ar-2.jpeg' },
  '2e13abe792fb': { corpus: '1/WhatsApp Image 2026-07-29 at 22.55.38.jpeg', fixture: 'wallet-log-ar-1.jpeg' },
  '58aad5ae0afd': { corpus: '3/photo_1_2026-08-10_15-23-32.jpg', fixture: 'log-0804-b.jpg' },
  '1add42aacf81': { corpus: '3/photo_2_2026-08-10_15-23-32.jpg', fixture: 'log-0804-a.jpg' },
  '753943690f12': { corpus: '3/photo_3_2026-08-10_15-23-32.jpg', fixture: 'orders-0804-c.jpg' },
  'c56b1e866f92': { corpus: '3/photo_4_2026-08-10_15-23-32.jpg', fixture: 'orders-0804-b.jpg' },
  'e01f3f38b29a': { corpus: '3/photo_5_2026-08-10_15-23-32.jpg', fixture: 'orders-0804-a.jpg' },
  '36220ba7b914': { corpus: '4/photo_1_2026-08-08_00-26-59.jpg', fixture: 'orders-0806-lg.jpg' },
  '84363fa7ae62': { corpus: '4/photo_10_2026-08-08_00-26-59.jpg', fixture: 'orders-h4.jpg' },
  'e013cfebb349': { corpus: '4/photo_11_2026-08-08_00-26-59.jpg', fixture: null },
  '25cb45ef9a8a': { corpus: '4/photo_12_2026-08-08_00-26-59.jpg', fixture: 'orders-h5.jpg' },
  '8e5cd6a31841': { corpus: '4/photo_13_2026-08-08_00-26-59.jpg', fixture: 'log-h1.jpg' },
  '7f17e60aa1d7': { corpus: '4/photo_14_2026-08-08_00-26-59.jpg', fixture: 'log-h2.jpg' },
  '37153b90ad70': { corpus: '4/photo_15_2026-08-08_00-26-59.jpg', fixture: 'log-h3.jpg' },
  '4415767dfe27': { corpus: '4/photo_16_2026-08-08_00-26-59.jpg', fixture: 'log-h4.jpg' },
  'f8d28c8442d5': { corpus: '4/photo_17_2026-08-08_00-26-59.jpg', fixture: null },
  '56b4da17fa47': { corpus: '4/photo_18_2026-08-08_00-26-59.jpg', fixture: 'orders-0806-en.jpg' },
  'a83beebdc9bc': { corpus: '4/photo_19_2026-08-08_00-26-59.jpg', fixture: null },
  '7077853d9782': { corpus: '4/photo_2_2026-08-08_00-26-59.jpg', fixture: null },
  '94b554b64a69': { corpus: '4/photo_20_2026-08-08_00-26-59.jpg', fixture: null },
  'a1e0411362f8': { corpus: '4/photo_21_2026-08-08_00-26-59.jpg', fixture: null },
  '17ae926036aa': { corpus: '4/photo_22_2026-08-08_00-26-59.jpg', fixture: null },
  '888406b445d3': { corpus: '4/photo_23_2026-08-08_00-26-59.jpg', fixture: null },
  'df176fae62ff': { corpus: '4/photo_24_2026-08-08_00-26-59.jpg', fixture: 'orders-0807-sm.jpg' },
  'f49a3de9bb12': { corpus: '4/photo_25_2026-08-08_00-26-59.jpg', fixture: null },
  '1a8ccb030364': { corpus: '4/photo_26_2026-08-08_00-26-59.jpg', fixture: null },
  'bb9dc2f54527': { corpus: '4/photo_27_2026-08-08_00-26-59.jpg', fixture: null },
  '41c5faae0e88': { corpus: '4/photo_28_2026-08-08_00-26-59.jpg', fixture: null },
  '6a3f08ba7c9d': { corpus: '4/photo_29_2026-08-08_00-26-59.jpg', fixture: null },
  '3f38cb858490': { corpus: '4/photo_3_2026-08-08_00-26-59.jpg', fixture: null },
  '63388b107929': { corpus: '4/photo_30_2026-08-08_00-26-59.jpg', fixture: null },
  'ea2445753596': { corpus: '4/photo_31_2026-08-08_00-26-59.jpg', fixture: null },
  '36e9e988d5b1': { corpus: '4/photo_32_2026-08-08_00-26-59.jpg', fixture: null },
  '10dc994e1485': { corpus: '4/photo_4_2026-08-08_00-26-59.jpg', fixture: null },
  '81a3551061f5': { corpus: '4/photo_5_2026-08-08_00-26-59.jpg', fixture: null },
  'f781b623fffc': { corpus: '4/photo_6_2026-08-08_00-26-59.jpg', fixture: 'orders-h1.jpg' },
  '4a097298c78d': { corpus: '4/photo_7_2026-08-08_00-26-59.jpg', fixture: 'orders-h2.jpg' },
  'eab4b4ecc01c': { corpus: '4/photo_8_2026-08-08_00-26-59.jpg', fixture: null },
  '229464c346b6': { corpus: '4/photo_9_2026-08-08_00-26-59.jpg', fixture: 'orders-h3.jpg' },
  'f983f86b2908': { corpus: 'New folder/475fdd95-2eb8-4724-99bf-0a975767ca77.jpg', fixture: null },
  '41061ae0a5b8': { corpus: 'New folder/4c209e8b-60f0-476f-ab6b-5b998ccc5071.jpg', fixture: null },
  'f951bcd61a1d': { corpus: 'New folder/82d542e4-e628-4b7e-8980-5c201a1672ad.jpg', fixture: null },
  '9a7527f711ba': { corpus: 'New folder/935036a4-60bb-4fc3-9a12-08607d03758e.jpg', fixture: null },
  'fb0ea4c67284': { corpus: 'photo_1_2026-07-30_15-20-32.jpg', fixture: 'dash-odometer.jpg' },
  'e6449c2f9e6b': { corpus: 'photo_2_2026-07-30_15-20-32.jpg', fixture: 'bms-cards-ar.jpg' },
  '2d57e3aacc2a': { corpus: 'photo_3_2026-07-30_15-20-32.jpg', fixture: 'bms-table-en.jpg' },
}

export const CORPUS_COUNT = 48

/**
 * What each screen IS. The reader must be told, because a payments log and an orders list are the
 * same shape — «number SYP, clock» down the right-hand side — and only the heading distinguishes
 * them. Held locally so it is a CHECK on the model's own `screen` answer rather than a hint to it.
 */
export const SCREEN = {
  payments_log: [
    '2e13abe792fb', 'f410aa3f1d02', '58aad5ae0afd', '1add42aacf81',
    '8e5cd6a31841', '7f17e60aa1d7', '37153b90ad70', '4415767dfe27',
    '41c5faae0e88', '17ae926036aa', 'bb9dc2f54527', '1a8ccb030364',
    'f49a3de9bb12', '6a3f08ba7c9d', '63388b107929', '888406b445d3',
    'a1e0411362f8', '10dc994e1485', '81a3551061f5', '3f38cb858490',
  ],
  recent_orders: [
    'f8e16d053837', '43fbfbc8fb6d', '753943690f12', 'c56b1e866f92', 'e01f3f38b29a',
    '36220ba7b914', '56b4da17fa47', 'df176fae62ff', 'f781b623fffc', '4a097298c78d',
    '229464c346b6', '84363fa7ae62', '25cb45ef9a8a', 'e013cfebb349', 'f8d28c8442d5',
    'a83beebdc9bc', '94b554b64a69', 'ea2445753596', '36e9e988d5b1', '7077853d9782',
    'eab4b4ecc01c', 'f983f86b2908', '9a7527f711ba',
  ],
  odometer: ['fb0ea4c67284'],
  bms: ['e6449c2f9e6b', '2d57e3aacc2a', '41061ae0a5b8', 'f951bcd61a1d'],
}

/**
 * hash → 'payments_log' | 'recent_orders' | 'odometer' | 'bms'.
 *
 * The TRANSCRIPTION WINS over the list above, because it is better evidence: `SCREEN` was filled in
 * by hand from filenames and a sample of the images, and the transcription is two independent
 * readers who both actually looked. They disagreed on four — `4/photo_25`, `4/photo_26` and
 * `New folder/82d542e4` are «الطلبات الحديثة» and were listed as payments logs or BMS, and
 * `4/photo_17` is the reverse. Checked against the pixels: the readers were right every time.
 *
 * This matters because `screenOf` is used as a CHECK on what Gemini says the screen is. Left as it
 * was, four images would have reported a disagreement that was the benchmark's fault, not the
 * model's — and a benchmark that cries wolf is worse than no benchmark.
 */
export const screenOf = (sha) =>
  CORPUS_TRUTH[sha]?.screen ?? Object.entries(SCREEN).find(([, list]) => list.includes(sha))?.[0] ?? 'unknown'

// ── Money, read back from a glyph string ─────────────────────────────────────────────────────

/**
 * Bidi controls are INVISIBLE and they eat the sign.
 *
 * Arabic screens are RTL, and any recogniser — Tesseract or a language model — may emit the marks
 * that hold a mixed run together. `normaliseAmount` in ocr-truth.mjs strips `\s`, which does not
 * cover them, so its `[-+]?\d+` match starts AFTER a stranded sign:
 *
 *     "-‏١١٥٥٫٦٥"  →  "1155.65"     a debit silently becomes a credit
 *     "١١‎٥٥"      →  "11"          the number is silently truncated
 *
 * Measured, not assumed — both of those are real outputs of that function today.
 */
const BIDI = /[‎‏؜⁦-⁩‪-‮]/g
export const stripBidi = (s) => String(s).replace(BIDI, '')

/** Arabic-Indic and Extended-Arabic digits → ASCII. Separators are left ALONE (see below). */
const asciiDigits = (s) =>
  s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))

/** Everything an amount may legally contain once bidi is gone. Anything else ⇒ suspect. */
const AMOUNT_OK = /^[-+−–—٠-٩۰-۹0-9٬٫،,.\s]*$/

/**
 * «+٣٩٦٫٥٠ SYP» → "396.50". «−١٬١٥٥٫٦٥» → "-1155.65". «٧٦،٥٠٩٬٥٥» → "76509.55".
 *
 * NOT a character mapping, because no character mapping can be right. The marks swap roles between
 * screens: the orders and log screens print «٬» thousands + «٫» decimal, while the wallet card
 * prints «،» thousands + «٬» decimal (see `apps/driver/test/ocr.test.ts:649`). Fold «٬»→"," and you
 * read the wallet's decimal as a grouping mark and lose the fraction; fold it to "." and you turn
 * the log's thousands mark into a decimal point and divide by a thousand.
 *
 * So the rule is POSITIONAL, exactly as the shipped reader already does it at
 * `apps/driver/src/ocr.ts:680-693`: a separator followed by ONE OR TWO digits at the very end is the
 * fraction; grouping separators always leave three-digit groups. The sign is kept — unlike
 * `parseWallet`, which reads an unsigned balance, these rows are signed and the sign is the whole
 * difference between money arriving and money leaving.
 *
 * Returns `null` rather than a guess when the string holds anything it should not — the benchmark
 * exists to find confident-and-wrong readings, so silently cleaning one up would defeat it.
 */
export function normaliseMoney(raw) {
  if (raw === null || raw === undefined) return null
  const clean = stripBidi(String(raw)).replace(/\s|SYP|syp/g, '')
  if (!AMOUNT_OK.test(clean)) return null

  const neg = /^[-−–—]/.test(clean)
  const body = asciiDigits(clean.replace(/^[-+−–—]/, ''))
  if (!/^[\d٬٫،,.]*$/.test(body) || body.replace(/[^\d]/g, '') === '') return null

  const frac = body.match(/[٬٫،,.](\d{1,2})$/)
  const intPart = (frac ? body.slice(0, frac.index) : body).replace(/[^\d]/g, '')
  if (intPart === '') return null

  // Leading zeros go, but a lone «0» survives and «.50» keeps its trailing zero: -165.50 and -165
  // are different money, which is why ocr-truth.mjs:130 says the same thing about its own output.
  const int = intPart.replace(/^0+(?=\d)/, '')
  return `${neg ? '-' : ''}${int}${frac ? `.${frac[1]}` : ''}`
}

/** Digits only — for the count cross-check, which is blind to where the separators fell. */
export const digitsIn = (s) => stripBidi(String(s ?? '')).replace(/[^٠-٩۰-۹0-9]/g, '').length

// ── The answer key ───────────────────────────────────────────────────────────────────────────

/**
 * Rows the corpus adds, hash → `[fee, 'HH:MM', 'YYYY-MM-DD']`, same shape as `TRUTH`.
 *
 * `''` means READ BUT NOT CERTAIN — the convention `glyph-harvest.mjs` already uses for rows whose
 * crop caught part of the «SYP». An uncertain row is left blank, never guessed: a wrong answer key
 * turns a correct reading into a recorded failure, which is worse than no answer at all.
 *
 * `null` in the fee position means the row genuinely HAS no amount — a «Cancelled» / «تم إلغاؤه»
 * order, or a card the scroll position sliced so its fee is off-screen. The right reading is
 * nothing; a number there is a hallucination and must score as one.
 */
export const CORPUS_TRUTH = {
  // payments_log · light · status clock 2:40
  //   Same Arabic «سجل المدفوعات» list as 3f38cb858490 and 81a3551061f5, scrolled to a middle
  //   position. Status-bar clock printed as ٢:٤٠, no AM/PM. All row stamps read ٠٨/٠٦ = Aug 6. Row 1
  //   (+٨٧٫٥٠) and row 11 (+٢٧١٫٥٠) both use the LOW decimal mark U+066B with exactly two trailing
  '10dc994e1485': { screen: 'payments_log', rows: [
    ['87.50', '17:38', '2026-08-06'],
    ['-37', '17:37', '2026-08-06'],
    ['405', '16:09', '2026-08-06'],
    ['-120', '16:08', '2026-08-06'],
    ['205', '15:03', '2026-08-06'],
    ['-48', '15:03', '2026-08-06'],
    ['130', '13:55', '2026-08-06'],
    ['-34', '13:55', '2026-08-06'],
    ['50', '13:36', '2026-08-06'],
    ['-26', '13:36', '2026-08-06'],
    ['271.50', '12:56', '2026-08-06'],
    ['-66', '12:56', '2026-08-06'],
  ] },
  // payments_log · dark
  //   Same «Transactions» list as a1e0411362f8, scrolled down; its first row (-35, 6:54 PM) is that
  //   screen's last row. All 12 rows are dated Aug 6 inline; no separate date header; year taken as
  //   2026. «-1,716.95» verified at high zoom: comma is the thousands mark, period the decimal →
  '17ae926036aa': { screen: 'payments_log', rows: [
    ['-35', '18:54', '2026-08-06'],
    ['-58', '18:18', '2026-08-06'],
    ['-26', '18:18', '2026-08-06'],
    ['307.20', '17:50', '2026-08-06'],
    ['-80', '17:50', '2026-08-06'],
    ['-78', '16:46', '2026-08-06'],
    ['127', '16:04', '2026-08-06'],
    ['-41', '16:03', '2026-08-06'],
    ['156', '10:05', '2026-08-06'],
    ['250', '10:04', '2026-08-06'],
    ['300', '03:58', '2026-08-06'],
    ['-1716.95', '02:08', '2026-08-06'],
  ] },
  // recent_orders · light
  //   Same screen as f49a3de9bb12, scrolled further down the same day. Single date header 'الجمعة, ٧
  //   أغسطس' -> 2026-08-07. Rows 1-2 are '١٢:٥٩ م' and '١٢:٢١ م': 12 PM stays 12, so 12:59 and
  //   12:21, NOT 24:59/24:21. Rows 3-4 are 'ص' (AM) -> 11:53 and 11:16. No separators in any amount.
  '1a8ccb030364': { screen: 'recent_orders', rows: [
    ['345', '12:59', '2026-08-07'],
    ['165', '12:21', '2026-08-07'],
    ['300', '11:53', '2026-08-07'],
    ['235', '11:16', '2026-08-07'],
  ] },
  // bms · dark · status clock 3:11
  //   Same JK-BMS style status screen as 41061ae0a5b8 but a different pack/session. No money rows.
  //   Status-bar clock printed Arabic-Indic ٣:١١ with no ص/م marker, recorded as 3:11 exactly as
  //   shown; status bar also reads 'ضوء الفلاش مشغل' and battery 38. Cells 01-20 all read 4.169V
  '2d57e3aacc2a': { screen: 'bms', rows: [], fields: [['charge', 'ON'], ['discharge', 'ON'], ['balance', 'OFF'], ['total_voltage_v', '83.37'], ['current_a', '0.00'], ['battery_power_w', '0.0'], ['battery_capacity_ah', '50.0'], ['remain_capacity_ah', '50.0'], ['remain_percent', '100'], ['cycle_count', '8'], ['battery_t2_c', '32.5'], ['detail_logs_count', '208'], ['cell_type', 'Lion'], ['ave_cell_volt_v', '4.169'], ['cell_volt_diff_v', '0.000'], ['balance_curr_a', '0.000'], ['mos_temp_c', '33.9'], ['cycle_capacity_ah', '436.8'], ['time_emerg', '0'], ['time_enter_sleep_s', '86400']] },
  // payments_log · dark
  //   Same Arabic payments log as f410aa3f1d02, scrolled further down. NO month header is visible on
  //   this screen (it has scrolled off), but every row prints its own inline date «٠٧/٢٩», so
  //   dateIso = 2026-07-29 throughout. Decimal marks (U+066B) confirmed on rows 4, 9 and 11: 107.50
  '2e13abe792fb': { screen: 'payments_log', rows: [
    ['-80', '15:48', '2026-07-29'],
    ['-28', '14:48', '2026-07-29'],
    ['-33', '14:21', '2026-07-29'],
    ['107.50', '13:46', '2026-07-29'],
    ['-32', '13:46', '2026-07-29'],
    ['-24', '13:08', '2026-07-29'],
    ['-42', '12:52', '2026-07-29'],
    ['-50', '11:58', '2026-07-29'],
    ['15.90', '11:54', '2026-07-29'],
    ['-33', '11:54', '2026-07-29'],
    ['9.75', '11:46', '2026-07-29'],
    ['300', '03:33', '2026-07-29'],
  ] },
  // recent_orders · light · status clock 5:50 PM
  //   Yallago "Recent orders", English UI, Western digits. One date header only: "Friday, August 7"
  //   (2026-08-07). The first card (3:06 PM / 295 SYP) sits partly under the sticky date header and
  //   is faded/clipped at the top, but at 10x zoom both the time and the amount are unambiguous.
  '36e9e988d5b1': { screen: 'recent_orders', rows: [
    ['295', '15:06', '2026-08-07'],
    ['185', '14:23', '2026-08-07'],
    ['140', '14:00', '2026-08-07'],
    ['590', '12:25', '2026-08-07'],
    ['445', '11:25', '2026-08-07'],
  ] },
  // payments_log · light · status clock 2:40
  //   Arabic RTL screen titled «سجل المدفوعات». Status-bar clock printed in Arabic-Indic digits as
  //   ٢:٤٠ with no AM/PM marker. Each row carries its own date+time stamp (no separate date
  //   headers); the stamp reads ٠٨/٠٦ = MM/DD = Aug 6. MM/DD order is confirmed by the sibling
  '3f38cb858490': { screen: 'payments_log', rows: [
    ['-26', '13:36', '2026-08-06'],
    ['271.50', '12:56', '2026-08-06'],
    ['-66', '12:56', '2026-08-06'],
    ['34', '12:29', '2026-08-06'],
    ['440', '12:23', '2026-08-06'],
    ['-105', '12:22', '2026-08-06'],
    ['85', '11:15', '2026-08-06'],
    ['-27', '11:14', '2026-08-06'],
    ['111', '10:05', '2026-08-06'],
    ['150', '10:04', '2026-08-06'],
    ['30', '09:58', '2026-08-06'],
    ['300', '03:57', '2026-08-06'],
  ] },
  // bms · dark · status clock 01:39
  //   JK-BMS style status screen, no money rows. MOS Temp. is printed 43.8 degC — see correction:
  //   the on-screen value is 43.8, recorded above erroneously as 33.8; the certain reading is 43.8.
  //   Cells Voltage grid (cells 01-20 populated, 21-24 show '--') and Cells Wire Resistance grid are
  '41061ae0a5b8': { screen: 'bms', rows: [], fields: [['charge', 'ON'], ['discharge', 'ON'], ['balance', 'ON'], ['total_voltage_v', '68.86'], ['current_a', '-0.38'], ['battery_power_w', '26.0'], ['battery_capacity_ah', '50.0'], ['remain_capacity_ah', '9.3'], ['remain_percent', '19'], ['cycle_count', '27'], ['battery_t2_c', '36.3'], ['detail_logs_count', '557'], ['cell_type', 'Lion'], ['ave_cell_volt_v', '3.443'], ['cell_volt_diff_v', '0.020'], ['balance_curr_a', '0.583'], ['cycle_capacity_ah', '1362.8'], ['time_emerg', '0'], ['time_enter_sleep_s', '86400']] },
  // payments_log · light
  //   Arabic 'سجل المدفوعات', the earlier (higher) scroll position of the same log as bb9dc2f54527.
  //   No date header; each row prints '٠٨/٠٧' inline -> 2026-08-07 for all 11 rows. SEPARATOR
  //   RULING: row 3 '+٣٩٦<mark>٥٠' and row 7 '+٨<mark>٢٥' both have exactly TWO trailing digits
  '41c5faae0e88': { screen: 'payments_log', rows: [
    ['95', '16:54', '2026-08-07'],
    ['-26', '16:54', '2026-08-07'],
    ['396.50', '16:03', '2026-08-07'],
    ['-115', '16:02', '2026-08-07'],
    ['140', '15:17', '2026-08-07'],
    ['-58', '15:17', '2026-08-07'],
    ['8.25', '15:00', '2026-08-07'],
    ['39', '14:46', '2026-08-07'],
    ['-32', '14:45', '2026-08-07'],
    ['12', '', '2026-08-07'],
    ['-55', '', '2026-08-07'],
  ] },
  // recent_orders · dark · status clock 22:54
  //   Same «الطلبات الحديثة» list scrolled further down, dark theme, same phone clock (١٠:٥٤ م). TWO
  //   date headers on this screen: «الأربعاء, ٢٩ يوليو» at the top (all five rows below belong to
  //   it) and «الثلاثاء, ٢٨ يوليو» (= 2026-07-28) at the very bottom edge — that second header has
  '43fbfbc8fb6d': { screen: 'recent_orders', rows: [
    ['165', '14:21', '2026-07-29'],
    ['160', '13:46', '2026-07-29'],
    ['120', '13:08', '2026-07-29'],
    ['210', '12:52', '2026-07-29'],
    ['165', '11:54', '2026-07-29'],
  ] },
  // payments_log · light · status clock 5:51 PM
  //   English LTR screen titled "Transactions" - the same wallet payments log in English locale,
  //   Western digits, "." decimal. No date headers; every row prints its own "Aug 7 h:mm PM" stamp
  //   -> 2026-08-07. All 11 listed rows are fully visible. A 12th row is sliced off by the bottom
  '63388b107929': { screen: 'payments_log', rows: [
    ['316.63', '17:15', '2026-08-07'],
    ['-73', '17:14', '2026-08-07'],
    ['-80', '16:41', '2026-08-07'],
    ['342.50', '15:51', '2026-08-07'],
    ['-91', '15:50', '2026-08-07'],
    ['-57', '15:06', '2026-08-07'],
    ['-59', '15:06', '2026-08-07'],
    ['36.20', '14:24', '2026-08-07'],
    ['-37', '14:23', '2026-08-07'],
    ['6.50', '14:00', '2026-08-07'],
    ['-28', '14:00', '2026-08-07'],
  ] },
  // payments_log · light · status clock 5:51 PM
  //   ENGLISH-language 'Transactions' screen on a DIFFERENT phone (720x1640, status bar '5:51 PM',
  //   battery 9%) - Western digits throughout, so no Arabic-Indic separator risk here. No date
  //   header; each row prints 'Aug 7' inline -> 2026-08-07. ROW 1 IS SLICED AND FADED: the first
  '6a3f08ba7c9d': { screen: 'payments_log', rows: [
    ['', '', '2026-08-07'],
    ['-59', '15:06', '2026-08-07'],
    ['36.20', '14:24', '2026-08-07'],
    ['-37', '14:23', '2026-08-07'],
    ['6.50', '14:00', '2026-08-07'],
    ['-28', '14:00', '2026-08-07'],
    ['559.40', '12:25', '2026-08-07'],
    ['-118', '12:25', '2026-08-07'],
    ['60', '11:41', '2026-08-07'],
    ['385', '11:26', '2026-08-07'],
    ['-89', '11:25', '2026-08-07'],
    ['300', '02:46', '2026-08-07'],
  ] },
  // recent_orders · light
  //   Light-theme Arabic RTL 'الطلبات الحديثة' list, 720x1600. Status-bar clock is printed in
  //   Arabic-Indic digits as '٢:٣٩' (= 2:39), with no ص/م marker beside it; battery reads ٪١٧. Two
  //   date headers: 'الجمعة, ٧ أغسطس' (2026-08-07) and 'الخميس, ٦ أغسطس' (2026-08-06). ROW 1 IS A
  '7077853d9782': { screen: 'recent_orders', rows: [
    ['', '', '2026-08-07'],
    ['185', '17:37', '2026-08-06'],
    ['600', '16:08', '2026-08-06'],
    ['240', '15:03', '2026-08-06'],
    ['170', '13:55', '2026-08-06'],
  ] },
  // payments_log · light · status clock 2:40
  //   Same Arabic «سجل المدفوعات» list, scrolled to the newest end. Status-bar clock ٢:٤٠, no AM/PM.
  //   SEPARATOR CHECK, done at 4x zoom: row 2 (−١٬٨٣٦) uses the RAISED thousands mark (U+066C,
  //   sitting at cap height) and is followed by THREE digits ٨٣٦ -> -1836. Row 3 (+٨٧٫٥٠) uses the
  '81a3551061f5': { screen: 'payments_log', rows: [
    ['300', '02:44', '2026-08-07'],
    ['-1836', '18:07', '2026-08-06'],
    ['87.50', '17:38', '2026-08-06'],
    ['-37', '17:37', '2026-08-06'],
    ['405', '16:09', '2026-08-06'],
    ['-120', '16:08', '2026-08-06'],
    ['205', '15:03', '2026-08-06'],
    ['-48', '15:03', '2026-08-06'],
    ['130', '13:55', '2026-08-06'],
    ['-34', '13:55', '2026-08-06'],
    ['50', '13:36', '2026-08-06'],
    ['-26', '13:36', '2026-08-06'],
  ] },
  // payments_log · dark
  //   Same «Transactions» list scrolled one screen further; its rows 1-8 equal rows 5-12 of sha
  //   17ae926036aa, which cross-checks the alignment. All rows dated Aug 6 inline; no separate date
  //   header; year taken as 2026. Rows 11-12 print «12:47 AM» — 12 AM maps to 00:47, not 12:47.
  '888406b445d3': { screen: 'payments_log', rows: [
    ['-80', '17:50', '2026-08-06'],
    ['-78', '16:46', '2026-08-06'],
    ['127', '16:04', '2026-08-06'],
    ['-41', '16:03', '2026-08-06'],
    ['156', '10:05', '2026-08-06'],
    ['250', '10:04', '2026-08-06'],
    ['300', '03:58', '2026-08-06'],
    ['-1716.95', '02:08', '2026-08-06'],
    ['115', '01:22', '2026-08-06'],
    ['-30', '01:22', '2026-08-06'],
    ['190', '00:47', '2026-08-06'],
    ['-54', '00:47', '2026-08-06'],
  ] },
  // recent_orders · dark · status clock 3:20 PM
  //   Dark-theme English 'Recent orders' list, 1080x2400. Single date header 'Thursday, August 6'.
  //   ROW 1 IS A SLICED CARD WITH NO AMOUNT PRINTED (schema rejected null, so value is the empty
  //   string; semantically 'no amount exists'): directly beneath the sticky header only the A line
  '94b554b64a69': { screen: 'recent_orders', rows: [
    ['', '', '2026-08-06'],
    ['130', '18:18', '2026-08-06'],
    ['400', '17:50', '2026-08-06'],
    ['', '16:50', '2026-08-06'],
    ['390', '16:46', '2026-08-06'],
    ['205', '16:04', '2026-08-06'],
  ] },
  // recent_orders · dark · status clock 01:28
  //   Dark theme, Western digits, 24-hour times already printed. TWO date headers: "الأربعاء, 12
  //   غشت" = Wednesday 12 August (2026-08-12) at the top, then "الثلاثاء, 11 غشت" = Tuesday 11
  //   August (2026-08-11) further down; each row takes the nearest header above it. ROW 1 IS SLICED
  '9a7527f711ba': { screen: 'recent_orders', rows: [
    ['', '', '2026-08-12'],
    ['150', '00:11', '2026-08-12'],
    ['235', '23:44', '2026-08-11'],
    ['195', '23:04', '2026-08-11'],
  ] },
  // payments_log · dark
  //   English LTR screen titled «Transactions», signed +/- rows. No standalone date headers — the
  //   date is printed inline on each row (Aug 7 / Aug 6); year not printed, taken as 2026. The
  //   display font draws the digit 1 as a bare vertical stroke, so -114 / -141 / -81 / +127 / +156 /
  'a1e0411362f8': { screen: 'payments_log', rows: [
    ['-1432.40', '01:55', '2026-08-07'],
    ['480', '00:25', '2026-08-07'],
    ['-114', '00:24', '2026-08-07'],
    ['-24', '23:28', '2026-08-06'],
    ['-141', '22:34', '2026-08-06'],
    ['259.20', '21:19', '2026-08-06'],
    ['-60', '21:19', '2026-08-06'],
    ['52', '20:26', '2026-08-06'],
    ['-26', '20:25', '2026-08-06'],
    ['265', '19:53', '2026-08-06'],
    ['-81', '19:52', '2026-08-06'],
    ['-35', '18:54', '2026-08-06'],
  ] },
  // recent_orders · dark · status clock 3:20 PM
  //   Dark-theme English 'Recent orders' list, 1080x2400. Two date headers: 'Friday, August 7' then
  //   'Thursday, August 6'. All five amounts are plain 3-digit integers with no thousands or decimal
  //   marks. The display font renders digit 1 with a slab/serif look resembling 'I' (e.g. '120',
  'a83beebdc9bc': { screen: 'recent_orders', rows: [
    ['570', '00:24', '2026-08-07'],
    ['120', '23:28', '2026-08-06'],
    ['705', '22:34', '2026-08-06'],
    ['300', '21:19', '2026-08-06'],
    ['130', '20:25', '2026-08-06'],
  ] },
  // payments_log · light
  //   Arabic 'سجل المدفوعات' (payments log). No date HEADER on this screen: every row prints its own
  //   date inline as '٠٨/٠٧' (MM/DD) -> 2026-08-07 for all 11 rows. SEPARATOR RULING: rows 2 and 4
  //   print '٢٨٣<mark>٨٠' and '٩٧<mark>٥٠'. The mark is followed by exactly TWO digits at the end,
  'bb9dc2f54527': { screen: 'payments_log', rows: [
    ['-55', '', '2026-08-07'],
    ['283.80', '12:59', '2026-08-07'],
    ['-69', '12:59', '2026-08-07'],
    ['97.50', '12:21', '2026-08-07'],
    ['-33', '12:21', '2026-08-07'],
    ['135', '11:53', '2026-08-07'],
    ['-60', '11:53', '2026-08-07'],
    ['139', '11:41', '2026-08-07'],
    ['187', '11:16', '2026-08-07'],
    ['-47', '11:16', '2026-08-07'],
    ['300', '02:45', '2026-08-07'],
  ] },
  // recent_orders · light · status clock 14:43
  //   «الطلبات الحديثة», light theme, phone clock ٢:٤٣ م. One date header: «الأربعاء, ٥ أغسطس» =
  //   Wednesday 5 August 2026 (verified: 5 Aug 2026 is a Wednesday). Four complete cards; the screen
  //   ends on a divider line after card 4, so there is no sliced fifth card. No separators in any
  'e013cfebb349': { screen: 'recent_orders', rows: [
    ['535', '19:46', '2026-08-05'],
    ['210', '16:14', '2026-08-05'],
    ['300', '15:51', '2026-08-05'],
    ['405', '15:14', '2026-08-05'],
  ] },
  // bms · light · status clock 3:07
  //   Arabic-localised BMS app, cyan/white light theme (the black band at the very top is the phone
  //   system status bar, not the page). No money rows. Status-bar clock is printed in Arabic-Indic
  //   as ٣:٠٧ with no ص/م marker visible, so no AM/PM can be asserted — recorded as 3:07 exactly as
  'e6449c2f9e6b': { screen: 'bms', rows: [], fields: [['remain_percent', '100'], ['total_voltage_v', '81.48'], ['current_a', '0'], ['power_w', '0.00'], ['cycles', '1'], ['mos_temp_c', '36.9'], ['t1_c', '33.7'], ['t2_c', '33.6'], ['battery_state', 'تشغيل طبيعي'], ['heating_state', 'إيقاف']] },
  // recent_orders · light · status clock 5:50 PM
  //   Light-theme English 'Recent orders' list, 720x1640. Single date header 'Friday, August 7'. All
  //   five amounts are plain 3-digit integers with no separators, verified at 3x magnification of
  //   the amount and time columns read separately. The bottom card (2:23 PM, 185 SYP) is clipped by
  'ea2445753596': { screen: 'recent_orders', rows: [
    ['365', '17:14', '2026-08-07'],
    ['500', '16:41', '2026-08-07'],
    ['455', '15:50', '2026-08-07'],
    ['295', '15:06', '2026-08-07'],
    ['185', '14:23', '2026-08-07'],
  ] },
  // recent_orders · light · status clock ٢:٤٢ م
  //   Arabic RTL "الطلبات الحديثة", amounts and times in Arabic-Indic digits. One date header:
  //   "الخميس, ٦ أغسطس" = Thursday 6 August (2026-08-06). Digit shapes confirmed at 14x zoom: ٥
  //   renders as a full oval, ٠ as a small dot, ٢ has two prongs, ٣ three prongs, ٨ is the
  'eab4b4ecc01c': { screen: 'recent_orders', rows: [
    ['315', '17:25', '2026-08-06'],
    ['155', '16:23', '2026-08-06'],
    ['440', '15:58', '2026-08-06'],
    ['600', '15:12', '2026-08-06'],
  ] },
  // payments_log · dark
  //   Arabic RTL payments log, title «سجل المدفوعات». One section header on screen: «يوليو» (July).
  //   Every row also carries its own inline date «٠٧/٢٩» plus a 12-h clock with ص/م, so dateIso =
  //   2026-07-29 for all 11 rows. The separator in ١٤٤٫١٥ and ١٠٧٫٥٠ is the DECIMAL mark (U+066B):
  'f410aa3f1d02': { screen: 'payments_log', rows: [
    ['-144.15', '19:29', '2026-07-29'],
    ['185', '18:10', '2026-07-29'],
    ['-99', '18:10', '2026-07-29'],
    ['-36', '16:54', '2026-07-29'],
    ['-80', '15:48', '2026-07-29'],
    ['-28', '14:48', '2026-07-29'],
    ['-33', '14:21', '2026-07-29'],
    ['107.50', '13:46', '2026-07-29'],
    ['-32', '13:46', '2026-07-29'],
    ['-24', '13:08', '2026-07-29'],
    ['-42', '12:52', '2026-07-29'],
  ] },
  // recent_orders · light
  //   Arabic 'الطلبات الحديثة' (recent orders), one date header only: 'الجمعة, ٧ أغسطس' = Friday 7
  //   August -> 2026-08-07. All four fees are plain 3-digit Arabic-Indic amounts with NO separator
  //   of any kind, so no decimal ambiguity. Times all carry 'م' (PM) -> +12. The 4th card (١٦٠ SYP,
  'f49a3de9bb12': { screen: 'recent_orders', rows: [
    ['130', '16:54', '2026-08-07'],
    ['575', '16:02', '2026-08-07'],
    ['290', '15:17', '2026-08-07'],
    ['160', '14:45', '2026-08-07'],
  ] },
  // payments_log · light · status clock 14:43
  //   «سجل المدفوعات», light theme, phone clock ٢:٤٣ م. ROW 1 IS A SLICED ROW: the list's top
  //   fade-out crops it to the last few pixels of its glyphs — only the green tint (so it is a «+»
  //   credit) and its grey round button are discernible; the digits, sign and time are NOT readable.
  'f8d28c8442d5': { screen: 'payments_log', rows: [
    ['', '', ''],
    ['-26', '21:48', '2026-08-05'],
    ['322', '21:22', '2026-08-05'],
    ['-80', '21:22', '2026-08-05'],
    ['214', '20:28', '2026-08-05'],
    ['-50', '20:28', '2026-08-05'],
    ['447', '19:46', '2026-08-05'],
    ['-107', '19:46', '2026-08-05'],
    ['-40', '16:19', '2026-08-05'],
    ['168', '16:14', '2026-08-05'],
    ['-42', '16:14', '2026-08-05'],
    ['210', '15:52', '2026-08-05'],
  ] },
  // recent_orders · dark · status clock 22:54
  //   Yallago «الطلبات الحديثة» list, dark theme. One date header only: «الأربعاء, ٢٩ يوليو» =
  //   Wednesday 29 July 2026 (verified: 29 July 2026 is indeed a Wednesday). All five cards are
  //   complete — nothing sliced at the top or bottom edge. Amounts are plain Arabic-Indic integers
  'f8e16d053837': { screen: 'recent_orders', rows: [
    ['495', '18:10', '2026-07-29'],
    ['180', '16:54', '2026-07-29'],
    ['400', '15:48', '2026-07-29'],
    ['140', '14:48', '2026-07-29'],
    ['165', '14:21', '2026-07-29'],
  ] },
  // recent_orders · dark · status clock 01:28
  //   Title الطلبات الحديثة. Two date headers, both Maghrebi month name غشت (August): 'الأربعاء, 12
  //   غشت' -> 2026-08-12 (day-of-week checks out: 12 Aug 2026 is a Wednesday) and 'الثلاثاء, 11 غشت'
  //   -> 2026-08-11 (Tuesday, also checks out). All four amounts are unsigned Western digits with no
  'f951bcd61a1d': { screen: 'recent_orders', rows: [
    ['530', '01:05', '2026-08-12'],
    ['150', '00:11', '2026-08-12'],
    ['235', '23:44', '2026-08-11'],
    ['195', '23:04', '2026-08-11'],
  ] },
  // recent_orders · dark · status clock 01:28
  //   Arabic RTL "الطلبات الحديثة" on a dark theme, but amounts and times are Western digits and
  //   times are already 24-hour (left as printed). One date header: "الثلاثاء, 11 غشت" (Maghrebi
  //   month name) = Tuesday 11 August, 2026-08-11. Immediately below the header only the bottom arc
  'f983f86b2908': { screen: 'recent_orders', rows: [
    ['135', '22:28', '2026-08-11'],
    ['600', '21:56', '2026-08-11'],
    ['360', '20:55', '2026-08-11'],
    ['225', '20:17', '2026-08-11'],
  ] },
  // odometer · dark
  //   Photo of a physical e-bike LCD behind glare-covered glass; no money rows. The ODO reading was
  //   NOT eyeballed — at first glance the glare makes it look like '02 61'. I extracted per-column
  //   and per-segment brightness profiles from the pixel data over the ODO band (y 948-1012) and
  'fb0ea4c67284': { screen: 'odometer', rows: [], fields: [['odometer_km', '2161']] },
}

/**
 * `AMOUNTS` from glyph-harvest.mjs — 9 files that train the templates and are never graded.
 *
 * ⚠ `log-h4.jpg` is CORRECTED HERE and still wrong in `glyph-harvest.mjs`. The screen has ELEVEN
 * rows; that file lists ten, missing the «−٣٠» between «+٥١» and «+٦٩٥». Found by this benchmark on
 * its first request, when Gemini read eleven rows and was marked wrong for the extra one — it was
 * right and the answer key was not.
 *
 * The consequence there is not corrupted labels: `glyph-harvest.mjs:275-280` refuses a whole file
 * when its anchor count disagrees with its label count, precisely so a missing row cannot shift
 * every label onto its neighbour's glyphs. So the guard held — but it means this file has been
 * SILENTLY CONTRIBUTING NOTHING to the template bank. Fixing it there changes `glyphs.json`, then
 * `glyph-templates.ts`, then the shipped reader, so it is left as its own deliberate change rather
 * than a drive-by edit made in passing by a benchmark.
 */
export const HARVEST_AMOUNTS = {
  'orders-h1.jpg': ['205', '500', '435', '155'],
  'orders-h2.jpg': ['155', '250', '485', '300'],
  'orders-h3.jpg': ['130', '130', '400', '250'],
  'orders-h4.jpg': ['130', '150', '750', '350'],
  'orders-h5.jpg': ['130', '455', '265', '275'],
  'log-h1.jpg': ['+97', '+250', '-1,875.87', '+85', '', '', '-100'],
  'log-h2.jpg': ['-87', '+135', '-31', '-50', '+437', '-97', '-150', '-60', '+213', '-63', '+155'],
  'log-h3.jpg': ['-31', '', '-88', '', '-120', '', '-355', '+26', '+79', ''],
  'log-h4.jpg': ['-2,067.30', '-229.70', '+51', '-30', '+695', '-150', '+221', '-70', '-185', '-26', '+74'],
}

/**
 * The whole answer key, hash → `{ amounts, rows, source }`, assembled from all three places it
 * currently lives. `amounts` is what the bench scores; `rows` carries clock and date where known.
 */
export function answerKey() {
  const key = {}
  for (const [sha, { fixture }] of Object.entries(INDEX)) {
    const corpus = CORPUS_TRUTH[sha]
    if (corpus) {
      key[sha] = { amounts: corpus.rows.map((r) => r[0]), rows: corpus.rows, source: 'corpus' }
      continue
    }
    if (fixture && TRUTH[fixture]) {
      const t = TRUTH[fixture]
      key[sha] = { amounts: t.rows.map((r) => r[0]), rows: t.rows, source: 'truth', ...t }
      continue
    }
    if (fixture && HARVEST_AMOUNTS[fixture]) {
      key[sha] = { amounts: HARVEST_AMOUNTS[fixture], rows: null, source: 'harvest' }
    }
  }
  return key
}

// ── Loading the images ───────────────────────────────────────────────────────────────────────

/**
 * Walk the corpus. RECURSIVELY, and asserting the count.
 *
 * A one-level-deep glob returns 45, not 48: `داتا التجريب/2/` is empty and three images sit loose at
 * the top level — and those three are the odometer and both BMS screens, i.e. exactly the anomalous
 * screen types a benchmark most needs. Losing them silently would leave the summary looking complete.
 */
export function loadCorpus(root) {
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : /\.(jpe?g|png)$/i.test(e.name) ? [join(d, e.name)] : [],
    )
  const files = walk(root).sort()
  const images = files.map((path) => {
    const bytes = readFileSync(path)
    const sha = shaOf(bytes)
    return { sha, path, rel: relative(root, path).split(sep).join('/'), bytes, screen: screenOf(sha) }
  })

  const unknown = images.filter((i) => !INDEX[i.sha])
  if (images.length !== CORPUS_COUNT || unknown.length > 0) {
    throw new Error(
      `corpus mismatch: found ${images.length} images (expected ${CORPUS_COUNT})` +
        (unknown.length ? `, ${unknown.length} not in INDEX: ${unknown.map((i) => `${i.rel} (${i.sha})`).join(', ')}` : ''),
    )
  }
  return images
}

// ── Scoring ──────────────────────────────────────────────────────────────────────────────────

/** Checks that need no answer key. Each one is a self-contradiction the model can be caught in. */
export function selfChecks(row) {
  const out = []
  const printed = stripBidi(String(row.printed ?? ''))
  const value = row.value == null ? null : String(row.value)

  /*
   * «has a fractional part», NOT «has an Arabic decimal glyph».
   *
   * The first version of this asked specifically about «٫» and then fired whenever a "." appeared,
   * so the English-locale screens — which print «-1,432.40» in Latin digits — were all reported as
   * self-contradictions. The model was right and the check was wrong. What actually matters is
   * whether a fractional part exists, whichever glyph drew the separator.
   */
  const printedHasFraction = /[٫.](\d{1,2})$/.test(printed.replace(/\s|SYP/g, ''))
  if (row.hasDecimal === true && !printedHasFraction) out.push('claims_decimal_but_none_printed')
  if (row.hasDecimal === false && printedHasFraction) out.push('denies_decimal_but_one_printed')
  // THE ONE THAT MATTERS: a fraction was seen, and the converted value has none. That is the 100x.
  if (row.hasDecimal === true && value !== null && !value.includes('.')) {
    out.push('decimal_seen_but_dropped_in_value')
  }
  if (typeof row.digitCount === 'number' && row.digitCount !== digitsIn(printed)) {
    out.push(`digit_count_mismatch(said ${row.digitCount}, printed has ${digitsIn(printed)})`)
  }
  if (value !== null && typeof row.digitCount === 'number' && row.digitCount !== digitsIn(value)) {
    out.push(`digits_lost_in_conversion(said ${row.digitCount}, value has ${digitsIn(value)})`)
  }
  // Our own re-derivation of the printed glyphs, which is the one piece of arithmetic we own.
  const ours = normaliseMoney(printed)
  const theirs = value === null ? null : normaliseMoney(value)
  if (ours !== null && theirs !== null && ours !== theirs) out.push(`reparse_disagrees(ours ${ours}, theirs ${theirs})`)
  if (row.cancelled && value !== null) out.push('cancelled_row_carries_an_amount')
  return out
}

export function scoreImage(entry, truth) {
  const rows = entry.rows ?? []
  const said = rows.map((r) => (r.value == null ? null : normaliseMoney(r.value)))
  const suspects = rows.map(selfChecks)

  if (!truth) return { said, suspects, scored: false }

  const want = truth.amounts.map((a) => (a === '' || a === null ? a : normaliseMoney(a)))
  /*
   * A REFUSAL IS AN ANSWER, and on these screens it is often the RIGHT one.
   *
   * A «Cancelled» order and a card sliced by the screen edge both genuinely have no amount, and the
   * correct reading of them is nothing. Scoring `null` as a miss punished the model for being right
   * and made every orders screen with a cancelled row look broken. `''` is different again — it
   * means the ANSWER KEY is unsure, and an unsure key must never mark a reading wrong.
   */
  const pool = want.filter((w) => w !== '' && w !== null)
  const expected = pool.length
  // Slots where the key asserts nothing: `null` = "this row genuinely has no amount" (a cancelled
  // order, a sliced card), `''` = "the transcribers could not be sure". Both mean the key is not
  // entitled to call a reading wrong here.
  let unasserted = want.filter((w) => w === null || w === '').length
  let matched = 0
  let unjudged = 0
  const wrong = []
  for (const s of said) {
    if (s === null) {
      // A refusal against an unasserted slot is the model agreeing that there is nothing to read.
      if (unasserted > 0) { unasserted -= 1; matched += 1 } else wrong.push(s)
      continue
    }
    const i = pool.indexOf(s)
    if (i >= 0) {
      pool.splice(i, 1)
      matched += 1
    } else if (unasserted > 0) {
      // A number where the key is unsure is not a failure — it is unmarkable. Counted separately so
      // it can never flatter the score OR damn a reading the key cannot actually judge.
      unasserted -= 1
      unjudged += 1
    } else wrong.push(s)
  }
  return { said, suspects, scored: true, want, matched, unjudged, expected, wrong, missed: pool }
}
