#!/usr/bin/env node
/**
 * Turn the harvested glyphs into the templates the driver app ships.
 *
 *   node scripts/glyph-templates.mjs   # glyphs.json → apps/driver/src/glyph-templates.ts
 *
 * Averaged per class: the bitmap thresholded at half, and the mean of the three scale-free
 * scalars. The bitmap travels as hex — 192 bits is 48 characters — because a literal array of
 * 192 numbers per class is 3,000 lines of noise in a source file nobody can review.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const data = JSON.parse(readFileSync(join(root, 'apps/driver/test/fixtures/ocr/glyphs.json'), 'utf8'))

const byLabel = new Map()
for (const s of data.samples) {
  if (!byLabel.has(s.label)) byLabel.set(s.label, [])
  byLabel.get(s.label).push(s)
}

/** Fraction of grid cells on which two samples disagree. */
function bitDistance(a, b) {
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d / a.length
}

/**
 * Split a class's samples into up to `MAX_SUBS` clusters of genuinely similar renderings.
 *
 * ONE averaged prototype per class is measurably too few: the same digit is printed at several
 * display scales, and averaging «٣»'s two top humps across scales blurs it toward «٢» — a real
 * «٣» then lands almost equally far from the blurred «٣» and the sharper «٢», the margin
 * collapses to 0.002, and the reader refuses a glyph it has ample evidence for.
 *
 * TWO PROPERTIES ARE LOAD-BEARING, and the first version of this had neither.
 *
 * AVERAGE LINKAGE, not the distance between recomputed cluster MEANS. Mean-linkage is
 * rich-get-richer: each round the big cluster's mean sits nearest everything, so it swallows the
 * next sample, and «٣»'s seventeen samples across nine distinct renderings collapsed to
 * «15, 1, 1» while «٢» kept a balanced «11, 6». That asymmetry IS the starved margin.
 *
 * NO SAMPLE IS EVER DISCARDED. The earlier code dropped clusters of one as "a single sighting,
 * maybe noise" — and the two it dropped from «٣» were the sharp renderings, the ones furthest
 * from the blur, which is exactly why they were still alone. A rendering the screen produces once
 * is a rendering the screen produces.
 */
const MAX_SUBS = 6

function clusterSamples(group) {
  const clusters = group.map((s) => [s])
  // Pairwise distances between SAMPLES, computed once; average linkage is their mean across the
  // two clusters, which no amount of merging can distort the way a recomputed mean can.
  const between = (a, b) => {
    let total = 0
    for (const x of a) for (const y of b) total += bitDistance(x.bits, y.bits)
    return total / (a.length * b.length)
  }
  while (clusters.length > MAX_SUBS) {
    let bi = 0
    let bj = 1
    let best = Infinity
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const d = between(clusters[i], clusters[j])
        if (d < best) {
          best = d
          bi = i
          bj = j
        }
      }
    clusters[bi] = [...clusters[bi], ...clusters[bj]]
    clusters.splice(bj, 1)
  }
  return clusters
}

/** Build up to MAX_SUBS averaged templates per class from whichever samples the caller chose. */
function buildRows(pick) {
  const rows = []
  for (const [label, all] of [...byLabel.entries()].sort()) {
    const group = pick(all)
    if (group.length === 0) continue
    for (const cluster of clusterSamples(group)) {
      const acc = new Float64Array(data.gw * data.gh)
      let aspect = 0
      let relH = 0
      let relY = 0
      for (const s of cluster) {
        for (let i = 0; i < acc.length; i++) acc[i] += s.bits[i]
        aspect += s.aspect
        relH += s.relH
        relY += s.relY
      }
      const n = cluster.length
      let hex = ''
      for (let i = 0; i < acc.length; i += 4) {
        let nibble = 0
        for (let b = 0; b < 4; b++) if ((acc[i + b] ?? 0) / n >= 0.5) nibble |= 1 << (3 - b)
        hex += nibble.toString(16)
      }
      rows.push({
        label,
        n,
        distinct: new Set(cluster.map((s) => s.bits.join(''))).size,
        fonts: [...new Set(cluster.map((s) => s.font))].sort().join('+'),
        hex,
        aspect: +(aspect / n).toFixed(4),
        relH: +(relH / n).toFixed(4),
        relY: +(relY / n).toFixed(4),
      })
    }
  }
  return rows
}

/*
 * TWO SETS, because these are averaged prototypes and the two screens are printed at different
 * sizes. Pooling them blurs both: harvesting the clock dropped the amounts from 31 rows to 26 with
 * nothing read wrongly — the prototypes had merely drifted between the two renderings and lost
 * margin — and sharpening them back for the amounts then made the clock unreadable outright.
 * Each region is scored against prototypes drawn from its own font, and a class with too few
 * samples there falls back to everything, which is how «٨» reaches the amounts at all.
 */
const amountRows = buildRows((all) => {
  const own = all.filter((s) => s.font === 'amount')
  return own.length >= 3 ? own : all
})
const clockRows = buildRows((all) => {
  const own = all.filter((s) => s.font === 'date')
  return own.length >= 3 ? own : all
})

const bodyOf = (rows) => rows
  .map(
    (r) =>
      `  // ${String(r.n).padStart(3)} samples, ${String(r.distinct).padStart(2)} distinct, ${r.fonts}\n` +
      `  { label: '${r.label}', hex: '${r.hex}', aspect: ${r.aspect}, relH: ${r.relH}, relY: ${r.relY}, distinct: ${r.distinct} },`,
  )
  .join('\n')

const file = `/**
 * Glyph templates for the delivery app's Arabic-Indic digits.
 *
 * GENERATED by scripts/glyph-templates.mjs from apps/driver/test/fixtures/ocr/glyphs.json.
 * Do not edit by hand — re-harvest and regenerate when new screenshots arrive.
 *
 * \`distinct\` is the number of DIFFERENT renderings behind a class, and it is the honest measure of
 * how much a template is worth. The sample count flatters badly: the same date «٠٨/٠٤» is reprinted
 * on twenty-two rows, so «8» has 22 samples and about two real glyphs. \`UNVALIDATED\` below reads
 * this field.
 */

export interface GlyphTemplate {
  readonly label: string
  /** The 12×16 grid, four pixels per hex digit. */
  readonly hex: string
  readonly aspect: number
  readonly relH: number
  readonly relY: number
  readonly distinct: number
}

export const GLYPH_TEMPLATES: readonly GlyphTemplate[] = [
${bodyOf(amountRows)}
]

/** The smaller font of the clock-and-date column. Same classes, prototypes drawn from that font. */
export const CLOCK_TEMPLATES: readonly GlyphTemplate[] = [
${bodyOf(clockRows)}
]
`

const out = join(root, 'apps/driver/src/glyph-templates.ts')
writeFileSync(out, file)
console.log(`${amountRows.length} amount + ${clockRows.length} clock templates → ${out}`)
for (const r of clockRows) console.log(`  clock ${r.label}  n=${String(r.n).padStart(3)}  distinct=${String(r.distinct).padStart(2)}  ${r.fonts}`)
