import { describe, expect, it } from 'vitest'
import {
  type Posting,
  type ShiftPostingInput,
  closingBalances,
  floatCarry,
  floatReturnSplit,
  fundCode,
  postingsForApproval,
  postingsForOpen,
  receivableAdjustment,
  walletCarry,
} from '../../src/ledger/recipes.ts'
import { type Minor, minor } from '../../src/money/minor.ts'
import { splitBlock, totalFees } from '../../src/money/allocate.ts'
import type { ShiftOrder } from '../../src/br1/equation.ts'

/**
 * «الذمم» — cash a driver keeps overnight — and «حصة السائق» taken out of the cash in his hands.
 *
 * The invariant everything else rests on: however the closing cash is distributed, `driver_cash`
 * lands on EXACTLY ZERO. It is one credit of the whole balance against as many debits as the
 * distribution needs, which is why this is a widened `float_return` and not three new events.
 */

const syp = (whole: number): Minor => minor(BigInt(whole) * 100n)
const DRIVER = 'driver-1'

/** Net movement of one fund across a set of postings. DEBIT increases, CREDIT decreases. */
function balance(postings: readonly Posting[], code: string): bigint {
  let net = 0n
  for (const p of postings) {
    for (const l of p.lines) {
      if (fundCode(l.fund) !== code) continue
      net += l.side === 'D' ? l.amount : -l.amount
    }
  }
  return net
}

const order = (fee: number): ShiftOrder => ({ orderNo: `o-${fee}`, fee: syp(fee), payMode: 'cash' })

const shift = (over: Partial<ShiftPostingInput> = {}): ShiftPostingInput => ({
  driverId: DRIVER,
  floatTranches: [syp(100_000)],
  topupTranches: [syp(50_000)],
  orders: [order(5_000)],
  ...over,
})

describe('the closing cash, distributed three ways', () => {
  it('leaves driver_cash at EXACTLY zero however it is split', () => {
    const input = shift({ keptAsReceivable: syp(40_000), driverSharePaid: syp(2_000) })
    const postings = postingsForApproval(input, splitBlock(totalFees(input.orders.map((o) => o.fee)), 4_000))

    // The return posting credits the WHOLE closing balance — one credit, however many debits the
    // distribution needs. (Across all approval postings the fund also RISES by each cash fee, so
    // the return is the thing to look at, not the net.)
    const ret = postings.find((p) => p.eventType === 'float_return')!
    expect(balance([ret], `driver_cash:${DRIVER}`)).toBe(-closingBalances(input).endCash)

    // And over the shift's whole life — float out, fees in, everything returned — it is zero.
    const all = [...postingsForOpen(input), ...postings]
    expect(balance(all, `driver_cash:${DRIVER}`)).toBe(0n)
  })

  it('sends the remainder to the box, and only the remainder', () => {
    const endCash = syp(105_000)
    const p = floatReturnSplit(DRIVER, endCash, syp(40_000), syp(2_000))
    expect(balance([p], 'office_cash')).toBe(syp(63_000))
    expect(balance([p], `driver_receivable_cash:${DRIVER}`)).toBe(syp(40_000))
    expect(balance([p], `driver_share_payable:${DRIVER}`)).toBe(syp(2_000))
    expect(balance([p], `driver_cash:${DRIVER}`)).toBe(-endCash)
  })

  /** With nothing kept and nothing paid it must be the two-line posting it has always been. */
  it('is byte-identical to the old float_return when nothing is distributed', () => {
    const p = floatReturnSplit(DRIVER, syp(105_000), minor(0n), minor(0n))
    expect(p.lines).toHaveLength(2)
    expect(p.eventType).toBe('float_return')
    expect(p.occurrenceKey).toBe('1')
  })

  it('refuses to distribute more than the driver is holding', () => {
    expect(() => floatReturnSplit(DRIVER, syp(100), syp(80), syp(50))).toThrow(RangeError)
  })
})

/**
 * `driver_share_payable` was credited by `shareSplit` and debited by nothing — the company's debt
 * to its drivers could only ever grow. Owner decision (f) settles it the same night.
 */
