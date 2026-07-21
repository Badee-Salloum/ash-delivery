import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Minor, minor, sum } from '../../src/money/minor.ts'
import { splitBlock, totalFees } from '../../src/money/allocate.ts'
import { type PayMode, type ShiftOrder, evaluateBr1 } from '../../src/br1/equation.ts'
import { DEFAULT_BANDS, bpsForCount } from '../../src/tier/rules.ts'
import {
  type Posting,
  UnbalancedPostingError,
  assertBalanced,
  balanceOf,
  creditsOf,
  debitsOf,
  isFund,
  closingBalances,
  minWalletBalance,
  postingsForApproval,
  postingsForOpen,
  reverse,
} from '../../src/ledger/recipes.ts'

const syp = (n: number) => minor(BigInt(n) * 100n)
const DRIVER = 'driver-1'

function orders(cash: number, electronic: number, free: number, fee: Minor): ShiftOrder[] {
  const out: ShiftOrder[] = []
  let n = 1
  for (let i = 0; i < cash; i++) out.push({ orderNo: `C${n++}`, payMode: 'cash', fee })
  for (let i = 0; i < electronic; i++) out.push({ orderNo: `E${n++}`, payMode: 'electronic', fee })
  for (let i = 0; i < free; i++) out.push({ orderNo: `F${n++}`, payMode: 'free', fee })
  return out
}

describe('SRS §2.3 walked through the ledger (AC #3, #4, #5)', () => {
  const input = {
    driverId: DRIVER,
    floatTranches: [syp(100_000)],
    topupTranches: [syp(50_000)],
    orders: orders(12, 6, 2, syp(5_000)),
  }

  const totals = totalFees(input.orders.map((o) => o.fee))
  const split = splitBlock(totals, bpsForCount(DEFAULT_BANDS, input.orders.length))
  const open = postingsForOpen(input)
  const approval = postingsForApproval(input, split)
  const all = [...open, ...approval]

  it('every posting balances individually (AC #5)', () => {
    for (const p of all) {
      expect(debitsOf(p), `${p.eventType}/${p.occurrenceKey}`).toBe(creditsOf(p))
    }
  })

  it('Σ debits === Σ credits across the whole shift (AC #5)', () => {
    expect(sum(all.map(debitsOf))).toBe(sum(all.map(creditsOf)))
  })

  it('the driver holds 160,000 cash and 70,000 wallet before the returns', () => {
    const beforeReturns = [...open, ...approval.filter((p) => !p.eventType.endsWith('_return'))]
    expect(balanceOf(beforeReturns, isFund('driver_cash'))).toBe(syp(160_000))
    expect(balanceOf(beforeReturns, isFund('driver_wallet'))).toBe(syp(70_000))
  })

  it('agrees exactly with the BR1 engine — the ledger and the equation cannot drift', () => {
    const beforeReturns = [...open, ...approval.filter((p) => !p.eventType.endsWith('_return'))]
    const br1 = evaluateBr1({
      floatTotal: syp(100_000),
      topupTotal: syp(50_000),
      endCashDeclared: syp(160_000),
      endWalletDeclared: syp(70_000),
      orders: input.orders,
    })
    expect(balanceOf(beforeReturns, isFund('driver_cash'))).toBe(br1.expectedCash)
    expect(balanceOf(beforeReturns, isFund('driver_wallet'))).toBe(br1.expectedWallet)
    expect(br1.scalarDiff).toBe(0n)
  })

  it('splits into Yallago 20,000 / driver 40,000 / company 40,000 (AC #7)', () => {
    expect(balanceOf(all, isFund('yalago_income'))).toBe(-syp(20_000)) // credit
    expect(balanceOf(all, isFund('driver_share_payable'))).toBe(-syp(40_000))
    expect(balanceOf(all, isFund('company_revenue'))).toBe(-syp(40_000))
  })

  it('yalago_share accumulates the 20,000 actually taken out of the wallet (BR2)', () => {
    expect(balanceOf(all, isFund('yalago_share'))).toBe(syp(20_000))
  })

  it('closes fee_earned to exactly zero — no revenue left unallocated', () => {
    expect(balanceOf(all, isFund('fee_earned'))).toBe(0n)
  })

  it('leaves both driver funds at zero after the daily returns (decision D-4)', () => {
    expect(balanceOf(all, isFund('driver_cash'))).toBe(0n)
    expect(balanceOf(all, isFund('driver_wallet'))).toBe(0n)
  })

  it('posts the SRS event types and nothing else', () => {
    expect([...new Set(all.map((p) => p.eventType))].sort()).toEqual([
      'float_out',
      'float_return',
      'order_fee',
      'share_split',
      'wallet_return',
      'wallet_topup',
      'yalago_cut',
    ])
  })
})

