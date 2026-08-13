/**
 * `review.html` — one card per image, so a person can check EVERY reading against the screen it
 * came from, one at a time. That is the whole point: an aggregate score tells you a reader is 96%
 * right and nothing at all about which 4% you are about to pay for.
 *
 * Self-contained: the screenshots go in as data URIs, so the file can be opened from anywhere and
 * still shows the pixels beside the claim. It is NEVER published anywhere — these are a delivery
 * company's real customers, their addresses and their coordinates.
 *
 * Ordering follows `ocr-bench.mjs:24` — «the table reports wrong first and read second,
 * deliberately». Suspect and disagreeing images sort to the top; the ones that are simply fine sort
 * to the bottom, where nobody has to scroll past them.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INDEX, answerKey, normaliseMoney, scoreImage } from './ocr-corpus.mjs'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Collect every recorded reading for every image, across every pass that has run. */
export function collect(outDir) {
  const key = answerKey()
  const runs = readdirSync(outDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(outDir, e.name, 'images')))
    .map((e) => e.name)
    .sort()

  const byImage = new Map()
  for (const run of runs) {
    const imgDir = join(outDir, run, 'images')
    for (const sha of readdirSync(imgDir)) {
      for (const f of readdirSync(join(imgDir, sha))) {
        if (!f.endsWith('.json')) continue
        const rec = JSON.parse(readFileSync(join(imgDir, sha, f), 'utf8'))
        /*
         * RE-SCORE, never trust the stored score.
         *
         * The reading is evidence and the score is an opinion about it. Freezing the opinion at run
         * time would mean a corrected answer key could only be applied by spending quota to re-read
         * images we already have — which is exactly backwards. Rows in, score derived, every time.
         */
        rec.truth = key[sha] ?? null
        rec.score = scoreImage({ rows: rec.rows ?? [] }, rec.truth)
        if (!byImage.has(sha)) byImage.set(sha, [])
        byImage.get(sha).push(rec)
      }
    }
  }
  for (const list of byImage.values()) list.sort((a, b) => String(a.runId).localeCompare(String(b.runId)))
  return { runs, byImage }
}

/**
 * Across repeat passes, did the model give the same answer every time?
 *
 * This is the measurement `ocr-bench.mjs:50-73` says is the only one that matters for a language
 * model: the fault it found showed up in one run out of ten, so a single pass that happens to be
 * clean proves nothing. A row that reads differently between two passes at temperature 0 is
 * unusable regardless of which reading is correct.
 */
function stability(records) {
  /*
   * «Unstable» must mean ONE READER answering differently twice — not two readers disagreeing.
   *
   * With every model's run in the same folder this compared gemini against gpt against the local
   * reader and called all of them unstable, which put a red badge on 44 of 48 screens and buried
   * the thing the badge exists to surface. Models disagreeing is the NORMAL state and is what the
   * columns are for; the same model contradicting itself at temperature 0 is the alarm.
   */
  // Keyed on model AND configuration. gpt-5.6-sol structured and gpt-5.6-sol --raw are the same
  // model asked two different ways, and calling their disagreement instability would be measuring
  // the question rather than the reader. Only runs of the SAME config are repeats of each other.
  const byModel = new Map()
  for (const r of records) {
    const m = `${r.model ?? 'unknown'} · ${r.pass ?? '1'}`
    if (!byModel.has(m)) byModel.set(m, [])
    byModel.get(m).push(r)
  }
  for (const [model, list] of byModel) {
    if (list.length < 2) continue
    // Compare the NUMBERS, not the prose. Asked twice, this model described the same two
    // no-amount rows as "", "?" and "Cancelled" — three correct ways of saying nothing, which a
    // string compare called a contradiction. What must be identical is what would reach the ledger.
    const sigs = list.map((r) => (r.rows ?? []).map((x) => String(x.value != null ? normaliseMoney(x.value) : x.printed ? (normaliseMoney(x.printed) ?? '∅') : '∅')).join('|'))
    const distinct = [...new Set(sigs)]
    if (distinct.length > 1) return { model, passes: list.length, distinct: distinct.length, stable: false }
  }
  return null
}

