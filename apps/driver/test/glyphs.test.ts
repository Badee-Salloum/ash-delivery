import { describe, expect, it } from 'vitest'
import { type Mask, componentsIn, featuresOf, groupMetrics, maskFromPixels } from '../src/glyphs.ts'

/**
 * The segmenter, tested on hand-built masks rather than photographs.
 *
 * Whether Tesseract can find «SYP» on a given phone is a calibration question no unit test can
 * answer (scripts/ocr-calibrate.mjs does that against the real screenshots). What a test CAN pin
 * is that a known arrangement of ink comes back as the right number of glyphs, in the right order,
 * described in a way that does not change when the font size does.
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

describe('finding the glyphs', () => {
  it('separates ink that does not touch, left to right', () => {
    const m = mask([
      '##...##...##',
      '##...##...##',
      '##...##...##',
    ])
    const comps = componentsIn(m, ALL(m))
    expect(comps).toHaveLength(3)
    expect(comps.map((c) => c.x0)).toEqual([0, 5, 10])
  })

  it('joins ink that touches only at a corner — a stroke is one glyph, not two', () => {
    const m = mask([
      '###...',
      '###...',
      '###...',
      '...###',
      '...###',
      '...###',
    ])
    expect(componentsIn(m, ALL(m))).toHaveLength(1)
  })

  it('drops speckle but keeps a dot — «٠» is a 3×3 dot and must survive', () => {
    const m = mask([
      '###...#',
      '###....',
      '###....',
    ])
    const comps = componentsIn(m, ALL(m))
    expect(comps).toHaveLength(1)
    expect(comps[0]!.pixels).toBe(9)
  })

  it('reads only inside the box it was given', () => {
    const m = mask([
      '###...###',
      '###...###',
      '###...###',
    ])
    expect(componentsIn(m, { x0: 0, y0: 0, x1: 5, y1: 3 })).toHaveLength(1)
  })

  it('survives a long run of ink without recursing to death', () => {
    // A dash across a full-width screenshot. The flood fill is iterative precisely for this.
    const wide = '#'.repeat(4000)
    const m = mask([wide, wide, wide])
    const comps = componentsIn(m, ALL(m))
    expect(comps).toHaveLength(1)
    expect(comps[0]!.pixels).toBe(12_000)
  })
})

describe('describing a glyph so its size does not matter', () => {
  /** The same shape — a solid square — drawn small and drawn large. */
  const small = mask(['.###.', '.###.', '.###.'])
  const large = mask(['..######..', '..######..', '..######..', '..######..', '..######..', '..######..'])

  it('gives the same shape grid at either size', () => {
    const a = componentsIn(small, ALL(small))[0]!
    const b = componentsIn(large, ALL(large))[0]!
    expect(Array.from(a.bits)).toEqual(Array.from(b.bits))
  })

  it('measures height against the tallest glyph beside it, not in pixels', () => {
    // A dot next to a tall stroke: the dot is a quarter of the line's height, at any font size.
    const line = mask([
      '#..###',
      '#..###',
      '#.....',
      '#.....',
      '#.....',
      '#.....',
      '#.....',
      '#.....',
    ])
    const comps = componentsIn(line, ALL(line))
    const group = groupMetrics(comps)
    const [stroke, dot] = comps
    expect(featuresOf(stroke!, group).relH).toBe(1)
    expect(featuresOf(dot!, group).relH).toBe(0.25)
  })

  it('separates a dot from a dash by aspect — their SHAPES are identical once stretched', () => {
    // This pair is why shape alone cannot be the whole answer: both are a solid block in the grid.
    const m = mask([
      '###....############',
      '###....############',
      '###................',
    ])
    const [dot, dash] = componentsIn(m, ALL(m))
    const group = groupMetrics([dot!, dash!])
    expect(Array.from(featuresOf(dot!, group).bits)).toEqual(Array.from(featuresOf(dash!, group).bits))
    expect(featuresOf(dot!, group).aspect).toBe(1)
    expect(featuresOf(dash!, group).aspect).toBe(6)
  })

  it('places a low mark below a full-height one', () => {
    const m = mask([
      '#.....',
      '#.....',
      '#.....',
      '#.....',
      '#..###',
      '#..###',
    ])
    const comps = componentsIn(m, ALL(m))
    const group = groupMetrics(comps)
    expect(featuresOf(comps[1]!, group).relY).toBeGreaterThan(featuresOf(comps[0]!, group).relY)
  })
})

describe('deciding which way round the ink is', () => {
  const px = (values: readonly number[]): Uint8ClampedArray => {
    const out = new Uint8ClampedArray(values.length * 4)
    values.forEach((v, i) => {
      out[i * 4] = v
      out[i * 4 + 1] = v
      out[i * 4 + 2] = v
      out[i * 4 + 3] = 255
    })
    return out
  }

  it('reads dark text on a light page', () => {
    const m = maskFromPixels(px([255, 255, 10, 255, 255, 255]), 6, 1)
    expect(Array.from(m.data)).toEqual([0, 0, 1, 0, 0, 0])
  })

  it('reads light text on a dark page — a dark-theme build is the same screen', () => {
    // Assuming one polarity is how a reader returns a confidently empty page on half the phones.
    const m = maskFromPixels(px([5, 5, 250, 5, 5, 5]), 6, 1)
    expect(Array.from(m.data)).toEqual([0, 0, 1, 0, 0, 0])
  })
})
