import { FIXED_DRIVER_BPS, allocate } from '../money/allocate.ts'
import { type Minor, ZERO, abs, add, minor, sub } from '../money/minor.ts'

/**
 * «كشف التسوية» — what happens to the cash in the driver's hands when a shift closes.
 *
 * The owner's requirement, verbatim: «يجب بعد كل نهاية نوبة ان توضح كم يجب ان يسحب و يدخل للصندوق
 * وكم يجب ان يعاد للسائق، اي مبلغ اضافي يعاد للسائق و اي نقص يرمم من حصة السائق، مع التوضيح و مرونة
 * بالتعديل من قبل المدير».
 *
 * ── WHY THIS IS NOT JUST «BR1 MINUS SOMETHING» ───────────────────────────────────────────────
 *
 * BR1 answers «does the money add up». This answers «so where does it go», and they are different
 * questions with different inputs. BR1 compares DECLARED against EXPECTED; this one distributes the
 * declared cash between three destinations that must sum back to it exactly:
 *
 *     يدخل إلى خزينة الفرع  +  يُعاد للسائق  +  يبقى تمويل النوبة التالية  ===  النقد المصرَّح به
 *
 * That identity is the whole safety property, and it is property-tested. Anything that does not
 * conserve the driver's cash is inventing or destroying money on the way to the box.
 *
 * ── THE VARIANCE IS ALWAYS ZERO ON A NORMAL APPROVAL, AND THAT IS NOT A BUG ───────────────────
 *
 * `canApproveClose` refuses unless BR1 is EXACTLY zero (`shift/state.ts`, reason `br1_not_zero`).
 * So on the ordinary path `endCashDeclared === expectedCash`, the shortfall and surplus branches
 * below are dead, and the statement is a pure distribution: the box, his share, and any funding
 * retained for his next shift.
 *
 * They come alive only on FORCE-CLOSE, which is the one path that admits a gap — and that is
 * exactly what owner decision (k) asks for: the refusal stays the default, the manager closes
 * deliberately with a written reason, and the shortfall comes off the driver's share. Writing the
 * arithmetic here rather than only in the force-close route means both paths produce one shape, and
 * the manager reads the same statement either way.
 *
 * PURE and string-free, like everything in this package: it emits CODES and the UI resolves
 * `settlement.line.<code>`.
 */

export type SettlementLineCode =
  /** النقد المصرَّح به — what the driver says is in his hands. The thing being distributed. */
  | 'end_cash_declared'
  /** تمويل مرحّل من النوبة السابقة, already inside the float and shown so the total reconciles. */
  | 'opening_receivable'
  /** حصة السائق for this shift — the day-tier delta, and it MAY be negative. */
  | 'driver_share'
  /** يدخل إلى خزينة الفرع. */
  | 'to_office_cash'
  /** يبقى كتمويل للنوبة القادمة — the manager's decision. */
  | 'kept_as_receivable'
  /** يُعاد للسائق: his share, plus any surplus he is carrying. */
  | 'paid_to_driver'
  /** نقص مرمَّم من حصة السائق (force-close only). */
  | 'withheld_from_share'
  /** نقص يتجاوز حصته كلها — becomes a receivable rather than vanishing (force-close only). */
  | 'residual_receivable'
  /** تعديل المدير — signed, and it always carries a reason. */
  | 'manager_adjustment'

export type SettlementRefusalCode =
  /** He cannot keep more than he is holding. */
  | 'keep_exceeds_end_cash'
  /** The distribution would take more out of the box than the driver brought in. */
  | 'office_share_negative'

