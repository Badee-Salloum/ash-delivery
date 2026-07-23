import { describe, expect, it } from 'vitest'
import { type OcrLine, parseBms, parseReading } from '../src/ocr.ts'

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
const line = (text: string, words: Array<[string, number, number]> = []): OcrLine => ({
  text,
  words: words.map(([w, x0, x1]) => ({ text: w, x0, x1 })),
})

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
