import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChatCompletionsOcrReader,
  normalizePrintedOrderTime,
  parsedResult,
  resolveSamePageOrderTimes,
  isDeliberateAbort,
  safeProviderDetail,
  type OcrProviderErrorEvent,
  type ParsedRow,
  type ParsedScreen,
} from '../src/ocr/chat-completions.ts'

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
const screenKind = (kind: 'orders' | 'payments_log' | 'unknown' = 'orders'): ParsedScreen => ({
  screenKind: kind,
})

function completion(parsed: ParsedScreen, tokensIn = 10, tokensOut = 5): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(parsed), refusal: null } }],
      usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const reader = (timeoutMs = 1_000): ChatCompletionsOcrReader =>
  new ChatCompletionsOcrReader({
    provider: 'openai',
    apiKey: 'test-only',
    model: 'gpt-test',
    effort: 'medium',
    verbosity: 'medium',
    timeoutMs,
    baseUrl: 'https://ocr.test/read',
  })

/** Same reader, real default endpoints, so the request body and the signature can be asserted. */
const providerReader = (
  provider: 'openai' | 'openrouter',
  onProviderError?: (event: OcrProviderErrorEvent) => void,
): ChatCompletionsOcrReader =>
  new ChatCompletionsOcrReader({
    provider,
    apiKey: 'sk-or-v1-testkeytestkeytestkey',
    model: 'model-under-test',
    effort: 'medium',
    verbosity: 'medium',
    timeoutMs: 1_000,
    ...(onProviderError === undefined ? {} : { onProviderError }),
  })

/**
 * Stub `fetch` and record every request, so a test can assert on the body that actually went out.
 *
 * Reading them back off `vi.fn().mock.calls` does not typecheck — a stub declaring no parameters
 * types its calls as an empty tuple — and casting around that would only hide the next mistake.
 */
function recordFetch(reply: () => Response): { urls: string[]; bodies: Record<string, unknown>[] } {
  const urls: string[] = []
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    urls.push(String(url))
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return reply()
  })
  return { urls, bodies }
}

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
    expect(reading.result).toMatchObject({ ok: false, reason: 'no_fields' })
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

