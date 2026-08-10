import { describe, expect, it } from 'vitest'
import {
  type Mask,
  type Template,
  classifyGlyph,
  componentsIn,
  featuresOf,
  groupMetrics,
  mergeStacked,
  readGlyphRow,
  unpackTemplates,
  withoutRules,
  AMOUNT_ALPHABET,
  GW,
  GH,
} from '../src/glyphs.ts'
import { GLYPH_TEMPLATES } from '../src/glyph-templates.ts'

/**
 * `readGlyphRow` and `classifyGlyph` — the two functions that decide what a fee IS — had no unit
 * test at all until a driver's ٢٣٥ SYP fare was accepted as «1105».
 *
 * The mechanism: a refused component used to be split at its thinnest column, each half
 * re-segmented, and EVERY resulting piece read and concatenated, recursively. Nothing tied the
 * output length to the number of glyphs on screen, so one refused shape could emit four digits.
 * These tests pin the invariant that replaced it — **one component, one character** — and they pin
 * it structurally, so no future gate tuning can reopen the hole.
 */

/** Build a mask from an ASCII picture: `#` is ink, anything else is page. */
function mask(rows: readonly string[]): Mask {
  const height = rows.length
  const width = Math.max(...rows.map((r) => r.length))
  const data = new Uint8Array(width * height)
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') data[y * width + x] = 1
  })
  return { data, width, height }
}

const ALL = (m: Mask) => ({ x0: 0, y0: 0, x1: m.width, y1: m.height })

/** A template that matches `component` of `m` exactly, labelled as asked. */
function templateOf(m: Mask, index: number, label: string): Template {
  const comps = componentsIn(m, ALL(m))
  const group = groupMetrics(comps)
  const f = featuresOf(comps[index]!, group)
  return { label, bits: f.bits, logAspect: Math.log(f.aspect), relH: f.relH, relY: f.relY }
}

const ALPHABET = new Set([...'0123456789'])

describe('one component, one character — the invariant that replaced the split', () => {
  /**
   * THE «1105» CASE, in miniature.
   *
   * A wide blob that matches nothing. Under the old code it was split at its ink valley, and each
   * half re-segmented into further pieces, every one of which was read and concatenated — so this
   * single component could return a multi-digit string. Now an unrecognised component refuses the
   * whole row, whatever its shape, and no amount of internal structure changes that.
   */
  it('never returns more characters than there is ink to justify — against the REAL templates', () => {
    // Random ink, scored by the templates the app actually ships. Whatever comes back must account
    // for itself: one character per connected component, or nothing at all.
    //
    // This is the property the «1105» bug violated. A refused component was split at its ink
    // valley and every resulting fragment read and concatenated, so a row of three shapes could
    // return four digits — and the extra digit was manufactured, not seen. Random smudges are
    // exactly the input that used to produce them: ink the classifier refuses, wide enough to cut.
    const real = unpackTemplates(GLYPH_TEMPLATES)
    const digits = real.filter((t) => /[0-9]/.test(t.label))

    /** Paint template bitmaps into one mask, side by side, `gap` blank columns between them. */
    const painted = (chosen: readonly Template[], gap: number): Mask => {
      const width = chosen.length * GW + Math.max(0, chosen.length - 1) * gap
      const data = new Uint8Array(width * GH)
      chosen.forEach((t, n) => {
        const originX = n * (GW + gap)
        for (let y = 0; y < GH; y++) {
          for (let x = 0; x < GW; x++) {
            if (t.bits[y * GW + x] === 1) data[y * width + originX + x] = 1
          }
        }
      })
      return { data, width, height: GH }
    }

    let readsSeen = 0
    let mergedSeen = 0
    for (let i = 0; i < digits.length; i++) {
      for (const gap of [0, 1, 3]) {
        // A pair of real digit shapes. `gap: 0` is the case that matters — two glyphs whose ink
        // touches become ONE component, which is precisely what the old splitter existed to
        // "rescue" and precisely how it manufactured a digit that was never on the screen.
        const pair = [digits[i]!, digits[(i * 7 + 3) % digits.length]!]
        const m = painted(pair, gap)
        const comps = mergeStacked(m, withoutRules(componentsIn(m, ALL(m))))
        if (comps.length === 0) continue
        if (comps.length < pair.length) mergedSeen++
        const out = readGlyphRow(m, ALL(m), real, AMOUNT_ALPHABET)
        if (out === null) continue
        readsSeen++
        expect(out.length, `read «${out}» from ${comps.length} component(s), gap ${gap}`).toBe(comps.length)
      }
    }
    // Both must have actually happened, or the assertion above proved nothing. A vacuous pass is
    // worse than no test: it reads as coverage.
    expect(readsSeen, 'no row was ever read — the property was never exercised').toBeGreaterThan(0)
    expect(mergedSeen, 'no two glyphs ever merged — the split case was never reached').toBeGreaterThan(0)
  })

  it('reads exactly one character per component when every one is recognised', () => {
    const m = mask([
      '##..##',
      '##..##',
      '##..##',
      '##..##',
    ])
    const t0 = templateOf(m, 0, '7')
    const t1 = templateOf(m, 1, '7')
    const out = readGlyphRow(m, ALL(m), [t0, t1], ALPHABET)
    expect(out).toBe('77')
    expect(out).toHaveLength(componentsIn(m, ALL(m)).length)
  })

  it('refuses the WHOLE row when a single glyph is unrecognised — half an amount is a different amount', () => {
    const m = mask([
      '##..##..#####',
      '##..##..#...#',
      '##..##..#####',
      '##..##..#...#',
    ])
    const known = templateOf(m, 0, '1')
    // The third shape has no template. The first two are perfect matches, and the row still refuses:
    // «١٦٥» minus its last glyph is «١٦», a plausible fee that is wrong by an order of magnitude.
    expect(readGlyphRow(m, ALL(m), [known], ALPHABET)).toBeNull()
  })

  it('property: on any recognised row, output length === component count', () => {
    for (const gaps of [1, 2, 3, 4]) {
      const cell = '##' + '.'.repeat(gaps)
      const m = mask([cell.repeat(5), cell.repeat(5), cell.repeat(5), cell.repeat(5)])
      const comps = componentsIn(m, ALL(m))
      const templates = comps.map((_, i) => templateOf(m, i, '3'))
      const out = readGlyphRow(m, ALL(m), templates, ALPHABET)
      expect(out).not.toBeNull()
      expect(out!).toHaveLength(comps.length)
    }
  })
})

