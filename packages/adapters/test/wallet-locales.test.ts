import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatCompletionsOcrReader, parsedResult, type ParsedRow, type ParsedScreen } from '../src/ocr/chat-completions.ts'

const row = (printed: string, value: string, over: Partial<ParsedRow> = {}): ParsedRow => ({
  printed, value, hasDecimal: true, hasThousands: true,
  digitCount: [...printed].filter(c => /[0-9٠-٩۰-۹]/u.test(c)).length,
  cancelled: false, ...over,
})
const screen = (r: ParsedRow): ParsedScreen => ({ screenKind: 'wallet', rows: [r] })
async function read(passes: ParsedScreen[]) {
  let index = 0
  const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(passes[index++]) } }] }), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const result = (await new ChatCompletionsOcrReader({ provider: 'openai', apiKey: 'test-only', model: 'test', effort: 'default', verbosity: 'default', timeoutMs: 1000, baseUrl: 'https://ocr.test/read' }).read({ field: 'wallet', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })).result
  expect(fetch).toHaveBeenCalledTimes(3)
  return result
}
afterEach(() => vi.unstubAllGlobals())

describe('wallet printed locale and screen integrity', () => {
  // Visually checked source screenshots, NOT historical AI transcripts (failed reads stored none).
  it.each([
    ['f3d19c61-952f-4a33-aac6-898cfc7be6ff', '1.175,56', '1175.56'],
    ['2065f954-27a6-4c43-848e-ab5a9bcd0a5f', '1.180,83', '1180.83'],
    ['cc615058-a729-4f3a-b03d-0743cc0ecd6d', '1.346,25', '1346.25'],
    ['c1c97d03-7f31-47c2-9f30-a781fc1c6b0a', '1.026,88', '1026.88'],
  ])('accepts the exact visible balance for source %s', async (_id, printed, value) => {
    const result = await read([screen(row(printed, value)), screen(row(printed, value)), { screenKind: 'unknown', rows: [] }])
    expect(result).toMatchObject({ ok: true, rows: [{ value }], fields: {} })
  })

  it.each([
    ['١٬١٨٠٫٨٣', '1180.83', true, true], ['۱٬۱۸۰٫۸۳', '1180.83', true, true],
    ['1,180.83', '1180.83', true, true], ['674,30', '674.30', true, false],
    ['−1.180,83', '-1180.83', true, true], ['\u20671.180,83\u2069 SYP', '1180.83', true, true],
    ['0,00', '0.00', true, false], ['1.180', '1180', false, true],
  ])('validates printed %s without a floating-point conversion', (printed, value, hasDecimal, hasThousands) => {
    expect(parsedResult('wallet', screen(row(printed as string, value as string, { hasDecimal: hasDecimal as boolean, hasThousands: hasThousands as boolean })))).toMatchObject({ ok: true, rows: [{ value }] })
  })

  it('agrees across locale spellings of the same balance', async () => {
    const result = await read([screen(row('1.180,83', '1180.83')), screen(row('١٬١٨٠٫٨٣', '1180.83')), screen(row('1,180.83', '1180.83'))])
    expect(result).toMatchObject({ ok: true, raw: { agreeingPasses: 3 } })
  })

  it.each([
    ['1.180,83', '118083', {}], ['1.180,83', '1180.83', { hasThousands: false }],
    ['1.180,83', '1180.83', { hasDecimal: false }], ['1.180,83', '1180.83', { digitCount: 5 }],
    ['1.18,83', '118.83', {}], ['1.180,833', '1180.833', {}],
    ['674,30', '67430', { hasDecimal: false, hasThousands: true }],
  ])('refuses inconsistent punctuation/flags/digits: %s => %s', (printed, value, over) => {
    const r = parsedResult('wallet', screen(row(printed as string, value as string, over as Partial<ParsedRow>)))
    expect(r.ok && r.rows[0]?.value).toBeFalsy()
  })

  it('requires a wallet identity even when other screens contain plausible money', async () => {
    const result = await read(Array.from({ length: 3 }, () => ({ screenKind: 'other', rows: [row('1.180,83', '1180.83')] })))
    expect(result).toMatchObject({ ok: false, reason: 'wrong_screen', raw: { reader: 'wallet-ai-consensus-v2' } })
  })

  it('does not accept an old response without the new screen gate', async () => {
    const result = await read(Array.from({ length: 3 }, () => ({ rows: [row('1.180,83', '1180.83')] })))
    expect(result).toMatchObject({ ok: false, reason: 'no_fields' })
  })

  it('does not accuse an unidentified/blurred image of being the wrong screen', async () => {
    const result = await read(Array.from({ length: 3 }, () => ({ screenKind: 'unknown', rows: [] })))
    expect(result).toMatchObject({ ok: false, reason: 'no_fields' })
  })

  it('retains failed transcripts for a later evidence-only diagnosis', async () => {
    const passes = ['1180.83', '1170.83', '1160.83'].map(value => screen(row(value.replace('.', ','), value, { hasThousands: false })))
    const result = await read(passes)
    expect(result).toMatchObject({ ok: false, reason: 'no_fields', raw: { passes: passes.map(transcript => ({ transcript })) } })
  })

  it('does not let one balance or several transaction rows manufacture agreement', async () => {
    const r = row('1.180,83', '1180.83')
    const result = await read([screen(r), { screenKind: 'wallet', rows: [r, r] }, { screenKind: 'unknown', rows: [] }])
    expect(result).toMatchObject({ ok: false, reason: 'no_fields' })
  })

  it('rejects cancelled balances', async () => {
    const result = await read(Array.from({ length: 3 }, () => screen(row('1.180,83', '1180.83', { cancelled: true }))))
    expect(result).toMatchObject({ ok: false, reason: 'no_fields' })
  })
})