export interface SettlementInput {
  /** What the driver declared he holds. NOT «what he handed over» — see the note on `toOfficeCash`. */
  readonly endCashDeclared: Minor
  /** `Br1Result.expectedCash`. Equal to `endCashDeclared` on any normally-approvable shift. */
  readonly expectedCash: Minor
  /**
   * This shift's driver share — a day-level TRUE-UP DELTA, which **may be negative**.
   *
   * Decision D-6 makes the tier band a property of the whole day, so a later shift restates the
   * earlier ones and the delta for a given shift can legitimately be below zero. Every branch below
   * is written for that; see `recipes.ts:280-308` for the measured case.
   */
  readonly driverShare: Minor
  /** Next-shift funding carried IN at open. Already inside `floatTotal`; shown here for reconciliation. */
  readonly openingReceivable: Minor
  /** How much of tonight's cash stays with him as next-shift funding. The manager decides. */
  readonly keepAsReceivable: Minor
  /** Owner decision (f) is per-shift payment, so this is normally true. */
  readonly payShareNow: boolean
  /** Signed. The route requires a reason for any non-zero value and audits it. */
  readonly managerAdjustment: Minor
}

export interface SettlementLine {
  readonly code: SettlementLineCode
  readonly amount: Minor
}

export interface SettlementPlan {
  /** يدخل إلى خزينة الفرع. */
  readonly toOfficeCash: Minor
  /** يبقى كتمويل للنوبة القادمة، ويُستهلك تلقائياً عند فتحها. */
  readonly keptAsReceivable: Minor
  /** يُعاد للسائق. */
  readonly paidToDriver: Minor
  /** نقص مرمَّم من حصة السائق. Zero unless BR1 is negative, which only force-close allows. */
  readonly withheldFromShare: Minor
  /** A shortfall bigger than his whole share. Becomes a receivable rather than disappearing. */
  readonly residualReceivable: Minor
  /** What the company still owes him after tonight — non-zero when `payShareNow` is false. */
  readonly shareRemainingPayable: Minor
  /** For display, in reading order. Zero-valued lines are omitted. */
  readonly lines: readonly SettlementLine[]
  readonly feasible: boolean
  readonly refusals: readonly SettlementRefusalCode[]
}

const max = (a: Minor, b: Minor): Minor => (a > b ? a : b)
const min = (a: Minor, b: Minor): Minor => (a < b ? a : b)

/**
 * Distribute the declared cash. Total-function: it always returns a plan, and marks it infeasible
 * rather than throwing, so the manager sees WHY on the screen instead of a 500.
 */
export function planSettlement(input: SettlementInput): SettlementPlan {
  const variance = sub(input.endCashDeclared, input.expectedCash)
  const shortfall = variance < ZERO ? minor(-variance) : ZERO
  const surplus = max(variance, ZERO)

  /*
   * A NEGATIVE share is not money owed BY the driver — it is a downward restatement of what he was
   * already credited earlier in the day, and it settles against the ledger, not against tonight's
   * cash. Clamping to zero here keeps it out of the distribution; `shareRemainingPayable` carries
   * the true signed figure so nothing is lost.
   */
  const shareDue = max(input.driverShare, ZERO)

  // Decision (k): the shortfall comes off his share FIRST, and only what exceeds the whole share
  // becomes a receivable. Never `allocate()` on a negative — both terms here are non-negative and
  // the result is a difference of two of them, which is the rule money rule 5 states.
  const withheldFromShare = min(shortfall, shareDue)
  const residualReceivable = sub(shortfall, withheldFromShare)
  const payable = sub(shareDue, withheldFromShare)

  const paidToDriver = add(input.payShareNow ? payable : ZERO, surplus)
  const toOfficeCash = add(
    sub(sub(input.endCashDeclared, input.keepAsReceivable), paidToDriver),
    input.managerAdjustment,
  )

  const refusals: SettlementRefusalCode[] = []
  if (input.keepAsReceivable > input.endCashDeclared) refusals.push('keep_exceeds_end_cash')
  if (toOfficeCash < ZERO) refusals.push('office_share_negative')

  const lines: SettlementLine[] = []
  const push = (code: SettlementLineCode, amount: Minor): void => {
    if (amount !== ZERO) lines.push({ code, amount })
  }
  push('end_cash_declared', input.endCashDeclared)
  push('opening_receivable', input.openingReceivable)
  push('driver_share', input.driverShare)
  push('withheld_from_share', withheldFromShare)
  push('residual_receivable', residualReceivable)
  push('manager_adjustment', input.managerAdjustment)
  push('paid_to_driver', paidToDriver)
  push('kept_as_receivable', input.keepAsReceivable)
  push('to_office_cash', toOfficeCash)

  return {
    toOfficeCash,
    keptAsReceivable: input.keepAsReceivable,
    paidToDriver,
    withheldFromShare,
    residualReceivable,
    shareRemainingPayable: input.payShareNow ? sub(input.driverShare, payable) : input.driverShare,
    lines,
    feasible: refusals.length === 0,
    refusals,
  }
}