describe('classifyGlyph — the two gates', () => {
  const m = mask(['####', '#..#', '#..#', '####'])
  const comps = componentsIn(m, ALL(m))
  const group = groupMetrics(comps)
  const f = featuresOf(comps[0]!, group)

  it('accepts an exact match with no rival', () => {
    const exact: Template = { label: '0', bits: f.bits, logAspect: Math.log(f.aspect), relH: f.relH, relY: f.relY }
    const r = classifyGlyph(f, [exact])
    expect(r?.label).toBe('0')
  })

  it('refuses when the nearest template is too far — MAX_SCORE', () => {
    // Every bit inverted: as distant as a 12×16 grid can be.
    const far: Template = {
      label: '0',
      bits: Uint8Array.from(f.bits, (b) => (b === 1 ? 0 : 1)),
      logAspect: Math.log(f.aspect),
      relH: f.relH,
      relY: f.relY,
    }
    expect(classifyGlyph(f, [far])).toBeNull()
  })

  it('refuses when two DIFFERENT labels fit almost equally well — MIN_MARGIN', () => {
    // The runner-up is the nearest template of another label, so an ambiguous shape refuses even
    // though its best match is close. This is «٢» vs «٣», the pair that causes every real refusal.
    const exact: Template = { label: '2', bits: f.bits, logAspect: Math.log(f.aspect), relH: f.relH, relY: f.relY }
    const rival: Template = { label: '3', bits: f.bits, logAspect: Math.log(f.aspect), relH: f.relH, relY: f.relY }
    expect(classifyGlyph(f, [exact, rival])).toBeNull()
  })

  it('a second template of the SAME label is not a rival — sub-templates must not eat their own margin', () => {
    const exact: Template = { label: '2', bits: f.bits, logAspect: Math.log(f.aspect), relH: f.relH, relY: f.relY }
    const sibling: Template = { label: '2', bits: f.bits, logAspect: Math.log(f.aspect) + 0.01, relH: f.relH, relY: f.relY }
    expect(classifyGlyph(f, [exact, sibling])?.label).toBe('2')
  })

  it('respects the alphabet: a clock template cannot spell a fee', () => {
    const colon: Template = { label: ':', bits: f.bits, logAspect: Math.log(f.aspect), relH: f.relH, relY: f.relY }
    // ':' is not in AMOUNT_ALPHABET, so the row has no usable template and refuses.
    expect(readGlyphRow(m, ALL(m), [colon], ALPHABET)).toBeNull()
  })
})
