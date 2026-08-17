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
  ORDERS_SCREEN_KIND_SCHEMA,
  ORDERS_TIME_READ_SCHEMA,
  READ_SCHEMA,
  ordersMoneyReadPrompt,
  ordersScreenKindPrompt,
  ordersTimeReadPrompt,
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
 * Orders have three independent latency budgets. Compact money and printed-time passes supply the
 * primary candidates; an aligned full route pass is a possible third time observation and may
 * enrich routes. A disagreement is refused rather than resolved by an arbitrary tie-break. Even
 * with a 50-second adapter configuration, routes cannot hold the read to the platform ceiling.
 */
const ORDERS_MONEY_TIMEOUT_MS = 30_000
const ORDERS_TIME_TIMEOUT_MS = 24_000
const ORDERS_SCREEN_KIND_TIMEOUT_MS = 12_000
const ORDERS_ROUTE_TIMEOUT_MS = 44_000
const ORDERS_ROUTE_GRACE_AFTER_MONEY_MS = 12_000
const ORDERS_MONEY_MAX_COMPLETION_TOKENS = 4096
const ORDERS_TIME_MAX_COMPLETION_TOKENS = 2048
// Reasoning tokens share this ceiling with the tiny JSON answer. 128 regularly lets a medium
// reasoning pass exhaust its budget before emitting `screenKind`, which turns the safety gate into
// a false `no_fields`. The schema still permits only one enum, so the larger ceiling cannot create
// a verbose response; it merely leaves enough room to finish the classification.
const ORDERS_SCREEN_KIND_MAX_COMPLETION_TOKENS = 512

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
      const timeTimeout = Math.min(this.config.timeoutMs, ORDERS_TIME_TIMEOUT_MS)
      const kindTimeout = Math.min(this.config.timeoutMs, ORDERS_SCREEN_KIND_TIMEOUT_MS)
      const routeTimeout = Math.min(this.config.timeoutMs, ORDERS_ROUTE_TIMEOUT_MS)
      return `${prefix}:orders-screen-kind-v1:orders-money-v4:orders-time-v3:orders-route-v3:money-authority-v1:money-validation-v2:time-validation-v3:position-evidence-v1:cancellation-consensus-v1:kind-timeout-${kindTimeout}:money-timeout-${moneyTimeout}:time-timeout-${timeTimeout}:route-timeout-${routeTimeout}:route-grace-${ORDERS_ROUTE_GRACE_AFTER_MONEY_MS}:kind-max-${ORDERS_SCREEN_KIND_MAX_COMPLETION_TOKENS}:money-max-${ORDERS_MONEY_MAX_COMPLETION_TOKENS}:time-max-${ORDERS_TIME_MAX_COMPLETION_TOKENS}:route-max-${MAX_COMPLETION_TOKENS}`
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
    const timePromise = this.runPass(request, ordersTimeReadPrompt(), {
      timeoutMs: Math.min(this.config.timeoutMs, ORDERS_TIME_TIMEOUT_MS),
      maxCompletionTokens: ORDERS_TIME_MAX_COMPLETION_TOKENS,
      schema: ORDERS_TIME_READ_SCHEMA,
      schemaName: 'orders_printed_time_verifier',
    })
    const screenKindPromise = this.runPass(request, ordersScreenKindPrompt(), {
      timeoutMs: Math.min(this.config.timeoutMs, ORDERS_SCREEN_KIND_TIMEOUT_MS),
      maxCompletionTokens: ORDERS_SCREEN_KIND_MAX_COMPLETION_TOKENS,
      schema: ORDERS_SCREEN_KIND_SCHEMA,
      schemaName: 'orders_screen_kind',
      screenKind: true,
    })

    // All three calls start above. Once both compact passes settle, routes get only a short grace;
    // if both fail, the already-running full pass gets its complete (still <45s) fallback budget.
    const [screenKind, money, time] = await Promise.all([screenKindPromise, moneyPromise, timePromise])
    const route = screenKind.result.ok || money.result.ok || time.result.ok
      ? await routePassWithinGrace(routePromise, routeAbort)
      : await routePromise

    return {
      result: ordersPassResult(screenKind, money, time, route),
      passes: [screenKind, money, time, route],
    }
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

    const result = options.screenKind ? parsedScreenKindResult(parsed) : parsedResult(request.field, parsed)
    return { result, raw: parsed, tokensIn, tokensOut }
  }
}

