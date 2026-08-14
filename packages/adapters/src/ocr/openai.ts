/**
 * The cloud reader: one screenshot in, transcribed money rows out.
 *
 * No SDK. The `openai` package is a large dependency tree for what is one HTTP verb, and
 * `scripts/build-api.mjs` inlines everything into a single 4 MB function file — the same argument
 * `S3BlobStore` makes for hand-rolling SigV4 rather than pulling the AWS SDK. `fetch` is enough.
 *
 * WHERE THIS RUNS MATTERS. OpenAI geo-blocks Syria, which is why `tools/gemini-relay/` exists at
 * all. The production API function runs in `iad1` (US East) because `vercel.json` sets no `regions`
 * key, so a call made from inside it originates in Virginia and needs no relay and no VPN. Move the
 * API to a region Syria cannot reach through and this adapter stops working with a confusing error.
 *
 * Wallet money gets extra care. One live Yallago screenshot visibly printed `٢٧٩٫٥٠`, while one
 * otherwise well-formed model answer confidently transcribed both `printed` and `value` as
 * `٣٧٩٫٥٠` / `379.50`. No separator parser can repair a glyph the model never saw. The wallet is
 * therefore read by three independent, differently worded AI passes and published only when two
 * agree. This remains AI-authoritative: phone OCR is not an input to the vote.
 *
 * REQUEST SHAPE, three parts of which are load-bearing and were each learned the expensive way:
 *
 *   `detail: 'high'`   — on `low` the image is downsampled to one 512px tile and Arabic-Indic
 *                        digits stop being resolvable at all. This is not a cost knob.
 *   no `temperature`   — the 5.x reasoning models reject any value but the default and answer a
 *                        400 `unsupported_value`. Determinism is governed by reasoning effort.
 *   strict json_schema — every property in `required`, `additionalProperties: false`, no `nullable`.
 *
 * It never throws for an upstream failure. A timeout, a 500, a refusal and an empty completion all
 * come back as `{ ok: false }` with a reason, because `wire.ts:322-337` records what happens when an
 * OCR limb can fail a money limb: a shift balancing to exactly 0.00 could not be handed over
 * because a cosmetic field disagreed.
 */

import type { OcrFailure, OcrField, OcrReader, OcrReading, OcrResult, OcrRow } from '@ash/contracts'
import {
  ORDERS_MONEY_READ_SCHEMA,
  READ_SCHEMA,
  ordersMoneyReadPrompt,
  readPrompt,
  walletReadPrompts,
} from './prompt.ts'

export interface OpenAiOcrConfig {
  apiKey: string
  model: string
  effort: 'low' | 'medium' | 'high'
  verbosity: 'low' | 'medium' | 'high'
  /** Must stay strictly BELOW the platform's function ceiling — see the note in `runPass`. */
  timeoutMs: number
  /** Overridable for tests; there is no other reason to change it. */
  baseUrl?: string
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1/chat/completions'

/**
 * Reasoning tokens count against this, and a completion that hits it comes back EMPTY rather than
 * truncated — which reads as "the screen had nothing on it" unless checked explicitly.
 */
const MAX_COMPLETION_TOKENS = 8192

/**
 * Orders have two independent latency budgets. The compact financial pass supplies the primary
 * candidates and should finish first; an aligned full pass independently verifies their money and
 * may enrich routes. A disagreement is refused rather than resolved by an arbitrary tie-break.
 * Even with a 50-second adapter configuration, routes cannot hold the read to the platform ceiling.
 */
const ORDERS_MONEY_TIMEOUT_MS = 30_000
const ORDERS_ROUTE_TIMEOUT_MS = 44_000
const ORDERS_ROUTE_GRACE_AFTER_MONEY_MS = 12_000
const ORDERS_MONEY_MAX_COMPLETION_TOKENS = 4096

export class OpenAiOcrReader implements OcrReader {
  readonly available = true
  readonly model: string
  private readonly config: OpenAiOcrConfig

  constructor(config: OpenAiOcrConfig) {
    if (!config.apiKey) throw new Error('OpenAiOcrReader requires an OPENAI_API_KEY')
    this.config = config
    this.model = config.model
  }

