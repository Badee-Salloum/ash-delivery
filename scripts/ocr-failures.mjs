/**
 * Every row a reader got WRONG, with the glyphs it claims to have seen.
 *
 *     node scripts/ocr-failures.mjs                        the best OpenAI run
 *     node scripts/ocr-failures.mjs --run=<folder name>
 *     node scripts/ocr-failures.mjs --vs=<other run>       put a second reader beside it
 *
 * Rows are compared BY POSITION, which is only meaningful when the reader returned as many rows as
 * the screen has. When it did not, the whole screen is reported as a count mismatch instead: with a
 * row missing, every row below it shifts up, and comparing position-wise would invent a dozen
 * failures out of one. That is the same rule `glyph-harvest.mjs:275` applies for the same reason.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { INDEX, answerKey, normaliseMoney } from './ocr-corpus.mjs'

const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d
const OUT = arg('out', join(homedir(), 'Desktop', 'ash-ocr-runs'))
const RUN = arg('run', '2026-08-12-gpt-5.6-sol-p1')
const VS = arg('vs', '2026-08-12-gemini-3.6-flash-p1')

const key = answerKey()
const read = (run, sha) => {
  const d = join(OUT, run, 'images', sha)
  if (!existsSync(d)) return null
  const f = readdirSync(d)[0]
  return f ? JSON.parse(readFileSync(join(d, f), 'utf8')) : null
}
const said = (row) => (row == null ? null : row.value != null ? normaliseMoney(row.value) : row.printed ? normaliseMoney(row.printed) : null)

const shas = readdirSync(join(OUT, RUN, 'images'))
let misread = 0
let refused = 0
let shifted = 0
const magnitude = []

console.log(`\n══ ${RUN} — every row it read as a DIFFERENT number ══`)
if (existsSync(join(OUT, VS, 'images'))) console.log(`   (second column: ${VS}, where it covered the same screen)\n`)

for (const sha of shas.sort()) {
  const rec = read(RUN, sha)
  const t = key[sha]
  if (!rec || !t) continue
  const rows = rec.rows ?? []
  const want = t.amounts

  if (rows.length !== want.length) {
    shifted += 1
    continue
  }

  const other = read(VS, sha)
  const bad = []
  for (let i = 0; i < want.length; i++) {
    // '' = the transcribers were unsure, null = the row genuinely has no amount. Neither convicts.
    if (want[i] === '' || want[i] === null) continue
    const w = normaliseMoney(want[i])
    const got = said(rows[i])
    if (got === w) continue
    /*
     * A REFUSAL IS NOT A MISREAD, and conflating them destroys the only distinction that matters.
     *
     * The shipped reader answers null when the ٢/٣ margin is too thin, and the driver types that
     * row. It is visible, it is safe, and it is the reason that reader is trusted with money. A
     * model that returns a confident wrong number instead is the thing this whole benchmark exists
     * to find. Counting them in one column made the local reader look like the worst engine here
     * when it had simply declined to guess 175 times.
     */
    if (got === null) { refused += 1; continue }
    misread += 1
    const ratio = got !== null && w !== null && Number(w) !== 0 ? Number(got) / Number(w) : null
    if (ratio !== null && (Math.abs(ratio - 100) < 1 || Math.abs(ratio - 10) < 0.5 || Math.abs(ratio - 0.01) < 0.001 || Math.abs(ratio - 0.1) < 0.01)) {
      magnitude.push({ file: INDEX[sha]?.fixture ?? rec.file, want: w, got, ratio })
    }
    bad.push({
      i,
      want: w,
      printed: rows[i].printed ?? '',
      got,
      otherGot: other && (other.rows ?? []).length === want.length ? said(other.rows[i]) : undefined,
    })
  }
  if (!bad.length) continue

  console.log(`── ${(INDEX[sha]?.fixture ?? rec.file)}   (${rec.screenLocal})`)
  for (const b of bad) {
    const mark = b.otherGot === undefined ? '' : b.otherGot === b.want ? '   ← the other reader got it right' : `   other reader: ${b.otherGot}`
    console.log(
      `   row ${String(b.i + 1).padStart(2)}  truth ${String(b.want).padStart(10)}   it transcribed ${JSON.stringify(b.printed).padEnd(16)} → ${String(b.got).padStart(10)}${mark}`,
    )
  }
  console.log()
}

console.log(`${misread} rows read as a DIFFERENT NUMBER, over ${shas.length} screens.`)
console.log(`${refused} rows it REFUSED to read — the driver types those. Visible, and therefore safe.`)
console.log(`${shifted} screen(s) returned the wrong NUMBER of rows and were skipped — position-wise`)
console.log(`comparison is meaningless once the rows have shifted, so those are counted separately.\n`)

if (magnitude.length) {
  console.log('══ THE DANGEROUS ONES — wrong by a factor of ten or a hundred ══\n')
  for (const m of magnitude) {
    console.log(`   ${m.file.padEnd(34)} ${String(m.want).padStart(10)}  read as ${String(m.got).padStart(10)}   ×${m.ratio > 1 ? m.ratio.toFixed(0) : `1/${(1 / m.ratio).toFixed(0)}`}`)
  }
  console.log('\n   A digit read wrong costs the difference between two plausible fees. A MAGNITUDE read')
  console.log('   wrong costs a hundred times the fee, and BR1 balances it against itself either way.\n')
}