const isScreenKindPrompt = (prompt: string): boolean =>
  prompt.includes('ORDERS SCREEN-KIND SAFETY CHECK')

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

  it('resolves 01:18 above 00:57 only when the 01:37 evidence receipt bound removes PM', () => {
    expect(resolveSamePageOrderTimes([
      { printedTime: '01:18', dateIso: '2026-08-16' },
      { printedTime: '00:57', dateIso: '2026-08-16' },
    ], { dateIso: '2026-08-16', time: '01:37' })).toEqual([
      {
        time: '01:18',
        candidates: ['01:18'],
        basis: 'screen_position',
        conflict: false,
      },
      {
        time: '00:57',
        candidates: ['00:57'],
        basis: 'printed_time',
        conflict: false,
      },
    ])
  })

  it('keeps a marker-less boundary clock unknown when both AM/PM paths remain possible', () => {
    expect(resolveSamePageOrderTimes([
      { printedTime: '01:18', dateIso: '2026-08-16' },
      { printedTime: '00:57', dateIso: '2026-08-16' },
    ])[0]).toEqual({
      time: null,
      candidates: ['01:18', '13:18'],
      basis: 'unknown',
      conflict: false,
    })
  })

  /**
   * The shift's own lower edge, added 2026-08-31.
   *
   * Eleven production rows worth 2,715.00 stayed unresolved because a marker-less clock has two
   * readings and the resolver will not guess — and a row with no time has no merge identity, so
   * 45% of them duplicated on the next retake against 0.6% of timed rows. A delivery cannot predate
   * its own shift, which settles the choice without anyone guessing a marker.
   */
  it('settles a marker-less clock against the minute the shift opened', () => {
    expect(resolveSamePageOrderTimes(
      [{ printedTime: '1:18', dateIso: '2026-08-16' }],
      { dateIso: '2026-08-16', time: '22:00' },
      { dateIso: '2026-08-16', time: '12:00' },
    )[0]).toEqual({
      time: '13:18',
      candidates: ['13:18'],
      basis: 'screen_position',
      conflict: false,
    })
  })

  it('keeps the delivery printed at the exact opening minute', () => {
    // INCLUSIVE, like the operation window itself. A strict comparison here would throw away the
    // first delivery of every shift — and every default close-draft fixture is an 08:00 row on a
    // shift that opens at 08:00.
    expect(resolveSamePageOrderTimes(
      [{ printedTime: '8:00 AM', dateIso: '2026-08-16' }],
      { dateIso: '2026-08-16', time: '22:00' },
      { dateIso: '2026-08-16', time: '08:00' },
    )[0]).toMatchObject({ time: '08:00', basis: 'printed_time', conflict: false })
  })

  it('never lets the shift bound delete the only reading a row has', () => {
    /*
     * The bound exists to CHOOSE between two candidates, not to erase one.
     *
     * A `1:00 PM` printed under the previous day's header is a perfectly legible time that simply
     * falls outside this shift — deciding what to do about that belongs to the window classifier,
     * which has `pre_open` for exactly it. Taking the minute away instead would cost the row its
     * merge identity and duplicate it on the next retake: the failure this bound was added to stop.
     *
     * Caught by a real test in `close-draft-adversarial` before this rule was written down.
     */
    expect(resolveSamePageOrderTimes(
      [{ printedTime: '1:00 PM', dateIso: '2026-07-20' }],
      { dateIso: '2026-07-21', time: '14:00' },
      { dateIso: '2026-07-21', time: '08:00' },
    )[0]).toMatchObject({ time: '13:00', conflict: false })
  })

  it('is unchanged when no shift bound is supplied, which is how the cached adapter pass calls it', () => {
    // The adapter's own pass stays context-free so its result remains cacheable — the reason
    // `cache_signature` does not move for this change and no page is re-read.
    expect(resolveSamePageOrderTimes([
      { printedTime: '01:18', dateIso: '2026-08-16' },
      { printedTime: '00:57', dateIso: '2026-08-16' },
    ])[0]).toEqual({
      time: null,
      candidates: ['01:18', '13:18'],
      basis: 'unknown',
      conflict: false,
    })
  })

  it('rejects trusted times that invert the newest-first screen order', () => {
    expect(resolveSamePageOrderTimes([
      { printedTime: '00:57', dateIso: '2026-08-16' },
      { printedTime: '01:18', dateIso: '2026-08-16' },
    ])).toEqual([
      { time: null, candidates: [], basis: 'unknown', conflict: true },
      { time: null, candidates: [], basis: 'unknown', conflict: true },
    ])
  })
})