describe('multi-tranche float (SRS C-5)', () => {
  it('each tranche posts under its own occurrence key', () => {
    const open = postingsForOpen({
      driverId: DRIVER,
      floatTranches: [syp(60_000), syp(40_000)],
      topupTranches: [syp(50_000)],
      orders: [],
    })
    const floats = open.filter((p) => p.eventType === 'float_out')
    expect(floats.map((p) => p.occurrenceKey)).toEqual(['1', '2'])
    expect(balanceOf(open, isFund('driver_cash'))).toBe(syp(100_000))
  })

  it('the (event, occurrenceKey) pairs are unique — the DB index will accept them', () => {
    const open = postingsForOpen({
      driverId: DRIVER,
      floatTranches: [syp(10_000), syp(20_000), syp(30_000)],
      topupTranches: [syp(5_000), syp(5_000)],
      orders: [],
    })
    const keys = open.map((p) => `${p.eventType}:${p.occurrenceKey}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('the negative wallet — found by a property test, not by inspection', () => {
  /**
   * Every cash order takes 20% of its fee OUT of the wallet (BR2) while putting nothing in. A
   * driver working cash orders on a thin top-up therefore drives the wallet below zero. This is
   * ordinary operation, not an edge case — and BR1 still evaluates to exactly zero throughout,
   * so the zero equation alone cannot detect it.
   */
  const thinTopup = {
    driverId: DRIVER,
    floatTranches: [syp(100_000)],
    topupTranches: [syp(1_000)],
    orders: orders(20, 0, 0, syp(5_000)),
  }

  it('is reachable: 20 cash orders at 5,000 want 20,000 from a 1,000 wallet', () => {
    expect(minWalletBalance(thinTopup)).toBe(-syp(19_000))
    expect(closingBalances(thinTopup).endWallet).toBe(-syp(19_000))
  })

  it('BR1 STILL BALANCES while it happens — which is why a separate check is needed', () => {
    const { endCash, endWallet } = closingBalances(thinTopup)
    const br1 = evaluateBr1({
      floatTotal: syp(100_000),
      topupTotal: syp(1_000),
      endCashDeclared: endCash,
      endWalletDeclared: endWallet,
      orders: thinTopup.orders,
    })
    expect(br1.scalarDiff).toBe(0n)
    expect(br1.splitBalanced).toBe(true)
  })

  it('the return posting runs the other way, so the driver fund still lands on zero', () => {
    const totals = totalFees(thinTopup.orders.map((o) => o.fee))
    const split = splitBlock(totals, bpsForCount(DEFAULT_BANDS, thinTopup.orders.length))
    const all = [...postingsForOpen(thinTopup), ...postingsForApproval(thinTopup, split)]

    for (const p of all) expect(debitsOf(p)).toBe(creditsOf(p))
    expect(balanceOf(all, isFund('driver_wallet'))).toBe(0n)
    // The office covered the shortfall rather than the money vanishing: it funded the 1,000
    // top-up AND the 19,000 Yallago took beyond it. Negative because balanceOf counts a credit
    // as an outflow — 20,000 left the office wallet in total.
    expect(balanceOf(all, isFund('office_wallet'))).toBe(-syp(20_000))
  })

  it('a healthy shift never dips below zero', () => {
    expect(
      minWalletBalance({
        driverId: DRIVER,
        floatTranches: [syp(100_000)],
        topupTranches: [syp(50_000)],
        orders: orders(12, 6, 2, syp(5_000)),
      }),
    ).toBeGreaterThan(0n)
  })
})

describe('assertBalanced', () => {
  it('rejects an unbalanced posting', () => {
    const bad: Posting = {
      eventType: 'manual',
      occurrenceKey: '1',
      lines: [
        { fund: { kind: 'office_cash' }, side: 'D', amount: syp(100) },
        { fund: { kind: 'office_wallet' }, side: 'C', amount: syp(90) },
      ],
    }
    expect(() => assertBalanced(bad)).toThrow(UnbalancedPostingError)
  })

  it('rejects a non-positive line — direction is carried by side, never by a sign', () => {
    const bad: Posting = {
      eventType: 'manual',
      occurrenceKey: '1',
      lines: [
        { fund: { kind: 'office_cash' }, side: 'D', amount: minor(-100n) },
        { fund: { kind: 'office_wallet' }, side: 'C', amount: minor(-100n) },
      ],
    }
    expect(() => assertBalanced(bad)).toThrow(RangeError)
  })

  it('rejects an empty posting', () => {
    expect(() => assertBalanced({ eventType: 'manual', occurrenceKey: '1', lines: [] })).toThrow(
      UnbalancedPostingError,
    )
  })
})

describe('corrections (BR7)', () => {
  it('a reversal is the mirror of the original and nets it to zero', () => {
    const original = postingsForOpen({
      driverId: DRIVER,
      floatTranches: [syp(100_000)],
      topupTranches: [],
      orders: [],
    })[0]!
    const rev = reverse(original, 'corr-1')

    expect(rev.eventType).toBe('correction')
    expect(debitsOf(rev)).toBe(creditsOf(rev))
    expect(balanceOf([original, rev], isFund('driver_cash'))).toBe(0n)
    expect(balanceOf([original, rev], isFund('office_cash'))).toBe(0n)
  })

  it('repeated corrections stay possible — occurrence keys differ', () => {
    const original = postingsForOpen({
      driverId: DRIVER,
      floatTranches: [syp(1_000)],
      topupTranches: [],
      orders: [],
    })[0]!
    expect(reverse(original, 'corr-1').occurrenceKey).not.toBe(reverse(original, 'corr-2').occurrenceKey)
  })
})

describe('property: every posting balances under random event streams (brief §5a, AC #5)', () => {
  const payMode = fc.constantFrom<PayMode>('cash', 'electronic', 'free')
  // Fees deliberately not divisible by 5, so the 20% cut does not divide evenly.
  const fee = fc.integer({ min: 1, max: 2_000_000 }).map((n) => minor(BigInt(n)))
  const orderArb = fc.record({ orderNo: fc.uuid(), payMode, fee })
  const tranche = fc.integer({ min: 1, max: 50_000_000 }).map((n) => minor(BigInt(n)))

  it('holds for any mix of modes, fees and tranche counts', () => {
    fc.assert(
      fc.property(
        fc.array(tranche, { minLength: 0, maxLength: 4 }),
        fc.array(tranche, { minLength: 0, maxLength: 4 }),
        fc.array(orderArb, { minLength: 0, maxLength: 40 }),
        (floatTranches, topupTranches, rawOrders) => {
          // Order numbers must be unique — they are the idempotency key.
          const seen = new Set<string>()
          const orderList = rawOrders.filter((o) => !seen.has(o.orderNo) && seen.add(o.orderNo))

          const input = { driverId: DRIVER, floatTranches, topupTranches, orders: orderList }
          const totals = totalFees(orderList.map((o) => o.fee))
          const split = splitBlock(totals, bpsForCount(DEFAULT_BANDS, orderList.length))
          const all = [...postingsForOpen(input), ...postingsForApproval(input, split)]

          for (const p of all) expect(debitsOf(p)).toBe(creditsOf(p))
          expect(sum(all.map(debitsOf))).toBe(sum(all.map(creditsOf)))

          // Revenue is fully allocated, and no driver fund is left holding anything.
          expect(balanceOf(all, isFund('fee_earned'))).toBe(0n)
          expect(balanceOf(all, isFund('driver_cash'))).toBe(0n)
          expect(balanceOf(all, isFund('driver_wallet'))).toBe(0n)
        },
      ),
      { numRuns: 400 },
    )
  })

  it('the ledger’s driver balances always equal what BR1 expects', () => {
    fc.assert(
      fc.property(
        fc.array(tranche, { minLength: 0, maxLength: 3 }),
        fc.array(tranche, { minLength: 0, maxLength: 3 }),
        fc.array(orderArb, { minLength: 0, maxLength: 30 }),
        (floatTranches, topupTranches, rawOrders) => {
          const seen = new Set<string>()
          const orderList = rawOrders.filter((o) => !seen.has(o.orderNo) && seen.add(o.orderNo))

          const input = { driverId: DRIVER, floatTranches, topupTranches, orders: orderList }
          const totals = totalFees(orderList.map((o) => o.fee))
          const split = splitBlock(totals, bpsForCount(DEFAULT_BANDS, orderList.length))
          const beforeReturns = [
            ...postingsForOpen(input),
            ...postingsForApproval(input, split).filter((p) => !p.eventType.endsWith('_return')),
          ]

          const br1 = evaluateBr1({
            floatTotal: sum(floatTranches),
            topupTotal: sum(topupTranches),
            endCashDeclared: minor(0n),
            endWalletDeclared: minor(0n),
            orders: orderList,
          })

          expect(balanceOf(beforeReturns, isFund('driver_cash'))).toBe(br1.expectedCash)
          expect(balanceOf(beforeReturns, isFund('driver_wallet'))).toBe(br1.expectedWallet)
        },
      ),
      { numRuns: 400 },
    )
  })
})
