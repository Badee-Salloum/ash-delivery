import { describe, expect, it } from 'vitest'
import { minor } from '../../src/money/minor.ts'
import { splitBlock, totalFees } from '../../src/money/allocate.ts'
import { type ShiftOrder, evaluateBr1 } from '../../src/br1/equation.ts'
import { diagnoseBr1 } from '../../src/br1/diagnose.ts'
import { DEFAULT_BANDS, bpsForCount } from '../../src/tier/rules.ts'

/**
 * SRS §2.3 / kickoff brief §3 — the client's own worked example, encoded verbatim.
 * Traceability: acceptance criteria #2, #3, #4, #5, #7.
 *
 * Amounts are new Syrian Lira; the minor unit is 1/100 of that, so 100,000 new SYP is
 * 10,000,000 minor units. The example's own numbers are kept visible in `syp()`.
 */
const syp = (newLira: number) => minor(BigInt(newLira) * 100n)

const FEE = syp(5_000)

function orders(cash: number, electronic: number, free: number): ShiftOrder[] {
  const out: ShiftOrder[] = []
  let n = 1
  for (let i = 0; i < cash; i++) out.push({ orderNo: `C${n++}`, payMode: 'cash', fee: FEE })
  for (let i = 0; i < electronic; i++) out.push({ orderNo: `E${n++}`, payMode: 'electronic', fee: FEE })
  for (let i = 0; i < free; i++) out.push({ orderNo: `F${n++}`, payMode: 'free', fee: FEE })
  return out
}

describe('SRS §2.3 — the canonical shift', () => {
  const shift = {
    floatTotal: syp(100_000),
    topupTotal: syp(50_000),
    endCashDeclared: syp(160_000),
    endWalletDeclared: syp(70_000),
    orders: orders(12, 6, 2),
  }

  it('reproduces the SRS table row for row', () => {
    const r = evaluateBr1(shift)

    // «البداية: كاش التحرك 100,000 + شحن المحفظة 50,000»
    // 12 cash orders  → cash +60,000, wallet (12,000)
    // 6 electronic    → wallet +24,000
    // 2 free          → wallet  +8,000
    expect(r.expectedCash).toBe(syp(160_000))
    expect(r.expectedWallet).toBe(syp(70_000))
  })

  it('closes the zero equation exactly (BR1, AC #2)', () => {
    const r = evaluateBr1(shift)

    // 160,000 + 70,000 = 230,000 == 100,000 + 50,000 + (80% × 100,000)
    expect(r.actualTotal).toBe(syp(230_000))
    expect(r.expectedTotal).toBe(syp(230_000))
    expect(r.totals.feeTotal).toBe(syp(100_000))
    expect(r.totals.blockTotal).toBe(syp(80_000))
    expect(r.scalarDiff).toBe(0n)
    expect(r.balanced).toBe(true)
    expect(r.splitBalanced).toBe(true)
  })

  it('reports "balanced" with no causes to investigate', () => {
    const causes = diagnoseBr1(evaluateBr1(shift), shift.orders)
    expect(causes).toHaveLength(1)
    expect(causes[0]?.code).toBe('balanced')
  })

  it('splits at approval: Yallago 20,000 / driver 40,000 / company 40,000 (AC #3, #4, #7)', () => {
    const totals = totalFees(shift.orders.map((o) => o.fee))

    // 20 orders → the 15–24 band → 40% for the driver.
    const driverBps = bpsForCount(DEFAULT_BANDS, shift.orders.length)
    expect(driverBps).toBe(4000)

    const split = splitBlock(totals, driverBps)
    expect(split.yalagoShare).toBe(syp(20_000))
    expect(split.driverShare).toBe(syp(40_000))
    expect(split.companyShare).toBe(syp(40_000))

    // AC #5 — the three shares exhaust the fee total exactly.
    expect(split.driverShare + split.companyShare + split.yalagoShare).toBe(totals.feeTotal)
  })
})