describe('orders fast financial pass', () => {
  it('versions the cache by model configuration and all orders pass versions and budgets', () => {
    expect(reader().cacheSignature('orders')).toBe(
      'openai@ocr.test:gpt-test:medium:medium:orders-screen-kind-v1:orders-money-v5:orders-money-2-v1:orders-time-v3:orders-route-v4:money-consensus-v1:money-validation-v2:time-validation-v3:position-evidence-v1:cancellation-consensus-v1:kind-timeout-1000:money-timeout-1000:time-timeout-1000:route-timeout-1000:route-grace-12000:kind-max-512:money-max-8192:time-max-4096:route-max-8192',
    )
    expect(reader(2_000).cacheSignature('orders')).not.toBe(reader().cacheSignature('orders'))
    expect(reader(2_000).cacheSignature('wallet')).not.toBe(reader().cacheSignature('wallet'))
    expect(reader().cacheSignature('bms')).toContain(':bms-prompt-v2:')
  })

  it('returns wrong_screen with no rows when the independent pass identifies a payments log', async () => {
    const paymentLikeRows = screen(orderRow('-93.75', {
      printed: '-٩٣٫٧٥',
      hasDecimal: true,
      digitCount: 4,
      time: '00:25',
      pointA: null,
      pointB: null,
    }))
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (isScreenKindPrompt(prompt)) return completion(screenKind('payments_log'))
      return completion(paymentLikeRows)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result).toEqual({ ok: false, reason: 'wrong_screen' })
    expect('rows' in reading.result).toBe(false)
  })

  it('does not claim the wrong screen when the independent classifier is merely unsure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (isScreenKindPrompt(prompt)) return completion(screenKind('unknown'))
      return completion(screen(orderRow('155')))
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result).toMatchObject({ ok: false, reason: 'no_fields' })
    // …and it says so. `no_fields` alone reads identically to a blank screen and to a completion
    // truncated by its ceiling; only the detail distinguishes an unsure classifier from either.
    expect((reading.result as { detail?: string }).detail).toContain('screen-kind gate')
    expect((reading.result as { detail?: string }).detail).toContain('unknown')
  })

  it('publishes agreed marker-less evidence and candidates without guessing AM or PM', async () => {
    const rows: ParsedScreen = {
      rows: [
        orderRow('220', { time: '01:18', dateIso: '2026-08-16' }),
        orderRow('155', { time: '00:57', dateIso: '2026-08-16' }),
      ],
      fields: [],
      notes: null,
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(rows)
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(rows)
      return new Response('', { status: 504 })
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok && reading.result.rows).toMatchObject([
      { value: '220', printedTime: '01:18', time: null, rowIndex: 0, rowCount: 2 },
      { value: '155', printedTime: '00:57', time: '00:57', rowIndex: 1, rowCount: 2 },
    ])
    expect(reading.result.ok && reading.result.raw).toMatchObject({
      timeAgreementCounts: [2, 2],
      timeCandidates: [['01:18', '13:18'], ['00:57']],
      timeBases: ['unknown', 'printed_time'],
    })
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
      if (isScreenKindPrompt(prompt)) return completion(screenKind(), 2, 1)
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(fast, 8, 4)
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(fast, 6, 3)
      return new Response('', { status: 504 })
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    // FIVE: screen-kind, two independent money readings, the printed-time verifier, and routes.
    // The second money pass was added after a single unchecked reading published 230 for a fee of
    // 330 on 2026-09-01 — the wallet and the clock had needed two agreeing readers for weeks.
    expect(fetch).toHaveBeenCalledTimes(5)
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
      reader: 'orders-ai-money-and-time-consensus-v5',
      routesAligned: false,
      route: { ok: false, reason: 'timeout' },
      timeAgreementCounts: [2, 2, 2, 2, 2],
    })
    // The price of the second opinion, summed across every pass exactly as `ocr_reads` records it:
    // 16/8 before, 24/12 after — the new pass costs what the first money pass costs. Measured
    // against production the same ratio came to +$1.63/month at ten shifts a day, against a single
    // misread fee that moved one employee settlement by 92.00.
    expect(reading.usage).toMatchObject({ tokensIn: 24, tokensOut: 12 })
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
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
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
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
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
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
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
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
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
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
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
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
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
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(money)
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return new Response('', { status: 504 })
      return completion(route)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok && reading.result.rows).toMatchObject([
      { value: '240', time: '23:21', cancelled: false },
      { value: '155', time: null, cancelled: false },
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
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
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
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
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

  it('keeps authoritative money when the optional route pass transcribes a different fee', async () => {
    const fast: ParsedScreen = {
      rows: [
        orderRow('155', { time: '14:32' }),
        orderRow('240', { time: '14:00' }),
      ],
      fields: [],
      notes: null,
    }
    const full: ParsedScreen = {
      rows: [
        orderRow('165', {
          time: '14:32',
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
      const prompt = requestedPrompt(init)
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
      return completion(prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS') ? fast : full)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result.ok).toBe(true)
    if (!reading.result.ok) throw new Error('expected an orders result')
    expect(reading.result.rows).toMatchObject([
      {
        printed: '155',
        value: '155',
        cancelled: false,
        time: '14:32',
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
    expect(reading.result.retryable).toBe(false)
  })

  it('never uses verifier plus route money when the authoritative money pass fails', async () => {
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
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
      if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return new Response('', { status: 503 })
      if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(verifier)
      return completion(full)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('does not publish route-only rows after a money timeout', async () => {
    const full = screen(orderRow('425', {
      printed: '٢٢٥',
      digitCount: 3,
      pointA: 'Pickup',
      pointB: 'Dropoff',
    }))
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (isScreenKindPrompt(prompt)) return completion(screenKind())
      return prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')
        ? new Response('', { status: 503 })
        : completion(full)
    }))

    const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

    expect(reading.result).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  /*
   * The fee, voted on — added 2026-09-01 after a single unchecked reading put a phantom delivery
   * into a settlement.
   *
   * Shift a3728815 photographed one Recent Orders list twice. On the second page the 14:50 row was
   * scrolled under the sticky header and rendered faded, the top of a ٣ was lost, and the money
   * pass returned 230 where the screen said 330 — while transcribing the clock and both address
   * lines perfectly. Nothing checked it, so both rows became orders: ten orders for nine
   * deliveries. The phantom raised `expectedTotal` by 0.8 × 230, which pulled a real 218.25 surplus
   * down to 34.25 and made the shift look almost exact.
   *
   * Yallago's own payments log settles the fee beyond argument: exactly one 20% deduction at that
   * minute, −66.00 = 20% of 330, and no −46.00 anywhere in it.
   *
   * The wallet has needed two agreeing readers since `٢٧٩٫٥٠` came back as `٣٧٩٫٥٠` — the same ٢/٣
   * confusion — and the printed clock since 0033. The fee, which the whole settlement is built
   * from, was the one field with no vote.
   */
  describe('the fee is voted on, not taken from one reader', () => {
    const twoPages = (first: string, second: string): ParsedScreen => ({
      rows: [
        orderRow(first, { time: '02:50 م', dateIso: '2026-09-01' }),
        orderRow(second, { time: '02:00 م', dateIso: '2026-09-01' }),
      ],
      fields: [],
      notes: null,
    })

    /** Stage the two money readings independently; everything else agrees. */
    const stage = (primary: ParsedScreen, second: ParsedScreen, route?: ParsedScreen): void => {
      vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const prompt = requestedPrompt(init)
        if (isScreenKindPrompt(prompt)) return completion(screenKind())
        // The second prompt embeds the first, so the specific marker must be tested FIRST.
        if (prompt.includes('SECOND FINANCIAL READING')) return completion(second)
        if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(primary)
        if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(primary)
        if (route !== undefined) return completion(route)
        return new Response('', { status: 504 })
      }))
    }

    it('refuses a fee the two readers disagree about, and says why', async () => {
      // The incident, reproduced: 330 on one reading, 230 on the other, everything else identical.
      stage(twoPages('330', '120'), twoPages('230', '120'))
      const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })

      expect(reading.result.ok).toBe(true)
      if (!reading.result.ok) throw new Error('expected an orders result')

      // NOT 330, and emphatically not 230. Neither reader is trusted over the other, so the row
      // goes to a human — `reviewRequired` reaches the manager as `reader_conflict` and the driver
      // as a fee to type. Before this, 230 was published with nothing to show anyone disagreed.
      expect(reading.result.rows[0]).toMatchObject({ value: null, reviewRequired: true })
      // The row the readers agreed on is untouched. A conflict is per row, never per screen.
      expect(reading.result.rows[1]).toMatchObject({ value: '120' })
      expect(reading.result.raw).toMatchObject({ moneyDisagreementIndexes: [0] })
      // And the whole image stays retryable, because a refused fee is an unread one.
      expect(reading.result.retryable).toBe(true)
    })

    it('publishes a fee both readers saw', async () => {
      stage(twoPages('330', '120'), twoPages('330', '120'))
      const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
      expect(reading.result.ok && reading.result.rows.map((row) => row.value)).toEqual(['330', '120'])
      expect(reading.result.ok && reading.result.raw).toMatchObject({ moneyDisagreementIndexes: [] })
    })

    it('counts 330 and 330.00 as one reading, not two disagreeing ones', async () => {
      // The vote is over the parsed money key. Two readers who wrote the same amount differently
      // agree, and treating that as a conflict would send honest rows to a human every night.
      stage(twoPages('330', '120'), twoPages('330.00', '120.00'))
      const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
      expect(reading.result.ok && reading.result.rows.map((row) => row.value)).toEqual(['330', '120'])
      expect(reading.result.ok && reading.result.raw).toMatchObject({ moneyDisagreementIndexes: [] })
    })

    it('still publishes when only ONE reader could read the fee', async () => {
      /*
       * Availability, stated as a deliberate limit rather than left implicit. If the second reading
       * fails — a timeout, a refusal, a truncated completion — the first is published as before.
       * Refusing here would turn every flaky-network shift into a page of hand-typed fees, and a
       * lone reading is not the failure this exists to catch. A CONTRADICTED one is.
       */
      vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const prompt = requestedPrompt(init)
        if (isScreenKindPrompt(prompt)) return completion(screenKind())
        if (prompt.includes('SECOND FINANCIAL READING')) return new Response('', { status: 504 })
        if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(twoPages('330', '120'))
        if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(twoPages('330', '120'))
        return new Response('', { status: 504 })
      }))
      const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
      expect(reading.result.ok && reading.result.rows.map((row) => row.value)).toEqual(['330', '120'])
    })

    it('lets two agreeing readers outvote a third that disagrees', async () => {
      // The wallet's rule exactly: two independent readers who saw the same amount outweigh one who
      // did not. Without this, any single bad pass could veto a whole screen.
      stage(twoPages('330', '120'), twoPages('330', '120'), twoPages('230', '120'))
      const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
      expect(reading.result.ok && reading.result.rows[0]).toMatchObject({ value: '330' })
    })

    it('keeps the second reading out of the printed-time vote', async () => {
      /*
       * The second money prompt is the first one plus a financial appendix, so its time
       * instructions are the first's verbatim. It is a genuinely independent reader of the FEE and
       * not of the clock — counting it would turn one reader's time into two votes and retire the
       * rule 0033 exists for.
       *
       * Here the two money passes agree on a clock the verifier contradicts. That is one reader
       * against one, so no time may be published.
       */
      const money = twoPages('330', '120')
      const verifier: ParsedScreen = {
        rows: [
          orderRow('330', { time: '03:50 م', dateIso: '2026-09-01' }),
          orderRow('120', { time: '02:00 م', dateIso: '2026-09-01' }),
        ],
        fields: [],
        notes: null,
      }
      vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const prompt = requestedPrompt(init)
        if (isScreenKindPrompt(prompt)) return completion(screenKind())
        if (prompt.includes('SECOND FINANCIAL READING')) return completion(money)
        if (prompt.includes('ORDERS MONEY/TIME/DATE FAST PASS')) return completion(money)
        if (prompt.includes('ORDERS PRINTED-TIME VERIFIER')) return completion(verifier)
        return new Response('', { status: 504 })
      }))
      const reading = await reader().read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
      expect(reading.result.ok).toBe(true)
      if (!reading.result.ok) throw new Error('expected an orders result')
      // The contested clock is refused; the money the two readers agreed on is published.
      expect(reading.result.rows[0]).toMatchObject({ value: '330', time: null })
      // Zero, not two. `consensusValue` reports the WINNER's votes, and a contested clock has no
      // winner — so this is the direct statement that the second money pass did not get to second
      // its own copy of the time. Row 1, which the verifier really did corroborate, still shows 2.
      expect(reading.result.raw).toMatchObject({ timeAgreementCounts: [0, 2] })
    })
  })
})

