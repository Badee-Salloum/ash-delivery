import { describe, expect, it } from 'vitest'
import { parseMinor } from '@ash/domain'
import { type OcrLine, parseBms, parseOrders, parseReading, parseWallet, profileById } from '../src/ocr.ts'

/**
 * The BMS parser, against text shaped like what Tesseract actually returns for the client's two
 * apps — one English, one Arabic.
 *
 * These are PARSER tests, not OCR tests: they take recognised text and check the label→value
 * pairing, the scaling, and the refusal to invent a reading. Whether Tesseract recognises the
 * glyphs correctly on a given phone is a calibration question no unit test can answer; what a
 * test can pin is that a plausible recognition produces the right numbers, and that an
 * implausible one produces null rather than a confident wrong answer.
 */

/** The English app, transcribed from the client's screenshot. */
const ENGLISH = `
Charge: ON   Discharge: ON   Balance: OFF
83.37V                    0.00A
Battery Power: 0.0W       Ave. Cell Volt.: 4.169V
Battery Capacity: 50.0Ah  Cell Volt. Diff.: 0.000V
Remain Capacity: 50.0Ah   Balance Curr.: 0.000A
Remain Battery: 100%      MOS Temp: 33.9C
Cycle Count: 8            Cycle Capacity: 436.8Ah
Battery T2: 32.5C         Time Emerg.: 0
Detail Logs Count: 208    Time Enter Sleep: 86400s
Cell Type: Lion
`

describe('the English BMS app', () => {
  const r = parseBms(ENGLISH)

  it('reads the state of charge from its label, not from the first % on screen', () => {
    expect(r.percent).toBe(100)
  })

  it('reads the cycle count — the number that says how tired the pack is', () => {
    expect(r.cycleCount).toBe(8)
  })

  it('does not mistake Cycle Capacity for the cycle count', () => {
    // «Cycle Capacity: 436.8Ah» sits on the same row as «Cycle Count: 8»; the count is 8, not 436.
    expect(r.cycleCount).toBe(8)
  })
})

/**
 * The Arabic app puts the VALUE first and the label second, because the layout is right-to-left.
 * "The number after the label" is therefore the wrong rule; "the number on the same line" is right
 * in both directions, which is why the parser is line-based.
 */
const ARABIC = `
100% الطاقة المتبقية
إيقاف :حالة التسخين
مَفتوح :حالة الموازنة
81.48V إجمالي الجهد
0A التيار
0.00W الطاقة
1 الدورات
36.9C :MOS
`

describe('the Arabic BMS app (value first, label second)', () => {
  const r = parseBms(ARABIC)

  it('finds the charge even though the label follows the number', () => {
    expect(r.percent).toBe(100)
  })

  it('finds the cycle count from the Arabic label', () => {
    expect(r.cycleCount).toBe(1)
  })
})

describe('it refuses to invent a reading', () => {
  it('returns nulls for text that contains no BMS fields at all', () => {
    const r = parseBms('the quick brown fox\nno numbers here')
    expect(r).toEqual({ percent: null, cycleCount: null })
  })

  it('drops an impossible value rather than storing it', () => {
    // A misread that puts the charge at 900% is not a reading. Leaving it null makes the gate
    // ask for it, which is right; storing it would look like an answer the driver gave.
    expect(parseBms('Remain Battery: 900%').percent).toBeNull()
  })

  it('reads Arabic-Indic numerals, in case the app renders them', () => {
    expect(parseBms('Cycle Count: ٨').cycleCount).toBe(8)
  })
})

describe('the dashboard reader reads only the odometer km', () => {
  it('reads the odometer and ignores the battery %', () => {
    expect(parseReading('85% 12345')).toEqual({ odometer: 12345 })
  })

  it('keeps an odometer that happens to equal the battery number', () => {
    // The old rule compared digit STRINGS, so an odometer of exactly 100 beside a 100% battery
    // was discarded as "the battery again" and a clock reading was offered in its place.
    expect(parseReading('100% 100').odometer).toBe(100)
  })
})

