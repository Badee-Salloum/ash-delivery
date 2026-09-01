import { describe, expect, it } from 'vitest'
import type { ShiftSettlementView } from '@ash/client'
import {
  br1SplitReconciles,
  br1SplitView,
  employeeShareChain,
  shareChainReconciles,
} from './money-story.ts'

/**
 * Haidar Mohammed's shift, 2026-08-31, exactly as production holds it. Its cash settlement of
 * 6,838.70 is the figure actually posted to the ledger, so if these tests drift from the screen the
 * screen is wrong, not the fixture.
 */
const haidar: ShiftSettlementView = {
  policyCode: 'fixed_40_cash_close_v2_receivable',
  driverRateBps: 4000,
  deliveryFeeTotal: '1910.00',
  fixedDriverShare: '764.00',
  manualDriverShare: '0.00',
  grossDriverShare: '764.00',
  cashDeductionTotal: '0.00',
  baseDriverShare: '764.00',
  expectedTotal: '7528.00',
  actualCash: '8000.00',
  actualWallet: '-74.70',
  actualTotal: '7925.30',
  variance: '397.30',
  varianceDirection: 'surplus',
  finalEmployeeCash: '1161.30',
  cashClaimToOffice: '6838.70',
  walletClaimToOffice: '-74.70',
  cashReceivableDeferred: '0.00',
  walletReceivableDeferred: '0.00',
  maximumCashShortageReceivable: '0.00',
  cashShortageReceivable: '0.00',
  walletToOffice: '-74.70',
  cashToOffice: '6838.70',
  walletAction: 'fund',
  walletAmount: '74.70',
  cashAction: 'collect',
  cashAmount: '6838.70',
  settlementHash: 'a'.repeat(64),
}

describe('the three BR1 differences', () => {
  it('shows where the difference sits, not only how big it is', () => {
    // Money rule 4: the scalar is blind by construction, so both components must be evaluated.
    // The screen has never rendered either of them.
    const view = br1SplitView({ difference: '397.30', cashDifference: '1090.00', walletDifference: '-692.70' })
    expect(view.direction).toBe('surplus')
    expect(view.total).toBe('397.30')
    expect(view.cash).toBe('1090.00')
    expect(view.wallet).toBe('-692.70')
  })

  it('names the offsetting amount when the two point opposite ways', () => {
    // 692.70 appears in one box and is missing from the other by exactly that much; 397.30 is what
    // is genuinely unaccounted for. Both are arithmetic, not a guess about a cause.
    const view = br1SplitView({ difference: '397.30', cashDifference: '1090.00', walletDifference: '-692.70' })
    expect(view.offsetting).toEqual({
      amount: '692.70',
      remainder: '397.30',
      remainderDirection: 'surplus',
    })
  })

  it('says nothing about offsetting when both point the same way', () => {
    // Two shortfalls are not one amount that moved between boxes; claiming so would invent a story.
    expect(br1SplitView({ difference: '-30.00', cashDifference: '-20.00', walletDifference: '-10.00' }).offsetting)
      .toBeNull()
  })

  it('treats a balanced shift as balanced even when the boxes disagree', () => {
    /*
     * The ordinary case under decision 8, and why the two components are rendered NEUTRAL. Pay mode
     * is no longer collected, so `expectedCash` assumes every order was cash; an electronic order
     * moves the two apart by exactly the amount that moved, on a perfectly correct shift.
     * `br1Verdict` suppresses `split_off` for the same reason. Colouring this amber would fire on
     * every honest close.
     */
    const view = br1SplitView({ difference: '0.00', cashDifference: '-500.00', walletDifference: '500.00' })
    expect(view.direction).toBe('balanced')
    expect(view.total).toBe('0.00')
    expect(view.offsetting).toEqual({ amount: '500.00', remainder: '0.00', remainderDirection: 'balanced' })
  })

  it('survives an older API that sends only the scalar', () => {
    const view = br1SplitView({ difference: '-12.50' })
    expect(view.direction).toBe('shortage')
    expect(view.total).toBe('12.50')
    expect(view.offsetting).toBeNull()
  })

  it('rests on an identity that holds', () => {
    // `cashDiff + walletDiff === scalarDiff`, from one snapshot, in minor units.
    expect(br1SplitReconciles({ difference: '397.30', cashDifference: '1090.00', walletDifference: '-692.70' })).toBe(true)
    expect(br1SplitReconciles({ difference: '0.00', cashDifference: '-500.00', walletDifference: '500.00' })).toBe(true)
    expect(br1SplitReconciles({ difference: '1.00', cashDifference: '1.00', walletDifference: '1.00' })).toBe(false)
  })
})

