import { type Minor, add, isZero, minor, sub } from '../money/minor.ts'
import { type FeeTotals, type Rounding, orderBlock, totalFees, yalagoCut } from '../money/allocate.ts'

/** BR3 — every order is exactly one of these three. */
export type PayMode = 'cash' | 'electronic' | 'free'

export interface ShiftOrder {
  readonly orderNo: string
  readonly payMode: PayMode
  readonly fee: Minor
}

export interface Br1Input {
  /** Σ of the shift's cash-float tranches. SRS C-5 permits more than one per day. */
  readonly floatTotal: Minor
  /** Σ of the shift's wallet top-up tranches. */
  readonly topupTotal: Minor
  /** What the driver declared and the manager counted at close. */
  readonly endCashDeclared: Minor
  readonly endWalletDeclared: Minor
  readonly orders: readonly ShiftOrder[]
  readonly rounding?: Rounding
}

export interface Br1Result {
  readonly totals: FeeTotals
  readonly expectedCash: Minor
  readonly expectedWallet: Minor
  readonly expectedTotal: Minor
  readonly actualTotal: Minor
  /** BR1 proper. Must be exactly zero for the branch manager to be allowed to approve. */
  readonly scalarDiff: Minor
  readonly cashDiff: Minor
  readonly walletDiff: Minor
  readonly balanced: boolean
  /** Both components zero. A shift can be `balanced` and NOT `splitBalanced` — see below. */
  readonly splitBalanced: boolean
}

/**
 * BR1 — the zero-shift equation.
 *
 *   driver_cash_on_hand + driver_app_wallet_balance
 *     == cash_float_given + wallet_topup_given + 0.80 × Σ(delivery fees)
 *
 * ...where the "0.80 ×" term is `totals.blockTotal`, a residual (see money/allocate.ts).
 *
 * Goods value does not appear. For a cash order the driver pays the merchant out of the
 * float and collects the same amount back from the customer, so it round-trips to net zero.
 * The open question (SRS م-3) is whether the same holds for electronic orders; the fee-only
 * invariant is correct under the round-trip assumption either way, and `goods_value_minor`
 * ships inactive so the answer can be flipped by a setting rather than a migration.
 *
 * ── WHY THIS RETURNS THREE DIFFERENCES, NOT ONE ────────────────────────────────────────
 * The scalar equation CANNOT SEE a pay-mode error. Record one order as `electronic` when it
 * was really `cash` and the scalar difference stays at exactly zero, while cash is short by
 * the fee and the wallet is over by the same fee. The shift would sail through a
 * zero-tolerance gate with the money in the wrong place. So BR1 is evaluated in three parts
 * and `splitBalanced` is reported separately from `balanced`.
 *
 * The `br1_split_gate` setting decides whether a split failure blocks approval:
 *   • `advisory` during the pilot — warn, log the diff, calibrate against reality;
 *   • `strict` afterwards.
 * That setting lives in the application layer; this function only reports the facts.
 */
export function evaluateBr1(input: Br1Input): Br1Result {
  const rounding = input.rounding ?? 'floor'
  const totals = totalFees(
    input.orders.map((o) => o.fee),
    rounding,
  )

  let cashFromOrders = 0n
  let walletFromOrders = 0n
  for (const order of input.orders) {
    switch (order.payMode) {
      case 'cash':
        // Collects the fee in cash; Yallago takes its 20% out of the wallet instantly (BR2).
        cashFromOrders += order.fee
        walletFromOrders -= yalagoCut(order.fee, rounding)
        break
      case 'electronic':
      case 'free':
        // Nothing collected in cash; the 80% block lands in the wallet.
        walletFromOrders += orderBlock(order.fee, rounding)
        break
    }
  }

  const expectedCash = add(input.floatTotal, minor(cashFromOrders))
  const expectedWallet = add(input.topupTotal, minor(walletFromOrders))
  const expectedTotal = add(expectedCash, expectedWallet)
  const actualTotal = add(input.endCashDeclared, input.endWalletDeclared)

  const scalarDiff = sub(actualTotal, expectedTotal)
  const cashDiff = sub(input.endCashDeclared, expectedCash)
  const walletDiff = sub(input.endWalletDeclared, expectedWallet)

  return {
    totals,
    expectedCash,
    expectedWallet,
    expectedTotal,
    actualTotal,
    scalarDiff,
    cashDiff,
    walletDiff,
    balanced: isZero(scalarDiff),
    splitBalanced: isZero(cashDiff) && isZero(walletDiff),
  }
}

/** Convenience: the BR1 right-hand side, for display next to the left-hand side. */
export function expectedFromGates(floatTotal: Minor, topupTotal: Minor, blockTotal: Minor): Minor {
  return add(add(floatTotal, topupTotal), blockTotal)
}
