/**
 * The PRE-FLIGHT bench: measure the reader production actually ships, not an approximation of it.
 *
 * `vision-bench.mjs` chose the model. It cannot clear it for production, and the distinction is the
 * whole reason this file exists:
 *
 *   vision-bench   ONE request carrying EIGHT images, its own prompt, a 32,768-token ceiling.
 *   production     FOUR single-image requests per orders screen, the shipped prompts, ceilings of
 *                  512 (screen-kind) / 4,096 (money) / 2,048 (time) / 8,192 (route).
 *
 * So the 5-vs-26 misread result is strong evidence about the MODEL and no evidence at all about the
 * CEILINGS. The dangerous one is screen-kind: its own comment records that 128 tokens already
 * produced a false `no_fields` on a medium-effort GPT-5 pass, and the candidate emits ~3.6x the
 * output. If it exhausts 512 the completion comes back EMPTY, `ordersPassResult` bails before money
 * is read, and every orders read fails while looking exactly like "the screen was blank".
 *
 * This harness imports `ChatCompletionsOcrReader` itself. Measuring the real class is the point: it
 * proves the request body is accepted (no silently swallowed 400) and exercises the true ceilings in
 * one motion. It observes per-pass usage by wrapping `fetch` rather than by adding a telemetry hook
 * to production code — the bench is the only consumer, so the bench carries the cost.
 *
 *     OPENROUTER_API_KEY=… node scripts/ocr-adapter-bench.mjs --provider=openrouter --pass=1
 *     OPENAI_API_KEY=…     node scripts/ocr-adapter-bench.mjs --provider=openai --pass=1   # control
 *     node scripts/ocr-adapter-bench.mjs --provider=openrouter --truncation-probe
 *
 * Then score it with the existing tools — the output layout is deliberately identical:
 *     node scripts/ocr-compare.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { INDEX, answerKey, loadCorpus, scoreImage, screenOf } from './ocr-corpus.mjs'

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const flag = (name) => process.argv.includes(`--${name}`)

const PROVIDER = arg('provider', 'openrouter')
const MODEL = arg('model', PROVIDER === 'openrouter' ? 'google/gemini-3.7-flash' : 'gpt-5.4')
const PASS = arg('pass', '1')
const TIMEOUT_MS = Number(arg('timeout', '50000'))
const CORPUS = arg('images', join(homedir(), 'Desktop', 'داتا التجريب'))
const OUT = arg('out', join(homedir(), 'Desktop', 'ash-ocr-runs'))
const ONLY = arg('field', '')
const LIMIT = Number(arg('limit', '0'))

const KEY = PROVIDER === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY
if (!KEY) {
  console.error(`set ${PROVIDER === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'}`)
  process.exit(1)
}

const adapter = await import(
  pathToFileURL(join(process.cwd(), 'packages/adapters/src/ocr/chat-completions.ts')).href
)

/**
 * Which of the four orders passes a request is, read off the prompt it carries.
 *
 * The adapter fires all four concurrently and sums their usage, so the aggregate cannot answer
 * "did screen-kind exhaust its 512". The prompt text is the only thing that distinguishes them on
 * the wire, which is exactly how `vision-bench.mjs` tells them apart too.
 */