function rowsTable(records) {
  const base = records[0]
  const n = Math.max(...records.map((r) => (r.rows ?? []).length))
  const truth = base.truth?.amounts ?? null

  let html = `<table class="rows"><thead><tr><th>#</th><th>as printed</th><th>our re-parse</th>`
  html += records.map((r) => `<th>${esc(r.runId.replace(/^\d{4}-\d{2}-\d{2}-/, ''))}</th>`).join('')
  html += `<th>truth</th><th>flags</th></tr></thead><tbody>`

  for (let i = 0; i < n; i++) {
    const cells = records.map((r) => (r.rows ?? [])[i])
    const printed = cells.find((c) => c?.printed)?.printed ?? ''
    const ours = normaliseMoney(printed)
    const values = cells.map((c) => (c == null ? null : c.value == null ? null : normaliseMoney(c.value)))
    const distinct = [...new Set(values.map((v) => String(v)))]
    const want = truth?.[i] === undefined ? null : truth[i] === '' ? '' : normaliseMoney(truth[i])
    const flags = [...new Set(records.flatMap((r) => r.score?.suspects?.[i] ?? []))]

    const unstable = distinct.length > 1
    const wrong = want !== null && want !== '' && values[0] !== want
    const cls = unstable ? 'unstable' : wrong ? 'wrong' : flags.length ? 'flagged' : ''

    html += `<tr class="${cls}"><td class="num">${i + 1}</td>`
    html += `<td class="printed" dir="auto">${esc(printed)}</td>`
    html += `<td class="num${ours !== null && values[0] !== null && ours !== values[0] ? ' disagree' : ''}">${esc(ours ?? '—')}</td>`
    for (const v of values) html += `<td class="num">${v === null ? '<span class=nil>null</span>' : esc(v)}</td>`
    html += `<td class="num truth">${want === null ? '<span class=nil>—</span>' : want === '' ? '<span class=nil>?</span>' : esc(want)}</td>`
    html += `<td class="flags">${flags.map((f) => `<span class="flag">${esc(f)}</span>`).join('')}</td></tr>`
  }
  return html + '</tbody></table>'
}

