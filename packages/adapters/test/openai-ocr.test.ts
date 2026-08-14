import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiOcrReader, parsedResult, type ParsedRow, type ParsedScreen } from '../src/ocr/openai.ts'

const walletRow = (
  printed: string,
  value: string,
  overrides: Partial<ParsedRow> = {},
): ParsedRow => ({
  hasDecimal: true,
  hasThousands: false,
  digitCount: [...printed].filter((glyph) => /[0-9٠-٩۰-۹]/u.test(glyph)).length,
  printed,
  value,
  cancelled: false,
  time: null,
  dateIso: null,
  pointA: null,
  pointB: null,
  ...overrides,
})

const screen = (row: ParsedRow): ParsedScreen => ({ rows: [row], fields: [], notes: null })

function completion(parsed: ParsedScreen, tokensIn = 10, tokensOut = 5): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(parsed), refusal: null } }],
      usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const reader = (): OpenAiOcrReader =>
  new OpenAiOcrReader({
    apiKey: 'test-only',
    model: 'gpt-test',
    effort: 'medium',
    verbosity: 'medium',
    timeoutMs: 1_000,
    baseUrl: 'https://ocr.test/read',
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('wallet AI consensus', () => {
  it('corrects the live ٢٧٩٫٥٠ → ٣٧٩٫٥٠ incident by requiring two independent AI votes', async () => {
    const replies = [
      screen(walletRow('٣٧٩٫٥٠', '379.50')),
      screen(walletRow('٢٧٩٫٥٠', '279.50')),
      screen(walletRow('٢٧٩٫٥٠', '279.50')),
    ]
    const prompts: string[] = []
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: Array<{ type: string; text?: string }> }>
      }
      prompts.push(body.messages[0]!.content[0]!.text ?? '')
      return completion(replies[call++]!, 11, 7)
    }))

    const reading = await reader().read({ field: 'wallet', bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' })

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(prompts.map((prompt) => /WALLET CHECK ([ABC])/u.exec(prompt)?.[1])).toEqual(['A', 'B', 'C'])
    expect(prompts.every((prompt) => prompt.includes('٢') && prompt.includes('٣'))).toBe(true)
    expect(reading.result.ok).toBe(true)
    if (!reading.result.ok) throw new Error('expected a wallet result')
    expect(reading.result.rows).toEqual([
      {
        printed: '٢٧٩٫٥٠',
        value: '279.50',
        cancelled: false,
        time: null,
        dateIso: null,
        pointA: null,
        pointB: null,
      },
    ])
    expect(reading.result.raw).toMatchObject({ reader: 'wallet-ai-consensus-v1', agreeingPasses: 2 })
    expect(reading.usage).toMatchObject({ tokensIn: 33, tokensOut: 21 })
  })

  it('refuses three conflicting AI amounts instead of publishing an arbitrary tie-break', async () => {
    const replies = [
      screen(walletRow('٢٧٩٫٥٠', '279.50')),
      screen(walletRow('٣٧٩٫٥٠', '379.50')),
      screen(walletRow('٤٧٩٫٥٠', '479.50')),
    ]
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => completion(replies[call++]!)))

    const reading = await reader().read({ field: 'wallet', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
    expect(reading.result).toEqual({ ok: false, reason: 'no_fields' })
  })

  it('survives one failed provider pass when the other two AI passes agree', async () => {
    const replies = [
      new Response('', { status: 503 }),
      completion(screen(walletRow('٢٧٩٫٥٠', '279.50'))),
      completion(screen(walletRow('٢٧٩٫٥٠', '279.50'))),
    ]
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => replies[call++]!))

    const reading = await reader().read({ field: 'wallet', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
    expect(reading.result.ok && reading.result.rows[0]?.value).toBe('279.50')
  })
})

describe('wallet transcription integrity', () => {
  it('re-derives Arabic-Indic digits and preserves the printed decimal', () => {
    const result = parsedResult('wallet', screen(walletRow('٢٧٩٫٥٠', '279.5')))
    expect(result.ok && result.rows[0]?.value).toBe('279.50')
  })

  it('rejects a printed/value disagreement even when the value looks like valid money', () => {
    const result = parsedResult('wallet', screen(walletRow('٢٧٩٫٥٠', '379.50')))
    expect(result.ok && result.rows[0]?.value).toBeNull()
  })

  it('rejects the production 674,30 thousands mistake because its final group has two digits', () => {
    const result = parsedResult(
      'wallet',
      screen(walletRow('674,30', '67430', { hasDecimal: false, hasThousands: true })),
    )
    expect(result.ok && result.rows[0]?.value).toBeNull()
  })

  it('does not multiply non-wallet calls or reinterpret their established row format', async () => {
    const orders: ParsedScreen = {
      rows: [
        {
          hasDecimal: false,
          hasThousands: true,
          digitCount: 4,
          printed: '٥٬٠٠٠',
          value: '5000',
          cancelled: false,
          time: '13:10',
          dateIso: '2026-08-14',
          pointA: 'A',
          pointB: 'B',
        },
      ],
      fields: [],
      notes: null,
    }
    vi.stubGlobal('fetch', vi.fn(async () => completion(orders)))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(reading.result.ok && reading.result.rows[0]?.value).toBe('5000')
  })
})