function passOf(body, field) {
  const text = String(body?.messages?.[0]?.content?.[0]?.text ?? '')
  if (text.includes('ORDERS SCREEN-KIND') || text.includes('screenKind')) return 'orders:screen-kind'
  if (text.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return 'orders:money'
  if (text.includes('ORDERS PRINTED-TIME VERIFIER')) return 'orders:time'
  if (field === 'orders') return 'orders:route'
  return field
}

/** The ceiling each pass was given, so an exhaustion can be reported as a fraction of its budget. */
const CEILING = {
  'orders:screen-kind': 512,
  'orders:money': 4096,
  'orders:time': 2048,
  'orders:route': 8192,
  wallet: 8192,
  bms: 8192,
  odometer: 8192,
  payments_log: 8192,
}

/** Per-pass observations, filled by the fetch wrapper. */
let calls = []
let currentField = ''
/** Gate 11 only: rewrite the ceiling ON THE WIRE, since the adapter offers no override. */
let forceCeiling = 0

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  let body = JSON.parse(String(init?.body ?? '{}'))
  const pass = passOf(body, currentField)
  if (forceCeiling > 0) {
    for (const name of ['max_tokens', 'max_completion_tokens']) {
      if (name in body) body[name] = forceCeiling
    }
    init = { ...init, body: JSON.stringify(body) }
  }
  const startedAt = Date.now()
  let res
  try {
    res = await realFetch(url, init)
  } catch (err) {
    calls.push({ pass, ms: Date.now() - startedAt, status: 0, error: String(err?.name ?? err) })
    throw err
  }
  const ms = Date.now() - startedAt
  const clone = res.clone()
  let usage = {}
  let finish = null
  try {
    const json = await clone.json()
    usage = json.usage ?? {}
    finish = json.choices?.[0]?.finish_reason ?? null
  } catch {
    /* a non-JSON body is itself the observation */
  }
  calls.push({
    pass,
    ms,
    status: res.status,
    finish,
    tokensIn: usage.prompt_tokens ?? 0,
    tokensOut: usage.completion_tokens ?? 0,
    reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    ceiling: CEILING[pass] ?? null,
    // The field that made gate 11 necessary: a ceiling silently ignored is a reasoner with no bound.
    hitCeiling: finish === 'length',
  })
  return res
}

const reader = new adapter.ChatCompletionsOcrReader({
  provider: PROVIDER,
  apiKey: KEY,
  model: MODEL,
  effort: 'default',
  verbosity: 'default',
  timeoutMs: TIMEOUT_MS,
  onProviderError: (e) => console.error(`    ! ${e.kind} ${e.pass}: ${e.detail}`),
})

/* ── the truncation probe (gate 11) ────────────────────────────────────────────────────────────
 * The ONLY way to prove the provider honours the ceiling rather than ignoring it. OpenRouter takes
 * `max_tokens` and may silently drop `max_completion_tokens`; an ignored ceiling does not fail
 * loudly, it just stops bounding an uncapped reasoner. Force an absurd ceiling and demand a
 * `finish_reason: 'length'` back. */
if (flag('truncation-probe')) {
  const images = loadCorpus(CORPUS)
  const victim = images.find((im) => screenOf(im.sha) === 'odometer') ?? images[0]
  const probe = new adapter.ChatCompletionsOcrReader({
    provider: PROVIDER,
    apiKey: KEY,
    model: MODEL,
    effort: 'default',
    verbosity: 'default',
    timeoutMs: TIMEOUT_MS,
  })
  calls = []
  currentField = 'odometer'
  // 16 tokens cannot hold the schema, so an HONOURED ceiling must truncate. If the answer comes
  // back whole, the provider ignored the field and nothing bounds an uncapped reasoner.
  forceCeiling = 16
  await probe.read({ field: 'odometer', bytes: victim.bytes, mimeType: 'image/jpeg' })
  forceCeiling = 0
  const honoured = calls.some((c) => c.finish === 'length' || (c.tokensOut > 0 && c.tokensOut <= 32))
  console.log(`\nGATE 11 truncation probe: ${honoured ? 'PASS — the ceiling is honoured' : 'FAIL — the ceiling appears IGNORED'}`)
  console.log(JSON.stringify(calls, null, 1))
  process.exit(honoured ? 0 : 1)
}

/* ── the run ──────────────────────────────────────────────────────────────────────────────────── */
const key = answerKey()
const images = loadCorpus(CORPUS)
  .filter((im) => (ONLY ? fieldFor(im.sha) === ONLY : true))
  .slice(0, LIMIT || undefined)

/** The corpus records which SCREEN an image is; the adapter takes an `OcrField`. */
function fieldFor(sha) {
  const screen = screenOf(sha)
  return screen === 'recent_orders' ? 'orders' : screen === 'unknown' ? 'odometer' : screen
}

const runId = `${new Date().toISOString().slice(0, 10)}-adapter-${MODEL.replace(/\//g, '__').replace(/:/g, '~')}-p${PASS}`
const runDir = join(OUT, runId)
const imgDir = join(runDir, 'images')
mkdirSync(imgDir, { recursive: true })

console.log(`\n${runId}`)
console.log(`provider ${PROVIDER}  model ${MODEL}  timeout ${TIMEOUT_MS}ms  ${images.length} images`)
console.log('THE SHIPPED ADAPTER, one image per request, production prompts and ceilings.\n')

