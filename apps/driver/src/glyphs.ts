/**
 * Reading Arabic-Indic digits off the delivery app's screens, ourselves.
 *
 * Tesseract cannot do it. Not the model we ship, not the standard one, not `script/Arabic`, and
 * `tessdata_best` will not run in tesseract.js at all. Across every page-segmentation mode, every
 * preprocessing variant, an isolated amount column at 4x and a single amount at 5x, the best result
 * on eleven known amounts was ZERO — and the failure is not merely noisy, it is unrecoverable:
 * «٢» and «٣» both come back "Y", «١» and «٦» both "\". No table gets −26 back from −36.
 *
 * What Tesseract IS good at here is finding the word «SYP» — plain ASCII, read correctly on 11 rows
 * of 11, on every pass. So it is used for LAYOUT ONLY. It anchors the row and hands over the font
 * size for free in its own cap height; the amount is the ink immediately to its left; and those
 * glyphs are cut out as connected components and classified against templates learnt from real
 * screenshots. On the sample day that segmentation is exact on 34 rows of 34, including
 * «−١٬١٥٥٫٦٥», which splits into all nine of its pieces.
 *
 * Everything in this file is PURE and works on a plain ink mask, so it is tested without a DOM.
 */

/** The grid every glyph's own bounding box is stretched into. Scale-free by construction. */
export const GW = 12
export const GH = 16

/** A binary ink mask: 1 where there is ink. */
export interface Mask {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

export interface Box {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

export interface Component extends Box {
  readonly pixels: number
  /** The glyph's own box, stretched into GW×GH. */
  readonly bits: Uint8Array
}

/** What the glyphs standing together on one line look like as a whole. */
export interface GroupMetrics {
  readonly tallest: number
  readonly top: number
  readonly height: number
}

/**
 * A glyph as the classifier sees it. Every feature is SCALE-FREE, which is what lets a template
 * learnt from a 12-pixel date digit match the same digit printed at 19 pixels in an amount — and
 * that matters more than it sounds: «٨» appears in NO amount on the sampled day, only in the date,
 * so without cross-font transfer roughly a quarter of real amounts would be unreadable.
 */
export interface GlyphFeatures {
  readonly bits: Uint8Array
  /** Wide-and-flat («−») against narrow-and-tall («١»). The cheapest discriminator there is. */
  readonly aspect: number
  /** Height against the tallest glyph beside it, so the font size cancels. */
  readonly relH: number
  /** Where it sits on the line: a zero is mid-height, a decimal mark hangs at the bottom. */
  readonly relY: number
}

/**
 * Build an ink mask, choosing the polarity from the image itself.
 *
 * The screens are dark text on white today, but a dark-theme build of the same app is light on
 * black, and a reader that assumes one of the two silently returns an empty page on the other.
 * The background is whatever most of the pixels are; ink is what stands clear of it.
 */
export function maskFromPixels(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Mask {
  const n = width * height
  const luma = new Uint8Array(n)
  const histogram = new Uint32Array(256)
  for (let i = 0; i < n; i++) {
    const p = i * 4
    const y = (rgba[p]! * 299 + rgba[p + 1]! * 587 + rgba[p + 2]! * 114) / 1000
    const level = y < 0 ? 0 : y > 255 ? 255 : Math.round(y)
    luma[i] = level
    histogram[level]!++
  }
  // The median, not the mean: a page that is mostly white with a black header has a mean pulled
  // somewhere between the two, and a threshold there is ink everywhere or nowhere.
  let seen = 0
  let median = 128
  for (let level = 0; level < 256; level++) {
    seen += histogram[level]!
    if (seen >= n / 2) {
      median = level
      break
    }
  }
  const darkOnLight = median > 127
  const cut = darkOnLight ? median - 40 : median + 40
  const data = new Uint8Array(n)
  for (let i = 0; i < n; i++) data[i] = (darkOnLight ? luma[i]! < cut : luma[i]! > cut) ? 1 : 0
  return { data, width, height }
}

/** Ink pixels smaller than this are speckle — but «٠» is a 3×3 dot, so the floor stays low. */
const MIN_PIXELS = 5

/**
 * Connected components (8-neighbour) inside a box, ordered left to right.
 *
 * Iterative, never recursive: a long dash on a high-resolution screenshot is thousands of pixels,
 * and a recursive flood fill blows the stack on exactly the glyph that is easiest to read.
 */
export function componentsIn(mask: Mask, box: Box): Component[] {
  const x0 = Math.max(0, Math.trunc(box.x0))
  const y0 = Math.max(0, Math.trunc(box.y0))
  const x1 = Math.min(mask.width, Math.trunc(box.x1))
  const y1 = Math.min(mask.height, Math.trunc(box.y1))
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return []

  const seen = new Uint8Array(w * h)
  const at = (x: number, y: number): number => mask.data[(y0 + y) * mask.width + (x0 + x)] ?? 0
  const out: Component[] = []
  const stack: number[] = []

  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const start = sy * w + sx
      if (at(sx, sy) === 0 || seen[start]) continue
      let minX = sx
      let maxX = sx
      let minY = sy
      let maxY = sy
      let pixels = 0
      stack.length = 0
      stack.push(start)
      seen[start] = 1
      while (stack.length > 0) {
        const p = stack.pop()!
        const y = (p / w) | 0
        const x = p % w
        pixels++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
            const q = ny * w + nx
            if (!seen[q] && at(nx, ny) === 1) {
              seen[q] = 1
              stack.push(q)
            }
          }
        }
      }
      if (pixels < MIN_PIXELS) continue
      out.push({
        x0: x0 + minX,
        y0: y0 + minY,
        x1: x0 + maxX,
        y1: y0 + maxY,
        pixels,
        bits: stretch(mask, x0 + minX, y0 + minY, x0 + maxX, y0 + maxY),
      })
    }
  }
  return out.sort((a, b) => a.x0 - b.x0)
}

/** The glyph's own box, sampled into the fixed grid — this is what makes the shape scale-free. */
function stretch(mask: Mask, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const gw = x1 - x0 + 1
  const gh = y1 - y0 + 1
  const bits = new Uint8Array(GW * GH)
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const sx = x0 + Math.min(gw - 1, Math.floor((x * gw) / GW))
      const sy = y0 + Math.min(gh - 1, Math.floor((y * gh) / GH))
      bits[y * GW + x] = mask.data[sy * mask.width + sx] ?? 0
    }
  }
  return bits
}

export function groupMetrics(comps: readonly Component[]): GroupMetrics {
  if (comps.length === 0) return { tallest: 1, top: 0, height: 1 }
  let tallest = 1
  let top = Infinity
  let bottom = -Infinity
  for (const c of comps) {
    tallest = Math.max(tallest, c.y1 - c.y0 + 1)
    top = Math.min(top, c.y0)
    bottom = Math.max(bottom, c.y1)
  }
  return { tallest, top, height: Math.max(1, bottom - top) }
}

export function featuresOf(c: Component, group: GroupMetrics): GlyphFeatures {
  const w = c.x1 - c.x0 + 1
  const h = c.y1 - c.y0 + 1
  return {
    bits: c.bits,
    aspect: w / h,
    relH: h / group.tallest,
    relY: ((c.y0 + c.y1) / 2 - group.top) / group.height,
  }
}