// ── Fixed-40, full-wallet settlement ─────────────────────────────────────────────────────

export type WalletSettlementAction = 'collect' | 'fund' | 'none'
export type CashSettlementAction = 'collect' | 'pay' | 'none'

export interface SettlementAction<Action extends string> {
  readonly action: Action
  /** Always an absolute magnitude. Direction lives in `action`, never in this number. */
  readonly amount: Minor
}

/**
 * Inputs owned by the server at approval time.
 *
 * `expectedCash` and `expectedWallet` are BR1's post-deduction balances. The dedicated cash
 * deduction term appears again in the employee's earnings because the operation both left his
 * physical cash and is his responsibility; this is not double-counting. Subtracting it on both
 * sides is precisely what keeps the office entitlement unchanged.
 */
export interface FixedShareSettlementInput {
  /** Gross fees of included Yallago deliveries on this shift. Manual jobs are excluded. */
  readonly deliveryFeeTotal: Minor
  /** Exactly floor(40% × deliveryFeeTotal), supplied by the caller's fixed split. */
  readonly fixedDriverShare: Minor
  /** Manager-agreed driver shares of included manual jobs on this shift. */
  readonly manualDriverShare: Minor
  /** Included negative recent-order rows, as one positive magnitude. */
  readonly cashDeductionTotal: Minor
  readonly expectedCash: Minor
  readonly expectedWallet: Minor
  /** What the driver declared before the manager performs the closing cash transaction. */
  readonly actualCash: Minor
  /** The complete app-wallet balance. Positive is collected; negative must be funded to reach 0. */
  readonly actualWallet: Minor
  /** Legacy-named positive cash collection retained as automatically consumed next-shift funding. */
  readonly cashReceivableDeferred?: Minor
  /** Legacy-named positive wallet collection retained as automatically consumed next-shift funding. */
  readonly walletReceivableDeferred?: Minor
  /**
   * Closing shortage the manager deliberately leaves as an ordinary cash receivable.
   *
   * This is not new money handed to the driver and is not next-shift funding. The operational
   * custody already left the office earlier in this shift, so this amount replaces only the
   * employee's missing close-time contribution and must never credit the office a second time.
   */
  readonly cashShortageReceivable?: Minor
}