export function render(outDir, corpusRoot, imagesBySha) {
  const { runs, byImage } = collect(outDir)
  if (byImage.size === 0) throw new Error(`no results under ${outDir} — run a pass first`)

  const FOCUS = process.argv.find((a) => a.startsWith('--focus='))?.slice(8) ?? 'gemini-3.6-flash'
  const cards = []
  for (const [sha, records] of byImage) {
    // The badge describes ONE reader — otherwise it is an average of readers, which is not a thing
    // anybody needs to know about a screenshot. Everything else stays visible as a column.
    const base = records.find((r) => (r.model ?? '').includes(FOCUS)) ?? records[0]
    const stab = stability(records)
    const suspects = records.flatMap((r) => (r.score?.suspects ?? []).flat())
    const scored = base.score?.scored === true
    const wrong = scored ? (base.score.wrong?.length ?? 0) + (base.score.missed?.length ?? 0) : 0
    const badge =
      stab && !stab.stable ? ['unstable', `${stab.model}: ${stab.distinct} DIFFERENT ANSWERS in ${stab.passes} runs`]
      : suspects.length ? ['flagged', `${suspects.length} self-contradiction${suspects.length > 1 ? 's' : ''}`]
      : wrong ? ['wrong', `${wrong} against truth`]
      : scored ? ['ok', 'matches truth']
      : ['none', 'no answer key']

    // Rank: unstable first, then contradictions, then wrong, then unscored, then clean.
    const rank = badge[0] === 'unstable' ? 0 : badge[0] === 'flagged' ? 1 : badge[0] === 'wrong' ? 2 : badge[0] === 'none' ? 3 : 4

    const bytes = imagesBySha.get(sha)
    const src = bytes ? `data:image/jpeg;base64,${bytes.toString('base64')}` : ''
    const screenWarn = base.screenAgrees === false ? `<span class="flag">screen: said ${esc(base.screenSaid)}, is ${esc(base.screenLocal)}</span>` : ''

    cards.push({
      rank,
      state: badge[0],
      html: `
<section class="card" data-state="${badge[0]}" id="i-${esc(sha)}">
  <header>
    <h2>${esc(INDEX[sha]?.fixture ?? base.file)}</h2>
    <div class="meta">
      <code>${esc(sha)}</code>
      <span>${esc(base.file)}</span>
      <span>${esc(base.screenLocal)}</span>
      ${base.theme ? `<span>${esc(base.theme)}</span>` : ''}
      ${base.statusBarClock ? `<span>clock ${esc(base.statusBarClock)}</span>` : ''}
      ${screenWarn}
    </div>
    <span class="badge ${badge[0]}">${esc(badge[1])}</span>
  </header>
  <div class="body">
    <figure>${src ? `<img loading="lazy" src="${src}" alt="">` : '<p class=nil>image not found</p>'}</figure>
    <div class="readings">
      ${rowsTable(records)}
      ${base.fields?.length ? `<table class="rows"><tbody>${base.fields.map((f) => `<tr><td>${esc(f.label)}</td><td class="num">${esc(f.value)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${base.notes ? `<p class="notes">${esc(base.notes)}</p>` : ''}
    </div>
  </div>
</section>`,
    })
  }

  cards.sort((a, b) => a.rank - b.rank)
  const counts = cards.reduce((acc, c) => ({ ...acc, [c.state]: (acc[c.state] ?? 0) + 1 }), {})

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>OCR review — ${byImage.size} images</title>
<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --line:#262b36; --ink:#e7e9ee; --dim:#98a0b0;
    --ok:#3fb27f; --wrong:#e05c5c; --flag:#e0a33c; --unstable:#c470e0; --none:#5a6272;
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif }
  header.top { position:sticky; top:0; z-index:5; background:var(--panel);
               border-block-end:1px solid var(--line); padding:12px 20px;
               display:flex; gap:16px; align-items:center; flex-wrap:wrap }
  h1 { font-size:16px; margin:0; font-weight:650 }
  .legend { display:flex; gap:8px; flex-wrap:wrap }
  .pill { border:1px solid var(--line); border-radius:999px; padding:3px 10px; cursor:pointer;
          background:transparent; color:var(--dim); font:inherit; font-size:12px }
  .pill[aria-pressed="true"] { color:var(--ink); border-color:var(--ink) }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-inline-end:6px }
  main { padding:20px; display:flex; flex-direction:column; gap:20px; max-width:1500px }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden }
  .card > header { padding:12px 16px; border-block-end:1px solid var(--line);
                   display:flex; gap:12px; align-items:center; flex-wrap:wrap }
  .card h2 { font-size:14px; margin:0; font-weight:600 }
  .meta { display:flex; gap:10px; flex-wrap:wrap; color:var(--dim); font-size:12px; align-items:center }
  .meta code { background:#0c0e12; padding:1px 6px; border-radius:4px }
  .badge { margin-inline-start:auto; font-size:12px; padding:3px 10px; border-radius:999px; font-weight:600 }
  .badge.ok{background:#12301f;color:var(--ok)} .badge.wrong{background:#341717;color:var(--wrong)}
  .badge.flagged{background:#33280f;color:var(--flag)} .badge.unstable{background:#2b1733;color:var(--unstable)}
  .badge.none{background:#1c1f27;color:var(--none)}
  .body { display:grid; grid-template-columns:minmax(220px,320px) 1fr; gap:18px; padding:16px }
  @media (max-width:900px){ .body{grid-template-columns:1fr} }
  figure { margin:0 }
  figure img { inline-size:100%; block-size:auto; max-block-size:78vh; object-fit:contain;
               border:1px solid var(--line); border-radius:6px; background:#000 }
  table.rows { inline-size:100%; border-collapse:collapse; font-size:13px }
  table.rows th { text-align:start; font-weight:600; color:var(--dim); font-size:11px;
                  text-transform:uppercase; letter-spacing:.04em; padding:4px 8px;
                  border-block-end:1px solid var(--line) }
  table.rows td { padding:5px 8px; border-block-end:1px solid #1e222b; vertical-align:top }
  .num { font-variant-numeric:tabular-nums; font-family:ui-monospace,SFMono-Regular,Menlo,monospace }
  .printed { font-size:15px }
  .truth { color:var(--dim) }
  .nil { color:var(--none) }
  tr.wrong td { background:#2a1414 } tr.flagged td { background:#2a2210 }
  tr.unstable td { background:#26132c }
  td.disagree { color:var(--wrong); font-weight:700 }
  .flags { display:flex; gap:4px; flex-wrap:wrap }
  .flag { background:#3a2a10; color:var(--flag); border-radius:4px; padding:1px 6px; font-size:11px }
  .notes { color:var(--dim); font-size:12px; margin:8px 0 0 }
  body.filter-suspect .card:not([data-state="flagged"]):not([data-state="unstable"]):not([data-state="wrong"]) { display:none }
  body.filter-none .card:not([data-state="none"]) { display:none }
</style></head><body>
<header class="top">
  <h1>OCR review — ${byImage.size} images · ${runs.length} pass${runs.length > 1 ? 'es' : ''}</h1>
  <div class="legend">
    <button class="pill" aria-pressed="true" data-f="">all ${cards.length}</button>
    <button class="pill" aria-pressed="false" data-f="suspect"><span class="dot" style="background:var(--flag)"></span>needs a look ${(counts.flagged ?? 0) + (counts.unstable ?? 0) + (counts.wrong ?? 0)}</button>
    <button class="pill" aria-pressed="false" data-f="none"><span class="dot" style="background:var(--none)"></span>no answer key ${counts.none ?? 0}</button>
  </div>
  <span style="color:var(--dim);font-size:12px">unstable ${counts.unstable ?? 0} · contradictions ${counts.flagged ?? 0} · wrong ${counts.wrong ?? 0} · ok ${counts.ok ?? 0}</span>
</header>
<main>${cards.map((c) => c.html).join('\n')}</main>
<script>
  const body = document.body
  for (const b of document.querySelectorAll('.pill')) {
    b.addEventListener('click', () => {
      for (const o of document.querySelectorAll('.pill')) o.setAttribute('aria-pressed', String(o === b))
      body.className = b.dataset.f ? 'filter-' + b.dataset.f : ''
    })
  }
</script>
</body></html>`

  const path = join(outDir, 'review.html')
  writeFileSync(path, html)
  return { path, images: byImage.size, runs: runs.length, counts }
}
