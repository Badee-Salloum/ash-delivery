import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatCompletionsOcrReader, type ParsedRow, type ParsedScreen } from '../src/ocr/chat-completions.ts'

const date = '2026-10-12'
const fragment = (over: Partial<ParsedRow> = {}): ParsedRow => ({
  printed: '', value: null, digitCount: 0, time: null, dateIso: date,
  cancelled: false, pointA: null, pointB: 'Partial edge destination', ...over,
})
const row = (value: string, time: string | null, over: Partial<ParsedRow> = {}): ParsedRow => ({
  printed: value, value, digitCount: value.replace(/\D/g, '').length,
  hasDecimal: false, hasThousands: false, time, dateIso: date,
  cancelled: false, pointA: null, pointB: null, ...over,
})
const screen = (rows: ParsedRow[]): ParsedScreen => ({ rows, fields: [], notes: null })
const verifier = (rows: ParsedRow[]) => screen(rows.map(({ time, dateIso, cancelled }) => ({ time: time ?? null, dateIso: dateIso ?? null, cancelled: cancelled ?? false })))

async function read(passes: { money: ParsedScreen; second?: ParsedScreen | undefined; time?: ParsedScreen | undefined; route?: ParsedScreen | undefined }) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    const schema = body.response_format.json_schema.name
    const parsed = schema === 'orders_screen_kind' ? { screenKind: 'orders' }
      : schema === 'orders_money_time_date' ? passes.money
        : schema === 'orders_money_second_reading' ? passes.second
          : schema === 'orders_printed_time_verifier' ? passes.time : passes.route
    if (!parsed) return new Response('', { status: 504 })
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(parsed) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
  }))
  const reader = new ChatCompletionsOcrReader({ provider: 'openai', apiKey: 'test-only', model: 'test', effort: 'default', verbosity: 'default', timeoutMs: 1000, baseUrl: 'https://ocr.test/read' })
  const reading = await reader.read({ field: 'orders', bytes: new Uint8Array([1]), mimeType: 'image/jpeg' })
  if (!reading.result.ok) throw new Error(`read refused: ${reading.result.reason}`)
  return reading.result
}
afterEach(() => { vi.unstubAllGlobals() })

