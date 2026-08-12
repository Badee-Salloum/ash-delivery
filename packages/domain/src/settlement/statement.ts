import { type Minor, ZERO, add, minor, sub } from '../money/minor.ts'

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
 *     يدخل إلى خزينة الفرع  +  يُعاد للسائق  +  يبقى ذمة  ===  النقد المصرَّح به
 *
 * That identity is the whole safety property, and it is property-tested. Anything that does not
 * conserve the driver's cash is inventing or destroying money on the way to the box.
 *
 * ── THE VARIANCE IS ALWAYS ZERO ON A NORMAL APPROVAL, AND THAT IS NOT A BUG ───────────────────
 *
 * `canApproveClose` refuses unless BR1 is EXACTLY zero (`shift/state.ts`, reason `br1_not_zero`).
 * So on the ordinary path `endCashDeclared === expectedCash`, the shortfall and surplus branches
 * below are dead, and the statement is a pure distribution: the box, his share, and any ذمة.
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
  /** ذمة مرحّلة من اليوم السابق, already inside the float and shown so the total reconciles. */
  | 'opening_receivable'
  /** حصة السائق for this shift — the day-tier delta, and it MAY be negative. */
  | 'driver_share'
  /** يدخل إلى خزينة الفرع. */
  | 'to_office_cash'
  /** يبقى ذمة على السائق — the manager's decision. */
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
  /** ذمة carried IN at open. Already inside `floatTotal`; carried here only so the statement reads. */
  readonly openingReceivable: Minor
  /** How much of tonight's cash stays with him. The MANAGER decides this (owner decision (g)). */
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
  /** يبقى ذمة على السائق. */
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