describe("how the employee's figure was reached", () => {
  it('is three steps on an ordinary shift', () => {
    // Haidar's: no manual jobs, no deductions. Showing «+ 0.00» twice would be noise, and a zero
    // addend contributes nothing, so omitting it hides no fact.
    expect(employeeShareChain(haidar).map((s) => s.code)).toEqual(['fees_to_share', 'variance', 'takes'])
  })

  it('carries the fee total the 40% came from, on the same line', () => {
    const [first] = employeeShareChain(haidar)
    expect(first).toMatchObject({ code: 'fees_to_share', from: '1910.00', amount: '764.00' })
  })

  it('states the variance as a magnitude with its direction beside it', () => {
    // The house convention: strip the sign, say the direction in words, colour both together.
    const variance = employeeShareChain(haidar).find((s) => s.code === 'variance')
    expect(variance).toMatchObject({ amount: '397.30', direction: 'surplus' })
  })

  it('ends on what the employee actually takes, signed', () => {
    const takes = employeeShareChain(haidar).at(-1)
    expect(takes).toMatchObject({ code: 'takes', amount: '1161.30', signed: true })
  })

  it('grows to five steps when a manual share or a deduction exists', () => {
    // And only then does `grossDriverShare` appear — a figure the close screen shows nowhere today.
    const complicated: ShiftSettlementView = {
      ...haidar,
      manualDriverShare: '200.00',
      grossDriverShare: '964.00',
      cashDeductionTotal: '50.00',
      baseDriverShare: '914.00',
      finalEmployeeCash: '1311.30',
    }
    expect(employeeShareChain(complicated).map((s) => s.code)).toEqual([
      'fees_to_share',
      'manual_share',
      'gross',
      'deductions',
      'base',
      'variance',
      'takes',
    ])
  })

  it('shows only the deduction pair when there are no manual jobs', () => {
    const withDeduction: ShiftSettlementView = {
      ...haidar,
      cashDeductionTotal: '50.00',
      baseDriverShare: '714.00',
      finalEmployeeCash: '1111.30',
    }
    expect(employeeShareChain(withDeduction).map((s) => s.code)).toEqual([
      'fees_to_share',
      'deductions',
      'base',
      'variance',
      'takes',
    ])
  })

  it('reaches its own answer — the chain equals the settlement', () => {
    // If this is ever false the screen is showing a derivation that does not arrive at the figure
    // printed beneath it, which is worse than showing no derivation at all.
    expect(shareChainReconciles(haidar)).toBe(true)
    expect(
      shareChainReconciles({
        ...haidar,
        manualDriverShare: '200.00',
        grossDriverShare: '964.00',
        cashDeductionTotal: '50.00',
        baseDriverShare: '914.00',
        finalEmployeeCash: '1311.30',
      }),
    ).toBe(true)
    // A settlement whose parts do not add up must be caught, not rendered.
    expect(shareChainReconciles({ ...haidar, finalEmployeeCash: '999.00' })).toBe(false)
  })

  it('handles an employee who owes the office', () => {
    // A shortage larger than his share: he contributes rather than receives, and `takes` is signed
    // so the screen can colour it red without a second rule.
    const owing: ShiftSettlementView = {
      ...haidar,
      variance: '-900.00',
      varianceDirection: 'shortage',
      finalEmployeeCash: '-136.00',
      maximumCashShortageReceivable: '136.00',
    }
    const chain = employeeShareChain(owing)
    expect(chain.find((s) => s.code === 'variance')).toMatchObject({ amount: '900.00', direction: 'shortage' })
    expect(chain.at(-1)).toMatchObject({ code: 'takes', amount: '-136.00' })
    expect(shareChainReconciles(owing)).toBe(true)
  })
})