describe('cropped edge alignment — 12 October screenshots', () => {
  it('isolates a clipped bottom clock and recovers independently anchored neighbours', async () => {
    const core = [row('330', '٢:٣٣ م'), row('260', '١:٤٣ م'), row('180', '١:١٢ م'), row('140', '١٢:٤٥ م')]
    const uncertain = [fragment(), ...core.map((r, i) => i === 3 ? { ...r, time: null } : r)]
    const result = await read({ money: screen(core), time: verifier(uncertain), route: screen(uncertain) })
    expect(result.rows.map(r => r.time)).toEqual(['14:33', '13:43', '13:12', null])
    expect(result.rows.map(r => r.value)).toEqual(['330', '260', '180', '140'])
    expect(result.raw).toMatchObject({ rowAlignment: { route: { basis: 'sparse_edge_anchored', sourceIndexes: [1, 2, 3, null] }, time: { basis: 'sparse_edge_anchored', sourceIndexes: [1, 2, 3, null] } } })
  })

  it('can recover the clear clocks even without a route pass when the final time row is empty', async () => {
    const core = [row('330', '٢:٣٣ م'), row('260', '١:٤٣ م'), row('180', '١:١٢ م')]
    const result = await read({ money: screen(core), time: verifier([fragment(), core[0]!, core[1]!, { ...core[2]!, time: null }]) })
    expect(result.rows.map(r => r.time)).toEqual(['14:33', '13:43', null])
    expect(result.rows.map(r => r.value)).toEqual(['330', '260', '180'])
  })

  it('refuses competing edge offsets instead of choosing one repeated block of clocks', async () => {
    const core = [row('330', '٢:٣٣ م'), row('260', '١:٤٣ م')]
    const extra = [fragment(), ...core, ...core, fragment()]
    const result = await read({ money: screen(core), time: verifier(extra) })
    expect(result.rows.map(r => r.time)).toEqual([null, null])
  })

  it('does not let a wrong AM/PM marker erase other verified clocks', async () => {
    const core = [row('330', '٢:٣٣ م'), row('260', '١:٤٣ م'), row('180', '١٢:٥٦ م')]
    const result = await read({ money: screen(core), time: verifier([fragment(), core[0]!, core[1]!, { ...core[2]!, time: '١٢:٥٦ ص' }]) })
    expect(result.rows.map(r => r.time)).toEqual(['14:33', '13:43', null])
    expect(result.rows[2]).toMatchObject({ value: '180', reviewRequired: true })
  })

  it('requires two unique dated clocks for partial alignment, not two repeated clocks', async () => {
    const core = [row('330', '٢:٣٣ م'), row('260', '٢:٣٣ م'), row('180', '١:١٢ م')]
    const result = await read({ money: screen(core), time: verifier([fragment(), core[0]!, core[1]!, { ...core[2]!, time: '١:١٢ ص' }]) })
    expect(result.rows.map(r => r.time)).toEqual([null, null, null])
    expect(result.raw).toMatchObject({ rowAlignment: { time: { basis: 'rejected' } } })
  })

  it('never gives a repeated clock a sparse vote even when other distinct anchors are proven', async () => {
    const core = [row('330', '٣:٣٣ م'), row('260', '٢:٤٣ م'), row('180', '١:١٢ م'), row('140', '١:١٢ م'), row('100', '١٢:٤٥ م')]
    const result = await read({ money: screen(core), time: verifier([fragment(), ...core.map((r, i) => i === 4 ? { ...r, time: '١٢:٤٥ ص' } : r)]) })
    expect(result.rows.map(r => r.time)).toEqual(['15:33', '14:43', null, null, null])
  })

  it('keeps a conflicting fee refused after a sparse time alignment', async () => {
    const core = [row('330', '٢:٣٣ م'), row('260', '١:٤٣ م'), row('180', '١:١٢ م')]
    const second = [fragment(), { ...core[0]!, printed: '230', value: '230' }, core[1]!, { ...core[2]!, time: null }]
    const result = await read({ money: screen(core), second: screen(second), time: verifier([fragment(), ...core.map((r, i) => i === 2 ? { ...r, time: '١:١٢ ص' } : r)]) })
    expect(result.rows[0]).toMatchObject({ value: null, time: '14:33', reviewRequired: true })
    expect(result.raw).toMatchObject({ moneyDisagreementIndexes: [0] })
  })

  it('does not confuse cancelled and live cards when their date and clock agree', async () => {
    const core = [row('330', '٢:٣٣ م'), row('260', '١:٤٣ م'), row('180', '١:١٢ م')]
    const result = await read({ money: screen(core), time: verifier([fragment(), core[0]!, core[1]!, { ...core[2]!, cancelled: true }]) })
    expect(result.rows[2]).toMatchObject({ value: '180', time: null, cancelled: false })
  })
  it('recovers Mohammad’s three clocks; keeps the two separate 260 deliveries distinct', async () => {
    const core = [row('330', '٢:٣٣ م'), row('260', '١:٤٣ م'), row('260', '١:١٢ م')]
    const full = [fragment(), ...core]
    const before = JSON.stringify(full)
    const result = await read({ money: screen(core), second: screen([fragment({ printed: '?' }), ...core]), time: verifier(full), route: screen(full.map((r, i) => i === 0 ? r : { ...r, pointA: `Pickup ${i}`, pointB: `Destination ${i}` })) })
    expect(result.rows.map(({ value, time, dateIso }) => ({ value, time, dateIso }))).toEqual([
      { value: '330', time: '14:33', dateIso: date }, { value: '260', time: '13:43', dateIso: date }, { value: '260', time: '13:12', dateIso: date },
    ])
    expect(result.rows.every((r) => !r.reviewRequired && r.pointA)).toBe(true)
    expect(result.retryable).toBe(false)
    expect(result.raw).toMatchObject({ rowAlignment: { time: { basis: 'edge_anchored', sourceIndexes: [1, 2, 3] }, moneySecond: { sourceIndexes: [1, 2, 3] } }, timeAgreementCounts: [3, 3, 3], moneyAgreementCounts: [3, 3, 3], routesAligned: true })
    expect(JSON.stringify(full)).toBe(before)
  })

  it('recovers Younes’s four clocks from five-row time/route passes', async () => {
    const core = [row('140', '١:٥٨ م'), row('385', '١:٢٦ م'), row('270', '١٢:٤٣ م'), row('280', '١٢:١٤ م')]
    const full = [fragment(), ...core]
    const result = await read({ money: screen(core), second: screen(core), time: verifier(full), route: screen(full) })
    expect(result.rows.map((r) => r.time)).toEqual(['13:58', '13:26', '12:43', '12:14'])
    expect(result.rows.map((r) => r.value)).toEqual(['140', '385', '270', '280'])
    expect(result.raw).toMatchObject({ rowAlignment: { route: { sourceRowCount: 5, sourceIndexes: [1, 2, 3, 4] } }, timeDisagreementIndexes: [] })
  })

  it('handles partial fragments at both edges without sorting or modifying raw evidence', async () => {
    const core = [row('330', '٢:٣٣ م'), row('260', '١:٤٣ م')]
    const result = await read({ money: screen(core), time: verifier([fragment(), fragment(), ...core, fragment()]) })
    expect(result.rows.map((r) => r.time)).toEqual(['14:33', '13:43'])
    expect(result.raw).toMatchObject({ rowAlignment: { time: { sourceIndexes: [2, 3] } } })
  })

  it('preserves a canonical unread edge row and gives it no invented verification votes', async () => {
    const core = [row('330', '٢:٣٣ م'), row('260', '١:٤٣ م')]
    const result = await read({ money: screen([fragment({ printed: '?', pointB: null }), ...core]), time: verifier(core), route: screen(core) })
    expect(result.rows).toHaveLength(3)
    expect(result.rows[0]).toMatchObject({ value: null, time: null, reviewRequired: true, cancelled: false })
    expect(result.rows.slice(1).map((r) => r.time)).toEqual(['14:33', '13:43'])
    expect(result.raw).toMatchObject({ rowAlignment: { time: { sourceIndexes: [null, 0, 1] } }, cancellationAgreementCounts: [0, 3, 3] })
  })

  it.each([
    ['visible fee', row('100', '٣:٣٣ م')],
    ['negative fee', row('-100', '٣:٣٣ م')],
    ['cancelled card', fragment({ cancelled: true })],
    ['visible but refused fee', fragment({ printed: '٣٣٠', digitCount: 3 })],
    ['malformed clock', fragment({ time: 'unreadable-clock' })],
    ['full route', fragment({ pointA: 'Pickup', pointB: 'Destination' })],
  ])('refuses to trim an extra %s as if it were a blank fragment', async (_name, extra) => {
    const core = [row('330', '٢:٣٣ م'), row('260', '١:٤٣ م')]
    const result = await read({ money: screen(core), route: screen([extra as ParsedRow, ...core]) })
    expect(result.rows.map((r) => r.time)).toEqual([null, null])
    expect(result.rows.map((r) => r.value)).toEqual(['330', '260'])
    expect(result.raw).toMatchObject({ rowAlignment: { route: { basis: 'rejected' } } })
  })

  it('does not remove an interior unread row or align by matching amounts alone', async () => {
    const core = [row('260', '١:٤٣ م'), row('260', '١:١٢ م')]
    const result = await read({ money: screen(core), time: verifier([core[0]!, fragment(), core[1]!]) })
    expect(result.rows.every((r) => r.time === null)).toBe(true)
    const untimed = core.map((r) => ({ ...r, time: null }))
    const second = await read({ money: screen(untimed), time: verifier([fragment(), ...core]) })
    expect(second.rows.every((r) => r.time === null)).toBe(true)
  })

  it.each([
    ['date mismatch', { dateIso: '2026-10-11' }],
    ['AM/PM mismatch', { time: '٢:٣٣ ص' }],
    ['invented marker', { time: '14:33' }],
    ['invalid date', { dateIso: '2026-02-30' }],
  ])('requires unambiguous matching anchors: %s', async (_name, over) => {
    const base = row('330', '٢:٣٣ م', _name === 'invalid date' ? over : {})
    const result = await read({ money: screen([base]), time: verifier([fragment(), { ...base, ...over }]) })
    expect(result.rows[0]?.time).toBeNull()
    expect(result.raw).toMatchObject({ rowAlignment: { time: { basis: 'rejected' } } })
  })

  it('still requires an independent time reader, not the second money reader', async () => {
    const core = [row('330', '٢:٣٣ م')]
    const result = await read({ money: screen(core), second: screen([fragment(), ...core]) })
    expect(result.rows[0]).toMatchObject({ value: '330', time: null })
    expect(result.raw).toMatchObject({ timeAgreementCounts: [0], moneyAgreementCounts: [2] })
  })

  it('does not mask conflicting fees after a successful clock alignment', async () => {
    const core = [row('330', '٢:٣٣ م')]
    const result = await read({ money: screen(core), second: screen([fragment(), row('230', '٢:٣٣ م')]), time: verifier([fragment(), ...core]) })
    expect(result.rows[0]).toMatchObject({ value: null, time: '14:33', reviewRequired: true })
    expect(result.raw).toMatchObject({ moneyDisagreementIndexes: [0] })
  })
})
