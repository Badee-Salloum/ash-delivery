import { type Minor, ZERO, abs, add, minor, sub } from '../money/minor.ts'
import {
  type OfficeFund,
  type Posting,
  assertBalanced,
  fundFromCompany,
  sweepToCompany,
} from '../ledger/recipes.ts'

/**
 * «الترميم» — the daily restoration, in the owner's own words.
 *
 * «راس مال المكتب رقم ثابت لكل من المحفظة و كاش المكتب. في نهاية كل يوم عمل يتم عملية اسمها ترميم،
 * الهدف منها سحب الارباح و ترميم النقص و اعادة راس المال على وضعه السابق مع مراعاة توزع الذمم.»
 *
 * Office capital is a FIXED TARGET per box. Every working day each live office-ledger balance is
 * settled against صندوق الشركة: a surplus is withdrawn as profit («كييش»), a shortfall is
 * replenished («شحن من الصندوق»), and الذمم COUNT TOWARD the capital.
 *
 * His own spreadsheet is the specification, and it verifies exactly:
 *
 *     كاش المكتب    3,600,000 + ذمم 400,000 = 4,000,000 = رأس المال   → delta 0
 *     محفظة المكتب    970,000 + ذمم  30,000 = 1,000,000 = رأس المال   → delta 0
 *
 * Both landing on target is a day already restored, which is what his `=SUM(...)-4000000`
 * formulae evaluate to. `restoration.test.ts` encodes those two rows verbatim.
 *
 * ── THE SUBTLETY THE ذمم INTRODUCE, WHICH IS NOT A BUG ────────────────────────────────────────
 *
 * The sweep is computed on `officeBalance + receivables`, so a box holding 5,000,000 cash with 400,000
 * out on ذمم against a 4,000,000 target sweeps 1,400,000 and is LEFT BELOW its own target, at
 * 3,600,000. That is correct: the missing 400,000 is not lost, it is in a driver's pocket and
 * returns tomorrow when he opens on it. Counting it is exactly why the owner's formula adds الذمم.
 *
 * What must never happen is sweeping more than the live office fund holds — hence the retained
 * `sweep_exceeds_counted`.
 *
 * PURE and string-free: it emits codes and postings, and the UI resolves the words.
 */

export type RestorationDirection =
  /** «كييش» — surplus withdrawn to صندوق الشركة as profit. */
  | 'to_company'
  /** «شحن من الصندوق» — the company fund restores the office capital. */
  | 'from_company'

export type RestorationRefusalCode =
  /** The surplus is real but the live office fund cannot cover the transfer — it is out on ذمم. */
  | 'sweep_exceeds_counted'
  /** No رأس مال is configured for this box, so there is nothing to restore TO. */
  | 'no_capital_target'

export interface FundPosition {
  readonly fundCode: OfficeFund
  /** The office fund's live double-entry balance, read inside the branch-money transaction. */
  readonly officeBalance: Minor
  /** Σ الذمم outstanding against THIS box. Counts toward the capital (the owner's own rule). */
  readonly receivables: Minor
  /** رأس مال المكتب — the fixed target. `null` ⇒ not configured, and the leg is refused. */
  readonly capitalTarget: Minor | null
}

export interface RestorationLeg {
  readonly fundCode: OfficeFund
  /** The live opening office balance frozen in the immutable restoration snapshot. */
  readonly officeBalance: Minor
  /** Outstanding driver debt assigned to this box and counted as office capital. */
  readonly receivables: Minor
  /** officeBalance + receivables — «الوضع الحالي». */
  readonly position: Minor
  readonly capitalTarget: Minor
  /** position − target. SIGNED: positive is a surplus, negative a shortfall. */
  readonly delta: Minor
  /** `null` when the box is already exactly on target and nothing should post. */
  readonly direction: RestorationDirection | null
  /** |delta| — what actually moves. */
  readonly amount: Minor
  readonly feasible: boolean
  readonly refusals: readonly RestorationRefusalCode[]
}

export interface RestorationPlan {
  readonly legs: readonly RestorationLeg[]
  /** Signed: positive is net profit taken, negative net capital restored. */
  readonly netToCompany: Minor
  readonly feasible: boolean
  readonly refusals: readonly RestorationRefusalCode[]
}

export interface CashCountVarianceLine {
  readonly fundCode: OfficeFund
  /** Physical count minus the ledger balance frozen when the count was sealed. */
  readonly variance: Minor
  /** The manager's line-specific explanation from the immutable count evidence. */
  readonly resolution: string | null
}

/**
 * Make a signed cash-count variance explicit before restoration.
 *
 * A restoration plan is deliberately based on the physical count. Posting that plan directly
 * against an unreconciled ledger leaves the office fund off target by exactly the count variance.
 * These balanced corrections first align the ledger with the sealed physical fact. Their contra
 * account is a dedicated variance cost centre, never `company_box`: a missing banknote is not a
 * transfer to the company fund, and presenting it as one would overstate profit/restoration flow.
 *
 * The occurrence key binds each correction to the count id, its SHA-256 proof, and the exact box.
 * The journal reason is supplied by the service from the manager's required restoration reason;
 * the line-specific resolution remains frozen in the restoration record beside these postings.
 */