  cacheSignature(field: OcrField): string {
    const prefix = `openai:${this.model}:${this.config.effort}:${this.config.verbosity}`
    if (field === 'orders') {
      const moneyTimeout = Math.min(this.config.timeoutMs, ORDERS_MONEY_TIMEOUT_MS)
      const routeTimeout = Math.min(this.config.timeoutMs, ORDERS_ROUTE_TIMEOUT_MS)
      return `${prefix}:orders-money-v2:orders-route-v1:money-validation-v2:money-timeout-${moneyTimeout}:route-timeout-${routeTimeout}:route-grace-${ORDERS_ROUTE_GRACE_AFTER_MONEY_MS}:money-max-${ORDERS_MONEY_MAX_COMPLETION_TOKENS}:route-max-${MAX_COMPLETION_TOKENS}`
    }
    const budget = `timeout-${this.config.timeoutMs}:max-${MAX_COMPLETION_TOKENS}`
    if (field === 'wallet') {
      return `${prefix}:wallet-consensus-v1:money-validation-v2:${budget}`
    }
    return `${prefix}:${field}-prompt-v1:validation-v1:${budget}`
  }

  async read(request: { field: OcrField; bytes: Uint8Array; mimeType: string }): Promise<OcrReading> {
    const startedAt = Date.now()
    let passes: ModelPass[]
    let result: OcrResult

    if (request.field === 'orders') {
      const orders = await this.readOrders(request)
      passes = orders.passes
      result = orders.result
    } else {
      const prompts = request.field === 'wallet' ? walletReadPrompts() : [readPrompt(request.field)]

      // Parallel, not sequential: three 20-second inspections must still fit below a 60-second
      // function ceiling. Each pass has its own abort signal and no pass can hold the others open.
      passes = await Promise.all(prompts.map(async (prompt) => await this.runPass(request, prompt)))
      result = request.field === 'wallet' ? walletConsensus(passes) : passes[0]!.result
    }

    const usage = passes.reduce(
      (sum, pass) => ({
        tokensIn: sum.tokensIn + pass.tokensIn,
        tokensOut: sum.tokensOut + pass.tokensOut,
      }),
      { tokensIn: 0, tokensOut: 0 },
    )

    return { result, usage: { ...usage, latencyMs: Date.now() - startedAt } }
  }

  private async readOrders(
    request: { field: OcrField; bytes: Uint8Array; mimeType: string },
  ): Promise<{ result: OcrResult; passes: ModelPass[] }> {
    const routeAbort = new AbortController()
    const routePromise = this.runPass(request, readPrompt('orders'), {
      timeoutMs: Math.min(this.config.timeoutMs, ORDERS_ROUTE_TIMEOUT_MS),
      signal: routeAbort.signal,
      schemaName: 'orders_with_routes',
    })
    const moneyPromise = this.runPass(request, ordersMoneyReadPrompt(), {
      timeoutMs: Math.min(this.config.timeoutMs, ORDERS_MONEY_TIMEOUT_MS),
      maxCompletionTokens: ORDERS_MONEY_MAX_COMPLETION_TOKENS,
      schema: ORDERS_MONEY_READ_SCHEMA,
      schemaName: 'orders_money_time_date',
    })

    // Both calls start above. If the compact pass succeeds, routes get only a short grace period;
    // if it fails, the already-running full pass gets its complete (still <45s) fallback budget.
    const money = await moneyPromise
    const route = money.result.ok
      ? await routePassWithinGrace(routePromise, routeAbort)
      : await routePromise

    return { result: ordersPassResult(money, route), passes: [money, route] }
  }

