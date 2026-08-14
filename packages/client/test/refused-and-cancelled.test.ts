import { describe, expect, it } from 'vitest'
import {
  type DraftOrder,
  allProblems,
  feeSourceOf,
  frequentFees,
  healCutOffRoutes,
  mergeScannedOrders,
  previewBr1,
  submittableOrders,
  validateRow,
  workedTotalText,
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
  it('keeps a server-excluded priced row in the payload while the read-only preview excludes it', () => {
    const rows = [rowOf({ localId: 'a', providerOrderNo: 'YAL-a', feeText: '235', included: false, recorded: true })]
    expect(submittableOrders(rows)).toEqual(rows)
    expect(previewBr1({ floatText: '0', topupText: '0', orders: rows })?.expectedCashText).toBe('0.00')
    expect(workedTotalText(rows)).toBe('0.00')
  })

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

/**
 * BR1 AS A CHECK ON THE READER — the owner's insight, and the one the pipeline was missing.
 *
 * Every other stage of reading a screenshot is a guess nothing contradicts. The money is not: of a
 * delivery's fee the driver keeps 80% between his cash and his wallet, so if a fee is misread the
 * shift stops balancing by 80% of the error. Dividing back out names the amount to go and look for.
 */
describe('the equation catches a misread fee', () => {
  const scanned = (localId: string, fee: string): DraftOrder => ({
    localId,
    providerOrderNo: `YAL-${localId}`,
    payMode: 'cash',
    feeText: fee,
    feeOcrText: fee,
    included: true,
  })

  it('THE «1105» INCIDENT: names the fee to look for, and blames the scanned rows', () => {
    // Ten deliveries, one of which the reader turned from 235 into 1105 — the real failure.
    const right = ['235', '210', '130', '135', '170', '260', '120', '235', '120', '135']
    const wrong = right.map((f, i) => (i === 0 ? '1105' : f))
    const orders = wrong.map((f, i) => scanned(`o${i}`, f))
    // The driver hands over what he ACTUALLY has: float + 80% of the TRUE fees.
    const trueFees = right.reduce((n, f) => n + Number(f), 0)
    const cash = String(3000 + trueFees * 0.8)

    const p = previewBr1({
      floatText: '3000',
      topupText: '0',
      orders,
      declaredCashText: cash,
      declaredWalletText: '0',
    })!
    expect(p.balanced).toBe(false)
    // 1105 − 235 = 870 too much fee. The equation is off by 80% of it; dividing back out says 870.
    expect(p.feeGapText).toBe('870.00')
    // And it points at the rows a machine read, not the ones a person typed.
    expect(p.suspectLocalIds).toHaveLength(10)
  })

  it('says nothing when the shift balances — a correct read raises no alarm', () => {
    const fees = ['235', '210', '130']
    const orders = fees.map((f, i) => scanned(`o${i}`, f))
    const cash = String(1000 + fees.reduce((n, f) => n + Number(f), 0) * 0.8)
    const p = previewBr1({ floatText: '1000', topupText: '0', orders, declaredCashText: cash, declaredWalletText: '0' })!
    expect(p.balanced).toBe(true)
    expect(p.feeGapText).toBeNull()
    expect(p.suspectLocalIds).toEqual([])
  })

  it('a MISSING order reads as a fee gap too — the same arithmetic finds both', () => {
    // Three delivered, only two scanned: the shift is over by 80% of the missing fee.
    const p = previewBr1({
      floatText: '1000',
      topupText: '0',
      orders: [scanned('a', '200'), scanned('b', '300')],
      declaredCashText: String(1000 + (200 + 300 + 150) * 0.8),
      declaredWalletText: '0',
    })!
    expect(p.balanced).toBe(false)
    expect(p.feeGapText).toBe('150.00')
  })

  it('does not blame the reader for a row the driver typed himself', () => {
    const typed: DraftOrder = { localId: 'typed', providerOrderNo: 'YAL-typed', payMode: 'cash', feeText: '200', included: true }
    const p = previewBr1({
      floatText: '0',
      topupText: '0',
      orders: [typed],
      declaredCashText: '999',
      declaredWalletText: '0',
    })!
    expect(p.balanced).toBe(false)
    expect(p.suspectLocalIds).toEqual([])
  })
})

/**
 * The card the screen sliced in half, healed by the page that shows it whole.
 *
 * Screenshots overlap, so a delivery cut off at the bottom of one page is usually complete at the
 * top of the next. Its fee and clock were right all along — those sit on the fully-drawn price row
 * — but its route was withheld, and the second sighting was then de-duplicated away and its
 * addresses thrown out with it.
 */
describe('a cut-off card heals on the next page', () => {
  const cut = (): DraftOrder => ({
    localId: 'c1',
    providerOrderNo: 'YAL-c1',
    payMode: 'cash',
    feeText: '170',
    feeOcrText: '170',
    timeText: '16:50',
    dateText: '2026-08-04',
    included: true,
    pointA: null,
    pointB: null,
  })
  const whole = { dateIso: '2026-08-04', time: '16:50', fee: '170', pointA: 'Abou Roummaneh', pointB: 'Al Beirouni Street' }

  it('fills in the route the sliced page could not read', () => {
    expect(healCutOffRoutes([cut()], [whole])).toEqual([
      { localId: 'c1', pointA: 'Abou Roummaneh', pointB: 'Al Beirouni Street' },
    ])
  })

  it('still adds nothing — the delivery is the same one, not a second', () => {
    expect(mergeScannedOrders([cut()], [whole], id)).toEqual([])
  })

  it('NEVER overwrites a route the row already has', () => {
    const has = { ...cut(), pointA: 'مأكولات الشام', pointB: 'الحارة الجديدة' }
    expect(healCutOffRoutes([has], [whole])).toEqual([])
  })

  it('never touches the FEE — a route is not money', () => {
    const patches = healCutOffRoutes([cut()], [{ ...whole, fee: '170' }])
    expect(patches[0]).not.toHaveProperty('feeText')
    expect(Object.keys(patches[0]!).sort()).toEqual(['localId', 'pointA', 'pointB'])
  })

  it('heals one row per sighting, so a page listing it twice cannot write over two rows', () => {
    const two = [cut(), { ...cut(), localId: 'c2', providerOrderNo: 'YAL-c2' }]
    expect(healCutOffRoutes(two, [whole])).toHaveLength(1)
    expect(healCutOffRoutes(two, [whole, whole])).toHaveLength(2)
  })

  it('does not heal a DIFFERENT delivery that happens to have no route', () => {
    const other = { ...cut(), timeText: '13:10', feeOcrText: '120', feeText: '120' }
    expect(healCutOffRoutes([other], [whole])).toEqual([])
  })
})

describe('the fees already on this shift, offered as taps', () => {
  const row = (fee: string, over: Partial<DraftOrder> = {}): DraftOrder => ({
    localId: `f${fee}${Math.random()}`,
    providerOrderNo: 'YAL-x',
    payMode: 'cash',
    feeText: fee,
    ...over,
  })

  it('puts the most-used fee first', () => {
    expect(frequentFees([row('130'), row('235'), row('130'), row('130'), row('235')])).toEqual(['130', '235'])
  })

  it('breaks a tie toward the LARGER fee — understating is what costs the driver money', () => {
    expect(frequentFees([row('120'), row('235')])).toEqual(['235', '120'])
  })

  it('ignores empty, zero and cancelled rows — none of them is a fee anyone charged', () => {
    expect(frequentFees([row(''), row('0'), row('200', { cancelled: true }), row('170')])).toEqual(['170'])
  })

  it('ignores a half-typed fee rather than offering nonsense back', () => {
    expect(frequentFees([row('abc'), row('170')])).toEqual(['170'])
  })

  it('offers nothing on an empty shift', () => {
    expect(frequentFees([])).toEqual([])
  })
})

/**
 * The two things the compact screen is built on: what he worked, and where each number came from.
 */
describe('what the driver worked', () => {
  const row = (fee: string, over: Partial<DraftOrder> = {}): DraftOrder => ({
    localId: `w${fee}${Math.random()}`,
    providerOrderNo: 'YAL-w',
    payMode: 'cash',
    feeText: fee,
    ...over,
  })

  it('adds up the fees he is claiming', () => {
    expect(workedTotalText([row('235'), row('210'), row('130')])).toBe('575.00')
  })

  it('leaves out a row he unchecked — that is what unchecking means', () => {
    expect(workedTotalText([row('235'), row('210', { included: false })])).toBe('235.00')
  })

  it('ignores a half-typed fee instead of throwing — this is a live display', () => {
    expect(workedTotalText([row('235'), row('abc'), row('')])).toBe('235.00')
  })

  it('is zero on an empty shift', () => {
    expect(workedTotalText([])).toBe('0.00')
  })

  it('matches the term BR1 multiplies by 0.80', () => {
    // Ten real deliveries from the Aug-4 screenshots.
    const fees = ['235', '210', '130', '135', '170', '260', '120', '235', '120', '135']
    expect(workedTotalText(fees.map((f) => row(f)))).toBe('1750.00')
  })
})

describe('where a fee came from', () => {
  const base = { localId: 'x', providerOrderNo: 'YAL-x', payMode: 'cash' as const }

  it('«read» when the reader produced it', () => {
    expect(feeSourceOf({ ...base, feeText: '235', feeOcrText: '235' })).toBe('read')
  })

  it('«refused» when the reader saw the row and declined — he typed over its admission', () => {
    expect(feeSourceOf({ ...base, feeText: '210', feeRefused: true })).toBe('refused')
  })

  it('«typed» when there was no screenshot behind it at all', () => {
    expect(feeSourceOf({ ...base, feeText: '130' })).toBe('typed')
  })

  it('stays «read» after the driver corrects it — the baseline is what he corrected', () => {
    // The correction is the point: the pair (what it read, what he says) is the training label.
    expect(feeSourceOf({ ...base, feeText: '235', feeOcrText: '1105' })).toBe('read')
  })
})
