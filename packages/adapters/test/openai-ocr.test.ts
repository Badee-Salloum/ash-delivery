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

const reader = (timeoutMs = 1_000): OpenAiOcrReader =>
  new OpenAiOcrReader({
    apiKey: 'test-only',
    model: 'gpt-test',
    effort: 'medium',
    verbosity: 'medium',
    timeoutMs,
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

  it('does not multiply payments-log calls or reinterpret their established row format', async () => {
    const payments: ParsedScreen = {
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
    vi.stubGlobal('fetch', vi.fn(async () => completion(payments)))

    const reading = await reader().read({ field: 'payments_log', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(reading.result.ok && reading.result.rows[0]?.value).toBe('5000')
  })
})

const orderRow = (
  value: string,
  overrides: Partial<ParsedRow> = {},
): ParsedRow => ({
  hasDecimal: false,
  hasThousands: false,
  digitCount: value.replace(/\D/gu, '').length,
  printed: value,
  value,
  cancelled: false,
  time: '13:32',
  dateIso: '2026-08-15',
  pointA: null,
  pointB: null,
  ...overrides,
})

function requestedPrompt(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body)) as {
    messages: Array<{ content: Array<{ type: string; text?: string }> }>
  }
  return body.messages[0]!.content[0]!.text ?? ''
}

describe('orders fast financial pass', () => {
  it('versions the cache by model configuration and both orders validation passes', () => {
    expect(reader().cacheSignature('orders')).toBe(
      'openai:gpt-test:medium:medium:orders-money-v2:orders-route-v1:money-validation-v2:money-timeout-1000:route-timeout-1000:route-grace-12000:money-max-4096:route-max-8192',
    )
    expect(reader(2_000).cacheSignature('orders')).not.toBe(reader().cacheSignature('orders'))
    expect(reader(2_000).cacheSignature('wallet')).not.toBe(reader().cacheSignature('wallet'))
  })

  it('returns all five incident fees totalling 1415 when the parallel full-route pass times out', async () => {
    const fast: ParsedScreen = {
      rows: [
        orderRow('155', { time: '00:03', dateIso: '2026-08-15' }),
        orderRow('240', { time: '23:21', dateIso: '2026-08-14' }),
        orderRow('225', { time: '22:27', dateIso: '2026-08-14' }),
        orderRow('425', { time: '21:19', dateIso: '2026-08-14' }),
        orderRow('370', { time: '20:09', dateIso: '2026-08-14' }),
      ],
      fields: [],
      notes: null,
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return requestedPrompt(init).includes('ORDERS MONEY/TIME/DATE FAST PASS')
        ? completion(fast, 8, 4)
        : new Response('', { status: 504 })
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(fetch).toHaveBeenCalledTimes(2)
    const fastCall = vi.mocked(fetch).mock.calls.find(([, init]) =>
      requestedPrompt(init).includes('ORDERS MONEY/TIME/DATE FAST PASS'),
    )
    expect(JSON.parse(String(fastCall?.[1]?.body))).toMatchObject({ reasoning_effort: 'medium' })
    expect(reading.result.ok).toBe(true)
    if (!reading.result.ok) throw new Error('expected an orders result')
    expect(reading.result.rows.map(({ value, time, dateIso, pointA, pointB }) => ({
      value,
      time,
      dateIso,
      pointA,
      pointB,
    }))).toEqual([
      { value: '155', time: '00:03', dateIso: '2026-08-15', pointA: null, pointB: null },
      { value: '240', time: '23:21', dateIso: '2026-08-14', pointA: null, pointB: null },
      { value: '225', time: '22:27', dateIso: '2026-08-14', pointA: null, pointB: null },
      { value: '425', time: '21:19', dateIso: '2026-08-14', pointA: null, pointB: null },
      { value: '370', time: '20:09', dateIso: '2026-08-14', pointA: null, pointB: null },
    ])
    expect(reading.result.rows.reduce((sum, row) => sum + Number(row.value), 0)).toBe(1_415)
    expect(reading.result.raw).toMatchObject({
      reader: 'orders-ai-money-authority-v1',
      routesAligned: false,
      route: { ok: false, reason: 'timeout' },
    })
    expect(reading.usage).toMatchObject({ tokensIn: 8, tokensOut: 4 })
  })

  it('enriches routes when the full pass rows align with the fast pass', async () => {
    const fast = screen(orderRow('155'))
    const full = screen(orderRow('155.00', {
      printed: '١٥٥',
      digitCount: 3,
      pointA: 'Abdullah Ibn Omar Street',
      pointB: 'Soprano M. Ali El Abed',
    }))
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return completion(requestedPrompt(init).includes('ORDERS MONEY/TIME/DATE FAST PASS') ? fast : full)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok).toBe(true)
    if (!reading.result.ok) throw new Error('expected an orders result')
    expect(reading.result.rows[0]).toMatchObject({
      printed: '155',
      value: '155',
      time: '13:32',
      dateIso: '2026-08-15',
      pointA: 'Abdullah Ibn Omar Street',
      pointB: 'Soprano M. Ali El Abed',
    })
    expect(reading.result.raw).toMatchObject({ routesAligned: true })
  })

  it('refuses a printed ٢٢٥ / converted 425 mismatch before it can become order money', () => {
    const result = parsedResult('orders', screen(orderRow('425', {
      printed: '٢٢٥',
      digitCount: 3,
    })))

    expect(result.ok && result.rows[0]).toMatchObject({ printed: '٢٢٥', value: null })
    expect(result.ok && result.retryable).toBe(true)
  })

  it('preserves a verified negative Recent Orders fee as a cash deduction', () => {
    const result = parsedResult('orders', screen(orderRow('-50', {
      printed: '-٥٠',
      digitCount: 2,
    })))

    expect(result.ok && result.rows[0]).toMatchObject({ printed: '-٥٠', value: '-50', cancelled: false })
    expect(result.ok && result.retryable).toBe(false)
  })

  it('does not retry a successful orders read containing only cancelled cards', () => {
    const result = parsedResult('orders', screen(orderRow('0', {
      printed: 'Cancelled',
      value: null,
      cancelled: true,
      digitCount: 0,
    })))

    expect(result.ok && result.rows[0]).toMatchObject({ value: null, cancelled: true })
    expect(result.ok && result.retryable).toBe(false)
  })

  it('refuses only an aligned fast/full fee disagreement and preserves other matching rows and routes', async () => {
    const fast: ParsedScreen = {
      rows: [
        orderRow('155'),
        orderRow('240', { time: '14:00' }),
      ],
      fields: [],
      notes: null,
    }
    const full: ParsedScreen = {
      rows: [
        orderRow('165', {
          pointA: 'Disputed pickup',
          pointB: 'Disputed dropoff',
        }),
        orderRow('240', {
          time: '14:00',
          pointA: 'Confirmed pickup',
          pointB: 'Confirmed dropoff',
        }),
      ],
      fields: [],
      notes: null,
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return completion(requestedPrompt(init).includes('ORDERS MONEY/TIME/DATE FAST PASS') ? fast : full)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok).toBe(true)
    if (!reading.result.ok) throw new Error('expected an orders result')
    expect(reading.result.rows).toEqual([
      {
        printed: '155',
        value: null,
        cancelled: false,
        time: '13:32',
        dateIso: '2026-08-15',
        pointA: null,
        pointB: null,
      },
      {
        printed: '240',
        value: '240',
        cancelled: false,
        time: '14:00',
        dateIso: '2026-08-15',
        pointA: 'Confirmed pickup',
        pointB: 'Confirmed dropoff',
      },
    ])
    expect(reading.result.raw).toMatchObject({
      routesAligned: false,
      financialDisagreementIndexes: [0],
    })
    expect(reading.result.retryable).toBe(true)
  })

  it('falls back to a successful full pass when the fast pass fails', async () => {
    const full = screen(orderRow('240', { pointA: 'Pickup', pointB: 'Dropoff' }))
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return requestedPrompt(init).includes('ORDERS MONEY/TIME/DATE FAST PASS')
        ? new Response('', { status: 503 })
        : completion(full)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok && reading.result.rows[0]).toMatchObject({
      value: '240',
      pointA: 'Pickup',
      pointB: 'Dropoff',
    })
  })

  it('keeps the printed/value integrity gate on the full-pass fallback', async () => {
    const full = screen(orderRow('425', {
      printed: '٢٢٥',
      digitCount: 3,
      pointA: 'Pickup',
      pointB: 'Dropoff',
    }))
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return requestedPrompt(init).includes('ORDERS MONEY/TIME/DATE FAST PASS')
        ? new Response('', { status: 503 })
        : completion(full)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok && reading.result.rows[0]).toMatchObject({
      printed: '٢٢٥',
      value: null,
      pointA: 'Pickup',
      pointB: 'Dropoff',
    })
    expect(reading.result.ok && reading.result.retryable).toBe(true)
  })
})
