import { describe, expect, it } from 'vitest'
import {
  type DraftOrder,
  allProblems,
  isComplete,
  mergeScannedMovements,
  mergeScannedOrders,
  nextPayMode,
  previewBr1,
  toApiPayloads,
  unsentOrders,
  validateRow,
} from '../src/order-entry.ts'

/**
 * The driver order-entry model. This is the screen the product is judged on, so its logic is
 * tested in isolation from any DOM.
 */

const row = (over: Partial<DraftOrder> = {}): DraftOrder => ({
  localId: Math.random().toString(36).slice(2),
  providerOrderNo: 'YAL-1',
  payMode: 'cash',
  feeText: '5000.00',
  ...over,
})

describe('row validation', () => {
  it('flags an empty order number', () => {
    const orders = [row({ providerOrderNo: '  ' })]
    expect(validateRow(orders, 0)).toEqual({ kind: 'empty_order_no' })
  })

  it('detects a duplicate as you type, pointing at the first occurrence', () => {
    // The single most common data-entry slip: the same Yallago number twice.
    const orders = [row({ providerOrderNo: 'YAL-7' }), row({ providerOrderNo: 'YAL-7' })]
    expect(validateRow(orders, 0)).toBeNull()
    expect(validateRow(orders, 1)).toEqual({ kind: 'duplicate_order_no', firstIndex: 0 })
  })

  it('rejects a non-numeric fee', () => {
    expect(validateRow([row({ feeText: 'abc' })], 0)).toEqual({ kind: 'bad_fee' })
  })

  it('rejects a negative fee', () => {
    expect(validateRow([row({ feeText: '-100' })], 0)).toEqual({ kind: 'negative_fee' })
  })

  it('accepts a clean row', () => {
    expect(validateRow([row()], 0)).toBeNull()
  })

  it('allProblems keys by localId and isComplete reflects it', () => {
    const orders = [row({ localId: 'a' }), row({ localId: 'b', providerOrderNo: '' })]
    const problems = allProblems(orders)
    expect(problems.has('b')).toBe(true)
    expect(problems.has('a')).toBe(false)
    expect(isComplete(orders)).toBe(false)
    expect(isComplete([row()])).toBe(true)
    expect(isComplete([])).toBe(false) // an empty shift is not "complete"
  })
})

describe('one-tap pay-mode cycling', () => {
  it('cycles cash → electronic → free → cash', () => {
    expect(nextPayMode('cash')).toBe('electronic')
    expect(nextPayMode('electronic')).toBe('free')
    expect(nextPayMode('free')).toBe('cash')
  })
})

describe('the live BR1 preview — the driver fixes his own mistakes', () => {
  const twentyOrders = (): DraftOrder[] => {
    const out: DraftOrder[] = []
    for (let i = 0; i < 12; i++) out.push(row({ localId: `c${i}`, providerOrderNo: `C${i}`, payMode: 'cash' }))
    for (let i = 0; i < 6; i++) out.push(row({ localId: `e${i}`, providerOrderNo: `E${i}`, payMode: 'electronic' }))
    for (let i = 0; i < 2; i++) out.push(row({ localId: `f${i}`, providerOrderNo: `F${i}`, payMode: 'free' }))
    return out
  }

  it('reproduces the §2.3 expectations before the driver even enters his figures', () => {
    const p = previewBr1({ floatText: '100000', topupText: '50000', orders: twentyOrders() })
    expect(p).not.toBeNull()
    expect(p!.expectedCashText).toBe('160000.00')
    expect(p!.expectedWalletText).toBe('70000.00')
    expect(p!.expectedTotalText).toBe('230000.00')
    expect(p!.blockText).toBe('80000.00')
    expect(p!.differenceText).toBeNull() // no declared figures yet
    expect(p!.balanced).toBeNull()
  })

  it('once he declares, it shows the difference and whether it balances', () => {
    const p = previewBr1({
      floatText: '100000',
      topupText: '50000',
      orders: twentyOrders(),
      declaredCashText: '160000',
      declaredWalletText: '70000',
    })
    expect(p!.differenceText).toBe('0.00')
    expect(p!.balanced).toBe(true)
  })

  it('a wrong declared figure shows immediately as a non-zero difference', () => {
    const p = previewBr1({
      floatText: '100000',
      topupText: '50000',
      orders: twentyOrders(),
      declaredCashText: '155000', // 5,000 short
      declaredWalletText: '70000',
    })
    expect(p!.balanced).toBe(false)
    expect(p!.differenceText).toBe('-5000.00')
  })

  it('ignores half-typed invalid rows rather than flickering to nonsense', () => {
    const orders = [row({ providerOrderNo: 'A', feeText: '5000' }), row({ providerOrderNo: '', feeText: '' })]
    const p = previewBr1({ floatText: '0', topupText: '0', orders })
    // Only the one valid cash order contributes: expected cash = 0 float + 5000.
    expect(p!.expectedCashText).toBe('5000.00')
  })

  it('returns null on an unparseable float rather than throwing', () => {
    expect(previewBr1({ floatText: 'xyz', topupText: '0', orders: [] })).toBeNull()
  })
})