const perPass = new Map()
let done = 0
for (const im of images) {
  const field = fieldFor(im.sha)
  calls = []
  currentField = field
  const startedAt = Date.now()
  const reading = await reader.read({ field, bytes: im.bytes, mimeType: 'image/jpeg' })
  const ms = Date.now() - startedAt

  for (const c of calls) {
    const acc = perPass.get(c.pass) ?? { n: 0, maxOut: 0, maxMs: 0, ceilings: 0, statuses: {} }
    acc.n += 1
    acc.maxOut = Math.max(acc.maxOut, c.tokensOut ?? 0)
    acc.maxMs = Math.max(acc.maxMs, c.ms)
    if (c.hitCeiling) acc.ceilings += 1
    acc.statuses[c.status] = (acc.statuses[c.status] ?? 0) + 1
    perPass.set(c.pass, acc)
  }

  const rows = reading.result.ok ? reading.result.rows : []
  const truth = key[im.sha]
  const score = truth ? scoreImage({ rows, fields: [] }, truth) : null
  const rec = {
    sha: im.sha,
    file: im.rel,
    fixture: INDEX[im.sha]?.fixture ?? null,
    field,
    model: MODEL,
    provider: PROVIDER,
    runId,
    cacheSignature: reader.cacheSignature(field),
    ok: reading.result.ok,
    reason: reading.result.ok ? null : reading.result.reason,
    detail: reading.result.ok ? null : (reading.result.detail ?? null),
    rows,
    fields: reading.result.ok ? reading.result.fields : [],
    latencyMs: ms,
    usage: { in: reading.usage.tokensIn, out: reading.usage.tokensOut },
    calls,
    truth: truth ?? null,
    score,
  }
  mkdirSync(join(imgDir, im.sha), { recursive: true })
  writeFileSync(join(imgDir, im.sha, `${runId}.json`), JSON.stringify(rec, null, 1))

  done += 1
  const mark = !reading.result.ok ? '✗' : score && score.wrong.length === 0 && score.missed.length === 0 ? '✓' : '·'
  console.log(
    `  ${mark} ${String(done).padStart(2)}/${images.length} ${field.padEnd(13)} ${String(ms + 'ms').padStart(7)} ` +
      `${calls.length} call(s)` +
      (reading.result.ok ? '' : `  ${reading.result.reason}: ${reading.result.detail ?? ''}`),
  )
}

/* ── gates ────────────────────────────────────────────────────────────────────────────────────── */
console.log('\n' + '='.repeat(78))
console.log('PER-PASS BUDGETS — what production actually gives each call')
console.log('='.repeat(78))
console.log('pass                 calls   max out / ceiling      max ms   ceiling hits   statuses')
const GATE = {
  'orders:screen-kind': { out: 307, ms: 7_200 },
  'orders:money': { out: 2458, ms: 18_000 },
  'orders:time': { out: 1229, ms: 14_400 },
  'orders:route': { out: 4915, ms: 26_400 },
}
let failures = 0
for (const [pass, a] of [...perPass.entries()].sort()) {
  const ceil = CEILING[pass] ?? 0
  const gate = GATE[pass]
  const outBad = gate && a.maxOut > gate.out
  const msBad = gate && a.maxMs > gate.ms
  if (outBad || msBad || a.ceilings > 0) failures += 1
  console.log(
    `${pass.padEnd(20)} ${String(a.n).padStart(5)}   ${String(a.maxOut).padStart(6)} / ${String(ceil).padEnd(6)} ` +
      `${outBad ? 'OVER' : '    '}  ${String(a.maxMs).padStart(6)} ${msBad ? 'SLOW' : '    '}  ` +
      `${String(a.ceilings).padStart(6)}        ${JSON.stringify(a.statuses)}`,
  )
}
console.log('\ngate 1 screen-kind out <= 307 (60% of 512) — exhaustion fails EVERY orders read')
console.log('gate 11 run --truncation-probe separately: proves the ceiling is honoured at all')
console.log(
  failures === 0
    ? '\nALL PER-PASS GATES PASS on this run. Score it with ocr-compare.mjs before concluding anything.'
    : `\n${failures} pass(es) BREACHED a gate. Do not flip the driver; raise the constant (it is inside cacheSignature) or stay put.`,
)
console.log(`\nwrote ${runDir}`)
