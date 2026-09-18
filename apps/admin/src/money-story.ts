import type { ShiftSettlementView } from '@ash/client'
import { abs, add, formatMinor, minor, parseMinor, sub } from '@ash/domain'

/**
 * The two lines of account under the handover instructions.
 *
 * The manager's job at the moment of approval is to move two amounts. Everything else on the screen
 * is *why*, and «why» has to fit in two lines or it does not get read at all — which is how a
 * screen ends up with a `<details>` nobody opens holding the only derivation of the figure being
 * signed for.
 *
 * Pure: no React, no clock, no catalogue. It emits CODES and money strings; the UI resolves the
 * codes, exactly as the domain does for `br1.cause.<code>`.
 */

export type VarianceDirection = 'surplus' | 'shortage' | 'balanced'

const directionOf = (signed: bigint): VarianceDirection =>
  signed > 0n ? 'surplus' : signed < 0n ? 'shortage' : 'balanced'

export interface Br1SplitView {
  /** The scalar — the only one of the three that is coloured. */
  direction: VarianceDirection
  /** Magnitude; the direction lives in the word beside it. */
  total: string
  /** Signed, and deliberately NEUTRAL in the UI — see `offsetting`. */
  cash: string
  wallet: string
  /**
   * Set only when the two components point in opposite directions.
   *
   * Then `amount` appears in one box and is missing from the other by exactly that much, and
   * `remainder` is what is genuinely unaccounted for. Both are arithmetic facts, not a diagnosis:
   * `cashDiff + walletDiff === scalarDiff` always holds, from one snapshot, in minor units.
   */
  offsetting: { amount: string; remainder: string; remainderDirection: VarianceDirection } | null
}

export interface Br1SplitInput {
  difference: string
  cashDifference?: string
  walletDifference?: string
}

/**
 * All three BR1 differences, which money rule 4 requires and the screen has never shown.
 *
 * A NON-ZERO SPLIT IS ORDINARY and must never be coloured as an alarm. Since decision 8 retired pay
 * mode, `expectedCash` is computed as though every order were cash, so any order the driver took
 * electronically moves the two components apart by exactly the amount that moved — on a perfectly
 * correct shift. `br1Verdict` suppresses its own `split_off` verdict for that reason. What the
 * split is good for is saying WHERE the difference sits, so the manager knows which drawer to open.
 */
export function br1SplitView(br1: Br1SplitInput): Br1SplitView {
  const scalar = parseMinor(br1.difference)
  const view: Br1SplitView = {
    direction: directionOf(scalar),
    total: formatMinor(abs(scalar)),
    cash: br1.cashDifference ?? '',
    wallet: br1.walletDifference ?? '',
    offsetting: null,
  }
  // An older API may not send the components; the headline still stands on its own.
  if (br1.cashDifference === undefined || br1.walletDifference === undefined) return view

  const cash = parseMinor(br1.cashDifference)
  const wallet = parseMinor(br1.walletDifference)
  const opposed = (cash > 0n && wallet < 0n) || (cash < 0n && wallet > 0n)
  if (!opposed) return view

  const offset = abs(cash) < abs(wallet) ? abs(cash) : abs(wallet)
  return {
    ...view,
    offsetting: {
      amount: formatMinor(offset),
      remainder: formatMinor(abs(scalar)),
      remainderDirection: directionOf(scalar),
    },
  }
}

export type ShareStepCode =
  | 'fees_to_share'
  | 'manual_share'
  | 'gross'
  | 'deductions'
  | 'base'
  | 'variance'
  | 'manager_charge'
  | 'takes'

export interface ShareStep {
  code: ShareStepCode
  /** Magnitude for `variance` (its direction is in the code's label); the value otherwise. */
  amount: string
  /** `fees_to_share` alone carries a second figure: the fee total the 40% was taken from. */
  from?: string
  /** `variance` and `takes` may be negative and are coloured accordingly. */
  signed?: boolean
  direction?: VarianceDirection
}

/**
 * How the employee's figure was reached — three steps on an ordinary shift, five on a complicated
 * one.
 *
 * A zero addend contributes nothing to the total, so omitting it hides no fact. That is NOT true of
 * a hidden order row, which is why `summarizeOrders` counts and totals every bucket including the
 * empty ones. Do not "make these consistent": one is arithmetic, the other is evidence.
 */
export function employeeShareChain(settlement: ShiftSettlementView): ShareStep[] {
  const manual = parseMinor(settlement.manualDriverShare)
  const deductions = parseMinor(settlement.cashDeductionTotal)
  const variance = parseMinor(settlement.variance)
  const steps: ShareStep[] = [
    {
      code: 'fees_to_share',
      amount: settlement.fixedDriverShare,
      from: settlement.deliveryFeeTotal,
    },
  ]
  if (manual !== 0n) {
    steps.push({ code: 'manual_share', amount: settlement.manualDriverShare })
    steps.push({ code: 'gross', amount: settlement.grossDriverShare })
  }
  if (deductions !== 0n) {
    steps.push({ code: 'deductions', amount: settlement.cashDeductionTotal })
    steps.push({ code: 'base', amount: settlement.baseDriverShare })
  }
  steps.push({
    code: 'variance',
    amount: formatMinor(abs(variance)),
    direction: settlement.varianceDirection,
  })
  /*
   * «الحسم» comes off AFTER the variance, because that is the order the money actually moves in:
   * the count settles what he is owed, and the charge is then paid out of it. Shown only when it
   * is non-zero — a zero addend hides no fact.
   */
  const charge = parseMinor(settlement.managerCharge ?? '0')
  if (charge !== 0n) steps.push({ code: 'manager_charge', amount: settlement.managerCharge ?? '0' })
  steps.push({ code: 'takes', amount: settlement.finalEmployeeCash, signed: true })
  return steps
}

/**
 * The identity the two lines rest on: the employee's figure IS the chain, to the minor unit.
 *
 * Exported so a test can assert it against real settlements rather than trusting the rendering —
 * if this is ever false, the screen is showing a derivation that does not reach its own answer.
 */
export function shareChainReconciles(settlement: ShiftSettlementView): boolean {
  const gross = add(parseMinor(settlement.fixedDriverShare), parseMinor(settlement.manualDriverShare))
  const base = sub(gross, parseMinor(settlement.cashDeductionTotal))
  const final = sub(
    add(base, parseMinor(settlement.variance)),
    parseMinor(settlement.managerCharge ?? '0'),
  )
  return (
    gross === parseMinor(settlement.grossDriverShare) &&
    base === parseMinor(settlement.baseDriverShare) &&
    final === parseMinor(settlement.finalEmployeeCash)
  )
}

/** `cashDiff + walletDiff === scalarDiff`, from one snapshot. The sentence rests on it. */
export function br1SplitReconciles(br1: Br1SplitInput): boolean {
  if (br1.cashDifference === undefined || br1.walletDifference === undefined) return true
  return (
    add(parseMinor(br1.cashDifference), parseMinor(br1.walletDifference)) ===
    minor(parseMinor(br1.difference))
  )
}