export function postingsForCashCountReconciliation(input: {
  readonly branchId: string
  readonly cashCountId: string
  readonly proofSha256: string
  readonly lines: readonly CashCountVarianceLine[]
}): Posting[] {
  if (input.branchId.trim() === '') throw new RangeError('cash-count reconciliation requires a branch id')
  if (input.cashCountId.trim() === '') throw new RangeError('cash-count reconciliation requires a count id')
  if (!/^[0-9a-f]{64}$/i.test(input.proofSha256)) {
    throw new RangeError('cash-count reconciliation requires a SHA-256 proof')
  }

  return input.lines.flatMap((line): Posting[] => {
    if (line.variance === ZERO) return []
    if (!line.resolution || line.resolution.trim() === '') {
      throw new RangeError(`cash-count variance for ${line.fundCode} requires a resolution`)
    }

    const amount = abs(line.variance)
    const office = { kind: line.fundCode } as const
    const variance = {
      kind: 'cost_center' as const,
      costCenterId: `cash_count_variance:${input.branchId}:${line.fundCode}`,
    }
    const officeSide = line.variance > ZERO ? 'D' : 'C'
    const varianceSide = line.variance > ZERO ? 'C' : 'D'

    return [assertBalanced({
      eventType: 'correction',
      occurrenceKey: `cash-count:${input.cashCountId}:${input.proofSha256}:${line.fundCode}`,
      lines: [
        { fund: office, side: officeSide, amount, role: 'cash_count_reconciled_fund' },
        { fund: variance, side: varianceSide, amount, role: 'cash_count_variance_counterpart' },
      ],
    })]
  })
}

/** Total function: it always returns a plan, and marks a leg infeasible rather than throwing. */
export function planRestoration(positions: readonly FundPosition[]): RestorationPlan {
  const legs: RestorationLeg[] = positions.map((p) => {
    const refusals: RestorationRefusalCode[] = []
    if (p.capitalTarget === null) {
      // Without a target every box looks like pure surplus, and a first run would sweep the entire
      // treasury to the company fund. Refusing is the only safe reading of "not configured".
      return {
        fundCode: p.fundCode,
        officeBalance: p.officeBalance,
        receivables: p.receivables,
        position: add(p.officeBalance, p.receivables),
        capitalTarget: ZERO,
        delta: ZERO,
        direction: null,
        amount: ZERO,
        feasible: false,
        refusals: ['no_capital_target'],
      }
    }

    const position = add(p.officeBalance, p.receivables)
    const delta = sub(position, p.capitalTarget)
    const amount = delta < ZERO ? minor(-delta) : delta
    const direction: RestorationDirection | null = delta === ZERO ? null : delta > ZERO ? 'to_company' : 'from_company'

    // You cannot transfer more than the office fund holds. A surplus funded entirely by ذمم is
    // real on paper but unavailable in the office account.
    if (direction === 'to_company' && amount > p.officeBalance) refusals.push('sweep_exceeds_counted')

    return {
      fundCode: p.fundCode,
      officeBalance: p.officeBalance,
      receivables: p.receivables,
      position,
      capitalTarget: p.capitalTarget,
      delta,
      direction,
      amount,
      feasible: refusals.length === 0,
      refusals,
    }
  })

  const netToCompany = legs
    .filter((l) => l.feasible)
    .reduce((acc, l) => (l.direction === 'to_company' ? add(acc, l.amount) : l.direction === 'from_company' ? sub(acc, l.amount) : acc), ZERO)

  return {
    legs,
    netToCompany,
    feasible: legs.every((l) => l.feasible),
    refusals: [...new Set(legs.flatMap((l) => l.refusals))],
  }
}

/**
 * The postings for a plan. One per moving leg; a box already on target emits nothing.
 *
 * `keyPrefix` is the business date, so the idempotency index refuses a second ترميم for the same
 * day on the same box — the restoration is once per working day by construction, not by a check
 * somebody has to remember to write.
 */
export function postingsForRestoration(plan: RestorationPlan, keyPrefix: string): Posting[] {
  const postings: Posting[] = []
  for (const leg of plan.legs) {
    if (!leg.feasible || leg.direction === null || leg.amount === ZERO) continue
    const key = `${keyPrefix}:${leg.fundCode}`
    postings.push(
      leg.direction === 'to_company'
        ? sweepToCompany(leg.fundCode, leg.amount, key)
        : fundFromCompany(leg.fundCode, leg.amount, key),
    )
  }
  return postings
}

/**
 * The post-condition, and the acceptance test for the whole feature:
 *
 *     fundBalance(box) + Σ ذمم  ===  رأس مال المكتب
 *
 * This is his `=SUM(I38:J48)-4000000` evaluating to zero, expressed as a system invariant.
 */
export function restoredPosition(leg: RestorationLeg, receivables: Minor): Minor {
  const after = leg.direction === 'to_company' ? sub(leg.position, leg.amount) : add(leg.position, leg.amount)
  return sub(after, add(receivables, ZERO))
}