export interface FixedShareSettlementPlan {
  readonly deliveryFeeTotal: Minor
  readonly fixedDriverShare: Minor
  readonly manualDriverShare: Minor
  /** fixedDriverShare + manualDriverShare. */
  readonly grossDriverShare: Minor
  readonly cashDeductionTotal: Minor
  /** Signed: grossDriverShare − cashDeductionTotal. */
  readonly baseDriverShare: Minor
  readonly expectedCash: Minor
  readonly expectedWallet: Minor
  readonly expectedTotal: Minor
  readonly actualCash: Minor
  readonly actualWallet: Minor
  readonly actualTotal: Minor
  /** Signed BR1 scalar variance: actualTotal − expectedTotal. */
  readonly variance: Minor
  /**
   * Signed cash left with / due from the employee after the close.
   * Positive means he keeps or receives it; negative means he contributes its absolute value.
   */
  readonly finalEmployeeCash: Minor
  /** The invariant office claim before choosing which physical box receives it. */
  readonly officeEntitlement: Minor
  /** Signed cash claim before any amount is deliberately deferred. */
  readonly cashClaimToOffice: Minor
  /** Signed wallet claim before any amount is deliberately deferred. Equal to actualWallet. */
  readonly walletClaimToOffice: Minor
  /** Legacy-named non-negative cash claim posted to the driver's next-shift funding. */
  readonly cashReceivableDeferred: Minor
  /** Legacy-named non-negative wallet claim posted to the driver's next-shift funding. */
  readonly walletReceivableDeferred: Minor
  /** Maximum current-shift shortage that may remain unpaid: `max(-finalEmployeeCash, 0)`. */
  readonly maximumCashShortageReceivable: Minor
  /** Current-shift shortage posted to the ordinary cash receivable instead of collected now. */
  readonly cashShortageReceivable: Minor
  /** Signed physical office-cash movement after deferral. Positive collects; negative pays. */
  readonly cashToOffice: Minor
  /** Signed physical office-wallet movement after deferral. */
  readonly walletToOffice: Minor
  readonly wallet: SettlementAction<WalletSettlementAction>
  readonly cash: SettlementAction<CashSettlementAction>
}

function requireNonNegative(label: string, amount: Minor): void {
  if (amount < ZERO) throw new RangeError(`${label} must be non-negative, got ${amount}`)
}

function walletAction(amount: Minor): SettlementAction<WalletSettlementAction> {
  return {
    action: amount > ZERO ? 'collect' : amount < ZERO ? 'fund' : 'none',
    amount: abs(amount),
  }
}

function cashAction(amount: Minor): SettlementAction<CashSettlementAction> {
  return {
    action: amount > ZERO ? 'collect' : amount < ZERO ? 'pay' : 'none',
    amount: abs(amount),
  }
}

/**
 * Settle a shift by clearing both operational funds. A manager may let the driver retain part of a
 * positive office collection as next-shift funding. It posts to `driver_shift_funding_cash` or
 * `driver_shift_funding_wallet` and is consumed automatically when that driver opens the next
 * shift; it is not an ordinary receivable awaiting a separate collection command. The public
 * `*ReceivableDeferred` identifiers are retained only as legacy wire/database names.
 *
 * The essential identities are:
 *
 *     base share          B = 40% Yallago share + manual share − deductions
 *     scalar variance     V = actual total − expected total
 *     employee cash       N = B + V
 *     cash claim          X0 = expected total − B − actual wallet
 *     physical cash       X  = X0 − deferred cash funding
 *     physical wallet     W  = actual wallet − deferred wallet funding
 *
 * Therefore physical movements plus both retained funding balances always give the office exactly
 * `expectedTotal − B`, independent of where the driver happened to hold the money.
 */
