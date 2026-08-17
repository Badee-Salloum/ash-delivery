/**
 * The scoreboard — every run on disk, side by side, on whatever images it actually covered.
 *
 * MISREAD is first and it is the only column that decides anything. A row that is MISSING is a row
 * the manager types in himself: annoying, visible, safe. A row that is MISREAD is a different
 * number sitting where a real one should be, and BR1 balances it against itself, so nobody finds it
 * — not that night, not at the Sunday close, not ever. `ocr-bench.mjs:627` sets the bar at zero and
 * this table exists to say whether anything clears it.
 *
 *     node scripts/ocr-compare.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { INDEX, answerKey, normaliseMoney } from './ocr-corpus.mjs'

const OUT = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? join(homedir(), 'Desktop', 'ash-ocr-runs')

/** Published USD per 1M tokens, checked 2026-08-13. Gemini's free tier is 0 until it is not. */
const PRICE = {
  'gpt-5.4-mini': [0.75, 4.5],
  'gpt-5.4': [2.5, 15],
  'gpt-5.4-nano': [0.2, 1.25],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-5.6-luna': [0.2, 1.2],
  'gpt-5.6-terra': [2.0, 12.0],
  'gpt-5.6-sol': [5.0, 30.0],
  'gpt-5.5': [5.0, 30.0],
  /*
   * Qwen3-VL via OpenRouter, read from its own `/api/v1/models` endpoint on 2026-08-17 rather than
   * from a pricing article. The `-thinking` variants cost roughly ten times their `-instruct`
   * siblings on OUTPUT, which is where a reasoning model spends — so the cheap-looking gap between
   * 32b-instruct and 235b-thinking is much wider per image than the input column suggests.
   */
  'qwen/qwen3-vl-235b-a22b-thinking': [0.4, 4.0],
  'qwen/qwen3-vl-235b-a22b-instruct': [0.21, 1.9],
  'qwen/qwen3-vl-30b-a3b-thinking': [0.2, 2.4],
  'qwen/qwen3-vl-30b-a3b-instruct': [0.13, 0.52],
  'qwen/qwen3-vl-32b-instruct': [0.104, 0.416],
  'qwen/qwen3-vl-8b-instruct': [0.117, 0.455],
}

const key = answerKey()
const runs = readdirSync(OUT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

const rows = []
for (const run of runs) {
  const dir = join(OUT, run, 'images')
  let imgs = 0, clean = 0, expected = 0, matched = 0, misread = 0, missing = 0
  let tin = 0, tout = 0, reasoning = 0
  const seen = new Set()
  const offenders = []

  for (const sha of readdirSync(dir)) {
    for (const f of readdirSync(join(dir, sha))) {
      const r = JSON.parse(readFileSync(join(dir, sha, f), 'utf8'))
      const t = key[sha]
      if (!t) continue
      imgs += 1

      // Only rows the key actually ASSERTS are scored. '' means the transcribers were unsure and
      // null means the row genuinely has no amount; neither can convict a reading.
      const want = t.amounts.filter((a) => a !== '' && a !== null).map(normaliseMoney)
      // Slots the key does NOT assert: '' = the transcribers were unsure, null = the row genuinely
      // has no amount. A reading that lands on one of these is UNJUDGEABLE, not wrong — scoring it
      // as a misread punishes a model for reading a row two humans could not agree on.
      let unasserted = t.amounts.filter((a) => a === '' || a === null).length
      const said = (r.rows ?? []).map((x) => (x.value != null ? normaliseMoney(x.value) : x.printed ? normaliseMoney(x.printed) : null))
      const pool = [...want]
      const wrong = []
      for (const s of said) {
        if (s === null) continue
        const i = pool.indexOf(s)
        if (i >= 0) pool.splice(i, 1)
        else if (unasserted > 0) unasserted -= 1
        else wrong.push(s)
      }
      expected += want.length
      matched += want.length - pool.length
      misread += wrong.length
      missing += pool.length
      if (pool.length === 0 && wrong.length === 0) clean += 1
      else offenders.push({ file: INDEX[sha]?.fixture ?? r.file, wrong, missed: pool })

      const u = r.usage ?? {}
      const sig = JSON.stringify(u)
      if (u.in && !seen.has(sig)) {
        seen.add(sig)
        tin += u.in
        tout += u.out ?? 0
        reasoning += u.reasoning ?? 0
      }
    }
  }

  // `__` back to `/`: OpenRouter ids are `vendor/model`, and a slash cannot live in a folder name.
  const model = run.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-p[^-]*$/, '').replace(/__/g, '/')
  const p = PRICE[model]
  rows.push({ run, model, imgs, clean, expected, matched, misread, missing, tin, tout, reasoning,
    cost: p ? (tin / 1e6) * p[0] + (tout / 1e6) * p[1] : null, offenders })
}