/**
 * The line-based input, which is what `readBms` actually feeds the parser now.
 *
 * v7 returns `{ text }` and nothing else unless `blocks` is requested, and it has no top-level
 * `data.words` — words live at `blocks[].paragraphs[].lines[].words[]`. The old code read
 * `data.words`, always got `[]`, and so the geometric pairing written for the Arabic layout had
 * never run once. These tests exercise the shape the recogniser really returns.
 */
let nextY = 0
const line = (text: string, words: Array<[string, number, number]> = [], y?: number, h = 30): OcrLine => {
  const y0 = y ?? (nextY += 40)
  return { text, y0, y1: y0 + h, words: words.map(([w, x0, x1]) => ({ text: w, x0, x1, y0, y1: y0 + h })) }
}

describe('lines from the recogniser, not a split of the flat text', () => {
  it('reads a single-column line', () => {
    expect(parseBms([line('Cycle Count: 8')]).cycleCount).toBe(8)
  })

  it('splits a TWO-COLUMN row using the gap between words, not the collapsed spaces', () => {
    // The recognised line text loses the gutter; only the word boxes still know where it was.
    // Without it, `Cycle Count` would take the 100 sitting in the left-hand cell.
    const row = line('Remain Battery: 100% Cycle Count: 8', [
      ['Remain', 0, 90], ['Battery:', 95, 190], ['100%', 195, 260],
      ['Cycle', 600, 660], ['Count:', 665, 740], ['8', 745, 780],
    ])
    const r = parseBms([row])
    expect(r.percent).toBe(100)
    expect(r.cycleCount).toBe(8)
  })

  it('handles the Arabic layout, where the value comes BEFORE its label', () => {
    const r = parseBms([line('100% الطاقة المتبقية'), line('1 الدورات')])
    expect(r.percent).toBe(100)
    expect(r.cycleCount).toBe(1)
  })

  it('still accepts a plain string, so a page with no blocks degrades rather than dies', () => {
    expect(parseBms('Cycle Count: 8').cycleCount).toBe(8)
  })
})

/**
 * The Arabic app is a CARD GRID: the reading sits on one line and its caption on the next, in
 * columns —
 *
 *     81.48V        0A        0.00W       1
 *   إجمالي الجهد    التيار     الطاقة    الدورات
 *
 * so a label and its value are NEVER in the same cell, and the same-line rule that reads the
 * English table finds absolutely nothing here. This is the layout that returned «لم نتعرّف على أي
 * حقل» from a real phone.
 */
describe('the Arabic card grid — value above, caption below', () => {
  const cards = [
    line('81.48V 0A 0.00W 1', [
      ['81.48V', 40, 150], ['0A', 250, 300], ['0.00W', 420, 520], ['1', 640, 660],
    ], 400),
    line('إجمالي الجهد التيار الطاقة الدورات', [
      ['إجمالي', 40, 100], ['الجهد', 105, 155], ['التيار', 245, 305], ['الطاقة', 420, 490], ['الدورات', 620, 700],
    ], 450),
  ]

  it('pairs the cycle count with the number in its own column', () => {
    expect(parseBms(cards).cycleCount).toBe(1)
  })

  it('does not hand a caption the number from the NEXT column', () => {
    // «الدورات» sits at x 620-700 and the 1 at 640-660; «الطاقة» sits at 420-490 over 0.00W.
    // Overlap by column is what keeps the cycle count from becoming 0.
    expect(parseBms(cards).cycleCount).not.toBe(0)
  })

  it('reads the gauge, whose caption is also underneath it', () => {
    const gauge = [
      line('100%', [['100%', 100, 220]], 100),
      line('الطاقة المتبقية', [['الطاقة', 100, 170], ['المتبقية', 175, 240]], 150),
    ]
    expect(parseBms(gauge).percent).toBe(100)
  })
})

