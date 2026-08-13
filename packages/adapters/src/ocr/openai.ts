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
 * REQUEST SHAPE, three parts of which are load-bearing and were each learned the expensive way:
 *
 *   `detail: 'high'`   — on `low` the image is downsampled to a single 512px tile and Arabic-Indic
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

import type { OcrField, OcrReader, OcrReading, OcrResult, OcrRow } from '@ash/contracts'
import { READ_SCHEMA, readPrompt } from './prompt.ts'

export interface OpenAiOcrConfig {
  apiKey: string
  model: string
  effort: 'low' | 'medium' | 'high'
  verbosity: 'low' | 'medium' | 'high'
  /** Must stay strictly BELOW the platform's function ceiling — see the note in `read`. */
  timeoutMs: number
  /** Overridable for tests; there is no other reason to change it. */
  baseUrl?: string
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1/chat/completions'

/**
 * Reasoning tokens count against this, and a completion that hits it comes back EMPTY rather than
 * truncated — which reads as "the screen had nothing on it" unless you check for it explicitly.
 */
const MAX_COMPLETION_TOKENS = 8192

export class OpenAiOcrReader implements OcrReader {
  readonly available = true
  readonly model: string
  private readonly config: OpenAiOcrConfig

  constructor(config: OpenAiOcrConfig) {
    if (!config.apiKey) throw new Error('OpenAiOcrReader requires an OPENAI_API_KEY')
    this.config = config
    this.model = config.model
  }

  async read(request: { field: OcrField; bytes: Uint8Array; mimeType: string }): Promise<OcrReading> {
    const startedAt = Date.now()
    const usage = { tokensIn: 0, tokensOut: 0, latencyMs: 0 }
    const done = (result: OcrResult): OcrReading => ({
      result,
      usage: { ...usage, latencyMs: Date.now() - startedAt },
    })

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
                { type: 'text', text: readPrompt(request.field) },
                {
                  type: 'image_url',
                  image_url: { url: dataUrl(request.bytes, request.mimeType), detail: 'high' },
                },
              ],
            },
          ],
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          reasoning_effort: this.config.effort,
          verbosity: this.config.verbosity,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'screen', strict: true, schema: READ_SCHEMA },
          },
        }),
        /*
         * STRICTLY below the platform's function ceiling, and that is the whole point.
         *
         * `tools/gemini-relay/api/gemini.mjs` carries the reason: set the two equal and the caller's
         * socket dies at the same instant the platform gives up, turning a clean 504 into an opaque
         * socket error nobody can diagnose from a log line.
         */
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })

      if (!res.ok) {
        // Never echo the body — undici puts the request URL in some errors, and this one carries a
        // bearer token. The status is enough to tell a rate limit from a bad key.
        return done({ ok: false, reason: res.status === 408 || res.status === 504 ? 'timeout' : 'unavailable' })
      }
      json = (await res.json()) as OpenAiResponse
    } catch (err) {
      const name = (err as { name?: string })?.name
      return done({ ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable' })
    }

    usage.tokensIn = json.usage?.prompt_tokens ?? 0
    usage.tokensOut = json.usage?.completion_tokens ?? 0

    const choice = json.choices?.[0]
    if (!choice) return done({ ok: false, reason: 'unavailable' })
    // A model that declines is saying something different from a model that read nothing.
    if (choice.message?.refusal) return done({ ok: false, reason: 'refused' })
    if (choice.finish_reason && choice.finish_reason !== 'stop') return done({ ok: false, reason: 'no_fields' })

    const text = choice.message?.content
    // Empty content means reasoning consumed `max_completion_tokens`. Scored as a clean read it
    // would look like a screen with nothing on it.
    if (!text) return done({ ok: false, reason: 'no_fields' })

    let parsed: ParsedScreen
    try {
      parsed = JSON.parse(text) as ParsedScreen
    } catch {
      return done({ ok: false, reason: 'no_fields' })
    }

    const rows: OcrRow[] = (parsed.rows ?? []).map((r) => ({
      printed: String(r.printed ?? ''),
      value: r.value == null ? null : String(r.value),
      cancelled: r.cancelled === true,
    }))
    const fields: Record<string, string | null> = {}
    for (const f of parsed.fields ?? []) {
      if (f?.label) fields[String(f.label)] = f.value == null ? null : String(f.value)
    }

    if (rows.length === 0 && Object.keys(fields).length === 0) {
      return done({ ok: false, reason: 'no_fields' })
    }
    return done({ ok: true, rows, fields, raw: parsed })
  }
}

function dataUrl(bytes: Uint8Array, mimeType: string): string {
  // Node 24 has Buffer; this adapter is server-only and never reaches a browser bundle.
  const b64 = Buffer.from(bytes).toString('base64')
  return `data:${mimeType};base64,${b64}`
}

interface OpenAiResponse {
  choices?: Array<{
    finish_reason?: string
    message?: { content?: string | null; refusal?: string | null }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface ParsedScreen {
  rows?: Array<{ printed?: string; value?: string | null; cancelled?: boolean }>
  fields?: Array<{ label?: string; value?: string | null }>
  notes?: string | null
}