describe('the pay-mode blind spot', () => {
  /**
   * THE reason BR1 returns three differences instead of one. Recording one cash order as
   * electronic leaves the scalar equation at exactly zero — a zero-tolerance gate that looked
   * only at the scalar would wave this shift through with the money in the wrong place.
   */
  it('a single miscoded order leaves scalarDiff at zero but moves cash and wallet by ±fee', () => {
    const truth = orders(12, 6, 2)
    const miscoded = orders(11, 7, 2) // one cash order recorded as electronic

    const r = evaluateBr1({
      floatTotal: syp(100_000),
      topupTotal: syp(50_000),
      // The driver hands over what he ACTUALLY has — the truth.
      endCashDeclared: syp(160_000),
      endWalletDeclared: syp(70_000),
      orders: miscoded,
    })

    expect(r.scalarDiff).toBe(0n) // ← the trap
    expect(r.balanced).toBe(true)
    expect(r.cashDiff).toBe(FEE) // real cash exceeds the model by one fee
    expect(r.walletDiff).toBe(-FEE)
    expect(r.splitBalanced).toBe(false) // ← what catches it

    expect(truth).toHaveLength(miscoded.length) // same order count, different truth
  })

  it('names the misclassification and the orders to look at', () => {
    const miscoded = orders(11, 7, 2)
    const r = evaluateBr1({
      floatTotal: syp(100_000),
      topupTotal: syp(50_000),
      endCashDeclared: syp(160_000),
      endWalletDeclared: syp(70_000),
      orders: miscoded,
    })
    const causes = diagnoseBr1(r, miscoded)

    expect(causes[0]?.code).toBe('pay_mode_misclassified')
    expect(causes[0]?.confidence).toBe('high')
    expect(causes[0]?.amount).toBe(FEE)
    expect(causes[0]?.detail.direction).toBe('recorded_electronic_actually_cash')
    // Every electronic/free order at that fee is a suspect.
    expect(causes[0]?.candidateOrderNos.length).toBe(9)
  })
})

describe('difference breakdown — the arithmetic signatures are distinguishable', () => {
  const base = {
    floatTotal: syp(100_000),
    topupTotal: syp(50_000),
    endCashDeclared: syp(160_000),
    endWalletDeclared: syp(70_000),
  }

  it('a missing CASH order shows +fee cash, −cut wallet', () => {
    const recorded = orders(11, 6, 2) // one cash order never entered
    const r = evaluateBr1({ ...base, orders: recorded })

    expect(r.cashDiff).toBe(syp(5_000))
    expect(r.walletDiff).toBe(-syp(1_000))
    expect(r.scalarDiff).toBe(syp(4_000)) // the block of one order

    const causes = diagnoseBr1(r, recorded)
    expect(causes[0]?.code).toBe('missing_order')
    expect(causes[0]?.detail.payMode).toBe('cash')
    expect(causes[0]?.detail.orderCount).toBe('1')
  })

  it('a missing ELECTRONIC order shows clean cash and +block wallet', () => {
    const recorded = orders(12, 5, 2)
    const r = evaluateBr1({ ...base, orders: recorded })

    expect(r.cashDiff).toBe(0n)
    expect(r.walletDiff).toBe(syp(4_000))
    expect(r.scalarDiff).toBe(syp(4_000))

    const causes = diagnoseBr1(r, recorded)
    expect(causes[0]?.code).toBe('missing_order')
    expect(causes[0]?.detail.payMode).toBe('electronic_or_free')
  })

  it('an unrecorded float tranche shows +cash and a perfectly clean wallet', () => {
    // The driver was handed a second 10,000 tranche that nobody logged.
    const r = evaluateBr1({
      ...base,
      floatTotal: syp(90_000),
      orders: orders(12, 6, 2),
    })

    expect(r.cashDiff).toBe(syp(10_000))
    expect(r.walletDiff).toBe(0n)

    const causes = diagnoseBr1(r, orders(12, 6, 2))
    expect(causes[0]?.code).toBe('unrecorded_float_tranche')
    expect(causes[0]?.amount).toBe(syp(10_000))
  })
})
