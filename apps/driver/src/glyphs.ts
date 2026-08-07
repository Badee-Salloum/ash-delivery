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
  // Otsu, not a fixed offset from the median.
  //
  // The offset version merged glyphs, and merging is not a cosmetic problem: «−١٧٧» came back as
  // three shapes instead of four, and a reader that silently loses a digit is worse than one that
  // reads nothing. A page of black text on white has a strongly bimodal histogram, and the
  // threshold that minimises within-class variance sits in the valley between the two peaks —
  // where the strokes keep their true width — instead of part-way up the page's own slope.
  let total = 0
  for (let level = 0; level < 256; level++) total += level * histogram[level]!
  let sumBackground = 0
  let countBackground = 0
  let best = 0
  let bestVariance = -1
  for (let level = 0; level < 256; level++) {
    countBackground += histogram[level]!
    if (countBackground === 0) continue
    const countForeground = n - countBackground
    if (countForeground === 0) break
    sumBackground += level * histogram[level]!
    const meanBackground = sumBackground / countBackground
    const meanForeground = (total - sumBackground) / countForeground
    const between = countBackground * countForeground * (meanBackground - meanForeground) ** 2
    if (between > bestVariance) {
      bestVariance = between
      best = level
    }
  }

  // Which side of the cut is the ink: whichever side has FEWER pixels. Text is a minority of any
  // page, in either theme, and assuming dark-on-light returns a confidently empty page on the
  // dark-theme build of the same app.
  let below = 0
  for (let level = 0; level <= best; level++) below += histogram[level]!
  const inkIsDark = below <= n - below

  const data = new Uint8Array(n)
  for (let i = 0; i < n; i++) data[i] = (inkIsDark ? luma[i]! <= best : luma[i]! > best) ? 1 : 0
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

// ── Naming a glyph ─────────────────────────────────────────────────────────────────────────

/**
 * Weights, and why they are what they are.
 *
 * Shape carries an implicit 1; the three scalars are corrections. Aspect is scored on the LOG
 * ratio, never the raw difference: raw aspect spans 0.28 to 5.33, so a raw term would let the
 * dash's 5.16 swamp every distinction among the digits, which sit between 0.3 and 0.8. In log
 * space the dot-versus-dash gap is 1.83 while the worst same-class drift across font sizes is
 * 0.131 — a factor of fourteen.
 *
 * `relH` and `relY` are deliberately the smallest, because they are not font-invariant so much as
 * GROUP-CONTEXT features: in the date «٠٨/٠٤» the tallest thing is the slash, so every digit there
 * measures ~0.75, while in an amount the tallest thing is a digit and they measure ~0.9. Weighting
 * them heavily buys a beautiful same-font score and collapses across font sizes — which is the one
 * thing this reader must not do, since «٨» is learnt entirely at one size.
 */
const W_ASPECT = 0.35
const W_RELH = 0.25
const W_RELY = 0.15

/**
 * The two conditions a reading must satisfy, and they are NOT interchangeable.
 *
 * A score alone does not mean recognition — it means "nothing else is nearby". Measured against
 * ink whose class is missing from the templates entirely, the best score runs as low as 0.35,
 * BELOW the worst score of a correct answer: no score threshold can separate them, because the
 * two populations overlap the wrong way round. That is precisely the shape of «−٥٢ read as −07».
 *
 * The MARGIN is what carries the safety. A glyph the templates genuinely know sits far from its
 * runner-up; ink they do not know sits between two equally poor guesses. Under adversarial
 * re-measurement the pair below produced zero accepted-but-wrong answers across a
 * production-difficulty cross-font split, a six-thousand-context sweep and 2–10% pixel noise.
 * It costs roughly one correct glyph in seven. On money that is the right side of the trade.
 */
const MAX_SCORE = 0.47
const MIN_MARGIN = 0.1