describe('a profile picks the strategy for its app', () => {
  it('the card profile does not use same-line matching', () => {
    // `cards_ar` skips pass 1 entirely, so an inline label is NOT read by it. That is the point:
    // a profile that knows its app does not have to guess at the others.
    const inline = [line('Cycle Count: 8', [['Cycle', 0, 60], ['Count:', 65, 130], ['8', 135, 150]], 100)]
    expect(parseBms(inline, profileById('cards_ar')).cycleCount).toBeNull()
    expect(parseBms(inline, profileById('table_en')).cycleCount).toBe(8)
  })

  it('an unknown or missing profile falls back to automatic, which tries both', () => {
    const inline = [line('Cycle Count: 8', [['Cycle', 0, 60], ['Count:', 65, 130], ['8', 135, 150]], 100)]
    expect(profileById(null).id).toBe('auto')
    expect(profileById('not-a-profile').id).toBe('auto')
    expect(parseBms(inline, profileById(null)).cycleCount).toBe(8)
  })
})

/**
 * The charge is the only field the BR5 gate actually requires, and it is the one the phone missed:
 * a big number in a ring whose «%» is a small superscript the recogniser drops. Size is the signal
 * that survives when the symbol and the Arabic caption do not.
 */
describe('the charge gauge, found by how big it is printed', () => {
  const page = (gaugeText: string) => [
    line(gaugeText, [[gaugeText, 100, 260]], 200, 96),
    line('81.48V 0A 0.00W 1', [
      ['81.48V', 40, 150], ['0A', 250, 300], ['0.00W', 420, 520], ['1', 640, 660],
    ], 600, 24),
    line('إجمالي الجهد التيار الطاقة الدورات', [
      ['إجمالي', 40, 100], ['الجهد', 105, 155], ['التيار', 245, 305], ['الطاقة', 420, 490], ['الدورات', 620, 700],
    ], 640, 24),
  ]

  it('reads the gauge even when the % was never recognised', () => {
    expect(parseBms(page('100')).percent).toBe(100)
  })

  it('reads it when the % did come through', () => {
    expect(parseBms(page('85%')).percent).toBe(85)
  })

  it('does not mistake the pack voltage for a charge', () => {
    // 81.48 is ≤ 100 and would pass a naive "biggest number" rule. A charge is a whole number, so
    // the fractional pack voltage on screen must never become the state of charge.
    expect(parseBms(page('100')).percent).toBe(100)
    expect(parseBms(page('100')).percent).not.toBe(81)
  })

  it('does not promote an ordinary card number just because nothing bigger exists', () => {
    // Every word the same size ⇒ no headline ⇒ no guess. The driver types it, which is honest.
    const flat = [
      line('81.48V 0A 0.00W 1', [['81.48V', 40, 150], ['0A', 250, 300], ['0.00W', 420, 520], ['1', 640, 660]], 600, 24),
      line('إجمالي الجهد التيار الطاقة الدورات', [['إجمالي', 40, 100], ['الجهد', 105, 155], ['التيار', 245, 305], ['الطاقة', 420, 490], ['الدورات', 620, 700]], 640, 24),
    ]
    expect(parseBms(flat).percent).toBeNull()
  })
})

/**
 * «الطاقة المتبقية» is the same reading the form calls the remaining charge — and it is written
 * with ة, which OCR and writers alike interchange with ه. أ/إ/ا and ى/ي go the same way, and
 * harakat are invented and dropped at random. A label that misses by one letter misses entirely,
 * so both sides are folded to one spelling before they are compared.
 */
describe('Arabic labels survive their spelling variants', () => {
  it('reads «الطاقة المتبقية» as the charge', () => {
    expect(parseBms([line('الطاقة المتبقية 100')]).percent).toBe(100)
  })

  it('reads it spelled with ه instead of ة', () => {
    expect(parseBms([line('الطاقه المتبقيه 100')]).percent).toBe(100)
  })

  it('reads it with harakat the recogniser invented', () => {
    expect(parseBms([line('الطاقَة المتبقيَة 100')]).percent).toBe(100)
  })

  it('reads «الدورات» with tatweel stretching', () => {
    expect(parseBms([line('الــدورات 8')]).cycleCount).toBe(8)
  })
})