function failedPass(reason: OcrFailure, tokensIn = 0, tokensOut = 0): ModelPass {
  return { result: { ok: false, reason }, raw: null, tokensIn, tokensOut }
}

function parsedScreenKindResult(parsed: ParsedScreen): OcrResult {
  return parsed.screenKind === 'orders' || parsed.screenKind === 'payments_log' || parsed.screenKind === 'unknown'
    ? { ok: true, rows: [], fields: {}, raw: parsed }
    : { ok: false, reason: 'no_fields' }
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
 * Money comes from the compact pass when available. Time never comes from one model answer: every
 * row is published with a clock/date only when two independently-started passes agree at the same
 * card position. The dedicated pass cannot see or reason about money, and the route pass is a
 * possible third vote. Thus a failed verifier can be rescued by money+route agreement, while a
 * money+verifier result does not have to wait for slow route transcription.
 */
function ordersPassResult(
  screenKind: ModelPass,
  money: ModelPass,
  time: ModelPass,
  route: ModelPass,
): OcrResult {
  // Screen identity is a separate inspection. A payments ledger contains plausible signed money and
  // times, so no monetary row is published unless this independent gate proves Recent Orders.
  if (!screenKind.result.ok) return screenKind.result
  if (screenKind.raw?.screenKind === 'payments_log') return { ok: false, reason: 'wrong_screen' }
  // `unknown` is not proof that the driver selected the wrong screen. Keep that distinction so the
  // UI asks for a clearer/retryable image instead of confidently naming an unrelated source.
  if (screenKind.raw?.screenKind !== 'orders') return { ok: false, reason: 'no_fields' }

  // The compact money pass is the sole financial authority. Route transcription is optional
  // enrichment and can neither rescue a failed money read nor replace/refuse a verified fee.
  if (!money.result.ok) return money.result
  const base = money as ModelPass & { result: Extract<OcrResult, { ok: true }> }

  const baseLength = base.result.rows.length
  const alignedPasses = [money, time, route].filter(
    (pass): pass is ModelPass & { result: Extract<OcrResult, { ok: true }> } =>
      pass.result.ok && pass.result.rows.length === baseLength,
  )
  const routePositionsAligned = route.result.ok && route.result.rows.length === baseLength
  const financialDisagreementIndexes: number[] = []
  const timeDisagreementIndexes: number[] = []
  const dateDisagreementIndexes: number[] = []
  const timeAgreementCounts: number[] = []
  const cancellationAgreementCounts: number[] = []
  const cancellationDisagreementIndexes: number[] = []
  const cancellationUnverifiedIndexes: number[] = []
  const routeAgreementIndexes: number[] = []

  let rows: OcrRow[] = base.result.rows.map((baseRow, index) => {
    const cancellation = orderCancellationConsensus(alignedPasses, index)
    cancellationAgreementCounts.push(cancellation.votes)
    if (cancellation.disagreement) cancellationDisagreementIndexes.push(index)
    if (cancellation.value === null) cancellationUnverifiedIndexes.push(index)

    // Any disagreement is financially unresolved even when two passes voted “cancelled”. A false
    // cancellation deletes a paid delivery, so contested rows remain visible as refused live-card
    // candidates and retryable; only an uncontested cancellation may disappear from the money.
    const cancellationContested = cancellation.disagreement
    const cancellationNeedsReview = cancellationContested || cancellation.value === null
    const cancelled = cancellationContested ? false : (cancellation.value ?? false)
    const printedMoneyRefused =
      !cancelled && baseRow.value === null && baseRow.printed.trim() !== ''
    const consensus = orderDateTimeConsensus(alignedPasses, index, cancelled)
    timeAgreementCounts.push(consensus.timeVotes)
    if (consensus.dateIso === null && !cancelled) dateDisagreementIndexes.push(index)

    let row: OcrRow = {
      ...baseRow,
      printedTime: consensus.printedTime,
      value: cancelled || cancellationContested ? null : baseRow.value,
      cancelled,
      ...(cancellationNeedsReview || printedMoneyRefused ? { reviewRequired: true } : {}),
      time: consensus.time,
      dateIso: consensus.dateIso,
      rowIndex: index,
      rowCount: baseLength,
      dateSection: consensus.dateIso,
      yTop: null,
      yBottom: null,
    }

    if (!routePositionsAligned || !route.result.ok) return row
    const routeRow = route.result.rows[index]!
    if (!ordersRowsFinanciallyAgree(baseRow, routeRow)) {
      financialDisagreementIndexes.push(index)
      return row
    }
    if (!ordersRowsAlign(row, routeRow)) return row
    routeAgreementIndexes.push(index)
    return { ...row, pointA: routeRow.pointA, pointB: routeRow.pointB }
  })

  const timePosition = resolveSamePageOrderTimes(rows.map((row) => ({
    printedTime: row.printedTime,
    dateIso: row.dateIso,
  })))
  rows = rows.map((row, index) => {
    const resolution = timePosition[index]!
    if (resolution.time === null && !row.cancelled) timeDisagreementIndexes.push(index)
    return {
      ...row,
      time: resolution.time,
      ...(resolution.conflict && !row.cancelled ? { reviewRequired: true } : {}),
    }
  })

  return {
    ok: true,
    retryable:
      ordersRowsRetryable(rows) ||
      cancellationDisagreementIndexes.length > 0 ||
      cancellationUnverifiedIndexes.length > 0,
    rows,
    fields: base.result.fields,
    raw: {
      reader: 'orders-ai-time-consensus-v4',
      screenKind: screenKind.raw,
      routesAligned:
        routePositionsAligned && routeAgreementIndexes.length === baseLength,
      financialDisagreementIndexes,
      timeDisagreementIndexes,
      dateDisagreementIndexes,
      timeAgreementCounts,
      timeCandidates: timePosition.map(({ candidates }) => candidates),
      timeBases: timePosition.map(({ basis }) => basis),
      monotonicConflictIndexes: timePosition
        .map(({ conflict }, index) => conflict ? index : -1)
        .filter((index) => index >= 0),
      cancellationAgreementCounts,
      cancellationDisagreementIndexes,
      cancellationUnverifiedIndexes,
      money: money.result.ok ? money.raw : money.result,
      time: time.result.ok ? time.raw : time.result,
      route: route.result.ok ? route.raw : route.result,
    },
  }
}

function orderCancellationConsensus(
  passes: ReadonlyArray<ModelPass & { result: Extract<OcrResult, { ok: true }> }>,
  index: number,
): { value: boolean | null; votes: number; disagreement: boolean } {
  let cancelledVotes = 0
  let liveVotes = 0
  for (const pass of passes) {
    const row = pass.result.rows[index]
    if (row === undefined) continue
    if (row.cancelled) cancelledVotes += 1
    else liveVotes += 1
  }
  const disagreement = cancelledVotes > 0 && liveVotes > 0
  if (cancelledVotes >= 2) return { value: true, votes: cancelledVotes, disagreement }
  if (liveVotes >= 2) return { value: false, votes: liveVotes, disagreement }
  return { value: null, votes: 0, disagreement }
}

function orderDateTimeConsensus(
  passes: ReadonlyArray<ModelPass & { result: Extract<OcrResult, { ok: true }> }>,
  index: number,
  cancelled: boolean,
): { time: string | null; printedTime: string | null; dateIso: string | null; timeVotes: number } {
  const candidates = passes
    .map((pass) => ({ pass, row: pass.result.rows[index] }))
    // A cancellation disagreement is a row-alignment warning, not supporting time evidence.
    .filter(
      (candidate): candidate is {
        pass: ModelPass & { result: Extract<OcrResult, { ok: true }> }
        row: OcrRow
      } => candidate.row !== undefined && candidate.row.cancelled === cancelled,
    )

  // Vote on the printed clock evidence, not the already-normalized public row. Otherwise
  // `12:03 AM` and a second pass that illegally omitted its marker as `00:03` would appear to
  // agree even though only one model actually transcribed the printed clock.
  const timeEvidence = candidates.map(({ pass }) =>
    printedOrderTimeEvidence(pass.raw?.rows?.[index]?.time),
  )
  const timeWinner = consensusValue(timeEvidence.map((evidence) => evidence?.key ?? null))
  const winningIndex = timeEvidence.findIndex((evidence) => evidence?.key === timeWinner.value)
  const winningEvidence = winningIndex < 0 ? null : timeEvidence[winningIndex] ?? null
  const winningPrinted = winningIndex < 0
    ? null
    : candidates[winningIndex]?.pass.raw?.rows?.[index]?.time
  const dateWinner = consensusValue(candidates.map(({ row }) => row.dateIso))
  return {
    time: winningEvidence === null ? null : normalizePrintedOrderTimeEvidence(winningEvidence),
    printedTime: typeof winningPrinted === 'string' ? winningPrinted : null,
    dateIso: dateWinner.value,
    timeVotes: timeWinner.votes,
  }
}

function consensusValue(values: readonly (string | null)[]): { value: string | null; votes: number } {
  const votes = new Map<string, number>()
  for (const value of values) {
    if (value === null) continue
    votes.set(value, (votes.get(value) ?? 0) + 1)
  }
  const winner = [...votes.entries()].find(([, count]) => count >= 2)
  return winner === undefined ? { value: null, votes: 0 } : { value: winner[0], votes: winner[1] }
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
  // Keep every unread or unverified non-cancelled slot eligible for the one explicit whole-image
  // retry. A time accepted from only one pass must never silently classify an order in the window.
  // Cancelled rows intentionally have neither a monetary value nor a required financial time.
  return rows.some(
    (row) => !row.cancelled && (row.value === null || row.time === null || row.dateIso === null),
  )
}

function sameMoneyValue(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  const leftKey = moneyKey(left)
  const rightKey = moneyKey(right)
  return leftKey !== null && rightKey !== null ? leftKey === rightKey : left.trim() === right.trim()
}

/**
 * Deterministically convert a card clock copied verbatim by the model.
 *
 * Both Arabic-Indic digit sets and Western digits are accepted. A 12-hour clock is accepted only
 * with an explicit Arabic or English AM/PM marker; a marker-less value must already be valid
 * 24-hour time. This function never repairs a plausible-looking but invalid transcription.
 */
export function normalizePrintedOrderTime(printed: string | null | undefined): string | null {
  const evidence = printedOrderTimeEvidence(printed)
  return evidence === null ? null : normalizePrintedOrderTimeEvidence(evidence)
}

interface PrintedOrderTimeEvidence {
  /** Canonical printed identity used for voting; still 12-hour when a marker was printed. */
  key: string
  hour: number
  minute: number
  marker: 'am' | 'pm' | '24h' | 'ambiguous'
}

function printedOrderTimeEvidence(
  printed: string | null | undefined,
): PrintedOrderTimeEvidence | null {
  if (typeof printed !== 'string') return null
  const clean = [...printed.normalize('NFKC').replace(/[\u061c\u200e\u200f]/gu, '').trim()]
    .map((glyph) => ARABIC_DIGITS[glyph] ?? glyph)
    .join('')

  const markerPattern = '(?:ص|م|A\\.?\\s*M\\.?|P\\.?\\s*M\\.?)'
  const suffix = new RegExp(`^(\\d{1,2})\\s*[:：]\\s*(\\d{2})\\s*(${markerPattern})?$`, 'iu').exec(clean)
  const prefix = suffix === null
    ? new RegExp(`^(${markerPattern})\\s*(\\d{1,2})\\s*[:：]\\s*(\\d{2})$`, 'iu').exec(clean)
    : null

  const hourText = suffix?.[1] ?? prefix?.[2]
  const minuteText = suffix?.[2] ?? prefix?.[3]
  const rawMarker = suffix?.[3] ?? prefix?.[1]
  if (hourText === undefined || minuteText === undefined) return null

  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null

  const marker = rawMarker?.replace(/[.\s]/gu, '').toUpperCase()
  if (marker === undefined) {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
    // A marker-less 01..12 remains valid literal evidence, but not yet a usable 24-hour minute.
    // Two readers may agree that the card really says `1:18` without proving AM or PM. Keeping the
    // evidence lets the linked-read service constrain its two candidates from trusted same-page
    // neighbours and the attachment receipt time without teaching the provider to guess a marker.
    if (hour >= 1 && hour <= 12) {
      return {
        key: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}|ambiguous`,
        hour,
        minute,
        marker: 'ambiguous',
      }
    }
    return {
      key: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}|24h`,
      hour,
      minute,
      marker: '24h',
    }
  }

  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return null
  const semanticMarker = marker === 'ص' || marker === 'AM'
    ? 'am'
    : marker === 'م' || marker === 'PM'
      ? 'pm'
      : null
  if (semanticMarker === null) return null
  return {
    key: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}|${semanticMarker}`,
    hour,
    minute,
    marker: semanticMarker,
  }
}

function normalizePrintedOrderTimeEvidence(evidence: PrintedOrderTimeEvidence): string | null {
  if (evidence.marker === 'ambiguous') return null
  let hour = evidence.hour
  if (evidence.marker === 'am') hour %= 12
  else if (evidence.marker === 'pm') hour = (hour % 12) + 12
  return `${String(hour).padStart(2, '0')}:${String(evidence.minute).padStart(2, '0')}`
}

export interface SamePageOrderTimeInput {
  /** Literal clock agreed by at least two independent readers. */
  printedTime: string | null | undefined
  /** Date from the nearest header above this exact row. */
  dateIso: string | null | undefined
}

export type OrdersEvidenceReceivedAt =
  | { dateIso: string; time: string }
  | string
  | number
  | Date

export interface SamePageOrderTimeResolution {
  /** A publishable 24-hour clock, or null when more than one safe candidate remains. */
  time: string | null
  /** All candidates still compatible with the evidence, ordered AM then PM. */
  candidates: string[]
  basis: 'printed_time' | 'screen_position' | 'unknown'
  /** True when printed evidence contradicts receipt time or newest-first screen order. */
  conflict: boolean
}

/**
 * Resolve agreed marker-less clocks without guessing.
 *
 * Recent Orders is newest first. For `1:18` the only candidates are 01:18 and 13:18 on the row's
 * own date. A candidate survives only if there is a complete non-increasing path through all other
 * dated clocks on this same screenshot and it is no later than the evidence receipt time. The
 * function is deliberately context-free with respect to shifts, so its output can be cached and a
 * linked-read service can call it again with the authoritative attachment time.
 */
export function resolveSamePageOrderTimes(
  rows: readonly SamePageOrderTimeInput[],
  receivedAt: OrdersEvidenceReceivedAt | null = null,
): SamePageOrderTimeResolution[] {
  const receivedMinute = receivedAt === null ? null : receivedAtMinute(receivedAt)
  const states = rows.map((row) => {
    const evidence = printedOrderTimeEvidence(row.printedTime)
    const allCandidates = evidence === null ? [] : timeCandidates(evidence)
    const datedCandidates = allCandidates
      .map((time) => ({ time, absoluteMinute: datedMinute(row.dateIso, time) }))
      .filter((candidate) =>
        receivedMinute === null ||
        candidate.absoluteMinute === null ||
        candidate.absoluteMinute <= receivedMinute,
      )
    return {
      evidence,
      allCandidates,
      candidates: datedCandidates,
      rejectedByReceipt: allCandidates.length > 0 && datedCandidates.length === 0,
    }
  })

  // Missing dates cannot safely constrain AM/PM, but an explicit marked/24h clock remains useful.
  const active = states
    .map((state, index) => ({ state, index }))
    .filter(({ state }) =>
      state.candidates.length > 0 &&
      state.candidates.every(({ absoluteMinute }) => absoluteMinute !== null),
    )

  const viable = new Map<number, Set<number>>()
  if (active.length > 0) {
    const forward = active.map(({ state }) => state.candidates.map(() => false))
    const backward = active.map(({ state }) => state.candidates.map(() => false))
    forward[0] = active[0]!.state.candidates.map(() => true)
    for (let position = 1; position < active.length; position += 1) {
      const previous = active[position - 1]!.state.candidates
      const current = active[position]!.state.candidates
      forward[position] = current.map((candidate) => previous.some((prior, priorIndex) =>
        forward[position - 1]![priorIndex] === true &&
        prior.absoluteMinute! >= candidate.absoluteMinute!,
      ))
    }
    backward[active.length - 1] = active.at(-1)!.state.candidates.map(() => true)
    for (let position = active.length - 2; position >= 0; position -= 1) {
      const current = active[position]!.state.candidates
      const next = active[position + 1]!.state.candidates
      backward[position] = current.map((candidate) => next.some((following, followingIndex) =>
        backward[position + 1]![followingIndex] === true &&
        candidate.absoluteMinute! >= following.absoluteMinute!,
      ))
    }
    active.forEach(({ index, state }, position) => {
      viable.set(index, new Set(state.candidates
        .map((_candidate, candidateIndex) => candidateIndex)
        .filter((candidateIndex) =>
          forward[position]![candidateIndex] === true && backward[position]![candidateIndex] === true,
        )))
    })
  }

  const monotonicPathExists = active.length === 0 ||
    [...(viable.get(active.at(-1)?.index ?? -1) ?? [])].length > 0

  return states.map((state, index): SamePageOrderTimeResolution => {
    if (state.evidence === null) {
      return { time: null, candidates: [], basis: 'unknown', conflict: false }
    }
    if (state.rejectedByReceipt) {
      return { time: null, candidates: [], basis: 'unknown', conflict: true }
    }

    const dated = state.candidates.every(({ absoluteMinute }) => absoluteMinute !== null)
    const candidateIndexes = dated && monotonicPathExists
      ? [...(viable.get(index) ?? [])]
      : state.candidates.map((_candidate, candidateIndex) => candidateIndex)
    if (dated && !monotonicPathExists) {
      return { time: null, candidates: [], basis: 'unknown', conflict: true }
    }

    const candidates = candidateIndexes.map((candidateIndex) => state.candidates[candidateIndex]!.time)
    if (state.evidence.marker !== 'ambiguous') {
      return {
        time: candidates.length === 1 ? candidates[0]! : null,
        candidates,
        basis: candidates.length === 1 ? 'printed_time' : 'unknown',
        conflict: candidates.length === 0,
      }
    }
    return {
      time: candidates.length === 1 ? candidates[0]! : null,
      candidates,
      basis: candidates.length === 1 ? 'screen_position' : 'unknown',
      conflict: false,
    }
  })
}

function timeCandidates(evidence: PrintedOrderTimeEvidence): string[] {
  if (evidence.marker !== 'ambiguous') {
    const normalized = normalizePrintedOrderTimeEvidence(evidence)
    return normalized === null ? [] : [normalized]
  }
  const amHour = evidence.hour % 12
  const pmHour = (evidence.hour % 12) + 12
  return [amHour, pmHour]
    .map((hour) => `${String(hour).padStart(2, '0')}:${String(evidence.minute).padStart(2, '0')}`)
    .filter((time, index, candidates) => candidates.indexOf(time) === index)
}

function datedMinute(dateIso: string | null | undefined, time: string): number | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateIso ?? '')
  const clock = /^(\d{2}):(\d{2})$/u.exec(time)
  if (date === null || clock === null) return null
  const year = Number(date[1])
  const month = Number(date[2])
  const day = Number(date[3])
  const hour = Number(clock[1])
  const minute = Number(clock[2])
  const dayStart = Date.UTC(year, month - 1, day) / 60_000
  if (
    !Number.isInteger(dayStart) ||
    new Date(dayStart * 60_000).toISOString().slice(0, 10) !== dateIso ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59
  ) return null
  return dayStart + hour * 60 + minute
}

function receivedAtMinute(receivedAt: OrdersEvidenceReceivedAt): number | null {
  if (typeof receivedAt === 'object' && !(receivedAt instanceof Date)) {
    return datedMinute(receivedAt.dateIso, receivedAt.time)
  }
  if (typeof receivedAt === 'string') {
    const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/u.exec(receivedAt)
    if (local !== null) return datedMinute(local[1]!, local[2]!)
  }
  const epoch = receivedAt instanceof Date ? receivedAt.getTime() :
    typeof receivedAt === 'number' ? receivedAt : Date.parse(receivedAt)
  if (!Number.isFinite(epoch)) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Damascus',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(epoch)
  const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((candidate) => candidate.type === type)?.value
  const dateIso = `${part('year')}-${part('month')}-${part('day')}`
  const time = `${part('hour')}:${part('minute')}`
  return datedMinute(dateIso, time)
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
  const parsedRows = parsed.rows ?? []
  const rows: OcrRow[] = parsedRows.map((r, index) => {
    const ordinaryValue = r.value == null ? null : String(r.value)
    const value = r.cancelled
      ? null
      : field === 'wallet' || field === 'orders'
        ? verifiedMoneyValue(r)
        : ordinaryValue
    return {
      printed: String(r.printed ?? ''),
      ...(field === 'orders'
        ? {
            printedTime: typeof r.time === 'string' ? r.time : null,
            rowIndex: index,
            rowCount: parsedRows.length,
            dateSection: r.dateIso == null ? null : String(r.dateIso),
            yTop: null,
            yBottom: null,
          }
        : {}),
      value,
      cancelled: r.cancelled === true,
      time:
        field === 'orders'
          ? normalizePrintedOrderTime(r.time)
          : r.time == null
            ? null
            : String(r.time),
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
  /** Parse the compact Orders-vs-Payments-Log classifier rather than monetary rows. */
  screenKind?: boolean
}

interface OpenAiResponse {
  choices?: Array<{
    finish_reason?: string
    message?: { content?: string | null; refusal?: string | null }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export interface ParsedScreen {
  screenKind?: 'orders' | 'payments_log' | 'unknown'
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
