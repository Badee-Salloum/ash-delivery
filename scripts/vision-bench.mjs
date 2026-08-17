#!/usr/bin/env node
/**
 * GEMINI, per image, inside a 20-request-a-day free tier.
 *
 *     node scripts/vision-bench.mjs --dry            build every request, send nothing
 *     node scripts/vision-bench.mjs --models         ask which model ids the key actually has
 *     node scripts/vision-bench.mjs --pass=1         one full pass over all 66 images
 *     node scripts/vision-bench.mjs --report         re-render review.html, zero requests
 *
 * ── WHAT THIS MEASURES, AND WHY THE OBVIOUS VERSION OF IT DOES NOT WORK ──────────────────────
 *
 * The failure being hunted is documented at `ocr-bench.mjs:50-73`: Gemini read «−١٬١٥٥٫٦٥» as
 * «115565» — the decimal dropped, a hundredfold error — in ONE RUN IN TEN, at temperature 0. On a
 * shift that must balance to exactly zero, plausible-and-wrong is the failure with no defence.
 *
 * The tempting design is to ask the model for the amount twice, once "as printed" and once parsed,
 * and to flag any disagreement. It does not work, and it is worth writing down why, because it
 * looks like it should. Both fields come out of ONE completion, the second conditioned on the
 * first. When the decimal is lost during READING — which is what actually happened — the printed
 * field comes back «١١٥٥٦٥» and the parsed field faithfully mirrors it as «115565». They agree.
 * The check passes. It only ever catches a normaliser bug inside the model, which is not the bug.
 *
 * So this asks instead for things that are cheap to state and awkward to fake, generated BEFORE
 * the amount (see `propertyOrdering`):
 *
 *   hasDecimal   does this amount have a FRACTIONAL PART at all?  ← catches the dropped decimal
 *   hasThousands is a thousands mark printed?
 *   digitCount   how many digit glyphs, ignoring marks?           ← catches dropped/added digits
 *
 * A model that answers `hasDecimal: true` and then hands back «١١٥٥٦٥» has contradicted
 * itself in a way we can see without knowing the answer. And the strongest check of all costs no
 * quota whatsoever: the SHIPPED GLYPH READER runs over the same corpus as a genuinely independent
 * second opinion — a different algorithm, not a second field of the same completion.
 *
 * ── ON THE DATA ──────────────────────────────────────────────────────────────────────────────
 * These screenshots hold real customer addresses and metre-level GPS. The owner decided on
 * 2026-08-13 to use the FREE tier, whose terms permit Google to train on submitted content and
 * allow human review. `ocr-bench.mjs:384` states the opposite principle; the difference is a
 * decision, recorded so nobody later mistakes it for an oversight.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { INDEX, answerKey, loadCorpus, scoreImage, screenOf } from './ocr-corpus.mjs'

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const flag = (name) => process.argv.includes(`--${name}`)

const CORPUS = arg('images', join(homedir(), 'Desktop', 'داتا التجريب'))
/**
 * OUTSIDE THE REPO, deliberately, and for the same reason `backups/` is: this writes customer
 * addresses and GPS to disk. A gitignored directory inside the working tree is one `git add -f`
 * from being permanent; a sibling directory cannot be committed by accident at all.
 */
const OUT = arg('out', join(homedir(), 'Desktop', 'ash-ocr-runs'))
/**
 * Pinned to the model the CONSOLE meters, not to an alias.
 *
 * `gemini-flash-latest` is a moving target and its quota is metered separately; the dashboard we
 * read the 5 RPM / 20 RPD from says «Gemini 3.6 Flash», so the benchmark asks for exactly that.
 * Measuring one model against another model's quota is how a run dies halfway through.
 */
/** Each provider carries its own default so `--provider=openrouter` alone is a valid run. */
const DEFAULT_MODEL = { openai: 'gpt-5.4-mini', openrouter: 'google/gemini-3.6-flash', gemini: 'gemini-3.6-flash' }
const MODEL = arg('model', process.env.GEMINI_MODEL ?? DEFAULT_MODEL[arg('provider', 'gemini')] ?? 'gemini-3.6-flash')

/**
 * `dynamic` sends no thinkingConfig at all, `off` pins the budget to zero, a number fixes it.
 *
 * DEFAULTS TO `dynamic` BECAUSE THIS MODEL REJECTS THE FIELD. Measured, not assumed: with
 * `thinkingConfig: { thinkingBudget: 0 }` gemini-3.6-flash answers a bare
 * `400 INVALID_ARGUMENT` naming nothing — Gemini 3.x replaced `thinkingBudget` with `thinkingLevel`,
 * so the 2.5-era field is simply not a field any more. That probe cost one request out of twenty,
 * which is exactly what `--limit=1` and stop-on-first-error are for.
 *
 * The pinning was wanted for a reason that has not gone away: a reasoning budget that varies per
 * call is a live variable in an experiment trying to explain a fault that appears one run in ten at
 * temperature 0. Re-pinning it means `thinkingLevel`, and that is worth doing before drawing any
 * conclusion about determinism from repeat passes.
 */
const THINKING = arg('thinking', 'dynamic')

/** Which vendor. Same images, same prompt, same answer key — only the wire format differs. */
const PROVIDER = arg('provider', 'gemini')

/** OpenAI 5.x reasoning effort. `default` omits the field entirely. */
const EFFORT = arg('effort', 'default')

