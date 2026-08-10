import { describe, expect, it } from 'vitest'
import {
  type DraftOrder,
  allProblems,
  mergeScannedOrders,
  submittableOrders,
  validateRow,
} from '../src/order-entry.ts'

/**
 * What happens to a row the reader would not price, and to a card the screen says was cancelled.
 *
 * Before this, a refused fee deleted its whole row. The driver saw «١ مرفوض» under the photo tile
 * and nothing else — no clock, no route, no way to know WHICH delivery was missing. On the owner's
 * own test the ٥:٤٢ order simply was not in the list. A row the reader cannot price is still a
 * delivery it can prove happened, so it now arrives with an empty fee to type into.
 */

let n = 0
const id = (): string => `id-${++n}`
const scan = (time: string, fee: string | null, extra: Record<string, unknown> = {}) => ({
  dateIso: '2026-08-04',
  time,
  fee,
  ...extra,
})

const rowOf = (over: Partial<DraftOrder> = {}): DraftOrder => ({
  localId: 'l1',
  providerOrderNo: 'YAL-l1',
  payMode: 'cash',
  feeText: '235',
  ...over,
})

describe('a refused fee arrives as an empty card, not as an absence', () => {
  it('carries the clock and route, with an empty fee and NO OCR baseline', () => {
    const [row] = mergeScannedOrders([], [scan('17:42', null, { pointA: 'عالم الدجاج', pointB: 'الجلاء' })], id)
    expect(row).toBeDefined()
    expect(row!.feeText).toBe('')
    expect(row!.timeText).toBe('17:42')
    expect(row!.pointA).toBe('عالم الدجاج')
    expect(row!.feeRefused).toBe(true)
    // The key must be ABSENT, not empty: `feeOcrText` is the baseline the manager's review compares
    // against, and its presence is what marks a row as OCR-sourced on the wire.
    expect('feeOcrText' in row!).toBe(false)
  })

  it('is CHECKED — it is a delivery the driver made, it just needs its number', () => {
    const [row] = mergeScannedOrders([], [scan('17:42', null)], id)
    expect(row!.included).toBe(true)
  })

  it('still dedups after the driver types the fee — the row is known by what the SCREEN said', () => {
    const first = mergeScannedOrders([], [scan('17:42', null, { pointA: 'أ' })], id)
    // The driver reads the screenshot and types it in.
    const typed = first.map((o) => ({ ...o, feeText: '210' }))
    // He photographs the overlapping next page, which re-shows the same delivery — still refused.
    expect(mergeScannedOrders(typed, [scan('17:42', null, { pointA: 'أ' })], id)).toEqual([])
  })

  it('a row whose fee WAS read still dedups after the driver corrects it', () => {
    // Pre-existing wrinkle the same key fixes: correcting a misread «١٦» to «١٦٥» used to make the
    // row unrecognisable, so the overlap added a duplicate.
    const first = mergeScannedOrders([], [scan('18:06', '16')], id)
    const corrected = first.map((o) => ({ ...o, feeText: '165' }))
    expect(mergeScannedOrders(corrected, [scan('18:06', '16')], id)).toEqual([])
  })

  it('a refused row and a priced row at the same minute are two different deliveries', () => {
    const rows = mergeScannedOrders([], [scan('18:06', '235'), scan('18:06', null)], id)
    expect(rows).toHaveLength(2)
  })
})

describe('an empty fee blocks the close, unless the row is unchecked', () => {
  it('reports empty_fee on a checked row with no number', () => {
    expect(validateRow([rowOf({ feeText: '', feeRefused: true })], 0)).toEqual({ kind: 'empty_fee' })
  })

  it('says nothing about an UNCHECKED row — unchecking is how the driver releases it', () => {
    expect(validateRow([rowOf({ feeText: '', feeRefused: true, included: false })], 0)).toBeNull()
  })

  it('is a real close blocker, so it reaches the «fix these rows» list', () => {
    const problems = allProblems([rowOf({ localId: 'a', providerOrderNo: 'YAL-a', feeText: '' })])
    expect(problems.size).toBe(1)
  })

  it('still catches a badly typed fee, and still allows a good one', () => {
    expect(validateRow([rowOf({ feeText: 'abc' })], 0)).toEqual({ kind: 'bad_fee' })
    expect(validateRow([rowOf({ feeText: '235' })], 0)).toBeNull()
  })
})

describe('the cancelled card', () => {
  const cancelled = () => scan('', null, { cancelled: true, pointA: 'ساحة الهدى', pointB: 'القابون' })

  it('arrives unchecked and priceless', () => {
    const [row] = mergeScannedOrders([], [cancelled()], id)
    expect(row!.cancelled).toBe(true)
    expect(row!.included).toBe(false)
    expect(row!.feeText).toBe('')
    expect('feeOcrText' in row!).toBe(false)
  })

  it('needs no fee while it stays unchecked', () => {
    const [row] = mergeScannedOrders([], [cancelled()], id)
    expect(validateRow([row!], 0)).toBeNull()
  })

  it('asks for a fee once the driver says he WAS paid for it', () => {
    const [row] = mergeScannedOrders([], [cancelled()], id)
    expect(validateRow([{ ...row!, included: true }], 0)).toEqual({ kind: 'empty_fee' })
  })

  it('dedups on its route across an overlapping page — it has no clock or fee to key on', () => {
    const first = mergeScannedOrders([], [cancelled()], id)
    expect(mergeScannedOrders(first, [cancelled()], id)).toEqual([])
  })
})

describe('what may go to the server', () => {
  it('drops an unchecked row with no price — it would 400 the whole request', () => {
    const rows = [
      rowOf({ localId: 'a', providerOrderNo: 'YAL-a', feeText: '235' }),
      rowOf({ localId: 'b', providerOrderNo: 'YAL-b', feeText: '', included: false, cancelled: true }),
      rowOf({ localId: 'c', providerOrderNo: 'YAL-c', feeText: '', included: false, feeRefused: true }),
    ]
    expect(submittableOrders(rows).map((o) => o.localId)).toEqual(['a'])
  })

  it('keeps an unchecked row that HAS a fee — «not this shift» is not «not a delivery»', () => {
    const rows = [rowOf({ localId: 'a', providerOrderNo: 'YAL-a', feeText: '235', included: false })]
    expect(submittableOrders(rows)).toHaveLength(1)
  })

  it('sends a cancelled card the driver was paid for, once he has priced it', () => {
    const rows = [rowOf({ localId: 'a', providerOrderNo: 'YAL-a', feeText: '100', included: true, cancelled: true })]
    expect(submittableOrders(rows)).toHaveLength(1)
    // No OCR baseline, so the wire calls it what it is: typed by a person.
    expect('feeOcrText' in rows[0]!).toBe(false)
  })
})
