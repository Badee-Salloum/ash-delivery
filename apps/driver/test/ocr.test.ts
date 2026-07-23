import { describe, expect, it } from 'vitest'
import { type OcrLine, parseBms, parseReading, profileById } from '../src/ocr.ts'

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

  it('scales capacities to deci-amp-hours, never a float', () => {
    expect(r.remainCapacityDah).toBe(500) // 50.0 Ah
    expect(r.fullCapacityDah).toBe(500)
    expect(Number.isInteger(r.remainCapacityDah)).toBe(true)
  })

  it('reads the cycle count — the number that says how tired the pack is', () => {
    expect(r.cycleCount).toBe(8)
  })

  it('takes the pack voltage, not a cell voltage', () => {
    // 4.169 V is a CELL; 83.37 V is the pack. Picking the first voltage on screen would be wrong
    // by a factor of twenty.
    expect(r.packMillivolts).toBe(83_370)
  })

  it('scales temperatures to deci-Celsius', () => {
    expect(r.mosTempDc).toBe(339) // 33.9 °C
    expect(r.t2Dc).toBe(325) // 32.5 °C
  })

  it('does not mistake Cycle Capacity for the pack capacity', () => {
    // 436.8 Ah appears on the same screen and is not a capacity reading at all.
    expect(r.fullCapacityDah).not.toBe(4368)
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

  it('finds the pack voltage', () => {
    expect(r.packMillivolts).toBe(81_480)
  })

  it('finds the cycle count from the Arabic label', () => {
    expect(r.cycleCount).toBe(1)
  })
})

describe('it refuses to invent a reading', () => {
  it('returns nulls for text that contains no BMS fields at all', () => {
    const r = parseBms('the quick brown fox\nno numbers here')
    expect(r).toEqual({
      percent: null,
      packMillivolts: null,
      cycleCount: null,
      remainCapacityDah: null,
      fullCapacityDah: null,
      mosTempDc: null,
      t1Dc: null,
      t2Dc: null,
    })
  })

  it('drops an impossible value rather than storing it', () => {
    // A misread that puts the charge at 900% is not a reading. Leaving it null makes the gate
    // ask for it, which is right; storing it would look like an answer the driver gave.
    expect(parseBms('Remain Battery: 900%').percent).toBeNull()
  })

  it('ignores a cell voltage masquerading as a pack voltage', () => {
    expect(parseBms('Ave. Cell Volt.: 4.169V').packMillivolts).toBeNull()
  })

  it('reads Arabic-Indic numerals, in case the app renders them', () => {
    expect(parseBms('Cycle Count: ٨').cycleCount).toBe(8)
  })
})

describe('the dashboard reader still works, and no longer eats a matching odometer', () => {
  it('reads battery and odometer', () => {
    expect(parseReading('85% 12345')).toEqual({ battery: 85, odometer: 12345 })
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
const line = (text: string, words: Array<[string, number, number]> = [], y?: number): OcrLine => {
  const y0 = y ?? (nextY += 40)
  return { text, y0, y1: y0 + 30, words: words.map(([w, x0, x1]) => ({ text: w, x0, x1 })) }
}

describe('lines from the recogniser, not a split of the flat text', () => {
  it('reads a single-column line', () => {
    expect(parseBms([line('Cycle Count: 8')]).cycleCount).toBe(8)
  })

  it('splits a TWO-COLUMN row using the gap between words, not the collapsed spaces', () => {
    // The recognised line text loses the gutter; only the word boxes still know where it was.
    // Without it, `MOS Temp` would take the 100 sitting in the left-hand cell.
    const row = line('Remain Battery: 100% MOS Temp: 33.9C', [
      ['Remain', 0, 90], ['Battery:', 95, 190], ['100%', 195, 260],
      ['MOS', 600, 660], ['Temp:', 665, 740], ['33.9C', 745, 820],
    ])
    const r = parseBms([row])
    expect(r.percent).toBe(100)
    expect(r.mosTempDc).toBe(339)
  })

  it('handles the Arabic layout, where the value comes BEFORE its label', () => {
    const r = parseBms([line('100% الطاقة المتبقية'), line('1 الدورات')])
    expect(r.percent).toBe(100)
    expect(r.cycleCount).toBe(1)
  })

  it('still accepts a plain string, so a page with no blocks degrades rather than dies', () => {
    expect(parseBms('Cycle Count: 8').cycleCount).toBe(8)
  })

  it('does not let a label’s own digit become the value', () => {
    // «Battery T2» — the 2 belongs to the label. This read 2 °C before the value was taken from
    // what remains after the label is removed.
    expect(parseBms([line('Battery T2: 32.5C')]).t2Dc).toBe(325)
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

  it('pairs the pack voltage with «إجمالي الجهد»', () => {
    expect(parseBms(cards).packMillivolts).toBe(81_480)
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

  it('reads the inline temperature row on the same screen', () => {
    const temps = line('MOS: 36.9℃ T1: 33.7℃ T2: 33.6℃', [
      ['MOS:', 40, 110], ['36.9℃', 115, 210],
      ['T1:', 300, 340], ['33.7℃', 345, 440],
      ['T2:', 530, 570], ['33.6℃', 575, 670],
    ], 800)
    const r = parseBms([temps])
    expect(r.mosTempDc).toBe(369)
    expect(r.t1Dc).toBe(337)
    expect(r.t2Dc).toBe(336)
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