  private async runPass(
    request: { field: OcrField; bytes: Uint8Array; mimeType: string },
    prompt: string,
    options: PassOptions = {},
  ): Promise<ModelPass> {
    let json: OpenAiResponse
    try {
      const res = await fetch(this.config.baseUrl ?? DEFAULT_BASE_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: { url: dataUrl(request.bytes, request.mimeType), detail: 'high' },
                },
              ],
            },
          ],
          max_completion_tokens: options.maxCompletionTokens ?? MAX_COMPLETION_TOKENS,
          reasoning_effort: this.config.effort,
          verbosity: this.config.verbosity,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: options.schemaName ?? 'screen',
              strict: true,
              schema: options.schema ?? READ_SCHEMA,
            },
          },
        }),
        /*
         * STRICTLY below the platform's function ceiling. Set the two equal and the caller's socket
         * dies at the same instant the platform gives up, turning a clean timeout into an opaque
         * transport error nobody can diagnose from a log line.
         */
        signal:
          options.signal === undefined
            ? AbortSignal.timeout(options.timeoutMs ?? this.config.timeoutMs)
            : AbortSignal.any([
                AbortSignal.timeout(options.timeoutMs ?? this.config.timeoutMs),
                options.signal,
              ]),
      })

      if (!res.ok) {
        // Never echo the body: it can include provider diagnostics and this request has a bearer
        // credential. The status is enough to distinguish timeout from general unavailability.
        return failedPass(res.status === 408 || res.status === 504 ? 'timeout' : 'unavailable')
      }
      json = (await res.json()) as OpenAiResponse
    } catch (err) {
      const name = (err as { name?: string })?.name
      return failedPass(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable')
    }

    const tokensIn = json.usage?.prompt_tokens ?? 0
    const tokensOut = json.usage?.completion_tokens ?? 0
    const choice = json.choices?.[0]
    if (!choice) return failedPass('unavailable', tokensIn, tokensOut)
    if (choice.message?.refusal) return failedPass('refused', tokensIn, tokensOut)
    if (choice.finish_reason && choice.finish_reason !== 'stop') {
      return failedPass('no_fields', tokensIn, tokensOut)
    }

    const text = choice.message?.content
    if (!text) return failedPass('no_fields', tokensIn, tokensOut)

    let parsed: ParsedScreen
    try {
      parsed = JSON.parse(text) as ParsedScreen
    } catch {
      return failedPass('no_fields', tokensIn, tokensOut)
    }

    const result = parsedResult(request.field, parsed)
    return { result, raw: parsed, tokensIn, tokensOut }
  }
}

function failedPass(reason: OcrFailure, tokensIn = 0, tokensOut = 0): ModelPass {
  return { result: { ok: false, reason }, raw: null, tokensIn, tokensOut }
}