/**
 * Classes whose templates are not yet backed by enough DISTINCT renderings to be trusted with money.
 *
 * «٨» is the reason this exists: it appears in no amount on the sampled day, so its template comes
 * entirely from the date «٠٨/٠٤» — twenty-two rows of the same two renderings, at a smaller size
 * than any amount. Two independent reviews reached the same conclusion: the decisive test has not
 * been run, and until a real amount containing an «٨» is photographed it cannot be. «٩» is barely
 * better — one amount-font sample and two renderings in all.
 *
 * The separator marks were quarantined too, and are not any more. Against the real screenshots they
 * matched at scores of 0.03 and 0.00 with margins of 0.47 and 0.55 — an order of magnitude clear of
 * what the gate demands — while the dangerous direction, a trailing zero mistaken for a decimal
 * point, was independently refused on score. The gate is doing that work; the quarantine was only
 * costing two rows that the reader in fact knew perfectly.
 *
 * A quarantined class is never ANSWERED: the glyph is refused and the driver types that row. Delete
 * an entry the moment real screenshots carry it, then re-harvest and regenerate the templates.
 */
export const UNVALIDATED: ReadonlySet<string> = new Set(['8', '9'])

export interface Template {
  readonly label: string
  readonly bits: Uint8Array
  readonly logAspect: number
  readonly relH: number
  readonly relY: number
}

/** Unpack the shipped hex form — four pixels per hex digit — into a grid. */
export function unpackTemplates(
  raw: readonly { label: string; hex: string; aspect: number; relH: number; relY: number }[],
): Template[] {
  return raw.map((t) => {
    const bits = new Uint8Array(GW * GH)
    for (let i = 0; i < t.hex.length; i++) {
      const nibble = parseInt(t.hex[i]!, 16)
      for (let b = 0; b < 4; b++) bits[i * 4 + b] = (nibble >> (3 - b)) & 1
    }
    return { label: t.label, bits, logAspect: Math.log(t.aspect), relH: t.relH, relY: t.relY }
  })
}

export interface Reading {
  readonly label: string
  readonly score: number
  readonly runnerUp: string | null
  readonly margin: number
}

/** The nearest template, with the runner-up — the runner-up is what makes refusal possible. */
export function nearestTemplate(f: GlyphFeatures, templates: readonly Template[]): Reading | null {
  if (templates.length === 0) return null
  const logAspect = Math.log(f.aspect)
  let best: Template | null = null
  let bestScore = Infinity
  let secondLabel: string | null = null
  let secondScore = Infinity
  for (const t of templates) {
    let differing = 0
    for (let i = 0; i < t.bits.length; i++) if (f.bits[i] !== t.bits[i]) differing++
    const score =
      differing / (GW * GH) +
      W_ASPECT * Math.abs(logAspect - t.logAspect) +
      W_RELH * Math.abs(f.relH - t.relH) +
      W_RELY * Math.abs(f.relY - t.relY)
    if (score < bestScore) {
      secondScore = bestScore
      secondLabel = best?.label ?? null
      bestScore = score
      best = t
    } else if (score < secondScore) {
      secondScore = score
      secondLabel = t.label
    }
  }
  if (!best) return null
  return { label: best.label, score: bestScore, runnerUp: secondLabel, margin: secondScore - bestScore }
}

/** The name of a glyph, or `null` — which means "type this one", never "here is my best guess". */
export function classifyGlyph(f: GlyphFeatures, templates: readonly Template[]): Reading | null {
  const r = nearestTemplate(f, templates)
  if (!r) return null
  if (r.score >= MAX_SCORE || r.margin <= MIN_MARGIN) return null
  if (UNVALIDATED.has(r.label)) return null
  return r
}

/**
 * Every glyph in a box, read left to right — or `null` if ANY of them was refused.
 *
 * All or nothing per row, deliberately. Half an amount is not a smaller amount, it is a different
 * one: dropping a refused glyph from «١٦٥» yields «١٦», which is a plausible fee and wrong by an
 * order of magnitude. A row the reader will not vouch for entirely, it does not offer at all.
 */
export function readGlyphRow(mask: Mask, box: Box, templates: readonly Template[]): string | null {
  const comps = componentsIn(mask, box)
  if (comps.length === 0) return null
  const group = groupMetrics(comps)
  let out = ''
  for (const c of comps) {
    const r = classifyGlyph(featuresOf(c, group), templates)
    if (!r) return null
    out += r.label
  }
  return out
}