describe('API payloads', () => {
  it('trims order numbers and carries the fee text verbatim', () => {
    const payloads = toApiPayloads([row({ providerOrderNo: '  YAL-9  ', feeText: '5000.00' })])
    expect(payloads[0]).toEqual({ providerOrderNo: 'YAL-9', payMode: 'cash', fee: '5000.00', zone: null })
  })
})

/**
 * Folding a screenshot into a list that already has rows.
 *
 * Both screens scroll, so each arrives as several OVERLAPPING images: page two re-shows the bottom
 * of page one. Appending blindly doubles every row in the overlap and leaves the driver to find and
 * uncheck each duplicate himself — on a phone, at the end of a shift.
 */
describe('merging a scanned page into the list', () => {
  let n = 0
  const id = (): string => `id-${++n}`
  const scan = (time: string, fee: string) => ({ dateIso: '2026-08-04', time, fee })

  it('adds each order once across two overlapping pages', () => {
    const pageOne = [scan('18:06', '235'), scan('17:42', '210'), scan('17:22', '130')]
    const first = mergeScannedOrders([], pageOne, id)
    expect(first).toHaveLength(3)

    // Page two re-shows the last two of page one and brings two genuinely new ones.
    const pageTwo = [scan('17:42', '210'), scan('17:22', '130'), scan('17:07', '135'), scan('16:50', '170')]
    const second = mergeScannedOrders(first, pageTwo, id)
    expect(second.map((o) => o.feeText)).toEqual(['135', '170'])
  })

  it('keeps a genuine second delivery in the same minute, under its own key', () => {
    // Same minute, DIFFERENT fee — two real orders. `YAL-<date>-<HHMM>` alone gives them the same
    // key, and since provider_order_no is globally unique the second one silently vanishes.
    const both = mergeScannedOrders([], [scan('18:06', '235'), scan('18:06', '120')], id)
    expect(both).toHaveLength(2)
    expect(new Set(both.map((o) => o.providerOrderNo)).size).toBe(2)
  })

  it('treats same minute AND same fee as the overlap, not a second delivery', () => {
    const first = mergeScannedOrders([], [scan('18:06', '235')], id)
    expect(mergeScannedOrders(first, [scan('18:06', '235')], id)).toEqual([])
  })

  it('keeps two deliveries that share a minute AND a fee — a multiset, not a set', () => {
    // One page listing «١٢٠» twice means two deliveries cost 120. The old key walked an ordinal to
    // separate them; the merge now counts, which is the same answer without a derived key.
    const page = [scan('18:06', '120'), scan('18:06', '120')]
    expect(mergeScannedOrders([], page, id)).toHaveLength(2)
    // …and a second page re-showing only ONE of them consumes one and adds nothing.
    const held = mergeScannedOrders([], page, id)
    expect(mergeScannedOrders(held, [scan('18:06', '120')], id)).toEqual([])
  })

  it('dedupes on the minute and the fee even when the clock could not be read', () => {
    // The live path while the reader still refuses some clocks. Every row has time ''; the fee is
    // then the only thing separating them, and the count is what keeps both 235s.
    const noClock = [
      { dateIso: null, time: '', fee: '235' },
      { dateIso: null, time: '', fee: '120' },
      { dateIso: null, time: '', fee: '235' },
    ]
    const added = mergeScannedOrders([], noClock, id)
    expect(added.map((o) => o.feeText)).toEqual(['235', '120', '235'])
    expect(mergeScannedOrders(added, noClock, id)).toEqual([])
  })

  /**
   * `shift_orders.provider_order_no` is UNIQUE over the WHOLE TABLE — not per shift, not per driver,
   * not per day. Every key that was ever derived from what the screen shows therefore collides
   * between drivers and between days, and the loser is a 409 nobody can see or clear.
   */
  it('never derives the wire key from anything two orders could share', () => {
    const day = [scan('18:06', '120')]
    // Two bikes, same minute, same fee, same day — the exact case ten of them make weekly.
    const bikeOne = mergeScannedOrders([], day, id)
    const bikeTwo = mergeScannedOrders([], day, id)
    expect(bikeOne[0]!.providerOrderNo).not.toBe(bikeTwo[0]!.providerOrderNo)

    // And with no clock at all, where the fee used to become the key outright.
    const noClock = [{ dateIso: null, time: '', fee: '120' }]
    expect(mergeScannedOrders([], noClock, id)[0]!.providerOrderNo).not.toBe(
      mergeScannedOrders([], noClock, id)[0]!.providerOrderNo,
    )
  })

  it('gives every row a key the wire will accept', () => {
    // NOT NULL, min(1), max(64) — and generated, so an empty one is a bug rather than a typo.
    const rows = mergeScannedOrders([], [scan('18:06', '235'), { dateIso: null, time: '', fee: '120' }], () =>
      crypto.randomUUID(),
    )
    for (const r of rows) {
      expect(r.providerOrderNo.trim().length).toBeGreaterThan(0)
      expect(r.providerOrderNo.length).toBeLessThanOrEqual(64)
    }
  })

  it('carries the OCR fee as the D-3 baseline and defaults the mode to cash', () => {
    // The dashboard screen carries no pay mode. Cash is the safe default because it is the mode
    // that expects the driver to be HOLDING the money — the easiest claim to check.
    const [row] = mergeScannedOrders([], [scan('18:06', '235')], id)
    expect(row!.payMode).toBe('cash')
    expect(row!.feeOcrText).toBe('235')
    expect(row!.timeText).toBe('18:06')
    expect(row!.included).toBe(true)
  })

  it('re-reading a log page adds nothing', () => {
    const page = [
      { amount: '-47', time: '18:06' },
      { amount: '153', time: '17:42' },
    ]
    const first = mergeScannedMovements([], page, id)
    expect(first).toHaveLength(2)
    expect(mergeScannedMovements(first, page, id)).toEqual([])
  })

  it('keeps two identical amounts in one minute — both are real', () => {
    // A multiset merge, mirroring the server's. Matching by value alone would discard the second
    // of two genuine −24 cuts.
    const both = mergeScannedMovements([], [{ amount: '-24', time: '13:10' }, { amount: '-24', time: '13:10' }], id)
    expect(both).toHaveLength(2)
    // …and a page re-showing only ONE of them consumes one, leaving nothing new.
    expect(mergeScannedMovements(both, [{ amount: '-24', time: '13:10' }], id)).toEqual([])
  })

  it('keeps the sign — a withdrawal is not a credit', () => {
    const [row] = mergeScannedMovements([], [{ amount: '-1155.65', time: '18:33' }], id)
    expect(row!.amountText).toBe('-1155.65')
  })
})