/**
 * OpenAI 5.x output verbosity. `default` omits the field entirely.
 *
 * Worth a flag rather than a constant because on a transcription task it is very close to a PRICE
 * knob: output is roughly three quarters of the bill at $30/1M against $5/1M in, and a terser model
 * has less room to editorialise around the number we asked for. Whether it also costs accuracy is
 * the thing to measure — a reader that says less could equally be a reader that looked less.
 */
const VERBOSITY = arg('verbosity', 'default')

/**
 * `--raw` asks for a PLAIN TRANSCRIPTION and no schema at all, and we do every bit of the parsing.
 *
 * Worth testing rather than assuming, because the structured mode measurably changes the answer:
 * asked for JSON, gpt-5.4-mini returned «-165.0» in LATIN digits for a row printed «−١٦٥٫٥٠» — it
 * normalised while transcribing, in the one field whose whole job was not to. Constrained decoding
 * costs the model something, and this measures how much.
 *
 * It does NOT fix a lost decimal. Scored both ways over every run already on disk, our own parse of
 * the model's glyph string scores identically to the model's own number (and slightly WORSE for
 * gpt-5.4), because gpt-5.4 wrote «−١٦٥٠٠» — the mark is simply not in the string it returned. No
 * downstream parser can recover a character the reader never emitted.
 */
const RAW = flag('raw')

/** Output ceiling. Reasoning/thinking tokens count against it on BOTH vendors. */
const MAX_OUT = Number(arg('max-out', '32768'))
const BATCH = Number(arg('batch', '8'))
const PASS = arg('pass', '1')
const DRY = flag('dry')

/**
 * Measured from the console on 2026-08-13, free tier: RPM 5 · RPD 20 · TPM 250K.
 *
 * The owner first said "5 per day"; the dashboard says 5 per MINUTE and 20 per day. The difference
 * is what makes this benchmark worth running — at the default batch of eight, 20 a day affords two
 * full passes over the current 66 images, and repetition is the only thing that can catch a fault
 * that shows up one run in ten.
 */
const RPD = Number(arg('rpd', arg('provider', 'gemini') === 'gemini' ? '20' : '40'))
const RPM = Number(arg('rpm', arg('provider', 'gemini') === 'gemini' ? '5' : '30'))
const SPACING_MS = Math.ceil(60_000 / RPM) + 1_000

const RELAY = arg('relay', process.env.GEMINI_RELAY_URL ?? '')
const SECRET = process.env.RELAY_SECRET ?? ''

// ── The quota ledger ─────────────────────────────────────────────────────────────────────────

/**
 * Google's daily window resets at midnight US PACIFIC, not local midnight.
 *
 * Damascus is UTC+3 and Los Angeles is UTC-7/8, so a local date key is ten or eleven hours out of
 * step with the window it claims to track: it would refuse while quota remained, then let a run
 * start that overruns. Keyed on the actual reset zone instead.
 */
const quotaDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
/*
 * The ledger is PER PROVIDER, and on a paid account it is a spend guard rather than a quota mirror.
 *
 * Gemini's key is a hard 20-a-day free-tier ceiling. OpenAI's is a card. The failure modes are
 * opposite — one refuses, the other silently bills — so the same counter cannot serve both, and a
 * shared key would have let a spent Gemini day block a paid OpenAI run for no reason at all.
 */
const ledgerKey = () => `${PROVIDER}:${quotaDay()}`
const ledgerPath = () => join(OUT, 'budget.json')

function readLedger() {
  try {
    return JSON.parse(readFileSync(ledgerPath(), 'utf8'))
  } catch {
    return {}
  }
}
/** Written BEFORE the call: if the process dies mid-request the quota still counted, so we must. */
function spend(n = 1) {
  const led = readLedger()
  const k = ledgerKey()
  led[k] = (led[k] ?? 0) + n
  mkdirSync(OUT, { recursive: true })
  writeFileSync(ledgerPath(), JSON.stringify(led, null, 2))
  return led[k]
}
const spentToday = () => readLedger()[ledgerKey()] ?? 0

// ── The request ──────────────────────────────────────────────────────────────────────────────

/**
 * `propertyOrdering` is load-bearing, not cosmetic.
 *
 * Gemini generates the object's fields in this order, so the verification fields are committed to
 * BEFORE the amount is written. Put `value` first and the model decides the number, then
 * back-fills the evidence from its own decision — the check becomes circular and always passes.
 *
 * `value` is a STRING and must stay one. Declared as NUMBER, constrained decoding cannot emit the
 * trailing zero in «-165.50», so every .50 and .00 in the corpus would come back short by
 * construction — the scorer would then report a hundred failures that are its own fault.
 */
const ROW_SCHEMA = {
  type: 'object',
  propertyOrdering: ['hasDecimal', 'hasThousands', 'digitCount', 'printed', 'value', 'time', 'dateIso', 'cancelled'],
  required: ['hasDecimal', 'hasThousands', 'digitCount', 'printed', 'value', 'time'],
  properties: {
    hasDecimal: { type: 'boolean', description: 'true iff this amount has a FRACTIONAL PART — a decimal mark ٫ (U+066B) or "." followed by one or two digits at the end' },
    hasThousands: { type: 'boolean', description: 'true iff a THOUSANDS mark is printed: ٬ (U+066C), ، (U+060C) or ","' },
    digitCount: { type: 'integer', description: 'how many DIGIT glyphs the amount has, ignoring sign and separators' },
    printed: { type: 'string', description: 'the amount EXACTLY as printed: same digits, same marks, same sign. Never converted.' },
    value: { type: 'string', nullable: true, description: 'STRING, never a number. Western digits, "." decimal, sign kept. "-165.50" keeps its trailing zero. null if the row has no amount.' },
    time: { type: 'string', nullable: true, description: '24-hour HH:MM' },
    dateIso: { type: 'string', nullable: true, description: 'YYYY-MM-DD from the nearest date header ABOVE this row' },
    cancelled: { type: 'boolean' },
  },
}

