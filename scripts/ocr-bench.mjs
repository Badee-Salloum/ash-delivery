#!/usr/bin/env node
/**
 * PAID OCR, MEASURED — the same eight screenshots, the same answer key, one table.
 *
 *   node scripts/ocr-bench.mjs --provider=google   GOOGLE_VISION_KEY=...
 *   node scripts/ocr-bench.mjs --provider=azure    AZURE_VISION_ENDPOINT=... AZURE_VISION_KEY=...
 *   node scripts/ocr-bench.mjs --provider=mistral  MISTRAL_API_KEY=...
 *   node scripts/ocr-bench.mjs --provider=tesseract          (no key — the documented baseline)
 *   node scripts/ocr-bench.mjs --provider=all
 *   node scripts/ocr-bench.mjs --provider=google --dry       (print the request, send nothing)
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 *
 * The shipped reader scores 46 fees read, 2 refused, ZERO WRONG on these fixtures. Every provider
 * priced at $1.50/1,000 claims "Arabic support"; so does Tesseract, which scores 0 of 11 on these
 * amounts with unrecoverable confusions («٢» and «٣» both return "Y"). Marketing language does not
 * distinguish the two. This does.
 *
 * ── THE METRIC THAT DECIDES IT IS «WRONG», NOT «READ» ─────────────────────────────────────────
 *
 * BR1 balances a shift to EXACTLY ZERO. A refused fee costs the driver ten seconds of typing. A
 * WRONG fee enters the equation as fact, balances to zero against itself, and nobody ever finds it.
 * A provider that reads 48/48 with one silent error is worse here than one that reads 30 and
 * refuses the rest. So the table reports `wrong` first and `read` second, deliberately.
 *
 * Two independent measurements per provider, because they fail differently:
 *
 *   RECALL   does the returned text contain the true amount ANYWHERE (digits folded to Western)?
 *            Layout-independent. Answers only «can this engine resolve ٢٣٥ at all».
 *   ROW      the amounts it actually put next to «SYP», in order, against the expected fees.
 *            This is the number that matters — it is what an integration would consume.
 *
 * No image leaves this machine unless you pass a key. `--dry` prints the exact request shape.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ARABIC_INDIC_FIXTURES, TRUTH, foldDigits, normaliseAmount } from './ocr-truth.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DRIVER = join(here, '..', 'apps', 'driver')
const FIXTURES = join(DRIVER, 'test', 'fixtures', 'ocr')
/** Workspace deps live under apps/driver, not here — same resolution `glyph-read.mjs` uses. */
const fromDriver = (s) => import(pathToFileURL(createRequire(join(DRIVER, 'package.json')).resolve(s)).href)

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const DRY = process.argv.includes('--dry')
/** `--dump=log-0804-a.jpg` prints what the provider actually returned, to judge a disputed row. */
const DUMP = arg('dump', null)
/** `--only=a.jpg,b.jpg` narrows the set — for pacing a rate-limited free tier. */
const ONLY = arg('only', null)
/**
 * `--repeat=5` reads every image N times and reports whether the answers AGREE.
 *
 * THE TEST THAT MATTERS FOR A LANGUAGE MODEL. A single clean run proves capability; only repetition
 * proves reliability, and a model is not a deterministic function even at temperature 0. An engine
 * that answers 345 today and 245 tomorrow is unusable for money no matter how good its best run
 * looked — and it would be the hardest kind of fault to ever notice in production.
 */