describe('provider identity and request shape', () => {
  it('gives two providers DIFFERENT cache signatures for every field', () => {
    // The signature is persisted to `ocr_reads.cache_signature` and IS the cache identity. It used
    // to begin with the literal string `openai`, so two providers running the same model name were
    // indistinguishable and a swap — or the revert — could serve rows the other one produced.
    for (const field of ['orders', 'wallet', 'bms', 'odometer', 'payments_log'] as const) {
      const openai = providerReader('openai').cacheSignature(field)
      const openrouter = providerReader('openrouter').cacheSignature(field)
      expect(openai).not.toBe(openrouter)
      expect(openai.startsWith('openai@api.openai.com:')).toBe(true)
      expect(openrouter.startsWith('openrouter@openrouter.ai:')).toBe(true)
    }
  })

  it('pins each provider default endpoint', async () => {
    for (const [provider, host] of [
      ['openai', 'https://api.openai.com/v1/chat/completions'],
      ['openrouter', 'https://openrouter.ai/api/v1/chat/completions'],
    ] as const) {
      const sent = recordFetch(() => completion(screen(walletRow('1', '1'))))
      await providerReader(provider).read({ field: 'odometer', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
      expect(sent.urls[0]).toBe(host)
      vi.unstubAllGlobals()
    }
  })

  it('names the token ceiling the way each provider expects, and never both', async () => {
    // OpenAI rejects `max_tokens`; OpenRouter may silently IGNORE `max_completion_tokens`, which
    // would leave an uncapped reasoner with no bound at all.
    const openai = recordFetch(() => completion(screen(walletRow('1', '1'))))
    await providerReader('openai').read({ field: 'odometer', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
    expect(openai.bodies[0]).toHaveProperty('max_completion_tokens', 8192)
    expect(openai.bodies[0]).not.toHaveProperty('max_tokens')
    vi.unstubAllGlobals()

    const openrouter = recordFetch(() => completion(screen(walletRow('1', '1'))))
    await providerReader('openrouter').read({ field: 'odometer', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
    expect(openrouter.bodies[0]).toHaveProperty('max_tokens', 8192)
    expect(openrouter.bodies[0]).not.toHaveProperty('max_completion_tokens')
  })

  it('sends temperature 0 and denies data collection on openrouter, and no OpenAI-only knobs', async () => {
    const sent = recordFetch(() => completion(screen(walletRow('1', '1'))))
    await providerReader('openrouter').read({ field: 'odometer', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
    const body = sent.bodies[0]!
    // Measured at temperature 0; omitting it would ship a reader nobody benchmarked.
    expect(body).toHaveProperty('temperature', 0)
    // The photos carry customer addresses and metre-level GPS — ASSUMPTIONS A-30.
    expect(body).toHaveProperty('provider', { data_collection: 'deny' })
    // Thinking stays UNCAPPED: a 256 cap measured two money self-disagreements in fifty images.
    expect(body).not.toHaveProperty('reasoning')
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('verbosity')
  })

  it('keeps sending the OpenAI reasoning knobs on the openai provider', async () => {
    const sent = recordFetch(() => completion(screen(walletRow('1', '1'))))
    await providerReader('openai').read({ field: 'odometer', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
    expect(sent.bodies[0]).toMatchObject({ reasoning_effort: 'medium', verbosity: 'medium' })
    expect(sent.bodies[0]).not.toHaveProperty('temperature')
    expect(sent.bodies[0]).not.toHaveProperty('provider')
  })
})

describe('a failed pass says what happened', () => {
  it('distinguishes a token-ceiling truncation from a blank screen', async () => {
    // Both are `no_fields`. Before this, a ceiling too small for a new model was indistinguishable
    // in the ledger from drivers photographing nothing — which is how an outage hides for days.
    const events: OcrProviderErrorEvent[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'length', message: { content: '', refusal: null } }],
            usage: { prompt_tokens: 10, completion_tokens: 8192 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const reading = await providerReader('openrouter', (e) => events.push(e)).read({
      field: 'odometer',
      bytes: new Uint8Array([1]),
      mimeType: 'image/jpeg',
    })
    expect(reading.result).toMatchObject({ ok: false, reason: 'no_fields' })
    expect((reading.result as { detail?: string }).detail).toContain('ceiling')
    expect((reading.result as { detail?: string }).detail).toContain('finish_reason=length')
    expect((reading.result as { detail?: string }).detail).toContain('8192/8192')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ provider: 'openrouter', kind: 'ceiling' })
  })

  /**
   * Three different situations reach `ocr_reads` as `no_fields`: a completion cut off by its token
   * ceiling, a screen the model could not identify, and a screen it read as genuinely empty. In
   * production three of four failed reads carried NO `detail` at all, so «the model transcribed
   * rows and verification rejected every one» could not be told apart from «the driver
   * photographed a blank screen» — the same shape as the evidence-upload outage, where every
   * distinct cause collapsed into one message and it took three days to name.
   */
  it('says WHICH kind of nothing it got when the model returns an empty transcription', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completion({ rows: [], fields: [], notes: null })))
    const reading = await reader().read({
      field: 'odometer',
      bytes: new Uint8Array([1]),
      mimeType: 'image/jpeg',
    })
    expect(reading.result).toMatchObject({ ok: false, reason: 'no_fields' })
    const detail = (reading.result as { detail?: string }).detail ?? ''
    expect(detail).toContain('odometer')
    expect(detail).toContain('0 rows, 0 fields')
    // The distinction that matters: this is NOT the ceiling case.
    expect(detail).not.toContain('finish_reason=length')
  })

  it('names an out-of-enum screen kind — the tell that a provider ignored the strict schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = requestedPrompt(init)
      if (isScreenKindPrompt(prompt)) {
        return completion({ screenKind: 'a_totally_unexpected_value' } as unknown as ParsedScreen)
      }
      return completion(screen(orderRow('155')))
    }))
    const reading = await reader().read({
      field: 'orders',
      bytes: new Uint8Array([1]),
      mimeType: 'image/jpeg',
    })
    expect(reading.result).toMatchObject({ ok: false, reason: 'no_fields' })
    expect((reading.result as { detail?: string }).detail).toContain('a_totally_unexpected_value')
  })

  it('carries the provider error code on a 4xx, and fires the sink exactly once', async () => {
    const events: OcrProviderErrorEvent[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'bad field xyz' } }), {
          status: 400,
        }),
      ),
    )
    const reading = await providerReader('openrouter', (e) => events.push(e)).read({
      field: 'odometer',
      bytes: new Uint8Array([1]),
      mimeType: 'image/jpeg',
    })
    expect(reading.result).toMatchObject({ ok: false, reason: 'unavailable' })
    expect((reading.result as { detail?: string }).detail).toContain('http 400')
    expect((reading.result as { detail?: string }).detail).toContain('bad field xyz')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'http', status: 400 })
  })

  it('turns a provider low-balance response into an immediate non-throwing fallback', async () => {
    const events: OcrProviderErrorEvent[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'insufficient_credits', message: 'credit balance too low' } }), {
          status: 402,
        }),
      ),
    )
    const reading = await providerReader('openrouter', (e) => events.push(e)).read({
      field: 'bms',
      bytes: new Uint8Array([1]),
      mimeType: 'image/jpeg',
    })

    expect(reading.result).toMatchObject({ ok: false, reason: 'unavailable' })
    expect((reading.result as { detail?: string }).detail).toContain('http 402')
    expect((reading.result as { detail?: string }).detail).toContain('insufficient_credits')
    expect(events).toEqual([
      expect.objectContaining({ provider: 'openrouter', kind: 'http', status: 402, pass: 'bms' }),
    ])
  })

  it('honours the API lifecycle abort instead of leaving provider fetch open', async () => {
    const events: OcrProviderErrorEvent[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('API deadline', 'AbortError'))
        }, { once: true })
      }),
    ))
    const controller = new AbortController()
    const pending = providerReader('openrouter', (event) => events.push(event)).read({
      field: 'bms',
      bytes: new Uint8Array([1]),
      mimeType: 'image/jpeg',
      signal: controller.signal,
    })

    controller.abort()
    const reading = await pending
    expect(reading.result).toMatchObject({ ok: false, reason: 'timeout' })
    expect(events).toEqual([
      expect.objectContaining({ kind: 'timeout', pass: 'bms', detail: 'caller deadline bms' }),
    ])
  })

  it('never fires the sink on a good read', async () => {
    const events: OcrProviderErrorEvent[] = []
    vi.stubGlobal('fetch', vi.fn(async () => completion(screen(walletRow('1', '1')))))
    await providerReader('openrouter', (e) => events.push(e)).read({
      field: 'odometer',
      bytes: new Uint8Array([1]),
      mimeType: 'image/jpeg',
    })
    expect(events).toHaveLength(0)
  })
})