/**
 * What the list does with the checkbox and the measured wallet amount — the two things that decide
 * money on the driver's own screen, and which must agree with the server's arithmetic exactly.
 */
describe('the live preview of the operations list', () => {
  const base = { floatText: '0', topupText: '0' }

  it('degrades to EXACTLY today’s arithmetic when nothing is measured', () => {
    // The property to protect, because it is what production actually looks like until the glyph
    // reader lands: no movements, no wallet amounts, every row checked.
    const orders = [row({ providerOrderNo: 'A', feeText: '5000' }), row({ providerOrderNo: 'B', payMode: 'electronic', feeText: '5000' })]
    const p = previewBr1({ ...base, orders, movements: [] })!
    expect(p.expectedCashText).toBe('5000.00')
    // BR2 takes the 20% out of the WALLET for every mode alike, so the cash order costs the wallet
    // 1,000 while putting nothing in: −1,000 + (5,000 − 1,000) = 3,000.
    expect(p.expectedWalletText).toBe('3000.00')
    expect(previewBr1({ ...base, orders })).toEqual(p)
  })

  it('drops an unchecked row from the equation', () => {
    const orders = [row({ providerOrderNo: 'A', feeText: '5000' }), row({ providerOrderNo: 'B', feeText: '5000', included: false })]
    expect(previewBr1({ ...base, orders })!.expectedCashText).toBe('5000.00')
  })

  it('splits a part-paid order between hand and wallet', () => {
    const orders = [row({ providerOrderNo: 'A', feeText: '5000', walletAmountText: '2000' })]
    const p = previewBr1({ ...base, orders })!
    expect(p.expectedCashText).toBe('3000.00')
    expect(p.expectedWalletText).toBe('1000.00')
  })

  it('adds only the movements no order explains, and keeps their SIGN', () => {
    const orders = [row({ providerOrderNo: 'A', feeText: '5000' })]
    const movements = [
      { localId: '1', amountText: '-1000', timeText: '18:06', role: 'yalago_cut' as const },
      { localId: '2', amountText: '300', timeText: '09:24' },
      { localId: '3', amountText: '-50', timeText: '11:00' },
      { localId: '4', amountText: '900', timeText: '12:00', included: false },
    ]
    // The logged cut is corroboration and never a second deduction; the excluded row is data only.
    // 0 topup − 1,000 of Yallago's derived cut + 300 − 50 = −750.
    expect(previewBr1({ ...base, orders, movements })!.expectedWalletText).toBe('-750.00')
  })
})