async function routePassWithinGrace(
  routePromise: Promise<ModelPass>,
  routeAbort: AbortController,
): Promise<ModelPass> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const graceExpired = new Promise<ModelPass>((resolve) => {
    timer = setTimeout(() => {
      routeAbort.abort()
      resolve(failedPass('timeout'))
    }, ORDERS_ROUTE_GRACE_AFTER_MONEY_MS)
  })

  try {
    return await Promise.race([routePromise, graceExpired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Money/date/time come from the compact pass when it succeeds, but a second successful pass is
 * still independent financial evidence. Agreement is evaluated per position: one disputed fee is
 * refused without throwing away the other rows or their correctly aligned routes.
 */
function ordersPassResult(money: ModelPass, route: ModelPass): OcrResult {
  if (!money.result.ok) return route.result

  const positionsAligned = route.result.ok && money.result.rows.length === route.result.rows.length
  const financialDisagreementIndexes: number[] = []
  const routeAgreementIndexes: number[] = []
  const rows = money.result.rows.map((row, index) => {
    if (!positionsAligned || !route.result.ok) return row
    const routeRow = route.result.rows[index]!
    if (!ordersRowsFinanciallyAgree(row, routeRow)) {
      financialDisagreementIndexes.push(index)
      return { ...row, value: null }
    }
    if (!ordersRowsAlign(row, routeRow)) return row
    routeAgreementIndexes.push(index)
    return { ...row, pointA: routeRow.pointA, pointB: routeRow.pointB }
  })

  return {
    ok: true,
    retryable: ordersRowsRetryable(rows),
    rows,
    fields: money.result.fields,
    raw: {
      reader: 'orders-ai-money-authority-v1',
      routesAligned:
        positionsAligned && routeAgreementIndexes.length === money.result.rows.length,
      financialDisagreementIndexes,
      money: money.raw,
      route: route.result.ok ? route.raw : route.result,
    },
  }
}

function ordersRowsAlign(money: OcrRow, route: OcrRow | undefined): boolean {
  if (route === undefined) return false
  return (
    ordersRowsFinanciallyAgree(money, route) &&
    money.time === route.time &&
    money.dateIso === route.dateIso
  )
}

function ordersRowsFinanciallyAgree(money: OcrRow, route: OcrRow): boolean {
  return money.cancelled === route.cancelled && sameMoneyValue(money.value, route.value)
}

function ordersRowsRetryable(rows: readonly OcrRow[]): boolean {
  // Keep every unread non-cancelled slot eligible for the one explicit whole-image retry. A
  // partial 3/5 read is still a partial failure even though the three authoritative rows remain
  // useful to the normal cached response. Cancelled rows intentionally have no monetary value.
  return rows.some((row) => !row.cancelled && row.value === null)
}

function sameMoneyValue(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  const leftKey = moneyKey(left)
  const rightKey = moneyKey(right)
  return leftKey !== null && rightKey !== null ? leftKey === rightKey : left.trim() === right.trim()
}

/**
 * Convert one strict provider response into the public port.
 *
 * For the wallet and every non-cancelled orders row, `printed` is re-derived rather than merely
 * trusted. The prompt has always asked for `hasDecimal`, `hasThousands` and `digitCount`, but the
 * old adapter threw those checks away. That is how `674,30` declared as a thousands number became
 * `67430`. A malformed grouping or a `printed`/`value` disagreement now makes that row a refusal.
 */
export function parsedResult(field: OcrField, parsed: ParsedScreen): OcrResult {
  const rows: OcrRow[] = (parsed.rows ?? []).map((r) => {
    const ordinaryValue = r.value == null ? null : String(r.value)
    const value = r.cancelled
      ? null
      : field === 'wallet' || field === 'orders'
        ? verifiedMoneyValue(r)
        : ordinaryValue
    return {
      printed: String(r.printed ?? ''),
      value,
      cancelled: r.cancelled === true,
      time: r.time == null ? null : String(r.time),
      dateIso: r.dateIso == null ? null : String(r.dateIso),
      pointA: r.pointA == null ? null : String(r.pointA),
      pointB: r.pointB == null ? null : String(r.pointB),
    }
  })
  const fields: Record<string, string | null> = {}
  for (const f of parsed.fields ?? []) {
    if (f?.label) fields[String(f.label)] = f.value == null ? null : String(f.value)
  }

  if (rows.length === 0 && Object.keys(fields).length === 0) return { ok: false, reason: 'no_fields' }
  return field === 'orders'
    ? { ok: true, retryable: ordersRowsRetryable(rows), rows, fields, raw: parsed }
    : { ok: true, rows, fields, raw: parsed }
}

/** Publish only a value seen by at least two independent wallet passes. */
function walletConsensus(passes: readonly ModelPass[]): OcrResult {
  const votes = new Map<string, Array<{ row: OcrRow; pass: ModelPass }>>()
  for (const pass of passes) {
    if (!pass.result.ok || pass.result.rows.length !== 1) continue
    const row = pass.result.rows[0]!
    const key = row.cancelled || row.value === null ? null : moneyKey(row.value)
    if (key === null) continue
    const group = votes.get(key) ?? []
    group.push({ row, pass })
    votes.set(key, group)
  }

  const winner = [...votes.values()].find((group) => group.length >= 2)
  if (!winner) return { ok: false, reason: consensusFailure(passes) }

  const representative = winner[0]!
  return {
    ok: true,
    rows: [representative.row],
    fields: representative.pass.result.ok ? representative.pass.result.fields : {},
    raw: {
      reader: 'wallet-ai-consensus-v1',
      agreeingPasses: winner.length,
      passes: passes.map((pass) => (pass.result.ok ? pass.raw : pass.result)),
    },
  }
}

function consensusFailure(passes: readonly ModelPass[]): OcrFailure {
  // Disagreement between readable amounts is an accuracy refusal, not an upstream outage.
  if (passes.some((pass) => pass.result.ok)) return 'no_fields'
  const reasons = passes.map((pass) => (pass.result.ok ? 'no_fields' : pass.result.reason))
  if (reasons.every((reason) => reason === 'timeout')) return 'timeout'
  if (reasons.every((reason) => reason === 'refused')) return 'refused'
  return 'unavailable'
}

const ARABIC_DIGITS: Readonly<Record<string, string>> = {
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
}

function verifiedMoneyValue(row: ParsedRow): string | null {
  if (typeof row.printed !== 'string' || typeof row.value !== 'string') return null
  if (typeof row.hasDecimal !== 'boolean' || typeof row.hasThousands !== 'boolean') return null
  if (!Number.isInteger(row.digitCount) || Number(row.digitCount) < 1) return null

  let printed = row.printed.trim().replace(/\s*SYP\s*/giu, '').replace(/\s/gu, '')
  if (printed.includes('?')) return null
  let sign = ''
  if (/^[+＋]/u.test(printed)) {
    printed = printed.slice(1)
  } else if (/^[-−–—]/u.test(printed)) {
    sign = '-'
    printed = printed.slice(1)
  }

  const western = [...printed].map((glyph) => ARABIC_DIGITS[glyph] ?? glyph).join('')
  const digitCount = [...western].filter((glyph) => /\d/u.test(glyph)).length
  if (digitCount !== Number(row.digitCount)) return null
  if (!/^[0-9.,٫٬،]+$/u.test(western)) return null

  const decimalCandidates = [...western]
    .map((glyph, index) => ({ glyph, index }))
    .filter(({ glyph }) => glyph === '.' || glyph === '٫')
  // A comma is decimal only when the model explicitly said there is a decimal part. When both
  // kinds are present, the final comma may be decimal and earlier commas remain grouping marks.
  if (row.hasDecimal && decimalCandidates.length === 0) {
    const commaIndexes = [...western]
      .map((glyph, index) => ({ glyph, index }))
      .filter(({ glyph }) => glyph === ',' || glyph === '،')
    if (commaIndexes.length > 0) decimalCandidates.push(commaIndexes.at(-1)!)
  }
  if (row.hasDecimal !== (decimalCandidates.length === 1)) return null

  const decimalAt = decimalCandidates[0]?.index ?? -1
  const wholePrinted = decimalAt < 0 ? western : western.slice(0, decimalAt)
  const fraction = decimalAt < 0 ? '' : western.slice(decimalAt + 1)
  if (row.hasDecimal && !/^\d{1,2}$/u.test(fraction)) return null

  const groupingMarks = [...wholePrinted].filter((glyph) => glyph === ',' || glyph === '،' || glyph === '٬')
  // A decimal comma was sliced away above, so any separators left in the whole part are grouping.
  if (row.hasThousands !== (groupingMarks.length > 0)) return null
  const groups = wholePrinted.split(/[,،٬]/u)
  if (groups.length === 0 || groups.some((group) => !/^\d+$/u.test(group))) return null
  if (groups.length > 1 && (groups[0]!.length > 3 || groups.slice(1).some((group) => group.length !== 3))) {
    return null
  }

  const whole = groups.join('').replace(/^0+(?=\d)/u, '')
  const derived = `${sign}${whole}${fraction === '' ? '' : `.${fraction}`}`
  return moneyKey(derived) !== null && moneyKey(derived) === moneyKey(row.value) ? derived : null
}

/** Exact money identity without floating point; accepts one or two fractional digits. */
function moneyKey(value: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/u.exec(value.trim())
  if (!match) return null
  const sign = match[1] === '-' ? -1n : 1n
  const fraction = (match[3] ?? '').padEnd(2, '0')
  return String(sign * (BigInt(match[2]!) * 100n + BigInt(fraction || '0')))
}

function dataUrl(bytes: Uint8Array, mimeType: string): string {
  // Node 24 has Buffer; this adapter is server-only and never reaches a browser bundle.
  const b64 = Buffer.from(bytes).toString('base64')
  return `data:${mimeType};base64,${b64}`
}

interface ModelPass {
  result: OcrResult
  raw: ParsedScreen | null
  tokensIn: number
  tokensOut: number
}

interface PassOptions {
  timeoutMs?: number
  maxCompletionTokens?: number
  schema?: unknown
  schemaName?: string
  signal?: AbortSignal
}

interface OpenAiResponse {
  choices?: Array<{
    finish_reason?: string
    message?: { content?: string | null; refusal?: string | null }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export interface ParsedScreen {
  rows?: ParsedRow[]
  fields?: Array<{ label?: string; value?: string | null }>
  notes?: string | null
}

export interface ParsedRow {
  hasDecimal?: boolean
  hasThousands?: boolean
  digitCount?: number
  printed?: string
  value?: string | null
  cancelled?: boolean
  time?: string | null
  dateIso?: string | null
  pointA?: string | null
  pointB?: string | null
}