/**
 * The gauge, at the proportions it really has.
 *
 * «قيمة الطاقة المتبقية فوق الكلمة وهي 100%» — the reading sits ABOVE its caption, and it is
 * printed about four times the height. That size difference is what broke the first attempt at
 * this: the gap was measured centre-to-centre and compared against the CAPTION's height, so a big
 * number directly above a small word measured as "far away" and was skipped, while two lines of
 * ordinary card text measured as "close". Edge-to-edge is what actually means adjacent.
 *
 * Tesseract's block order on an RTL page is also not guaranteed to run top to bottom, so the lines
 * here are deliberately given OUT of visual order — neighbours are found by geometry, never by
 * position in the array.
 */
describe('the gauge: value above, caption below', () => {
  const gaugeAt = (value: string, gaugeY: number, gaugeH: number, labelY: number, labelH: number): OcrLine[] => [
    // Caption first, value second: the array order is wrong on purpose.
    line('الطاقة المتبقية', [['الطاقة', 120, 190], ['المتبقية', 195, 265]], labelY, labelH),
    line(value, [[value, 110, 270]], gaugeY, gaugeH),
  ]

  it('reads 100 from a gauge four times the caption’s height', () => {
    expect(parseBms(gaugeAt('100%', 150, 96, 260, 24)).percent).toBe(100)
  })

  it('reads it when the superscript % was never recognised', () => {
    expect(parseBms(gaugeAt('100', 150, 96, 260, 24)).percent).toBe(100)
  })

  it('reads a part-charged pack, where no size heuristic could guess the number', () => {
    expect(parseBms(gaugeAt('47%', 150, 96, 260, 24)).percent).toBe(47)
  })

  it('does not reach across a gap far bigger than either line', () => {
    // A number way up the page belongs to a different card, not to this caption. Written WITHOUT
    // a «%» on purpose: a lone «100%» anywhere on screen is the charge by a separate and correct
    // rule, which would mask what this test is actually about.
    expect(parseBms(gaugeAt('100', 20, 96, 900, 24)).percent).toBeNull()
  })

  it('pairs with the value ABOVE in preference to one below', () => {
    const both = [
      line('100%', [['100%', 110, 270]], 150, 96),
      line('الطاقة المتبقية', [['الطاقة', 120, 190], ['المتبقية', 195, 265]], 260, 24),
      line('47', [['47', 110, 270]], 290, 24),
    ]
    expect(parseBms(both).percent).toBe(100)
  })
})

/**
 * A gauge whose digits arrive as SEPARATE WORDS.
 *
 * Sparse-text mode does no layout analysis and readily returns isolated glyphs one at a time, so
 * «100» came off a real phone as `1`, `0`, `0`. Taking the first word gave a charge of **1** — a
 * perfectly plausible number, stored as a real reading, with nothing at all to show it was wrong.
 * That is the worst kind of failure: not a blank field, a confident lie.
 */
describe('a number split across words is rebuilt, not truncated', () => {
  const split = (glyphs: Array<[string, number, number]>): OcrLine[] => [
    line('الطاقة المتبقية', [['الطاقة', 120, 190], ['المتبقية', 195, 265]], 260, 24),
    line(glyphs.map(([g]) => g).join(''), glyphs, 150, 96),
  ]

  it('reads 100 when it arrives as 1, 0, 0', () => {
    expect(parseBms(split([['1', 110, 150], ['0', 155, 200], ['0', 205, 250]])).percent).toBe(100)
  })

  it('reads it with the % as a fourth glyph', () => {
    expect(parseBms(split([['1', 110, 150], ['0', 155, 200], ['0', 205, 250], ['%', 252, 268]])).percent).toBe(100)
  })

  it('reads a part charge split the same way', () => {
    expect(parseBms(split([['4', 110, 150], ['7', 155, 200]])).percent).toBe(47)
  })

  it('the size heuristic rebuilds the headline too, rather than reporting 1', () => {
    // No caption at all, so only the "biggest number on the page" rule can find it.
    const page = [
      line('100', [['1', 110, 150], ['0', 155, 200], ['0', 205, 250]], 150, 96),
      line('81.48V 0A 0.00W 1', [
        ['81.48V', 40, 150], ['0A', 250, 300], ['0.00W', 420, 520], ['1', 640, 660],
      ], 600, 24),
    ]
    expect(parseBms(page).percent).toBe(100)
  })
})

