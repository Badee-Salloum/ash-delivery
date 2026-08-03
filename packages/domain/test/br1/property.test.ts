import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Minor, add, minor, sum } from '../../src/money/minor.ts'
import { orderBlock, totalFees, yalagoCut } from '../../src/money/allocate.ts'
import { type PayMode, type ShiftOrder, evaluateBr1 } from '../../src/br1/equation.ts'

const payMode = fc.constantFrom<PayMode>('cash', 'electronic', 'free')
// Fees that are NOT round: 20% of these does not divide evenly.
const fee = fc.integer({ min: 1, max: 2_000_000 }).map((n) => minor(BigInt(n)))

const order = fc.record({ orderNo: fc.string({ minLength: 1, maxLength: 12 }), payMode, fee })
const orderList = fc.array(order, { minLength: 0, maxLength: 80 })

const tranche = fc.integer({ min: 0, max: 50_000_000 }).map((n) => minor(BigInt(n)))
/** SRS C-5 — more than one float / top-up tranche within a day. */
const tranches = fc.array(tranche, { minLength: 0, maxLength: 6 }).map((ts) => sum(ts))

/** The truthful end state a driver would physically hold, given the gates and the orders. */
function truthfulClose(floatTotal: Minor, topupTotal: Minor, orders: readonly ShiftOrder[]) {
  let cash = floatTotal
  let wallet = topupTotal
  for (const o of orders) {
    if (o.payMode === 'cash') {
      cash = add(cash, o.fee)
      wallet = minor(wallet - yalagoCut(o.fee))
    } else {
      wallet = add(wallet, orderBlock(o.fee))
    }
  }
  return { endCashDeclared: cash, endWalletDeclared: wallet }
}

