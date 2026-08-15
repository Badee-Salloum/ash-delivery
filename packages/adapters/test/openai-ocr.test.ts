import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpenAiOcrReader,
  normalizePrintedOrderTime,
  parsedResult,
  type ParsedRow,
  type ParsedScreen,
} from '../src/ocr/openai.ts'

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

describe('printed order time normalization', () => {
  it.each([
    ['١٢:٠٣ ص', '00:03'],
    ['۱۲:۳۰ ص', '00:30'],
    ['12:00 PM', '12:00'],
    ['١:٠٥ م', '13:05'],
    ['P.M. 9:19', '21:19'],
    ['00:03', '00:03'],
    ['23:21', '23:21'],
  ])('converts %s deterministically to %s', (printed, expected) => {
    expect(normalizePrintedOrderTime(printed)).toBe(expected)
  })

  it.each(['24:03', '٠٠:٦٠', '13:03 ص', '12:03', '01:03', '11:3 PM', 'وقت غير واضح'])('refuses invalid or ambiguous %s', (printed) => {
    expect(normalizePrintedOrderTime(printed)).toBeNull()
  })
})

describe('orders fast financial pass', () => {
  it('versions the cache by model configuration and all orders pass versions and budgets', () => {
    expect(reader().cacheSignature('orders')).toBe(
      'openai:gpt-test:medium:medium:orders-money-v3:orders-time-v2:orders-route-v2:money-validation-v2:time-validation-v2:cancellation-consensus-v1:money-timeout-1000:time-timeout-1000:route-timeout-1000:route-grace-12000:money-max-4096:time-max-2048:route-max-8192',
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
      const prompt = requestedPrompt(init)
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(fast, 8, 4)
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(fast, 6, 3)
      return new Response('', { status: 504 })
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(fetch).toHaveBeenCalledTimes(3)
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
      reader: 'orders-ai-time-consensus-v3',
      routesAligned: false,
      route: { ok: false, reason: 'timeout' },
      timeAgreementCounts: [2, 2, 2, 2, 2],
    })
    expect(reading.usage).toMatchObject({ tokensIn: 14, tokensOut: 7 })
  })

  it('normalizes the exact midnight incident only after money and time passes agree', async () => {
    const cancelled = (time: string): ParsedRow => orderRow('0', {
      printed: 'تم إلغاؤه',
      value: null,
      digitCount: 0,
      cancelled: true,
      time,
      dateIso: '2026-08-15',
    })
    const money: ParsedScreen = {
      rows: [
        cancelled('١٢:٥٩ ص'),
        cancelled('١٢:٤٩ ص'),
        orderRow('155', { time: '١٢:٣٠ ص', dateIso: '2026-08-15' }),
        orderRow('155', { time: '١٢:٠٣ ص', dateIso: '2026-08-15' }),
        orderRow('240', { time: '١١:٢١ م', dateIso: '2026-08-14' }),
        orderRow('225', { time: '١٠:٢٧ م', dateIso: '2026-08-14' }),
        orderRow('425', { time: '٩:١٩ م', dateIso: '2026-08-14' }),
        orderRow('370', { time: '٨:٠٩ م', dateIso: '2026-08-14' }),
      ],
      fields: [],
      notes: null,
    }
    const verifier: ParsedScreen = {
      rows: [
        { time: '12:59 AM', dateIso: '2026-08-15', cancelled: true },
        { time: '12:49 AM', dateIso: '2026-08-15', cancelled: true },
        { time: '12:30 AM', dateIso: '2026-08-15', cancelled: false },
        { time: '12:03 AM', dateIso: '2026-08-15', cancelled: false },
        { time: '11:21 PM', dateIso: '2026-08-14', cancelled: false },
        { time: '10:27 PM', dateIso: '2026-08-14', cancelled: false },
        { time: '9:19 PM', dateIso: '2026-08-14', cancelled: false },
        { time: '8:09 PM', dateIso: '2026-08-14', cancelled: false },
      ],
      fields: [],
      notes: null,
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(money)
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(verifier)
      return new Response('', { status: 504 })
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok).toBe(true)
    if (!reading.result.ok) throw new Error('expected an orders result')
    expect(reading.result.rows.map(({ value, cancelled: isCancelled, time, dateIso }) => ({
      value,
      cancelled: isCancelled,
      time,
      dateIso,
    }))).toEqual([
      { value: null, cancelled: true, time: '00:59', dateIso: '2026-08-15' },
      { value: null, cancelled: true, time: '00:49', dateIso: '2026-08-15' },
      { value: '155', cancelled: false, time: '00:30', dateIso: '2026-08-15' },
      { value: '155', cancelled: false, time: '00:03', dateIso: '2026-08-15' },
      { value: '240', cancelled: false, time: '23:21', dateIso: '2026-08-14' },
      { value: '225', cancelled: false, time: '22:27', dateIso: '2026-08-14' },
      { value: '425', cancelled: false, time: '21:19', dateIso: '2026-08-14' },
      { value: '370', cancelled: false, time: '20:09', dateIso: '2026-08-14' },
    ])
    expect(reading.result.rows.reduce((sum, row) => sum + Number(row.value ?? 0), 0)).toBe(1_570)
    expect(reading.result.retryable).toBe(false)
  })

  it('keeps money but refuses a silently conflicting non-cancelled time and makes it retryable', async () => {
    const money = screen(orderRow('155', { time: '١٢:٠٣ ص' }))
    const verifier: ParsedScreen = {
      rows: [{ time: '١١:٠٣ ص', dateIso: '2026-08-15', cancelled: false }],
      fields: [],
      notes: null,
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(money)
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(verifier)
      return new Response('', { status: 504 })
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok && reading.result.rows[0]).toMatchObject({
      value: '155',
      time: null,
      dateIso: '2026-08-15',
    })
    expect(reading.result.ok && reading.result.retryable).toBe(true)
    expect(reading.result.ok && reading.result.raw).toMatchObject({
      timeDisagreementIndexes: [0],
      timeAgreementCounts: [0],
    })
  })

  it('votes on printed evidence before normalization can make unlike transcriptions look equal', async () => {
    const money = screen(orderRow('155', { time: '١٢:٠٣ ص' }))
    const verifier: ParsedScreen = {
      // This is the same normalized minute, but it is not evidence of the printed 12-hour clock.
      rows: [{ time: '00:03', dateIso: '2026-08-15', cancelled: false }],
      fields: [],
      notes: null,
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(money)
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(verifier)
      return new Response('', { status: 504 })
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok && reading.result.rows[0]).toMatchObject({
      value: '155',
      time: null,
      dateIso: '2026-08-15',
    })
    expect(reading.result.ok && reading.result.retryable).toBe(true)
    expect(reading.result.ok && reading.result.raw).toMatchObject({
      timeDisagreementIndexes: [0],
      timeAgreementCounts: [0],
    })
  })

  it('does not let one false money-pass cancellation silently discard two live-card votes', async () => {
    const money = screen(orderRow('0', {
      printed: 'Cancelled',
      value: null,
      digitCount: 0,
      cancelled: true,
      time: '12:30 AM',
    }))
    const verifier: ParsedScreen = {
      rows: [{ time: '12:30 AM', dateIso: '2026-08-15', cancelled: false }],
      fields: [],
      notes: null,
    }
    const route = screen(orderRow('155', {
      time: '12:30 AM',
      pointA: 'Pickup',
      pointB: 'Dropoff',
    }))
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(money)
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(verifier)
      return completion(route)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok && reading.result.rows[0]).toMatchObject({
      value: null,
      cancelled: false,
      time: '00:30',
      dateIso: '2026-08-15',
    })
    expect(reading.result.ok && reading.result.retryable).toBe(true)
    expect(reading.result.ok && reading.result.raw).toMatchObject({
      financialDisagreementIndexes: [0],
      cancellationAgreementCounts: [2],
      cancellationDisagreementIndexes: [0],
      cancellationUnverifiedIndexes: [],
    })
  })

  it('keeps a paid candidate visible when two cancellation votes conflict with one live vote', async () => {
    const money = screen(orderRow('155', { time: '12:30 AM' }))
    const cancelledRow = orderRow('0', {
      printed: 'Cancelled',
      value: null,
      digitCount: 0,
      cancelled: true,
      time: '12:30 AM',
    })
    const verifier: ParsedScreen = {
      rows: [{ time: '12:30 AM', dateIso: '2026-08-15', cancelled: true }],
      fields: [],
      notes: null,
    }
    const route = screen(cancelledRow)
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(money)
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(verifier)
      return completion(route)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok && reading.result.rows[0]).toMatchObject({
      value: null,
      cancelled: false,
      reviewRequired: true,
      time: null,
    })
    expect(reading.result.ok && reading.result.retryable).toBe(true)
    expect(reading.result.ok && reading.result.raw).toMatchObject({
      cancellationAgreementCounts: [2],
      cancellationDisagreementIndexes: [0],
    })
  })

  it('marks a lone cancellation observation for review when the other passes cannot vote', async () => {
    const money: ParsedScreen = {
      rows: [
        orderRow('240', { time: '11:21 PM' }),
        orderRow('0', {
          printed: 'Cancelled',
          value: null,
          digitCount: 0,
          cancelled: true,
          time: '12:30 AM',
        }),
      ],
      fields: [],
      notes: null,
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(money)
      return new Response('', { status: 504 })
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok && reading.result.rows).toMatchObject([
      { value: '240', cancelled: false, reviewRequired: true, time: null },
      { value: null, cancelled: false, reviewRequired: true, time: null },
    ])
    expect(reading.result.ok && reading.result.retryable).toBe(true)
  })

  it('keeps a fee/time disagreement visible beside a valid row when the verifier times out', async () => {
    const money: ParsedScreen = {
      rows: [
        orderRow('240', { time: '11:21 PM' }),
        orderRow('155', { time: '12:30 AM' }),
      ],
      fields: [],
      notes: null,
    }
    const route: ParsedScreen = {
      rows: [
        orderRow('240', { time: '11:21 PM', pointA: 'A1', pointB: 'B1' }),
        orderRow('175', { time: '11:30 AM', pointA: 'A2', pointB: 'B2' }),
      ],
      fields: [],
      notes: null,
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(money)
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return new Response('', { status: 504 })
      return completion(route)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok && reading.result.rows).toMatchObject([
      { value: '240', time: '23:21', cancelled: false },
      { value: null, time: null, cancelled: false, reviewRequired: true },
    ])
    expect(reading.result.ok && reading.result.retryable).toBe(true)
  })

  it('keeps an agreed time but refuses a conflicting date without choosing a tie-break', async () => {
    const money = screen(orderRow('155', { time: '١٢:٠٣ ص', dateIso: '2026-08-15' }))
    const verifier: ParsedScreen = {
      rows: [{ time: '12:03 AM', dateIso: '2026-08-14', cancelled: false }],
      fields: [],
      notes: null,
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(money)
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(verifier)
      return new Response('', { status: 504 })
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok && reading.result.rows[0]).toMatchObject({
      value: '155',
      time: '00:03',
      dateIso: null,
    })
    expect(reading.result.ok && reading.result.retryable).toBe(true)
    expect(reading.result.ok && reading.result.raw).toMatchObject({
      timeDisagreementIndexes: [],
      dateDisagreementIndexes: [0],
    })
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
      const prompt = requestedPrompt(init)
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(fast)
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return new Response('', { status: 503 })
      return completion(full)
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
    expect(reading.result.raw).toMatchObject({
      routesAligned: true,
      timeAgreementCounts: [2],
      time: { ok: false, reason: 'unavailable' },
    })
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
        reviewRequired: true,
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

  it('uses verifier plus route consensus when the money pass fails', async () => {
    const full = screen(orderRow('240', {
      time: '١١:٢١ م',
      dateIso: '2026-08-14',
      pointA: 'Pickup',
      pointB: 'Dropoff',
    }))
    const verifier: ParsedScreen = {
      rows: [{ time: '11:21 PM', dateIso: '2026-08-14', cancelled: false }],
      fields: [],
      notes: null,
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return new Response('', { status: 503 })
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(verifier)
      return completion(full)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok && reading.result.rows[0]).toMatchObject({
      value: '240',
      time: '23:21',
      dateIso: '2026-08-14',
      pointA: 'Pickup',
      pointB: 'Dropoff',
    })
    expect(reading.result.ok && reading.result.retryable).toBe(false)
    expect(reading.result.ok && reading.result.raw).toMatchObject({
      money: { ok: false, reason: 'unavailable' },
      timeAgreementCounts: [2],
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