/**
 * The real recognitions, captured from the client's own three screenshots.
 *
 * Everything else in this file is text SHAPED like what a recogniser returns. These are what
 * tesseract actually produced, verbatim, via `node scripts/ocr-calibrate.mjs` — including the
 * mangling that made the reader fill wrong numbers on a real phone: the «%» arriving as «°» or
 * «/», and «ODO 02611 km» arriving as «ono B48 km». Re-run that script to regenerate them.
 *
 * The rule these pin: a blank field is a driver typing; a WRONG field is a lie he might submit.
 */
describe('the real screenshots, as tesseract actually read them', () => {
  // The dark English table app at psm 6 — «Remain Battery: 100°» (the % lost) and «Cycle Count: 8»
  // sharing its row with «Cycle Capacity: 436.8”».
  const EN_TABLE = `Charge: ON         Discharge: ON          Balance: OFF
83.37      0.00
Battery Power: 2."           Ave. Cell Volt.: 4.169"
Battery Capacity: 50.0”           Cell Volt. Diff.: 9.966"
Remain Capacity: 50.0"        Balance Curr.: @. 200°
Remain Battery: 100°             MOS Temp.: 33.9"
Cycle Count: 8            Cycle Capacity: 436.8”
Battery T2: 32.5         Time Emerg.: 8
Detail Logs Count: 208       Time Enter Sleep: 86466`

  it('reads the English app’s charge and cycles — the «%» came back as «°»', () => {
    const r = parseBms(EN_TABLE, profileById('table_en'))
    expect(r.percent).toBe(100)
    expect(r.cycleCount).toBe(8)
  })

  it('does not let «Cycle Capacity: 436.8» become the cycle count', () => {
    // Same row, one column over. A decimal is never a count, which is what refuses it.
    expect(parseBms(EN_TABLE, profileById('table_en')).cycleCount).not.toBe(4368)
  })

  // The cyan Arabic card app, contrast-stretched at psm 6: the gauge's «%» came back as «/».
  const AR_CARDS = ` إيقاف © :حالة التسخين       |     100/
 مفوح © 'حالة   الموازنة     1      0|
81.48V         OA         0.00W          1
            الدورات              الطاقة          التيار إجماليالجهد
    12660 60- 105:36,96 2ج ©:الوحدة`

  it('reads the Arabic gauge’s 100 — the «%» came back as «/»', () => {
    expect(parseBms(AR_CARDS, profileById('cards_ar')).percent).toBe(100)
  })

  it('reads «الدورات» — the count sits ABOVE its caption, pairable only by column', () => {
    // The card row and its captions, with the word boxes the recogniser really returns. Flat text
    // cannot express this layout at all: the value and its label are never on the same line, so
    // the count is found by the column they share. `1` is the cycle count of the client's pack.
    const cards: OcrLine[] = [
      line('81.48V OA 0.00W 1', [
        ['81.48V', 40, 150], ['OA', 250, 300], ['0.00W', 420, 520], ['1', 640, 660],
      ], 560, 26),
      line('الدورات الطاقة التيار إجماليالجهد', [
        ['الدورات', 620, 700], ['الطاقة', 420, 490], ['التيار', 245, 305], ['إجماليالجهد', 40, 155],
      ], 600, 24),
    ]
    expect(parseBms(cards, profileById('cards_ar')).cycleCount).toBe(1)
  })

  it('never reports the charge as 1 — a truncated «100» is the misread a driver was shown', () => {
    // The inverted pass of the same screenshot yielded a lone big «1». One digit beside a guessed
    // percent sign is indistinguishable from a three-digit number that lost two glyphs.
    expect(parseBms('1/ 0| 1', profileById('cards_ar')).percent).toBeNull()
  })

  it('never scavenges a temperature into the cycle count', () => {
    // «36.9°C» in a neighbouring cell rounded to 37 cycles, and 36 906 at another segmentation.
    const r = parseBms(AR_CARDS, profileById('cards_ar'))
    expect(r.cycleCount === null || r.cycleCount === 1).toBe(true)
  })

  it('refuses to invent an odometer from the glare-covered dash', () => {
    // «ODO 02611 km» through glass, outdoors. The old rule offered 48 as a distance.
    expect(parseReading('2\nMODE A\n4 ١              8\n1 Deepa\nono B48 km').odometer).toBeNull()
  })

  it('still reads a dash that IS legible', () => {
    expect(parseReading('ODO 02611 km').odometer).toBe(2611)
  })

  it('never mistakes the clock for the odometer', () => {
    // «1 00:00» is a time. Digits either side of a colon are not a distance.
    expect(parseReading('MODE 1 00:00').odometer).toBeNull()
  })
})