export function planFixedShareSettlement(input: FixedShareSettlementInput): FixedShareSettlementPlan {
  requireNonNegative('delivery fee total', input.deliveryFeeTotal)
  requireNonNegative('fixed driver share', input.fixedDriverShare)
  requireNonNegative('manual driver share', input.manualDriverShare)
  requireNonNegative('cash deduction total', input.cashDeductionTotal)
  requireNonNegative('actual cash', input.actualCash)
  const cashReceivableDeferred = input.cashReceivableDeferred ?? ZERO
  const walletReceivableDeferred = input.walletReceivableDeferred ?? ZERO
  const cashShortageReceivable = input.cashShortageReceivable ?? ZERO
  requireNonNegative('deferred cash funding', cashReceivableDeferred)
  requireNonNegative('deferred wallet funding', walletReceivableDeferred)
  requireNonNegative('cash shortage receivable', cashShortageReceivable)

  const canonicalFixedShare = allocate(input.deliveryFeeTotal, FIXED_DRIVER_BPS, 'floor')
  if (input.fixedDriverShare !== canonicalFixedShare) {
    throw new RangeError(
      `fixed driver share must equal floor(${FIXED_DRIVER_BPS}bps × ${input.deliveryFeeTotal}), ` +
      `got ${input.fixedDriverShare} instead of ${canonicalFixedShare}`,
    )
  }

  const grossDriverShare = add(input.fixedDriverShare, input.manualDriverShare)
  const baseDriverShare = sub(grossDriverShare, input.cashDeductionTotal)
  const expectedTotal = add(input.expectedCash, input.expectedWallet)
  const actualTotal = add(input.actualCash, input.actualWallet)
  const variance = sub(actualTotal, expectedTotal)
  const finalEmployeeCash = add(baseDriverShare, variance)
  const maximumCashShortageReceivable = finalEmployeeCash < ZERO ? abs(finalEmployeeCash) : ZERO
  const officeEntitlement = sub(expectedTotal, baseDriverShare)
  const cashClaimToOffice = sub(officeEntitlement, input.actualWallet)
  const walletClaimToOffice = input.actualWallet

  // Retained next-shift funding may replace only value the office was otherwise about to COLLECT.
  // When a signed action is already a payout/funding operation, deferring it would create an office
  // liability rather than retain office value with the driver, and belongs to a different workflow.
  const maximumCashReceivable = cashClaimToOffice > ZERO ? cashClaimToOffice : ZERO
  const maximumWalletReceivable = walletClaimToOffice > ZERO ? walletClaimToOffice : ZERO
  if (cashReceivableDeferred > maximumCashReceivable) {
    throw new RangeError(
      `deferred cash funding ${cashReceivableDeferred} exceeds collectible cash ${maximumCashReceivable}`,
    )
  }
  if (walletReceivableDeferred > maximumWalletReceivable) {
    throw new RangeError(
      `deferred wallet funding ${walletReceivableDeferred} exceeds collectible wallet ${maximumWalletReceivable}`,
    )
  }
  if (cashShortageReceivable > maximumCashShortageReceivable) {
    throw new RangeError(
      `cash shortage receivable ${cashShortageReceivable} exceeds unpaid employee cash ${maximumCashShortageReceivable}`,
    )
  }

  const cashToOffice = sub(sub(cashClaimToOffice, cashReceivableDeferred), cashShortageReceivable)
  const walletToOffice = sub(walletClaimToOffice, walletReceivableDeferred)

  // This identity is kept executable rather than documentation-only. A future edit that changes
  // one side of the settlement cannot quietly invent or destroy a minor unit.
  if (
    sub(input.actualCash, cashToOffice) !==
    add(add(finalEmployeeCash, cashReceivableDeferred), cashShortageReceivable)
  ) {
    throw new RangeError('fixed-share settlement does not conserve the closing cash')
  }
  if (sub(input.actualWallet, walletToOffice) !== walletReceivableDeferred) {
    throw new RangeError('fixed-share settlement does not conserve the closing wallet')
  }
  if (
    add(
      add(cashToOffice, walletToOffice),
      add(add(cashReceivableDeferred, walletReceivableDeferred), cashShortageReceivable),
    ) !==
    officeEntitlement
  ) {
    throw new RangeError('fixed-share settlement does not conserve the office entitlement')
  }

  return {
    deliveryFeeTotal: input.deliveryFeeTotal,
    fixedDriverShare: input.fixedDriverShare,
    manualDriverShare: input.manualDriverShare,
    grossDriverShare,
    cashDeductionTotal: input.cashDeductionTotal,
    baseDriverShare,
    expectedCash: input.expectedCash,
    expectedWallet: input.expectedWallet,
    expectedTotal,
    actualCash: input.actualCash,
    actualWallet: input.actualWallet,
    actualTotal,
    variance,
    finalEmployeeCash,
    officeEntitlement,
    cashClaimToOffice,
    walletClaimToOffice,
    cashReceivableDeferred,
    walletReceivableDeferred,
    maximumCashShortageReceivable,
    cashShortageReceivable,
    cashToOffice,
    walletToOffice,
    wallet: walletAction(walletToOffice),
    cash: cashAction(cashToOffice),
  }
}
