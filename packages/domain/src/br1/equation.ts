import { type Minor, add, isZero, minor, sub, sum } from '../money/minor.ts'
import { type FeeTotals, type Rounding, yalagoCut } from '../money/allocate.ts'

/** BR3 — every order is exactly one of these three. */
export type PayMode = 'cash' | 'electronic' | 'free'

/**
 * Where an order came from, which decides how its money is cut up.
 *
 * `yallago` — a delivery Yallago handed us. Their 20% leaves instantly (BR2) and the remaining
 * block is split driver-vs-company at the DAY's tier band (BR4/F-1).
 *
 * `manual` — a job the branch took itself, entered by a manager. Yallago is not involved, so there
 * is no 20% cut and the daily band does not apply to it: the driver's and the company's shares are
 * entered by hand and must add up to the fee exactly.
 */
export type OrderKind = 'yallago' | 'manual'

export interface ShiftOrder {
  readonly orderNo: string
  readonly payMode: PayMode
  readonly fee: Minor
  /** Absent means `yallago` — every order was one before manual orders existed. */
  readonly kind?: OrderKind
  /** Manual orders only: the hand-entered split. `driverShare + companyShare === fee`, exactly. */
  readonly driverShare?: Minor
  readonly companyShare?: Minor
  /**
   * How much of this order's fee actually reached the WALLET (0 ≤ walletAmount ≤ fee).
   *
   * `payMode` treats an order as all-cash or all-wallet, and the client's real payments log shows
   * that is not how it works: a customer can settle part of an order electronically and hand over
   * the rest, so only PART of the 80% lands in the wallet. This is the measured amount, read off
   * the log, and it makes the three modes two endpoints of one continuum:
   *
   *     walletAmount = 0    ⇒ exactly today's `cash`
   *     walletAmount = fee  ⇒ exactly today's `electronic` / `free`
   *
   * Absent means "nobody measured it" and `orderWalletAmount` falls back to the pay mode, so every
   * shift recorded before the log was read keeps its old arithmetic to the minor unit.
   */
  readonly walletAmount?: Minor
}

export const isManualOrder = (order: ShiftOrder): boolean => order.kind === 'manual'

/**
 * How much of the fee arrived in the wallet.
 *
 * The measurement when there is one; otherwise what the pay mode implies. Clamped into `[0, fee]`
 * because a reading outside it is a misread, and letting it through would put money into BR1 that
 * the order never carried.
 */
export const orderWalletAmount = (order: ShiftOrder): Minor => {
  if (order.walletAmount === undefined) {
    return order.payMode === 'cash' ? minor(0n) : order.fee
  }
  if (order.walletAmount < 0n) return minor(0n)
  return order.walletAmount > order.fee ? order.fee : order.walletAmount
}

/** Yallago's cut of one order — zero for a manual job, which they never touched. */
export const orderYalagoCut = (order: ShiftOrder, rounding: Rounding = 'floor'): Minor =>
  isManualOrder(order) ? minor(0n) : yalagoCut(order.fee, rounding)

/** What lands with the driver from one order: the fee less whatever Yallago took. */
export const orderNetBlock = (order: ShiftOrder, rounding: Rounding = 'floor'): Minor =>
  sub(order.fee, orderYalagoCut(order, rounding))

/**
 * The three BR1 fee terms across a mixed set of orders.
 *
 * `totalFees` sums a list of bare fees and charges Yallago on every one of them. That is right when
 * every order is Yallago's, and wrong the moment a manual job is in the list — it would invent a
 * 20% cut for a delivery Yallago never saw and put BR1 out by that amount. This walks the orders
 * instead, so each one is charged (or not) according to its own kind. `blockTotal` stays a
 * RESIDUAL — see the boxed comment in money/allocate.ts.
 */
export function totalFeesOfOrders(orders: readonly ShiftOrder[], rounding: Rounding = 'floor'): FeeTotals {
  const feeTotal = sum(orders.map((o) => o.fee))
  const yalagoTotal = sum(orders.map((o) => orderYalagoCut(o, rounding)))
  return { feeTotal, yalagoTotal, blockTotal: sub(feeTotal, yalagoTotal) }
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
  /**
   * Signed wallet movements that no order explains — an incentive, a top-up, a withdrawal — read
   * off the payments log. Positive raises the wallet, negative lowers it.
   */
  readonly walletAdjustments?: readonly Minor[]
  /**
   * Cash operations scanned as negative movements, represented here as POSITIVE magnitudes.
   *
   * They are not orders: they reduce only the cash the driver is expected to hold. In particular,
   * they do not change the order count, the day's tier, the fee totals, or Yallago's cut.
   */
  readonly cashDeductions?: readonly Minor[]
  readonly rounding?: Rounding
}

/**
 * The payments log is archival evidence only. Its OCR rows never change BR1, order fees, tiers,
 * Yallago's share, or ledger postings. The app-wallet balance entered from the dedicated wallet
 * screenshot remains the sole closing-wallet measurement.
 *
 * Keep this named switch shared by API and client so a future accounting-policy change cannot make
 * the driver's preview disagree with the manager's review.
 */
export const WALLET_LOG_FEEDS_BR1 = false

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
 *     == cash_float_given + wallet_topup_given + 0.80 × Σ(delivery fees) - cash_deductions
 *
 * ...where the "0.80 ×" term is `totals.blockTotal`, a residual (see money/allocate.ts), and
 * cash deductions are positive magnitudes for classified operations that reduced cash in hand.
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
  const totals = totalFeesOfOrders(input.orders, rounding)

  let cashFromOrders = 0n
  let walletFromOrders = 0n
  for (const order of input.orders) {
    // Zero for a manual job — Yallago never touched it, so nothing leaves the wallet for them and
    // the whole fee is the driver's block.
    const cut = orderYalagoCut(order, rounding)
    // What actually reached the wallet; the rest of the fee he collected in his hand. One rule for
    // every order, replacing the three-way switch: an all-cash order has `wallet = 0` and an all-
    // electronic one has `wallet = fee`, so both come out exactly as they did before, and a part-
    // paid order — which the pay modes could not express at all — now comes out right too.
    const inWallet = orderWalletAmount(order)
    cashFromOrders += sub(order.fee, inWallet)
    walletFromOrders += sub(inWallet, cut)
  }
  // Wallet movements that belong to no order at all: an incentive Yallago paid, a top-up, a
  // withdrawal. Without them the equation reports their sum as a discrepancy and blames the driver
  // for money the app moved on its own.
  for (const adjustment of input.walletAdjustments ?? []) walletFromOrders += adjustment

  const cashDeductions = input.cashDeductions ?? []
  for (const deduction of cashDeductions) {
    if (deduction <= 0n) {
      throw new RangeError(`cash deductions must be positive magnitudes, got ${deduction}`)
    }
  }

  const expectedCash = sub(add(input.floatTotal, minor(cashFromOrders)), sum(cashDeductions))
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
export function expectedFromGates(
  floatTotal: Minor,
  topupTotal: Minor,
  blockTotal: Minor,
  cashDeductionTotal: Minor = minor(0n),
): Minor {
  if (cashDeductionTotal < 0n) {
    throw new RangeError(`cash deduction total must be a positive magnitude, got ${cashDeductionTotal}`)
  }
  return sub(add(add(floatTotal, topupTotal), blockTotal), cashDeductionTotal)
}