describe('the Yallago wallet balance (SRS D-2)', () => {
  it('reads the real sample — white on orange, Arabic-Indic digits, Arabic separators', () => {
    expect(parseWallet('٧٦،٥٠٩٬٥٥ SYP')).toBe('76509.55')
    // and it lands on the right minor-unit amount (76,509.55 × 100)
    expect(parseMinor('76509.55')).toBe(7_650_955n)
  })
  it('tolerates a label and Latin separators', () => {
    expect(parseWallet('المحفظة  76,509.55 SYP')).toBe('76509.55')
  })
  it('reads a whole number with no fraction (grouping separators are dropped)', () => {
    expect(parseWallet('١٢٣٤ SYP')).toBe('1234')
    expect(parseWallet('1,234 SYP')).toBe('1234')
  })
  it('refuses to invent when there is no number', () => {
    expect(parseWallet('SYP')).toBeNull()
    expect(parseWallet('المحفظة')).toBeNull()
  })
})

/**
 * The Yallago «Recent orders» list (SRS D-1), transcribed from the owner's two real screenshots.
 * The parser anchors on a `NNN SYP` amount with the time on the same row and groups by the
 * «Monday, 27 July» headers. It reads the FEE (BR1's number); there is no order-id or pay-mode on
 * this screen, so those are the driver's to supply.
 */
const RECENT_1 = `
Recent orders
Monday, 27 July
23:46          335 SYP
A مأكولات الشام - شارع بغداد, موقف السادات
B جسر النحاس
23:03          205 SYP
A تشيكستر, الصالحية
B (33.4973497958, 36.2750883357)
21:35          130 SYP
A مطبخ بيت الكل, القصور
B شارع بغداد
21:05          360 SYP
A عصير أورانج, القصور
B دخلة مكتب مهند العقاري entrance
`

const RECENT_2 = `
Recent orders
Tuesday, 28 July
01:47          175 SYP
A الهجرة و الجوازات
B شارع بغداد
00:38          155 SYP
A امية, الشعلان
B إبراهيم هنانو
Monday, 27 July
23:46          335 SYP
A مأكولات الشام
B جسر النحاس
`

describe('the Yallago «Recent orders» list (SRS D-1)', () => {
  it('reads the fee list, the times and the day from the first screenshot', () => {
    const orders = parseOrders(RECENT_1, 2026)
    expect(orders.map((o) => o.fee)).toEqual(['335', '205', '130', '360'])
    expect(orders[0]).toMatchObject({ time: '23:46', fee: '335', dateIso: '2026-07-27' })
    expect(orders.every((o) => o.dateIso === '2026-07-27')).toBe(true)
  })

  it('tracks the day header switching mid-list', () => {
    const orders = parseOrders(RECENT_2, 2026)
    expect(orders.map((o) => o.fee)).toEqual(['175', '155', '335'])
    expect(orders[0]!.dateIso).toBe('2026-07-28')
    expect(orders[2]!.dateIso).toBe('2026-07-27') // after the «Monday, 27 July» header
  })

  it('drops a row with no readable fee and refuses to invent from nothing', () => {
    expect(parseOrders('Recent orders\nno amounts here at all', 2026)).toEqual([])
    // a stray time with no fee produces no order
    expect(parseOrders('12:30 just a time, no SYP', 2026)).toEqual([])
  })
})