const pad = (s, n) => String(s).padEnd(n)
const num = (s, n) => String(s).padStart(n)

console.log('\n══ every run on disk, scored against the current corpus answer key ══\n')
console.log(pad('run', 36), num('imgs', 4), num('clean', 6), num('rows', 5), num('ok', 5), num('MISREAD', 8), num('missed', 7), num('cost', 9))
for (const r of rows) {
  console.log(
    pad(r.run, 36), num(r.imgs, 4), num(`${r.clean}/${r.imgs}`, 6), num(r.expected, 5),
    num(r.matched, 5), num(r.misread, 8), num(r.missing, 7),
    num(r.cost === null ? 'free' : `$${r.cost.toFixed(3)}`, 9),
  )
}

console.log('\n  MISREAD = a different number, silently. BR1 balances it against itself and nobody')
console.log('            ever finds it. ANY misread disqualifies an engine from money here.')
console.log('  missed  = a row not read, or REFUSED. The driver types it. Visible, and therefore safe.')
console.log('            A refusing reader scores badly here and is the SAFE one — read the two together.')
console.log('  Adopt only if MISREAD is 0.\n')

// A like-for-like column: only the images EVERY run covered, so a short run cannot flatter itself.
const covered = rows.map((r) => new Set(readdirSync(join(OUT, r.run, 'images'))))
const common = [...(covered[0] ?? [])].filter((sha) => covered.every((c) => c.has(sha)) && key[sha])
if (rows.length > 1 && common.length) {
  console.log(`══ head to head, on the ${common.length} images EVERY run covered ══\n`)
  console.log(pad('run', 36), num('rows', 5), num('ok', 5), num('MISREAD', 8), num('missed', 7))
  for (const r of rows) {
    let e = 0, m = 0, w = 0, miss = 0
    for (const sha of common) {
      const dir = join(OUT, r.run, 'images', sha)
      const rec = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'))
      const want = key[sha].amounts.filter((a) => a !== '' && a !== null).map(normaliseMoney)
      let unasserted = key[sha].amounts.filter((a) => a === '' || a === null).length
      const said = (rec.rows ?? []).map((x) => (x.value != null ? normaliseMoney(x.value) : x.printed ? normaliseMoney(x.printed) : null))
      const pool = [...want]
      for (const s of said) {
        if (s === null) continue
        const i = pool.indexOf(s)
        if (i >= 0) pool.splice(i, 1)
        else if (unasserted > 0) unasserted -= 1
        else w += 1
      }
      e += want.length
      m += want.length - pool.length
      miss += pool.length
    }
    console.log(pad(r.run, 36), num(e, 5), num(m, 5), num(w, 8), num(miss, 7))
  }
  console.log()
}

for (const r of rows) {
  if (!r.offenders.length) continue
  console.log(`── ${r.run}: ${r.offenders.length} image(s) not clean`)
  for (const o of r.offenders.slice(0, 8)) {
    console.log(`   ${pad(o.file.slice(0, 34), 34)} read-but-not-expected ${JSON.stringify(o.wrong)}  never-read ${JSON.stringify(o.missed)}`)
  }
  if (r.offenders.length > 8) console.log(`   … and ${r.offenders.length - 8} more`)
  console.log()
}