describe('BR1 — property tests', () => {
  it('closes at exactly zero for any mix of the three modes, any fees, any tranche count', () => {
    fc.assert(
      fc.property(tranches, tranches, orderList, (floatTotal, topupTotal, orders) => {
        const close = truthfulClose(floatTotal, topupTotal, orders)
        const r = evaluateBr1({ floatTotal, topupTotal, ...close, orders })

        expect(r.scalarDiff).toBe(0n)
        expect(r.cashDiff).toBe(0n)
        expect(r.walletDiff).toBe(0n)
        expect(r.balanced).toBe(true)
        expect(r.splitBalanced).toBe(true)
      }),
      { numRuns: 500 },
    )
  })

  it('the expected total always equals float + topup + the RESIDUAL block', () => {
    fc.assert(
      fc.property(tranches, tranches, orderList, (floatTotal, topupTotal, orders) => {
        const r = evaluateBr1({
          floatTotal,
          topupTotal,
          endCashDeclared: minor(0n),
          endWalletDeclared: minor(0n),
          orders,
        })
        const t = totalFees(orders.map((o) => o.fee))
        expect(r.expectedTotal).toBe(floatTotal + topupTotal + t.blockTotal)
      }),
    )
  })

  it('flipping any order cash↔electronic keeps scalarDiff at zero and moves the split by ±fee', () => {
    fc.assert(
      fc.property(
        tranches,
        tranches,
        fc.array(order, { minLength: 1, maxLength: 40 }),
        fc.nat(),
        (floatTotal, topupTotal, orders, pick) => {
          const i = pick % orders.length
          const target = orders[i]
          if (!target) return

          const close = truthfulClose(floatTotal, topupTotal, orders)
          const flippedMode: PayMode = target.payMode === 'cash' ? 'electronic' : 'cash'
          const flipped = orders.map((o, j) => (j === i ? { ...o, payMode: flippedMode } : o))

          const r = evaluateBr1({ floatTotal, topupTotal, ...close, orders: flipped })

          // The scalar equation is blind to this. Always.
          expect(r.scalarDiff).toBe(0n)

          const direction = target.payMode === 'cash' ? 1n : -1n
          expect(r.cashDiff).toBe(direction * target.fee)
          expect(r.walletDiff).toBe(-direction * target.fee)
          expect(r.splitBalanced).toBe(target.fee === 0n)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('dropping one order from the record moves scalarDiff by exactly that order’s block', () => {
    fc.assert(
      fc.property(
        tranches,
        tranches,
        fc.array(order, { minLength: 1, maxLength: 40 }),
        fc.nat(),
        (floatTotal, topupTotal, orders, pick) => {
          const i = pick % orders.length
          const dropped = orders[i]
          if (!dropped) return

          const close = truthfulClose(floatTotal, topupTotal, orders)
          const recorded = orders.filter((_, j) => j !== i)
          const r = evaluateBr1({ floatTotal, topupTotal, ...close, orders: recorded })

          expect(r.scalarDiff).toBe(orderBlock(dropped.fee))
        },
      ),
      { numRuns: 500 },
    )
  })

  it('is order-insensitive: shuffling the orders changes nothing', () => {
    fc.assert(
      fc.property(tranches, tranches, orderList, (floatTotal, topupTotal, orders) => {
        const close = truthfulClose(floatTotal, topupTotal, orders)
        const a = evaluateBr1({ floatTotal, topupTotal, ...close, orders })
        const b = evaluateBr1({ floatTotal, topupTotal, ...close, orders: [...orders].reverse() })
        expect(b.expectedCash).toBe(a.expectedCash)
        expect(b.expectedWallet).toBe(a.expectedWallet)
      }),
    )
  })
})

/**
 * A part-paid order — the client's real payments log shows a customer can settle some of an order
 * electronically and hand over the rest, so only PART of the 80% reaches the wallet. `walletAmount`
 * is that measured part, and the three pay modes become two ends of one continuum.
 *
 * These properties are what make the change safe to ship: the first two prove the generalisation
 * cannot move a single existing shift by a single minor unit, and the third proves the 80% block —
 * and therefore the tier split, the ledger and BR4 — is invariant to where the money landed.
 */
describe('BR1 — a part-paid order', () => {
  it('walletAmount = 0 is EXACTLY today’s cash order', () => {
    fc.assert(
      fc.property(tranches, tranches, orderList, (floatTotal, topupTotal, orders) => {
        const asCash = orders.map((o) => ({ ...o, payMode: 'cash' as const }))
        const measured = asCash.map((o) => ({ ...o, walletAmount: minor(0n) }))
        const close = truthfulClose(floatTotal, topupTotal, asCash)
        const a = evaluateBr1({ floatTotal, topupTotal, ...close, orders: asCash })
        const b = evaluateBr1({ floatTotal, topupTotal, ...close, orders: measured })
        expect(b.expectedCash).toBe(a.expectedCash)
        expect(b.expectedWallet).toBe(a.expectedWallet)
        expect(b.scalarDiff).toBe(0n)
      }),
    )
  })

  it('walletAmount = fee is EXACTLY today’s electronic order', () => {
    fc.assert(
      fc.property(tranches, tranches, orderList, (floatTotal, topupTotal, orders) => {
        const asElectronic = orders.map((o) => ({ ...o, payMode: 'electronic' as const }))
        const measured = asElectronic.map((o) => ({ ...o, walletAmount: o.fee }))
        const close = truthfulClose(floatTotal, topupTotal, asElectronic)
        const a = evaluateBr1({ floatTotal, topupTotal, ...close, orders: asElectronic })
        const b = evaluateBr1({ floatTotal, topupTotal, ...close, orders: measured })
        expect(b.expectedCash).toBe(a.expectedCash)
        expect(b.expectedWallet).toBe(a.expectedWallet)
        expect(b.scalarDiff).toBe(0n)
      }),
    )
  })

  it('however the fee splits between hand and wallet, the 80% block is unchanged', () => {
    // The invariant the whole design rests on: (fee − W) + (W − cut) === fee − cut. The tier reads
    // the block, so a part-paid order must not be able to move anyone's share by moving where the
    // money landed. `split` walks W across the entire range, including both endpoints.
    fc.assert(
      fc.property(
        tranches,
        tranches,
        fc.array(fc.record({ orderNo: fc.string({ minLength: 1, maxLength: 12 }), fee, split: fc.double({ min: 0, max: 1, noNaN: true }) }), { maxLength: 40 }),
        (floatTotal, topupTotal, rows) => {
          const orders = rows.map((r) => ({
            orderNo: r.orderNo,
            payMode: 'cash' as const,
            fee: r.fee,
            walletAmount: minor(BigInt(Math.round(Number(r.fee) * r.split))),
          }))
          const expectedCash = add(floatTotal, sum(orders.map((o) => minor(o.fee - o.walletAmount))))
          const expectedWallet = add(topupTotal, sum(orders.map((o) => minor(o.walletAmount - yalagoCut(o.fee)))))
          const r = evaluateBr1({
            floatTotal,
            topupTotal,
            endCashDeclared: expectedCash,
            endWalletDeclared: expectedWallet,
            orders,
          })
          expect(r.scalarDiff).toBe(0n)
          expect(r.cashDiff).toBe(0n)
          expect(r.walletDiff).toBe(0n)
          // And the block — what the tier splits — is the same as if every order had been all-cash.
          expect(r.totals.blockTotal).toBe(totalFees(orders.map((o) => o.fee)).blockTotal)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('a wallet movement no order explains lands in the wallet, and nowhere else', () => {
    // An incentive Yallago paid, or a withdrawal. Without this term BR1 would report its value as a
    // discrepancy and blame the driver for money the app moved on its own.
    fc.assert(
      fc.property(tranches, tranches, orderList, fc.array(fc.integer({ min: -500_000, max: 500_000 }).map((n) => minor(BigInt(n))), { maxLength: 8 }), (floatTotal, topupTotal, orders, adjustments) => {
        const close = truthfulClose(floatTotal, topupTotal, orders)
        const withAdjustments = {
          ...close,
          endWalletDeclared: add(close.endWalletDeclared, sum(adjustments)),
        }
        const r = evaluateBr1({ floatTotal, topupTotal, ...withAdjustments, orders, walletAdjustments: adjustments })
        expect(r.scalarDiff).toBe(0n)
        expect(r.cashDiff).toBe(0n)
        expect(r.walletDiff).toBe(0n)
      }),
    )
  })
})