describe('safeProviderDetail', () => {
  it('removes the api key, by value and by shape', () => {
    const key = 'sk-or-v1-abcdef0123456789'
    expect(safeProviderDetail('auth failed for ' + key, key)).not.toContain(key)
    // A key that is NOT the one we hold — a proxy's, or one already rotated.
    expect(safeProviderDetail('upstream said sk-proj-ZZZZZZZZZZZZ', 'other')).not.toContain('sk-proj-ZZZZ')
  })

  it('removes an echoed screenshot rather than logging customer addresses', () => {
    const out = safeProviderDetail('rejected: data:image/jpeg;base64,AAAABBBBCCCCDDDD/w== end', 'k')
    expect(out).toContain('[image]')
    expect(out).not.toContain('AAAABBBBCCCC')
  })

  it('caps the length so one provider cannot flood the ledger', () => {
    expect(safeProviderDetail('x'.repeat(5_000), 'k').length).toBeLessThanOrEqual(200)
  })
})

describe('a deliberate cancellation is not an alarm', () => {
  // The orders route pass is aborted ON PURPOSE by `routePassWithinGrace` once the compact money
  // and time passes have settled — that happens on every healthy orders read. Reporting it as a
  // provider failure would put an `ocr_provider_error` in the log on the happy path, and an alert
  // channel that shouts during normal operation is one people stop reading. Which is how the NEXT
  // outage stays hidden for three days.
  it('treats an abort from the caller signal as cancellation, not failure', () => {
    const caller = new AbortController()
    caller.abort()
    expect(isDeliberateAbort('AbortError', caller.signal)).toBe(true)
  })

  it('still treats a budget expiry as a real failure worth reporting', () => {
    // The timeout signal fires and the caller's own signal is untouched — that is the discriminator.
    const caller = new AbortController()
    expect(isDeliberateAbort('TimeoutError', caller.signal)).toBe(false)
    expect(isDeliberateAbort('AbortError', caller.signal)).toBe(false)
    // Passes with no caller signal at all (wallet, bms, odometer) can only ever be real timeouts.
    expect(isDeliberateAbort('TimeoutError', undefined)).toBe(false)
  })

  it('never calls a transport error deliberate, however the signal looks', () => {
    const caller = new AbortController()
    caller.abort()
    expect(isDeliberateAbort('TypeError', caller.signal)).toBe(false)
    expect(isDeliberateAbort(undefined, caller.signal)).toBe(false)
  })
})