const REPEAT = Number(arg('repeat', '1'))
/** `--delay=4000` waits between calls, so a free tier's per-minute cap is not mistaken for a fault. */
const DELAY = Number(arg('delay', '0'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ONLY_ARABIC = process.argv.includes('--arabic-only')
const WANTED = arg('provider', 'all')

/** Every fixture whose amounts are Arabic-Indic — the only ones that test the hard thing. */
const files = Object.keys(TRUTH)
  .filter((f) => !ONLY_ARABIC || ARABIC_INDIC_FIXTURES.has(f))
  .filter((f) => ONLY === null || ONLY.split(',').includes(f))

// ── Providers ────────────────────────────────────────────────────────────────────────────────
//
// Each returns { text, lines: string[] } or throws. Keys come from the environment and are never
// logged. The request shapes follow each vendor's current public API; verify against their docs if
// a call 4xx's — they move.

const providers = {
  /**
   * Google Cloud Vision, DOCUMENT_TEXT_DETECTION.
   * $1.50 per 1,000 units after the first 1,000/month free.
   * `languageHints: ['ar']` matters: without it Latin is preferred and Arabic-Indic digits are
   * frequently transliterated into whatever Latin shape is nearest.
   */
  google: {
    needs: ['GOOGLE_VISION_KEY'],
    async run(bytes) {
      const body = {
        requests: [
          {
            image: { content: bytes.toString('base64') },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            imageContext: { languageHints: ['ar'] },
          },
        ],
      }
      if (DRY) return { dry: 'POST https://vision.googleapis.com/v1/images:annotate?key=***', body: { ...body, requests: [{ ...body.requests[0], image: { content: `<${bytes.length} bytes>` } }] } }
      const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_KEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`google ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const json = await res.json()
      const r = json.responses?.[0]
      if (r?.error) throw new Error(`google: ${r.error.message}`)
      const text = r?.fullTextAnnotation?.text ?? ''
      return { text, lines: text.split('\n') }
    },
  },

  /**
   * Azure AI Vision — Image Analysis 4.0 `read` feature.
   * $1.50 per 1,000 on S0. Endpoint looks like https://<resource>.cognitiveservices.azure.com
   */
  azure: {
    needs: ['AZURE_VISION_ENDPOINT', 'AZURE_VISION_KEY'],
    async run(bytes) {
      const url = `${(process.env.AZURE_VISION_ENDPOINT ?? '').replace(/\/$/, '')}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read`
      if (DRY) return { dry: `POST ${url}`, body: `<${bytes.length} bytes, application/octet-stream>` }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'Ocp-Apim-Subscription-Key': process.env.AZURE_VISION_KEY },
        body: bytes,
      })
      if (!res.ok) throw new Error(`azure ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const json = await res.json()
      const lines = (json.readResult?.blocks ?? []).flatMap((b) => (b.lines ?? []).map((l) => l.text ?? ''))
      return { text: lines.join('\n'), lines }
    },
  },

  /**
   * Mistral OCR — document understanding, priced around $1.00 per 1,000 pages.
   * Returns markdown per page rather than positioned lines, so ROW scoring is weaker here by
   * construction; RECALL is the honest number for it.
   */
  mistral: {
    needs: ['MISTRAL_API_KEY'],
    async run(bytes) {
      const body = {
        model: 'mistral-ocr-latest',
        document: { type: 'image_url', image_url: `data:image/jpeg;base64,${bytes.toString('base64')}` },
      }
      if (DRY) return { dry: 'POST https://api.mistral.ai/v1/ocr', body: { ...body, document: { type: 'image_url', image_url: `<${bytes.length} bytes>` } } }
      const res = await fetch('https://api.mistral.ai/v1/ocr', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`mistral ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const json = await res.json()
      const text = (json.pages ?? []).map((p) => p.markdown ?? '').join('\n')
      return { text, lines: text.split('\n') }
    },
  },

  /**
   * GEMINI via Google AI Studio — a free API key, NO billing account, NO card.
   *
   * Cloud Vision refuses without billing (403 «This API method requires billing to be enabled»),
   * but AI Studio is a different product with its own free tier. Get a key at aistudio.google.com.
   *
   * ⚠ This is a LANGUAGE MODEL, not an OCR engine, and the difference is the whole risk: an OCR
   * engine that cannot resolve a glyph returns noise, while a model returns the most plausible
   * number. On a shift that must balance to zero, plausible-and-wrong is the one failure mode with
   * no defence. Measured here precisely because it is the option people reach for first.
   */
  gemini: {
    needs: ['GEMINI_API_KEY'],
    async run(bytes) {
      const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
      const body = {
        contents: [
          {
            parts: [
              {
                text:
                  'Transcribe every line of this screenshot exactly as printed, one line per output line. ' +
                  'Keep Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) EXACTLY as they appear — do not convert them to Western digits. ' +
                  'Keep the Arabic thousands separator ٬ and decimal separator ٫ distinct from each other. ' +
                  'If a character is unclear, write ? rather than guessing. Output only the transcription.',
              },
              { inline_data: { mime_type: 'image/jpeg', data: bytes.toString('base64') } },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      }
      if (DRY) return { dry: `POST ${url} (model ${model})`, body: '<image inline>' }
      const res = await fetch(`${url}?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300)
        throw new Error(`gemini ${res.status}: ${detail}${res.status === 404 ? '  — try GEMINI_MODEL=gemini-2.0-flash' : ''}`)
      }
      const json = await res.json()
      const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
      return { text, lines: text.split('\n') }
    },
  },

  /**
   * CLAUDE — same shape as the Gemini probe, so the two are compared and not merely quoted.
   *
   * Priced per token like Gemini, not per page: Haiku 4.5 at $1/$5 per million is the tier that
   * makes sense here; Sonnet and Opus cost 2-5x for a job that is transcription, not reasoning.
   * Override with ANTHROPIC_MODEL.
   *
   * The same warning as Gemini applies and is the whole reason this is measured rather than
   * assumed: a model answers with the most plausible number when it cannot read one, and BR1
   * cannot catch a plausible wrong fee.
   */
  claude: {
    needs: ['ANTHROPIC_API_KEY'],
    async run(bytes) {
      const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'
      const body = {
        model,
        max_tokens: 2048,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bytes.toString('base64') } },
              {
                type: 'text',
                text:
                  'Transcribe every line of this screenshot exactly as printed, one line per output line. ' +
                  'Keep Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) EXACTLY as they appear — do not convert them to Western digits. ' +
                  'Keep the Arabic thousands separator ٬ and decimal separator ٫ distinct from each other. ' +
                  'If a character is unclear, write ? rather than guessing. Output only the transcription.',
              },
            ],
          },
        ],
      }
      if (DRY) return { dry: `POST https://api.anthropic.com/v1/messages (model ${model})`, body: '<image inline>' }
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`claude ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const json = await res.json()
      const text = (json.content ?? []).map((c) => c.text ?? '').join('')
      return { text, lines: text.split('\n') }
    },
  },

  /**
   * OPENAI — same probe again. GPT-5.4 Nano by default, because on paper it is the CHEAPEST option
   * of anything tested here (~$0.20/$1.25 per million), and if the smallest model can transcribe
   * digits then nothing larger is justified for a job that is not reasoning.
   *
   * That is also the hypothesis most likely to fail: a nano-tier model under-reading a cramped
   * Arabic-Indic glyph will still answer with a confident number. Override with OPENAI_MODEL to try
   * gpt-5.4-mini or the full model before concluding anything about the family.
   */
  openai: {
    needs: ['OPENAI_API_KEY'],
    async run(bytes) {
      const model = process.env.OPENAI_MODEL ?? 'gpt-5.4-nano'
      const body = {
        model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Transcribe every line of this screenshot exactly as printed, one line per output line. ' +
                  'Keep Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) EXACTLY as they appear — do not convert them to Western digits. ' +
                  'Keep the Arabic thousands separator ٬ and decimal separator ٫ distinct from each other. ' +
                  'If a character is unclear, write ? rather than guessing. Output only the transcription.',
              },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}`, detail: 'high' } },
            ],
          },
        ],
      }
      if (DRY) return { dry: `POST https://api.openai.com/v1/chat/completions (model ${model})`, body: '<image inline>' }
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const json = await res.json()
      const text = json.choices?.[0]?.message?.content ?? ''
      return { text, lines: text.split('\n') }
    },
  },

  /**
   * OCR.space — a free key by email, 25,000 requests/month, NO card.
   *
   * A real OCR engine rather than a model, so it refuses instead of inventing. Engine 1 is the one
   * that lists Arabic; engine 2 is faster but its language coverage differs — override with
   * OCRSPACE_ENGINE if a run looks empty.
   */
  ocrspace: {
    needs: ['OCRSPACE_API_KEY'],
    async run(bytes) {
      const form = new FormData()
      form.set('base64Image', `data:image/jpeg;base64,${bytes.toString('base64')}`)
      form.set('language', process.env.OCRSPACE_LANG ?? 'ara')
      form.set('OCREngine', process.env.OCRSPACE_ENGINE ?? '1')
      form.set('scale', 'true')
      form.set('isTable', 'true')
      if (DRY) return { dry: 'POST https://api.ocr.space/parse/image', body: '<multipart, base64Image>' }
      const res = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { apikey: process.env.OCRSPACE_API_KEY },
        body: form,
      })
      if (!res.ok) throw new Error(`ocrspace ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const json = await res.json()
      if (json.IsErroredOnProcessing) throw new Error(`ocrspace: ${JSON.stringify(json.ErrorMessage ?? json).slice(0, 200)}`)
      const text = (json.ParsedResults ?? []).map((p) => p.ParsedText ?? '').join('\n')
      return { text, lines: text.split('\n') }
    },
  },

  /** The control. Free, already vendored, and documented at 0 of 11 on these amounts. */
  tesseract: {
    needs: [],
    async run(bytes) {
      if (DRY) return { dry: 'local tesseract.js, no network', body: `<${bytes.length} bytes>` }
      const { createWorker, OEM } = await fromDriver('tesseract.js')
      const worker = await createWorker(['eng', 'ara'], OEM.LSTM_ONLY, {
        langPath: join(DRIVER, 'public', 'tesseract'),
        gzip: true,
      })
      await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' })
      const { data } = await worker.recognize(bytes)
      await worker.terminate()
      const text = data.text ?? ''
      return { text, lines: text.split('\n') }
    },
  },
}

// ── Scoring ──────────────────────────────────────────────────────────────────────────────────

/**
 * The amounts a provider put beside «SYP», left to right, top to bottom.
 *
 * Same rule the shipped reader uses: the money is the ink adjacent to the anchor word. Taking every
 * number on the page instead would score a provider on the clock, the date and the plus-code too,
 * and flatter it enormously.
 */
function amountsNearAnchor(lines) {
  const out = []
  for (const raw of lines) {
    const line = foldDigits(raw)
    if (!/SYP/i.test(line)) continue
    // The fee sits immediately before the anchor on these screens; fall back to after it.
    const before = line.split(/SYP/i)[0] ?? ''
    const after = line.split(/SYP/i)[1] ?? ''
    const pick = (s) => {
      const all = s.match(/[-+−–]?\s*\d[\d,،.]*/g)
      return all && all.length > 0 ? all[all.length - 1] : null
    }
    const candidate = pick(before) ?? pick(after)
    const n = candidate === null ? null : normaliseAmount(candidate)
    if (n !== null) out.push(n)
  }
  return out
}

function scoreFile(file, text, lines) {
  /*
   * THE TRUTH IS NORMALISED BY THE SAME FUNCTION AS THE ANSWER, or the bench lies.
   *
   * The answer key writes credits as «+153»; `normaliseAmount` drops a leading plus, so an engine
   * that returned exactly «١٥٣» was scored WRONG against «+153» — four times on the first payments
   * log alone. That is the benchmark inventing failures, which is worse than useless: it would have
   * had me report a provider as unsafe for money on the strength of a bug in the scorer.
   *
   * Dropping «+» from BOTH sides keeps the only sign distinction that carries meaning: a MINUS.
   * «-153» still does not match «153», so a genuinely flipped sign is still caught.
   */
  const expected = TRUTH[file].rows.map((r) => normaliseAmount(r[0]))
  const folded = foldDigits(text).replace(/[,،\s]/g, '')

  // RECALL — can the engine resolve the digits at all, anywhere on the page?
  let recall = 0
  for (const fee of expected) {
    // Both with and without the decimal point: «165.50» printed as «165,50» is the SAME reading,
    // and a separator style is not a misread digit.
    const bare = fee.replace(/^[-+]/, '')
    if (folded.includes(bare) || folded.includes(bare.replace('.', ''))) recall++
  }

  // ROW — what an integration would actually consume.
  /*
   * TWO KINDS OF WRONG, and they lead to opposite decisions.
   *
   * SEPARATOR — every digit is right but the marks are ambiguous. Mistral flattens BOTH the Arabic
   *   thousands «٬» and decimal «٫» into a plain comma, so «−١٬١٥٥٫٦٥» arrives as «-1,155,65» and
   *   1155.65 is no longer distinguishable from 115565. Recoverable in our own code with a strict
   *   rule (a final group of exactly two digits is the decimal), so it is a cost, not a verdict.
   *
   * MISREAD — a different digit. «٣٤٥» returned as «٢٤٥». Nothing downstream can detect it: it is a
   *   plausible fee, it balances against itself, and BR1's zero tolerance never fires. THIS is what
   *   disqualifies an engine from money, and it is why the two are counted apart.
   */
  const digitsOnly = (s) => s.replace(/[^0-9]/g, '')
  const got = amountsNearAnchor(lines)
  let correct = 0
  const wrongs = []
  const pool = [...expected]
  for (const g of got) {
    const i = pool.indexOf(g)
    if (i >= 0) {
      pool.splice(i, 1)
      correct++
      continue
    }
    const j = pool.findIndex((e) => digitsOnly(e) === digitsOnly(g))
    if (j >= 0) {
      wrongs.push({ got: g, want: pool[j], kind: 'separator' })
      pool.splice(j, 1)
    } else {
      wrongs.push({ got: g, want: null, kind: 'misread' })
    }
  }
  const separator = wrongs.filter((w) => w.kind === 'separator').length
  const misread = wrongs.filter((w) => w.kind === 'misread').length
  return { expected: expected.length, recall, correct, wrong: wrongs.length, separator, misread, wrongs, missing: pool, anchored: got.length }
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────

const chosen = WANTED === 'all' ? Object.keys(providers) : WANTED.split(',')
const results = []

for (const name of chosen) {
  const p = providers[name]
  if (!p) {
    console.error(`unknown provider «${name}» — try ${Object.keys(providers).join(', ')}`)
    process.exit(2)
  }
  const missingKeys = p.needs.filter((k) => !process.env[k])
  if (missingKeys.length > 0 && !DRY) {
    console.log(`\n▸ ${name}: SKIPPED — set ${missingKeys.join(', ')}`)
    results.push({ name, skipped: missingKeys })
    continue
  }

  console.log(`\n▸ ${name}${DRY ? '  (dry run — nothing is sent)' : ''}`)
  const total = { expected: 0, recall: 0, correct: 0, wrong: 0, separator: 0, misread: 0, anchored: 0 }
  for (const file of files) {
    const bytes = readFileSync(join(FIXTURES, file))

    /*
     * REPETITION IS THE RELIABILITY TEST. Run the same image N times and compare the extracted
     * amounts. Disagreement between runs is disqualifying on its own: it means no single result —
     * including a perfect one — can be trusted, and the fault would be invisible in production
     * because each individual answer looks perfectly reasonable.
     */
    if (REPEAT > 1) {
      const seen = []
      for (let i = 0; i < REPEAT; i++) {
        if (i > 0 && DELAY > 0) await sleep(DELAY)
        try {
          const r = await p.run(bytes)
          seen.push(amountsNearAnchor(r.lines).join(' '))
        } catch (e) {
          seen.push(`ERROR ${e.message.slice(0, 60)}`)
        }
      }
      const distinct = [...new Set(seen)]
      const expected = TRUTH[file].rows.map((r) => normaliseAmount(r[0])).join(' ')
      const stable = distinct.length === 1
      const right = distinct.length === 1 && distinct[0] === expected
      console.log(`  ${file.padEnd(22)} ${REPEAT} runs · ${stable ? 'IDENTICAL' : `${distinct.length} DIFFERENT ANSWERS`} · ${right ? 'and correct' : stable ? 'but NOT the truth' : ''}`)
      if (!stable) for (const d of distinct) console.log(`      ${d}`)
      if (stable && !right) {
        console.log(`      got  ${distinct[0]}`)
        console.log(`      want ${expected}`)
      }
      continue
    }

    try {
      const r = await p.run(bytes)
      if (DRY) {
        console.log(`  ${file}: ${r.dry}`)
        continue
      }
      if (DUMP && file === DUMP) {
        console.log(`\n──── raw text from ${name} for ${file} ────`)
        console.log(r.lines.filter((l) => /SYP/i.test(l)).join('\n') || r.text.slice(0, 2000))
        console.log('──── end raw ────\n')
      }
      const s = scoreFile(file, r.text, r.lines)
      total.expected += s.expected
      total.recall += s.recall
      total.correct += s.correct
      total.wrong += s.wrong
      total.separator += s.separator
      total.misread += s.misread
      total.anchored += s.anchored
      const flag =
        s.wrongs.length > 0
          ? '  ⚠ ' + s.wrongs.map((w) => (w.kind === 'separator' ? `sep «${w.got}»→${w.want}` : `MISREAD «${w.got}»`)).join(' ')
          : ''
      console.log(
        `  ${file.padEnd(22)} recall ${String(s.recall).padStart(2)}/${s.expected}` +
          `   rows ${String(s.correct).padStart(2)}/${s.expected}   sep ${s.separator}  misread ${s.misread}${flag}`,
      )
    } catch (e) {
      console.log(`  ${file.padEnd(22)} ERROR ${e.message}`)
    }
  }
  if (!DRY) {
    results.push({ name, ...total })
    console.log(
      `  ── ${name}: recall ${total.recall}/${total.expected} · rows ${total.correct}/${total.expected} · WRONG ${total.wrong}`,
    )
  }
}

if (!DRY && results.some((r) => !r.skipped)) {
  console.log('\n══ SUMMARY — MISREAD is the column that decides this ══')
  console.log('  provider              recall     rows     sep   MISREAD')
  console.log(`  ${'shipped glyph reader'.padEnd(20)}     —     46/48      0        0    (node scripts/glyph-read.mjs)`)
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${r.name.padEnd(20)} skipped — needs ${r.skipped.join(', ')}`)
      continue
    }
    console.log(
      `  ${r.name.padEnd(20)} ${String(r.recall).padStart(3)}/${r.expected}   ${String(r.correct).padStart(3)}/${r.expected}   ${String(r.separator).padStart(4)}   ${String(r.misread).padStart(6)}`,
    )
  }
  console.log('\n  sep     = every digit right, separator ambiguous. Our problem to fix; a cost, not a verdict.')
  console.log('  MISREAD = a different digit, silently. BR1 balances it against itself and nobody')
  console.log('            ever finds it. ANY misread disqualifies an engine from money here.')
  console.log('\n  Adopt only if MISREAD is 0 AND rows beats 46/48.')
}