describe('حصة السائق finally settles', () => {
  it('nets the liability to zero when the share is paid out of tonight`s cash', () => {
    const orders = [order(5_000)]
    const totals = totalFees(orders.map((o) => o.fee))
    const split = splitBlock(totals, 4_000) // 40% of gross — the owner's own band
    const input = shift({ orders, driverSharePaid: split.driverShare })
    const postings = postingsForApproval(input, split)
    expect(balance(postings, `driver_share_payable:${DRIVER}`)).toBe(0n)
  })

  it('leaves the liability standing when the share is NOT paid tonight', () => {
    const orders = [order(5_000)]
    const totals = totalFees(orders.map((o) => o.fee))
    const split = splitBlock(totals, 4_000)
    const postings = postingsForApproval(shift({ orders }), split)
    // Credited by shareSplit, debited by nothing: the company still owes him.
    expect(balance(postings, `driver_share_payable:${DRIVER}`)).toBe(-split.driverShare)
  })
})

describe('shift-funding receivables carried into the next shift', () => {
  it('raises his cash without the branch box paying twice', () => {
    const p = floatCarry(DRIVER, syp(40_000))
    expect(balance([p], `driver_cash:${DRIVER}`)).toBe(syp(40_000))
    expect(balance([p], `driver_shift_funding_cash:${DRIVER}`)).toBe(-syp(40_000))
    expect(balance([p], `driver_receivable_cash:${DRIVER}`)).toBe(0n)
    expect(balance([p], 'office_cash')).toBe(0n) // the box already paid, yesterday
  })

  it('raises his wallet from wallet funding without touching an ordinary wallet debt', () => {
    const p = walletCarry(DRIVER, syp(25_000))
    expect(balance([p], `driver_wallet:${DRIVER}`)).toBe(syp(25_000))
    expect(balance([p], `driver_shift_funding_wallet:${DRIVER}`)).toBe(-syp(25_000))
    expect(balance([p], `driver_receivable_wallet:${DRIVER}`)).toBe(0n)
    expect(balance([p], 'office_wallet')).toBe(0n)
  })

  it('counts as closing cash, exactly like a float tranche', () => {
    const withCarry = closingBalances(shift({ carriedTranches: [syp(40_000)] }))
    const without = closingBalances(shift())
    expect(withCarry.endCash - without.endCash).toBe(syp(40_000))
  })

  /** Namespaced so a carry and a second cash tranche cannot collide on the idempotency key. */
  it('uses a key that cannot collide with an ordinary tranche', () => {
    expect(floatCarry(DRIVER, syp(1), 1).occurrenceKey).toBe('carry-1')
    expect(floatCarry(DRIVER, syp(1), 2).occurrenceKey).toBe('carry-2')
  })
})

/**
 * THE ROUND TRIP — the property that makes this safe to run every night for a year.
 *
 * Advance shift funding, consume it at open, then return it at close. Every fund must return to
 * where it started. Ordinary receivables are deliberately excluded from this automatic cycle.
 */
describe('create shift funding, open with it, close flat', () => {
  it('returns cash funding to zero and leaves nothing stranded', () => {
    const amount = syp(40_000)
    const all = [
      receivableAdjustment(DRIVER, 'shift_funding', 'cash', 'create', amount, 'cash-advance'),
      floatCarry(DRIVER, amount),
      floatReturnSplit(DRIVER, amount, minor(0n), minor(0n)),
    ]
    expect(balance(all, `driver_shift_funding_cash:${DRIVER}`)).toBe(0n)
    expect(balance(all, `driver_receivable_cash:${DRIVER}`)).toBe(0n)
    expect(balance(all, `driver_cash:${DRIVER}`)).toBe(0n)
    expect(balance(all, 'office_cash')).toBe(0n)
  })

  it('does not auto-consume an ordinary receivable', () => {
    const amount = syp(40_000)
    const ordinary = receivableAdjustment(DRIVER, 'ordinary', 'cash', 'create', amount, 'ordinary-debt')
    const open = floatCarry(DRIVER, amount)
    expect(balance([ordinary, open], `driver_receivable_cash:${DRIVER}`)).toBe(amount)
    expect(balance([ordinary, open], `driver_shift_funding_cash:${DRIVER}`)).toBe(-amount)
  })
})