const IMAGE_SCHEMA = {
  type: 'object',
  propertyOrdering: ['id', 'screen', 'theme', 'statusBarClock', 'rowCount', 'rows', 'fields', 'notes'],
  required: ['id', 'screen', 'theme', 'rowCount', 'rows'],
  properties: {
    id: { type: 'string', description: 'the IMG-nn label printed on the image itself' },
    screen: { type: 'string', enum: ['payments_log', 'recent_orders', 'odometer', 'bms', 'other'] },
    theme: { type: 'string', enum: ['light', 'dark'] },
    statusBarClock: { type: 'string', nullable: true, description: "the phone's own clock in the status bar" },
    rowCount: { type: 'integer', description: 'how many money rows this screen shows' },
    rows: { type: 'array', items: ROW_SCHEMA },
    fields: {
      type: 'array',
      description: 'odometer / BMS screens only — no money rows',
      items: {
        type: 'object',
        required: ['label', 'value'],
        properties: { label: { type: 'string' }, value: { type: 'string' } },
      },
    },
    notes: { type: 'string', nullable: true },
  },
}

const SCHEMA = {
  type: 'object',
  required: ['images'],
  properties: { images: { type: 'array', items: IMAGE_SCHEMA } },
}

const PROMPT = `You are transcribing screenshots from a Damascus delivery company's driver app. Every number you read becomes money in a ledger that must balance to exactly zero, so a plausible guess is worse than an honest refusal.

For EACH image, in the order given, produce one entry.

\`id\` — copy the IMG-nn label printed in the white strip at the top of the image itself. It identifies which image you are describing; get it from the pixels, not from your own count.

For every money row, answer the verification fields FIRST and honestly, then the amount:

  hasDecimal         — does this amount have a FRACTIONAL PART? (a "٫" or "." followed by one or two digits at the end)
  hasThousands       — is a THOUSANDS mark printed? ("٬", "،" or ",")
  digitCount         — how many digit glyphs, excluding the sign and any separators?
  printed            — the amount EXACTLY as it appears. Same digits (Arabic-Indic ٠١٢٣٤٥٦٧٨٩ stay Arabic-Indic), same marks, same sign. Convert NOTHING here.
  value              — only here do you convert. Western digits, "." as the decimal point, sign kept, as a STRING.

٫ and ٬ are DIFFERENT characters and the difference is a factor of one hundred. ٫ is the decimal mark and is followed by one or two digits at the end. ٬ and ، are thousands marks and always leave groups of exactly three digits.

  «−١٬١٥٥٫٦٥»  →  printed "−١٬١٥٥٫٦٥", value "-1155.65", digitCount 6, hasDecimal true, hasThousands true
  NOT "-115565". This single error is the reason this benchmark exists.

Other rules, each of which corresponds to a real screen in this set:

- A payments-log row is SIGNED: "+" is money arriving, "−" money leaving. Keep the sign in \`value\`. Orders-list fees are unsigned.
- A CANCELLED order ("Cancelled" / "تم إلغاؤه") has NO amount: \`value\` null, \`cancelled\` true, \`digitCount\` 0. Never copy a number from a neighbouring row.
- A card SLICED by the top or bottom edge may show its addresses but not its fee: \`value\` null, and say so in \`notes\`.
- A screen may carry MORE THAN ONE date header ("Friday, August 7" … then lower down "Thursday, August 6"). Each row takes the nearest header ABOVE it. Month names may be Arabic (أغسطس, آب), Maghrebi (غشت) or English. The year is 2026.
- Times: Arabic "م" is PM, "ص" is AM. Report 24-hour HH:MM. Some screens already print 24-hour times.
- Addresses contain digits — "المدخل ١", "entrance ٨٦", GPS pairs, plus-codes like "G63V 78J". Those are NOT fees. Only the amount printed beside "SYP" is a fee.
- If a character is genuinely unreadable, put "?" in \`printed\` and null in \`value\`. An honest refusal is a correct answer.

An odometer photo (a physical bike dashboard behind glass) and a BMS battery app screenshot have no money rows: \`rows\` is [], \`rowCount\` 0, and the readable labelled values go in \`fields\`.`

/**
 * The id is burned INTO THE PIXELS, not passed as a neighbouring text part.
 *
 * Batching is what makes 48 images fit in a 20-a-day quota, and the failure it introduces is
 * silent: rows from image 3 attributed to image 7 look perfectly plausible and are entirely wrong.
 * A text label sitting beside the image is something the model can shuffle; a label it has to READ
 * off the image cannot drift from the image it is printed on.
 */
async function labelImage(bytes, label) {
  const { createCanvas, loadImage } = await import(
    (await import('node:url')).pathToFileURL(
      (await import('node:module')).createRequire(join(process.cwd(), 'apps', 'driver', 'package.json')).resolve('@napi-rs/canvas'),
    ).href
  )
  const img = await loadImage(bytes)
  const strip = Math.max(48, Math.round(img.height * 0.035))
  const canvas = createCanvas(img.width, img.height + strip)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, strip)
  ctx.fillStyle = '#000000'
  ctx.font = `bold ${Math.round(strip * 0.62)}px sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText(label, 12, strip / 2)
  ctx.drawImage(img, 0, strip)
  return canvas.toBuffer('image/jpeg', 88)
}

/**
 * The RAW prompt — transcription only, no schema, no conversion, no structure.
 *
 * Deliberately close to the prompt `ocr-bench.mjs:221-224` used when it recorded gemini at 48/48,
 * so a difference between the two modes is attributable to the SCHEMA rather than to the wording.
 */
const RAW_PROMPT = `Transcribe these phone screenshots exactly as printed.