/**
 * The driver can step back out of the closing package to add a delivery he forgot, so this list is
 * submitted more than once. Every row already on the server must be filtered out of the second
 * submit: `provider_order_no` is globally unique, and a 409 here shows up as "my orders failed" on
 * a list where nothing is wrong and no amount of retrying will clear it.
 */
describe('re-submitting the list after stepping back', () => {
  it('sends nothing when every row is already recorded', () => {
    const orders = [row({ providerOrderNo: 'YAL-1', recorded: true }), row({ providerOrderNo: 'YAL-2', recorded: true })]
    expect(unsentOrders(orders, orders)).toEqual([])
  })

  it('sends only the order added after coming back', () => {
    const sent = [row({ providerOrderNo: 'YAL-1', recorded: true })]
    const added = row({ providerOrderNo: 'YAL-2' })
    expect(unsentOrders([...sent, added], sent).map((o) => o.providerOrderNo)).toEqual(['YAL-2'])
  })

  it('still filters a row the server holds but that is not yet flagged', () => {
    // The window between the resumed list arriving and its rows being marked. The flag alone would
    // let these through, and every one of them would come back a 409.
    const onServer = [row({ providerOrderNo: 'YAL-1' })]
    expect(unsentOrders([row({ providerOrderNo: ' YAL-1 ' })], onServer)).toEqual([])
  })

  it('sends everything on a first submit, with nothing recorded yet', () => {
    const orders = [row({ providerOrderNo: 'YAL-1' }), row({ providerOrderNo: 'YAL-2' })]
    expect(unsentOrders(orders)).toHaveLength(2)
  })
})