Each image carries a label like IMG-07 in a white strip at the very top. Begin each image's
transcription with that label alone on its own line, copied from the pixels.

Then write every line of that screen, one line of output per line on screen, in the order they
appear top to bottom.

Copy the characters you SEE. Do not convert anything:
- Arabic-Indic digits ٠١٢٣٤٥٦٧٨٩ stay Arabic-Indic. Never write them as 0123456789.
- The thousands mark ٬ (U+066C) and the decimal mark ٫ (U+066B) are DIFFERENT characters and must
  stay different. ٫ sits raised, is the decimal point, and is followed by one or two digits at the
  end. ٬ sits on the baseline, is the thousands mark, and always leaves groups of exactly 3 digits.
  «−١٬١٥٥٫٦٥» has both, and writing it as «−١١٥٥٦٥» is a hundredfold error on somebody's wages.
- Keep the sign exactly as printed: + or −.
- If a character is genuinely unreadable, write ? for that character. An honest ? is a correct
  answer; a plausible guess is not.

Output nothing but the transcription.`

/**
 * Plain text back into the same shape the structured mode produces, so ONE scorer serves both.
 *
 * Everything numeric is done here rather than by the model — which is the whole point of the mode.
 * `printed` carries the glyphs and `value` is left null, so the scorer falls through to our own
 * `normaliseMoney(printed)` exactly as it does for a structured run.
 */
function parseRaw(text) {
  const images = []
  let current = null
  for (const line of String(text).split('\n')) {
    const label = line.match(/\bIMG[-\s]?(\d{2})\b/)
    if (label && line.trim().length <= 12) {
      current = { id: `IMG-${label[1]}`, screen: 'other', theme: null, statusBarClock: null, rows: [], fields: [], notes: null, rawLines: [] }
      images.push(current)
      continue
    }
    if (!current) continue
    current.rawLines.push(line)

    // A money row is a line carrying the SYP anchor. Take the number ADJACENT to it — the same rule
    // `ocr-bench.mjs:417` uses — because these screens also print digits in addresses, plus-codes
    // and coordinates, and none of those are fees.
    if (!/SYP/i.test(line)) continue
    const before = line.split(/SYP/i)[0]
    const after = line.split(/SYP/i)[1] ?? ''
    const TOKEN = /[-+−–—]?[\d٠-٩۰-۹][\d٠-٩۰-۹٬٫،,.]*/g
    const left = before.match(TOKEN)
    const right = after.match(TOKEN)
    const printed = (left && left.length ? left[left.length - 1] : right && right.length ? right[0] : null)
    if (printed === null) continue
    current.rows.push({ printed, value: null, time: null, dateIso: null, cancelled: false, hasDecimal: null, hasThousands: null, digitCount: null })
  }
  for (const im of images) { im.rowCount = im.rows.length; delete im.rawLines }
  return { images }
}

/**
 * ── TWO PROVIDERS, ONE EXPERIMENT ────────────────────────────────────────────────────────────
 *
 * Same images, same prompt, same answer key, same review page. Only the wire format differs, so a
 * difference in the results is a difference in the MODEL rather than in how it was asked.
 *
 * The schemas are not interchangeable, and the differences are load-bearing:
 *
 *   Gemini  `responseSchema` + `propertyOrdering`, which fixes the ORDER fields are generated in.
 *           That is what puts the verification fields before the amount.
 *   OpenAI  `json_schema` with `strict: true`, which has no ordering control but DOES demand
 *           `additionalProperties: false` and every property listed in `required`; it refuses a
 *           schema missing either. It has no `nullable` — an optional value is a type union.
 *           Generation follows declaration order, which is why the row schema is already written
 *           in the same order as Gemini's `propertyOrdering`.
 */
const PROVIDERS = {
  gemini: {
    defaultModel: 'gemini-3.6-flash',
    build: (batch) => ({
      contents: [
        {
          parts: [
            { text: RAW ? RAW_PROMPT : PROMPT },
            ...batch.map((im) => ({ inline_data: { mime_type: 'image/jpeg', data: im.labelled.toString('base64') } })),
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        topP: 1,
        seed: 7,
        /*
         * PINNED, and this is as much the experiment as the model is.
         *
         * Flash ships with thinking ON and `thinkingBudget: -1` (dynamic), so the amount of hidden
         * reasoning varies from call to call — a mechanically plausible explanation for a 1-in-10
         * flip at temperature 0. Thinking tokens also count against maxOutputTokens, so a dynamic
         * budget under a small ceiling can consume the lot and return a candidate with no parts.
         */
        ...(THINKING === 'dynamic' ? {} : { thinkingConfig: { thinkingBudget: THINKING === 'off' ? 0 : Number(THINKING) } }),
        maxOutputTokens: MAX_OUT,
        ...(RAW ? {} : { responseMimeType: 'application/json', responseSchema: SCHEMA }),
      },
    }),
    extract: (json) => {
      if (json.promptFeedback?.blockReason) throw new Error(`gemini blocked: ${json.promptFeedback.blockReason}`)
      if (json.error) throw new Error(`gemini ${json.error.code}: ${json.error.message}`)
      const c = json.candidates?.[0]
      if (!c) throw new Error('gemini: no candidate in response')
      if (c.finishReason && c.finishReason !== 'STOP') throw new Error(`gemini finishReason=${c.finishReason}`)
      const parts = c.content?.parts
      if (!Array.isArray(parts) || parts.length === 0) {
        throw new Error('gemini: candidate has no parts — thinking most likely consumed maxOutputTokens')
      }
      const u = json.usageMetadata ?? {}
      const out = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)
      if (out >= MAX_OUT * 0.98) throw new Error(`gemini: ${out}/${MAX_OUT} output tokens — treat as truncated`)
      return parts.map((p) => p.text ?? '').join('')
    },
    usage: (json) => {
      const u = json.usageMetadata ?? {}
      return {
        in: u.promptTokenCount ?? 0,
        out: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        reasoning: u.thoughtsTokenCount ?? 0,
        raw: u,
      }
    },
  },

  /*
   * OpenRouter: one key, many vendors — and the only payment channel that works from here.
   *
   * WHY NOT ALIBABA DIRECT, which is cheaper: their own structured-output documentation says Qwen
   * supports `response_format: {"type":"json_object"}` and NOT strict JSON Schema, and requires the
   * word "json" to appear in the prompt. This benchmark's whole method rests on the model being
   * unable to omit `hasDecimal` / `hasThousands` / `digitCount` — the fields the money check
   * re-derives the amount from. JSON mode guarantees valid JSON of arbitrary shape, which is not
   * the same promise at all. Alibaba also lists VL structured output under non-thinking mode, and
   * reasoning is exactly what bought gpt-5.5 its accuracy.
   *
   * OpenRouter answers both: queried live, eight Qwen VL models advertise `structured_outputs`,
   * including the thinking variants. It speaks the OpenAI Chat Completions shape, so this entry is
   * the `openai` one below with three OpenAI-only knobs removed.
   *
   * `strict: true` is sent, but OpenRouter's docs are explicit that enforcement varies by upstream
   * host — some constrain decoding natively, others treat the schema as a strong hint. So batch 1
   * is the real smoke test: if rows come back missing the verification fields, this is measuring
   * a different thing and the run should stop rather than collect five batches of noise.
   */
  openrouter: {
    defaultModel: 'qwen/qwen3-vl-235b-a22b-thinking',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    envKey: 'OPENROUTER_API_KEY',
    build: (batch) => ({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: RAW ? RAW_PROMPT : PROMPT },
            ...batch.map((im) => ({
              type: 'image_url',
              // Same reasoning as the OpenAI entry: on `low` the image becomes a single 512px tile
              // and Arabic-Indic digits stop being resolvable. Non-OpenAI hosts generally accept
              // and ignore this; Qwen's own resolution control is a pixel budget, so if a run comes
              // back uniformly unable to read digits, suspect downsampling before blaming the model.
              image_url: { url: `data:image/jpeg;base64,${im.labelled.toString('base64')}`, detail: 'high' },
            })),
          ],
        },
      ],
      // `max_tokens`, not `max_completion_tokens` — the older name is what compatible endpoints
      // accept. Sending only the newer one risks a silently ignored ceiling, and an ignored ceiling
      // shows up as a truncated completion that reads exactly like "the screen had nothing on it".
      max_tokens: MAX_OUT,
      // Qwen has no `reasoning_effort` and no `verbosity`; the reasoning knob here is which MODEL
      // you pick (`-thinking` vs `-instruct`). Temperature 0 IS accepted, unlike OpenAI 5.x.
      temperature: 0,
      ...(RAW ? {} : { response_format: { type: 'json_schema', json_schema: { name: 'screens', strict: true, schema: strictify(SCHEMA) } } }),
    }),
    extract: (json) => {
      if (json.error) throw new Error(`openrouter ${json.error.code ?? json.error.type}: ${json.error.message}`)
      const c = json.choices?.[0]
      if (!c) throw new Error('openrouter: no choice in response')
      if (c.finish_reason && c.finish_reason !== 'stop') throw new Error(`openrouter finish_reason=${c.finish_reason}`)
      const text = c.message?.content
      // No `refusal` field outside OpenAI — a refusal arrives as prose in `content` and fails the
      // JSON parse downstream, which is the same outcome by a different road.
      if (!text) throw new Error('openrouter: empty content — the output ceiling was most likely consumed')
      return text
    },
    usage: (json) => {
      const u = json.usage ?? {}
      return {
        in: u.prompt_tokens ?? 0,
        out: u.completion_tokens ?? 0,
        // Thinking variants may or may not itemise reasoning tokens; they are already inside
        // `completion_tokens` either way, so 0 here under-reports a breakdown, never the bill.
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
        raw: u,
      }
    },
  },

  openai: {
    defaultModel: 'gpt-5.4-mini',
    build: (batch) => ({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: RAW ? RAW_PROMPT : PROMPT },
            ...batch.map((im) => ({
              type: 'image_url',
              // `detail: high` is not optional here. On `low` the image is downsampled to a single
              // 512px tile, and Arabic-Indic digits at this size stop being resolvable at all — the
              // benchmark would be measuring the downsampler rather than the model.
              image_url: { url: `data:image/jpeg;base64,${im.labelled.toString('base64')}`, detail: 'high' },
            })),
          ],
        },
      ],
      max_completion_tokens: MAX_OUT,
      /*
       * NO `temperature`. The 5.x reasoning models reject any value but the default and answer a
       * 400 `unsupported_value` — which would cost a PAID request to discover. Determinism there is
       * governed by reasoning effort, not by a sampling knob.
       */
      ...(EFFORT === 'default' ? {} : { reasoning_effort: EFFORT }),
      ...(VERBOSITY === 'default' ? {} : { verbosity: VERBOSITY }),
      ...(RAW ? {} : { response_format: { type: 'json_schema', json_schema: { name: 'screens', strict: true, schema: strictify(SCHEMA) } } }),
    }),
    extract: (json) => {
      if (json.error) throw new Error(`openai ${json.error.code ?? json.error.type}: ${json.error.message}`)
      const c = json.choices?.[0]
      if (!c) throw new Error('openai: no choice in response')
      if (c.finish_reason && c.finish_reason !== 'stop') throw new Error(`openai finish_reason=${c.finish_reason}`)
      if (c.message?.refusal) throw new Error(`openai refused: ${c.message.refusal}`)
      const text = c.message?.content
      if (!text) throw new Error('openai: empty content — reasoning most likely consumed max_completion_tokens')
      return text
    },
    usage: (json) => {
      const u = json.usage ?? {}
      return {
        in: u.prompt_tokens ?? 0,
        out: u.completion_tokens ?? 0,
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
        raw: u,
      }
    },
  },
}

/**
 * Gemini's schema dialect translated into OpenAI's strict one.
 *
 * `strict: true` refuses a schema unless EVERY property appears in `required` and every object sets
 * `additionalProperties: false`, and it has no `nullable` — an optional value is a type union.
 * Translating here rather than hand-maintaining two schemas keeps the providers genuinely
 * comparable: a field that quietly drifted between them would read as a model difference.
 */
function strictify(node) {
  if (Array.isArray(node)) return node.map(strictify)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'propertyOrdering' || k === 'nullable') continue
    out[k] = strictify(v)
  }
  if (node.nullable === true && typeof node.type === 'string') out.type = [node.type, 'null']
  if (out.type === 'object' && out.properties) {
    out.additionalProperties = false
    out.required = Object.keys(out.properties)
  }
  return out
}

const provider = () => {
  const p = PROVIDERS[PROVIDER]
  if (!p) throw new Error(`unknown provider "${PROVIDER}" — known: ${Object.keys(PROVIDERS).join(', ')}`)
  return p
}
const buildRequest = (batch) => provider().build(batch)

// ── Talking to the relay ─────────────────────────────────────────────────────────────────────

/**
 * Every one of these failure modes returns HTML, not JSON, and every one costs a request:
 * Vercel deployment protection (401 SSO page), FUNCTION_INVOCATION_TIMEOUT (504),
 * FUNCTION_PAYLOAD_TOO_LARGE (413). `res.json()` on any of them throws something unhelpful, so the
 * body is captured to disk first and the error names the file.
 */
async function callRelay(request, rawDir, tag) {
  /*
   * DIRECT WHEN THE PROVIDER IS REACHABLE, relayed when it is not.
   *
   * The relay exists because Google and OpenAI geo-block Syria — it is a Vercel function in a US
   * region whose only job is to be somewhere they will answer. Measured 2026-08-17: OpenRouter
   * answers Damascus directly (`/api/v1/key` → 200), so a provider carrying its own `endpoint` and
   * an env key skips the hop entirely. One less moving part, one less place for a 504 to come from,
   * and no key sitting in a second project's environment.
   *
   * Set `--relay=` / `GEMINI_RELAY_URL` and it goes back through the relay regardless, which is
   * what the geo-blocked providers still need.
   */
  const provider = PROVIDERS[PROVIDER]
  const directKey = provider?.envKey ? process.env[provider.envKey] : undefined
  if (RELAY === '' && provider?.endpoint && directKey) {
    const res = await fetch(provider.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${directKey}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(270_000),
    })
    const ct = res.headers.get('content-type') ?? ''
    const text = await res.text()
    if (!res.ok || !ct.includes('json')) {
      writeFileSync(join(rawDir, `${tag}.error.txt`), `HTTP ${res.status}  ${ct}\n\n${text.slice(0, 8000)}`)
      throw new Error(`${PROVIDER} ${res.status} (${ct || 'no content-type'}) — see raw/${tag}.error.txt`)
    }
    return JSON.parse(text)
  }

  const res = await fetch(RELAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-secret': SECRET, 'x-provider': PROVIDER },
    body: JSON.stringify({ model: MODEL, request }),
    signal: AbortSignal.timeout(270_000),
  })
  const ct = res.headers.get('content-type') ?? ''
  const text = await res.text()
  if (!res.ok || !ct.includes('json')) {
    writeFileSync(
      join(rawDir, `${tag}.error.txt`),
      `HTTP ${res.status}  ${ct}\nx-vercel-id: ${res.headers.get('x-vercel-id')}\n\n${text.slice(0, 8000)}`,
    )
    throw new Error(`relay ${res.status} (${ct || 'no content-type'}) — see raw/${tag}.error.txt`)
  }
  return JSON.parse(text)
}

/**
 * A truncated structured response is the quiet one.
 *
 * `ocr-bench.mjs:243` uses `(parts ?? []).map(p => p.text ?? '').join('')`, which turns every one of
 * these into an empty string with no error — a batch that hit the output ceiling would be scored as
 * "eight images, zero rows" and the summary would look merely disappointing rather than broken.
 * Both providers under-report truncation, so each extractor checks for it explicitly.
 */
const extractText = (json) => provider().extract(json)

// ── Main ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const images = loadCorpus(CORPUS)
  const key = answerKey()
  console.log(`corpus: ${images.length} images · answer key covers ${Object.keys(key).length}`)

  // Re-render the review page from what is already on disk. Costs NOTHING, so the answer key can be
  // corrected and everything re-scored as often as you like without touching the quota.
  if (flag('report')) {
    const { render } = await import('./ocr-report.mjs')
    const r = render(OUT, CORPUS, new Map(images.map((im) => [im.sha, im.bytes])))
    console.log(`\n${r.path}\n  ${r.images} images · ${r.runs} pass(es) · ${JSON.stringify(r.counts)}`)
    return
  }

  if (flag('models')) {
    if (!RELAY) throw new Error('--models needs --relay=<url> or GEMINI_RELAY_URL')
    const r = await fetch(RELAY, { headers: { 'x-relay-secret': SECRET } })
    const j = await r.json()
    for (const m of j.models ?? []) {
      if ((m.supportedGenerationMethods ?? []).includes('generateContent')) {
        console.log(`  ${(m.name ?? '').replace('models/', '').padEnd(38)} ${m.displayName ?? ''}`)
      }
    }
    return
  }

  // Size-balanced batches: fill them largest-first round-robin so no single request carries the
  // ten biggest images at once. Vercel's body cap is 4.5 MB and the corpus is 4.45 MB base64 in
  // total, so a badly-packed batch is not fatal — but it costs nothing to keep every one small.
  const sorted = [...images].sort((a, b) => b.bytes.length - a.bytes.length)
  const nBatches = Math.ceil(images.length / BATCH)
  const batches = Array.from({ length: nBatches }, () => [])
  sorted.forEach((im, i) => batches[i % nBatches].push(im))

  /*
   * The model id goes into a DIRECTORY NAME, and OpenRouter ids carry a vendor prefix with a slash
   * — `qwen/qwen3-vl-235b-a22b-thinking`. Left alone that silently creates a nested folder, the run
   * lands one level deeper than every scorer looks for it, and the pass appears to have produced
   * nothing. Flattened to `qwen__qwen3-vl-…`, which `ocr-compare.mjs` reverses.
   */
  const runId = `${quotaDay()}-${MODEL.replace(/\//g, '__')}-p${PASS}`
  const runDir = join(OUT, runId)
  const rawDir = join(runDir, 'raw')
  const imgDir = join(runDir, 'images')
  mkdirSync(rawDir, { recursive: true })
  mkdirSync(imgDir, { recursive: true })

  // Label every image before anything is sized or sent, so --dry reports the real payload.
  let n = 0
  for (const im of images) im.label = `IMG-${String(++n).padStart(2, '0')}`
  for (const im of images) im.labelled = await labelImage(im.bytes, im.label)

  console.log(`\nbatches (${BATCH}/request, size-balanced):`)
  let total = 0
  const requests = batches.map((batch, i) => {
    const req = buildRequest(batch)
    const bytes = Buffer.byteLength(JSON.stringify({ model: MODEL, request: req }))
    total += bytes
    console.log(
      `  batch ${i + 1}: ${String(batch.length).padStart(2)} images  ${(bytes / 1024).toFixed(0).padStart(5)} KB  ` +
        batch.map((im) => im.label).join(' '),
    )
    return { batch, req, bytes }
  })
  console.log(`  total ${(total / 1048576).toFixed(2)} MB across ${requests.length} requests`)

  const used = spentToday()
  console.log(`\nquota (${quotaDay()} US/Pacific): ${used}/${RPD} used, ${RPD - used} left · this pass needs ${requests.length}`)

  if (DRY) {
    console.log('\n--dry: nothing sent. Prompt is below.\n')
    console.log(RAW ? RAW_PROMPT : PROMPT)
    writeFileSync(join(runDir, 'dry-request-1.json'), JSON.stringify({ model: MODEL, request: requests[0].req }, null, 1).slice(0, 4000))
    return
  }
  /*
   * A relay is required only for the providers that need one. Google and OpenAI geo-block Syria, so
   * calls to them must originate from the US function; OpenRouter answers Damascus directly
   * (measured 2026-08-17), so it needs an endpoint and a key and nothing else.
   */
  const direct = PROVIDERS[PROVIDER]?.endpoint && process.env[PROVIDERS[PROVIDER]?.envKey ?? '']
  if (!RELAY && !direct) {
    const wants = PROVIDERS[PROVIDER]?.envKey
    throw new Error(
      wants
        ? `set ${wants} to call ${PROVIDER} directly, or --relay=<url> (and RELAY_SECRET) to go through the relay`
        : 'set --relay=<url> or GEMINI_RELAY_URL (and RELAY_SECRET)',
    )
  }
  if (used + requests.length > RPD) {
    throw new Error(`would exceed the daily cap: ${used} used + ${requests.length} needed > ${RPD}. Wait for the Pacific-midnight reset or pass --rpd=N.`)
  }

  // `--limit=1` makes the first real call a single probe: it proves the schema is accepted, the
  // thinking config is accepted, the ids come back, and the JSON parses — for one request out of
  // twenty rather than six. Everything after it is the same call with different pixels.
  const LIMIT = Number(arg('limit', String(requests.length)))
  const byLabel = new Map(images.map((im) => [im.label, im]))
  for (const [i, { batch, req }] of requests.slice(0, LIMIT).entries()) {
    const tag = `batch-${i + 1}`

    /*
     * RESUME. A batch every one of whose images already has a result for THIS run is not sent again.
     *
     * The first probe cost one request and succeeded; without this, finishing the pass would pay for
     * it a second time. With twenty requests a day and six to a pass, one wasted request is a sixth
     * of a pass. `--force` re-reads regardless, and a NEW `--pass=N` writes under a different runId
     * so repeat passes are never mistaken for work already done.
     */
    if (!flag('force') && batch.every((im) => existsSync(join(imgDir, im.sha, `${runId}.json`)))) {
      console.log(`\n${tag}: already read in ${runId} — skipped, no request spent`)
      continue
    }
    if (i > 0) await new Promise((r) => setTimeout(r, SPACING_MS)) // RPM 5 ⇒ 13s apart
    const after = spend(1)
    console.log(`\n${tag}: ${batch.length} images … (request ${after}/${RPD} today)`)

    let json
    try {
      json = await callRelay(req, rawDir, tag)
    } catch (err) {
      console.error(`  ${err.message}`)
      /*
       * A DAILY 429 is not a transient failure and must not be retried today.
       *
       * Google's own body carries the proof — `GenerateRequestsPerDayPerProjectPerModel-FreeTier`
       * with `quotaValue: 20`. The local ledger only ever counted requests THIS script made, so it
       * happily reported "3/20 used" while the project was already exhausted by work done outside
       * it. Recording the exhaustion means the next run refuses in the pre-flight check instead of
       * spending a request to be told again.
       */
      const detail = (() => {
        try {
          return readFileSync(join(rawDir, `${tag}.error.txt`), 'utf8')
        } catch {
          return ''
        }
      })()
      if (/PerDay|RequestsPerDay/i.test(detail)) {
        const led = readLedger()
        led[ledgerKey()] = RPD
        writeFileSync(ledgerPath(), JSON.stringify(led, null, 2))
        const secs = detail.match(/retry in ([\d.]+)s/)?.[1]
        console.error(`  DAILY quota for ${MODEL} is exhausted. Ledger marked ${RPD}/${RPD}.`)
        console.error(`  It resets at midnight US/Pacific. Re-run then; finished batches are skipped.`)
        if (secs) console.error(`  (Google also suggests retrying in ${Math.ceil(Number(secs))}s — that is the per-MINUTE limit, not the daily one.)`)
      } else {
        console.error(`  STOPPING — later batches are not attempted, so the rest of today's quota survives.`)
      }
      break
    }
    writeFileSync(join(rawDir, `${tag}.json`), JSON.stringify(json, null, 1))

    let parsed
    try {
      const raw = extractText(json)
      parsed = RAW ? parseRaw(raw) : JSON.parse(raw)
    } catch (err) {
      console.error(`  ${err.message} — raw kept at raw/${tag}.json, batch NOT scored`)
      continue
    }

    // The id must come back as the exact set we sent. Anything else and the rows may belong to a
    // different screen than the one they are about to be scored against, so nothing is scored.
    const got = (parsed.images ?? []).map((e) => e.id)
    const want = batch.map((im) => im.label)
    if (got.length !== want.length || want.some((l) => !got.includes(l))) {
      console.error(`  id mismatch — sent [${want.join(' ')}] got [${got.join(' ')}] · batch NOT scored`)
      continue
    }

    for (const entry of parsed.images ?? []) {
      const im = byLabel.get(entry.id)
      if (!im) continue
      const truth = key[im.sha]
      const score = scoreImage(entry, truth)
      const localScreen = screenOf(im.sha)
      const rec = {
        sha: im.sha,
        file: im.rel,
        fixture: INDEX[im.sha]?.fixture ?? null,
        label: im.label,
        pass: PASS,
        model: MODEL,
        runId,
        // The knobs, stored with the answer. A run folder that does not say what settings produced
        // it is not a measurement — and `gpt-5.5` at low effort and at medium effort are two
        // different readers wearing one name.
        effort: EFFORT,
        verbosity: VERBOSITY,
        batch: BATCH,
        screenSaid: entry.screen,
        screenLocal: localScreen,
        screenAgrees: entry.screen === localScreen,
        theme: entry.theme ?? null,
        statusBarClock: entry.statusBarClock ?? null,
        rows: entry.rows ?? [],
        fields: entry.fields ?? [],
        notes: entry.notes ?? null,
        truth: truth ?? null,
        score,
        usage: provider().usage(json),
        provider: PROVIDER,
      }
      // Keyed by sha AND run, so repeat passes ACCUMULATE instead of clobbering — repetition is
      // the whole point when the fault under test appears one run in ten.
      mkdirSync(join(imgDir, im.sha), { recursive: true })
      writeFileSync(join(imgDir, im.sha, `${runId}.json`), JSON.stringify(rec, null, 1))

      const flags = score.suspects.flat()
      const mark = flags.length ? '⚠' : score.scored ? (score.wrong.length === 0 && score.missed.length === 0 ? '✓' : '✗') : '·'
      console.log(
        `  ${mark} ${im.label} ${(INDEX[im.sha]?.fixture ?? im.rel).padEnd(34).slice(0, 34)} ` +
          `rows ${String(entry.rows?.length ?? 0).padStart(2)}` +
          (score.scored ? `  matched ${score.matched}/${score.expected}` : '  (no truth)') +
          (flags.length ? `  SUSPECT: ${[...new Set(flags)].join(', ')}` : ''),
      )
    }
  }

  const { render } = await import('./ocr-report.mjs')
  const rep = render(OUT, CORPUS, new Map(images.map((im) => [im.sha, im.bytes])))
  console.log(`\nwrote ${runDir}`)
  console.log(`review: ${rep.path}  (${rep.images} images, ${rep.runs} pass(es))`)
  console.log(`quota now: ${spentToday()}/${RPD} today`)
}

await main()
