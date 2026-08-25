import { type Minor, ZERO, abs, add, minor, neg, sub, sum } from '../money/minor.ts'
import { type FeeTotals, type Rounding } from '../money/allocate.ts'
import type { BlockSplit } from '../money/allocate.ts'
import { type PayMode, type ShiftOrder, orderWalletAmount, orderYalagoCut, totalFeesOfOrders } from '../br1/equation.ts'
import { type FixedShareSettlementPlan, planFixedShareSettlement } from '../settlement/statement.ts'

/**
 * The posting recipes: every way money is allowed to move.
 *
 * These are pure. They emit balanced line sets; persisting them is `packages/db`'s job.
 *
 * ── The account model ───────────────────────────────────────────────────────────────────
 * Convention: DEBIT increases a fund, CREDIT decreases it. The client's funds tree (SRS E-1)
 * plus three accounts the tree implies but does not name:
 *
 *   fee_earned            revenue recognised when an order completes, closed out at approval
 *   company_revenue       the company's side of the block, recognised at approval (BR4)
 *   yalago_income         Yallago's 20%, recognised at approval so all three shares close out
 *                         of one account and provably exhaust the fee total
 *
 * `yalago_share` is the FUND from SRS E-1 — it accumulates what has actually left the driver's
 * wallet for Yallago. `yalago_income` is the P&L recognition of the same 20%. They are separate
 * on purpose: one answers "how much have we handed over", the other "what did it cost us".
 *
 * ── Why an order produces TWO postings ──────────────────────────────────────────────────
 * The SRS's own event list has `order_fee` and `yalago_cut` as distinct events, and the split
 * is what makes all three payment modes share one shape:
 *
 *   order_fee   debits whichever asset physically received the fee, credits fee_earned
 *   yalago_cut  debits yalago_share, credits driver_wallet   — identical for all three modes
 *
 * Cash lands in `driver_cash`; electronic and free land in `driver_wallet`. Both then lose the
 * 20% from the wallet, which is exactly BR2's instant deduction. Net wallet effect is −cut for
 * a cash order and +block for the other two — precisely what BR1 expects.
 */

export type LedgerEvent =
  | 'float_out'
  | 'wallet_topup'
  | 'order_fee'
  | 'yalago_cut'
  | 'wallet_adjustment'
  | 'driver_cash_deduction'
  | 'share_split'
  | 'float_return'
  | 'wallet_return'
  | 'expense'
  | 'manual'
  | 'correction'
  /** «الترميم» — the daily sweep of profit to صندوق الشركة, or the replenishment of office capital. */
  | 'restoration'
  /** The driver taking his share. */
  | 'driver_payout'
  /** Direct driver receivable creation or later collection, outside a shift. */
  | 'receivable_adjustment'

export type FundRef =
  | { readonly kind: 'office_cash' }
  | { readonly kind: 'office_wallet' }
  | { readonly kind: 'driver_cash'; readonly driverId: string }
  | { readonly kind: 'driver_wallet'; readonly driverId: string }
  | { readonly kind: 'yalago_share' }
  | { readonly kind: 'driver_share_payable'; readonly driverId: string }
  | { readonly kind: 'company_revenue' }
  | { readonly kind: 'yalago_income' }
  | { readonly kind: 'fee_earned' }
  /**
   * «صندوق الشركة» — where profit goes, and where an office capital shortfall is funded from.
   *
   * BRANCH-SCOPED like every other fund, deliberately. `funds.branch_id` is NOT NULL and both
   * unique constraints key on it; making it nullable would turn `funds_code_uq` into two partial
   * indexes (Postgres treats NULLs as distinct, so the constraint would stop preventing
   * duplicates), split `ensureFund`'s ON CONFLICT target, and push `OR branch_id IS NULL` into the
   * query behind every treasury balance. A wide, irreversible change to a live ledger for no
   * benefit at one branch. The AGGREGATE across branches is صندوق الشركة, and this way it also
   * records which branch each sweep came from.
   */
  | { readonly kind: 'company_box' }
  /**
   * «الذمم» — cash a named driver kept past the close, and its wallet counterpart.
   *
   * TWO kinds because the owner's own book has two: receivables sit against كاش المكتب (400,000)
   * AND against محفظة المكتب (30,000), and الترميم must know which capital target each counts
   * toward. This is the ordinary receivable: an office asset owed by the driver until an explicit
   * later collection. It is never auto-consumed by opening a shift; `driver_shift_funding_*` below
   * is the separate kind reserved for that workflow.
   */
  | { readonly kind: 'driver_receivable_cash'; readonly driverId: string }
  | { readonly kind: 'driver_receivable_wallet'; readonly driverId: string }
  /** Money already advanced specifically for automatic use at the driver's next shift open. */
  | { readonly kind: 'driver_shift_funding_cash'; readonly driverId: string }
  | { readonly kind: 'driver_shift_funding_wallet'; readonly driverId: string }
  | { readonly kind: 'cost_center'; readonly costCenterId: string }

/** The two branch funds that hold real value and are counted, restored and swept. */
export type OfficeFund = 'office_cash' | 'office_wallet'

export interface PostingLine {
  readonly fund: FundRef
  readonly side: 'D' | 'C'
  readonly amount: Minor
  readonly role?: string
}

export interface Posting {
  readonly eventType: LedgerEvent
  /**
   * Discriminates repeated occurrences of the same event on one shift. Together with
   * (shift_id, event_type) this is the idempotency key.
   *
   * The kickoff brief specifies (shift_id, event_type) alone. That is wrong and it loses money:
   * SRS C-5 allows several float and top-up tranches per day, so the second tranche cannot post
   * and an "idempotent replay" silently swallows it — cash leaves the office with no ledger
   * record. See ASSUMPTIONS A-10.
   */
  readonly occurrenceKey: string
  readonly lines: readonly PostingLine[]
}

export class UnbalancedPostingError extends Error {
  readonly posting: Posting
  readonly debits: Minor
  readonly credits: Minor
  constructor(posting: Posting, debits: Minor, credits: Minor) {
    super(`posting ${posting.eventType}/${posting.occurrenceKey} is unbalanced: D ${debits} <> C ${credits}`)
    this.name = 'UnbalancedPostingError'
    this.posting = posting
    this.debits = debits
    this.credits = credits
  }
}

export function debitsOf(posting: Posting): Minor {
  return sum(posting.lines.filter((l) => l.side === 'D').map((l) => l.amount))
}

export function creditsOf(posting: Posting): Minor {
  return sum(posting.lines.filter((l) => l.side === 'C').map((l) => l.amount))
}

/**
 * The invariant the database also enforces with a deferred constraint trigger. Checked here so
 * a recipe bug fails in a unit test rather than at COMMIT in production.
 */
export function assertBalanced(posting: Posting): Posting {
  const d = debitsOf(posting)
  const c = creditsOf(posting)
  if (d !== c) throw new UnbalancedPostingError(posting, d, c)
  if (posting.lines.length === 0) throw new UnbalancedPostingError(posting, d, c)
  for (const line of posting.lines) {
    if (line.amount <= 0n) {
      throw new RangeError(
        `line amounts must be strictly positive; direction is carried by 'side'. Got ${line.amount}`,
      )
    }
  }
  return posting
}

const D = (fund: FundRef, amount: Minor, role?: string): PostingLine =>
  role === undefined ? { fund, side: 'D', amount } : { fund, side: 'D', amount, role }
const C = (fund: FundRef, amount: Minor, role?: string): PostingLine =>
  role === undefined ? { fund, side: 'C', amount } : { fund, side: 'C', amount, role }

/** Append a signed fund movement without ever placing a signed amount on a journal line. */
function signedLine(lines: PostingLine[], fund: FundRef, movement: Minor, role: string): void {
  if (movement > ZERO) lines.push(D(fund, movement, role))
  else if (movement < ZERO) lines.push(C(fund, abs(movement), role))
}

// ── Gate postings ─────────────────────────────────────────────────────────────────────────

/** Cash float handed to the driver at open. One posting per tranche (C-5). */
export function floatOut(driverId: string, amount: Minor, tranche: string | number = 1): Posting {
  return assertBalanced({
    eventType: 'float_out',
    // A KEY, not an ordinal. An ordinal is recomputed from the current row on every request, so a
    // retried disbursement lands on the next number and hands out the cash twice; only the caller
    // knows whether this is a second tranche (SRS C-5 allows several) or the same one again.
    occurrenceKey: String(tranche),
    lines: [D({ kind: 'driver_cash', driverId }, amount), C({ kind: 'office_cash' }, amount)],
  })
}

/** Wallet top-up at open. One posting per tranche (C-5). */
export function walletTopup(driverId: string, amount: Minor, tranche: string | number = 1): Posting {
  return assertBalanced({
    eventType: 'wallet_topup',
    /** See {@link floatOut}: the caller's key, because only the caller can tell a retry apart. */
    occurrenceKey: String(tranche),
    lines: [D({ kind: 'driver_wallet', driverId }, amount), C({ kind: 'office_wallet' }, amount)],
  })
}

/** The float returned in full at end of day. */
export function floatReturn(driverId: string, amount: Minor): Posting {
  return assertBalanced({
    eventType: 'float_return',
    occurrenceKey: '1',
    lines: [D({ kind: 'office_cash' }, amount), C({ kind: 'driver_cash', driverId }, amount)],
  })
}

/**
 * The end-of-day cash, split between the box, a ذمة, and the share the driver keeps.
 *
 * ONE POSTING, NOT THREE, and that is the whole design. `driver_cash` is credited once for the
 * entire closing balance, so it lands on EXACTLY ZERO however the money is distributed — the
 * invariant `recipes.test.ts` pins and the reason this is not a `float_return` plus two extra
 * events. The event type and occurrence key are unchanged, so the idempotency index sees the same
 * row it always did.
 *
 * The three debits, in the owner's own terms:
 *   • `office_cash`              «يدخل إلى خزينة الفرع»
 *   • `driver_receivable_cash`   «يبقى ذمة على السائق» — the manager's decision (owner decision g)
 *   • `driver_share_payable`     «يُعاد للسائق» — he keeps his share out of the cash in his hands
 *
 * DEBITING `driver_share_payable` DISCHARGES A LIABILITY. `shareSplit` credits it; this payout and a
 * separately classified `driverCashDeduction` are the explicit ways to debit it. Owner decision
 * (f) pays the remaining share at the end of a shift, out of cash he is already holding.
 *
 * With both extras zero this emits exactly the two lines `floatReturn` always did.
 */
export function floatReturnSplit(
  driverId: string,
  endCash: Minor,
  keptAsReceivable: Minor,
  sharePaid: Minor,
): Posting {
  const toOffice = sub(sub(endCash, keptAsReceivable), sharePaid)
  if (toOffice < 0n) {
    throw new RangeError(
      `the split exceeds the closing cash: ${keptAsReceivable} kept + ${sharePaid} paid > ${endCash}`,
    )
  }
  const lines: PostingLine[] = []
  // Zero lines are omitted, not pushed — `assertBalanced` requires every amount to be strictly
  // positive because direction is carried by `side` and a zero has no direction to carry.
  if (toOffice > 0n) lines.push(D({ kind: 'office_cash' }, toOffice, 'to_office'))
  if (keptAsReceivable > 0n) {
    lines.push(D({ kind: 'driver_receivable_cash', driverId }, keptAsReceivable, 'kept_as_receivable'))
  }
  if (sharePaid > 0n) lines.push(D({ kind: 'driver_share_payable', driverId }, sharePaid, 'driver_payout'))
  lines.push(C({ kind: 'driver_cash', driverId }, endCash))
  return assertBalanced({ eventType: 'float_return', occurrenceKey: '1', lines })
}

/**
 * A ذمة carried INTO a new shift — «should be handled when he starts a new shift» (owner decision c).
 *
 * He already holds the cash, so the office hands over only the difference. Posting it as a
 * `float_out` that credits the RECEIVABLE instead of `office_cash` is what makes that true in the
 * ledger: the driver's cash rises exactly as it would have, the receivable clears, and no money
 * leaves the branch box for something it already paid out yesterday.
 *
 * Keeping the `float_out` event type also keeps BR1 in its ABSOLUTE form (CLAUDE.md decision 4) —
 * the carried amount is simply another float tranche, and the equation needs no opening balance.
 */
export function floatCarry(driverId: string, amount: Minor, tranche: string | number = 1): Posting {
  return assertBalanced({
    eventType: 'float_out',
    // Namespaced away from `addTranche`'s ordinal keys, so a carry and a second cash tranche on the
    // same shift can never collide on (shift_id, event_type, occurrence_key).
    occurrenceKey: `carry-${tranche}`,
    lines: [
      D({ kind: 'driver_cash', driverId }, amount),
      C({ kind: 'driver_shift_funding_cash', driverId }, amount),
    ],
  })
}

/** Wallet funding already advanced for this driver's next shift; no office value leaves twice. */
export function walletCarry(driverId: string, amount: Minor, tranche: string | number = 1): Posting {
  return assertBalanced({
    eventType: 'wallet_topup',
    occurrenceKey: `carry-${tranche}`,
    lines: [
      D({ kind: 'driver_wallet', driverId }, amount),
      C({ kind: 'driver_shift_funding_wallet', driverId }, amount),
    ],
  })
}

/**
 * The wallet balance returned at end of day, zeroing the driver's wallet fund.
 *
 * Product-owner decision D-4: the wallet is zeroed daily exactly like the float, per the literal
 * SRS §1.4 / C-5 text «يُعاد كاملاً آخر النهار». The §2.3 example's closing 70,000 is the balance
 * AT close, before this return.
 *
 * ── `amount` MAY BE NEGATIVE, and that is not a hypothetical ────────────────────────────
 * A driver who runs many cash orders on a small top-up drives the wallet below zero: every
 * cash order takes 20% of its fee OUT of the wallet (BR2) while putting nothing in. With a
 * 1,000 top-up and twenty 5,000 cash fees, Yallago wants 20,000 from a wallet holding 1,000.
 *
 * A property test found this by generating exactly that shape. The first version of this
 * function skipped the posting when the balance was negative, silently leaving the fund at −1
 * — money unaccounted for.
 *
 * Here the posting simply runs the other way: the office covers the shortfall. Whether the
 * shift should have been ALLOWED to reach that state is a separate, operational question —
 * see `minWalletBalance()`, which the close gate uses to surface it to the branch manager.
 */
export function walletReturn(driverId: string, amount: Minor): Posting {
  const magnitude = amount < 0n ? minor(-amount) : amount
  const lines: PostingLine[] =
    amount >= 0n
      ? [D({ kind: 'office_wallet' }, magnitude), C({ kind: 'driver_wallet', driverId }, magnitude)]
      : // The wallet closed negative: the office funds it back up to zero.
        [D({ kind: 'driver_wallet', driverId }, magnitude, 'wallet_shortfall'), C({ kind: 'office_wallet' }, magnitude)]
  return assertBalanced({ eventType: 'wallet_return', occurrenceKey: '1', lines })
}

/**
 * Create or collect a named driver's receivable without pretending it belonged to a shift.
 *
 * Creation reclassifies an office asset into a receivable, so total office capital is unchanged;
 * collection performs the exact reverse. The immutable command record supplies the human reason
 * and idempotency key, while the line roles make the direction obvious in the journal.
 */
export function receivableAdjustment(
  driverId: string,
  receivableKind: 'ordinary' | 'shift_funding',
  channel: 'cash' | 'wallet',
  direction: 'create' | 'collect',
  amount: Minor,
  occurrenceKey: string,
): Posting {
  if (amount <= ZERO) throw new RangeError(`receivable adjustment must be positive, got ${amount}`)
  const office: FundRef = channel === 'cash' ? { kind: 'office_cash' } : { kind: 'office_wallet' }
  const receivable: FundRef = receivableKind === 'shift_funding'
    ? channel === 'cash'
      ? { kind: 'driver_shift_funding_cash', driverId }
      : { kind: 'driver_shift_funding_wallet', driverId }
    : channel === 'cash'
      ? { kind: 'driver_receivable_cash', driverId }
      : { kind: 'driver_receivable_wallet', driverId }
  const lines = direction === 'create'
    ? [D(receivable, amount, 'receivable_created'), C(office, amount, 'office_value_reclassified')]
    : [D(office, amount, 'receivable_collected'), C(receivable, amount, 'receivable_cleared')]
  return assertBalanced({ eventType: 'receivable_adjustment', occurrenceKey, lines })
}

export interface CashSettledReturnInput {
  readonly driverId: string
  /** The exact immutable plan the manager reviewed and confirmed. */
  readonly settlement: FixedShareSettlementPlan
}

/**
 * A settlement plan crosses an application/domain boundary as a plain object, so its derived
 * fields are not protected by a runtime brand. Rebuild them from the seven source facts before
 * allowing that object to decide a journal. This also protects the audit snapshot: a caller cannot
 * preserve `cashToOffice` while silently changing the displayed variance or employee amount.
 */
function assertCanonicalFixedShareSettlement(settlement: FixedShareSettlementPlan): void {
  const canonical = planFixedShareSettlement({
    deliveryFeeTotal: settlement.deliveryFeeTotal,
    fixedDriverShare: settlement.fixedDriverShare,
    manualDriverShare: settlement.manualDriverShare,
    cashDeductionTotal: settlement.cashDeductionTotal,
    expectedCash: settlement.expectedCash,
    expectedWallet: settlement.expectedWallet,
    actualCash: settlement.actualCash,
    actualWallet: settlement.actualWallet,
    cashReceivableDeferred: settlement.cashReceivableDeferred,
    walletReceivableDeferred: settlement.walletReceivableDeferred,
  })
  const scalarFields = [
    'grossDriverShare',
    'baseDriverShare',
    'expectedTotal',
    'actualTotal',
    'variance',
    'finalEmployeeCash',
    'officeEntitlement',
    'cashClaimToOffice',
    'walletClaimToOffice',
    'cashReceivableDeferred',
    'walletReceivableDeferred',
    'cashToOffice',
    'walletToOffice',
  ] as const
  for (const field of scalarFields) {
    if (settlement[field] !== canonical[field]) {
      throw new RangeError(
        `non-canonical fixed-share settlement ${field}: ${settlement[field]} vs ${canonical[field]}`,
      )
    }
  }
  if (
    settlement.wallet.action !== canonical.wallet.action ||
    settlement.wallet.amount !== canonical.wallet.amount ||
    settlement.cash.action !== canonical.cash.action ||
    settlement.cash.amount !== canonical.cash.amount
  ) {
    throw new RangeError('non-canonical fixed-share settlement action')
  }
}

/**
 * The two physical close movements for the fixed-40 policy.
 *
 * Before these run, order/share/deduction postings have left:
 *
 *   driver_cash                 = expectedCash
 *   driver_wallet               = expectedWallet
 *   driver_share_payable credit = max(baseDriverShare, 0)
 *   driver_receivable_cash      = max(-baseDriverShare, 0)
 *
 * First, the wallet posting reclassifies `actualWallet − expectedWallet` between the two driver
 * assets and sweeps the complete actual wallet balance. The driver's cash asset is then
 * `expectedTotal − actualWallet`. Second, one signed cash posting clears that asset and whichever
 * side of the employee account exists. `office_cash` receives (or pays) the residual.
 *
 * No variance cost centre is involved: policy assigns the scalar variance to the employee and the
 * confirmed cash transaction physically settles it. Both driver assets, the share payable and the
 * close-time receivable therefore finish at exactly zero.
 */
export function cashSettledReturnPostings(input: CashSettledReturnInput): Posting[] {
  const { driverId, settlement } = input
  assertCanonicalFixedShareSettlement(settlement)
  const postings: Posting[] = []

  const walletDelta = sub(settlement.actualWallet, settlement.expectedWallet)
  const walletLines: PostingLine[] = []
  // Reclassify the observed cash/wallet split before either fund is swept.
  signedLine(walletLines, { kind: 'driver_wallet', driverId }, walletDelta, 'wallet_reclassification')
  signedLine(walletLines, { kind: 'driver_cash', driverId }, neg(walletDelta), 'wallet_reclassification')
  // Clear the operational wallet. A positive amount may be split between a transfer now and a
  // reviewed receivable; a negative wallet is always funded in full.
  signedLine(walletLines, { kind: 'driver_wallet', driverId }, neg(settlement.actualWallet), 'wallet_cleared')
  signedLine(walletLines, { kind: 'office_wallet' }, settlement.walletToOffice, 'wallet_settlement')
  if (settlement.walletReceivableDeferred > ZERO) {
    // `driver_shift_funding_wallet`, NOT `driver_receivable_wallet`. A deferred wallet collection is
    // balance the driver still physically holds in the Yallago app and will spend on the next
    // shift's per-order cuts — which is the definition of shift funding, not of an ordinary debt.
    // Booked as an ordinary receivable it is invisible to `postingsForOpen`, so no carry tranche
    // reaches `topupTotal`, BR1 reads the money as a SURPLUS, and decision 13 pays the driver his
    // own debt. See `walletCarry` above for the consuming half.
    walletLines.push(
      D(
        { kind: 'driver_shift_funding_wallet', driverId },
        settlement.walletReceivableDeferred,
        'wallet_settlement_deferred',
      ),
    )
  }
  if (walletLines.length > 0) {
    postings.push(assertBalanced({ eventType: 'wallet_return', occurrenceKey: '1', lines: walletLines }))
  }

  const cashAfterWallet = sub(settlement.expectedTotal, settlement.actualWallet)
  const payable = settlement.baseDriverShare > ZERO ? settlement.baseDriverShare : ZERO
  const receivable = settlement.baseDriverShare < ZERO ? abs(settlement.baseDriverShare) : ZERO
  const cashClaimToOffice = sub(cashAfterWallet, settlement.baseDriverShare)
  if (cashClaimToOffice !== settlement.cashClaimToOffice) {
    throw new RangeError(
      `cash-settled claim disagrees with reviewed plan: ${cashClaimToOffice} vs ${settlement.cashClaimToOffice}`,
    )
  }
  const cashToOffice = sub(cashClaimToOffice, settlement.cashReceivableDeferred)
  if (cashToOffice !== settlement.cashToOffice) {
    throw new RangeError(
      `cash-settled movement disagrees with reviewed plan: ${cashToOffice} vs ${settlement.cashToOffice}`,
    )
  }

  const cashLines: PostingLine[] = []
  signedLine(cashLines, { kind: 'driver_cash', driverId }, neg(cashAfterWallet), 'cash_cleared')
  signedLine(cashLines, { kind: 'driver_share_payable', driverId }, payable, 'driver_share_settled')
  signedLine(cashLines, { kind: 'driver_receivable_cash', driverId }, neg(receivable), 'driver_receivable_settled')
  if (settlement.cashReceivableDeferred > ZERO) {
    // Same reasoning as the wallet deferral above, and the same fund distinction: cash the driver
    // kept past the close is his next float, which is what `shifts.kept_as_receivable_minor` has
    // always promised — «Cleared when he opens his next shift» (0025). 0036 moved that carry
    // behaviour to `driver_shift_funding_*` and this posting was left behind on the old name.
    cashLines.push(
      D(
        { kind: 'driver_shift_funding_cash', driverId },
        settlement.cashReceivableDeferred,
        'cash_settlement_deferred',
      ),
    )
  }
  signedLine(cashLines, { kind: 'office_cash' }, cashToOffice, 'cash_settlement')
  if (cashLines.length > 0) {
    postings.push(assertBalanced({ eventType: 'float_return', occurrenceKey: '1', lines: cashLines }))
  }

  return postings
}

// ── Order postings (BR3) ──────────────────────────────────────────────────────────────────

/**
 * Fee revenue for one order, split across the two funds that actually received it.
 *
 * This used to debit the WHOLE fee to one fund chosen by `payMode`, while `closingBalances` below
 * split the same order by `orderWalletAmount`. The two agreed only while `walletAmount` was never
 * measured. The moment it is — a customer settles part of an order electronically and hands over
 * the rest — the one-fund posting strands `fee − walletAmount` in `driver_cash` and drives
 * `driver_wallet` negative by the same amount, so `postingsForApproval` no longer leaves the
 * driver's funds at zero. The two must use ONE rule, and this is it:
 *
 *     driver_wallet  ← orderWalletAmount(order)
 *     driver_cash    ← fee − orderWalletAmount(order)
 *
 * With `walletAmount` absent, `orderWalletAmount` falls back to the pay mode and one of the two
 * lines is zero and is omitted — so every order recorded before the log was read posts exactly the
 * single line it posted before, to the minor unit.
 */
export function orderFee(driverId: string, order: ShiftOrder): Posting {
  const inWallet = orderWalletAmount(order)
  const inHand = sub(order.fee, inWallet)
  const lines: PostingLine[] = []
  if (inWallet > 0n) lines.push(D({ kind: 'driver_wallet', driverId }, inWallet, 'fee_wallet'))
  if (inHand > 0n) lines.push(D({ kind: 'driver_cash', driverId }, inHand, 'fee_cash'))
  lines.push(C({ kind: 'fee_earned' }, order.fee))
  return assertBalanced({ eventType: 'order_fee', occurrenceKey: order.orderNo, lines })
}

/**
 * BR2 — Yallago's 20%, deducted from the wallet the moment the order completes.
 *
 * A MANUAL order gets a zero cut: it is the branch's own job and Yallago never saw it, so charging
 * them a share would take money out of the driver's wallet and hand it to a party with no claim.
 * The posting is still emitted (balanced, at zero) so every order has one and replays stay keyed
 * the same way.
 */
export function yalagoCutPosting(driverId: string, order: ShiftOrder, rounding: Rounding = 'floor'): Posting {
  const cut = orderYalagoCut(order, rounding)
  return assertBalanced({
    eventType: 'yalago_cut',
    occurrenceKey: order.orderNo,
    lines: [D({ kind: 'yalago_share' }, cut), C({ kind: 'driver_wallet', driverId }, cut)],
  })
}

/**
 * A wallet movement that belongs to no order — an incentive, a merchant payment, a top-up the
 * office did not make, a withdrawal.
 *
 * `closingBalances` has always added these into `endWallet`, and `walletReturn` credits that back —
 * but nothing ever DEBITED the wallet for them, so wiring adjustments in without this recipe would
 * leave `driver_wallet` at exactly −Σadjustments. They were harmless only while nothing populated
 * the term.
 *
 * The counterparty is a COST CENTRE, deliberately, and not `company_revenue` or `yalago_income`:
 * nobody has yet decided whose money an incentive is, and posting it to a named party would be this
 * system asserting an answer it does not have. `forceClose` already uses the same escape hatch for
 * an unexplained gap. The books balance, the amount stays visible under its own code, and the
 * accounting engine reclassifies it later — which is exactly what the owner said the operations
 * list is for.
 *
 * `amount` is SIGNED, because a movement is not a balance: negative left the wallet.
 */
export function walletAdjustment(
  driverId: string,
  branchId: string,
  amount: Minor,
  occurrenceKey: string,
): Posting {
  const magnitude = amount < 0n ? minor(-amount) : amount
  const centre: FundRef = { kind: 'cost_center', costCenterId: `wallet_adjustment:${branchId}` }
  const lines: PostingLine[] =
    amount >= 0n
      ? [D({ kind: 'driver_wallet', driverId }, magnitude, 'wallet_adjustment'), C(centre, magnitude)]
      : [D(centre, magnitude), C({ kind: 'driver_wallet', driverId }, magnitude, 'wallet_adjustment')]
  return assertBalanced({ eventType: 'wallet_adjustment', occurrenceKey, lines })
}

/**
 * One scanned cash operation that the manager has classified as the driver's responsibility.
 *
 * `amount` and `sharePortion` are POSITIVE magnitudes. The part covered by earned share debits
 * `driver_share_payable`, discharging that liability; anything beyond the allocated share becomes
 * a named cash receivable. The full operation credits `driver_cash`, because that is the asset the
 * negative scan says left the driver's hands.
 *
 * Classification and allocation happen outside this pure recipe. In particular, it does not
 * inspect orders or choose a tier, and the caller supplies the scan's stable identity as the
 * occurrence key.
 */
export function driverCashDeduction(
  driverId: string,
  amount: Minor,
  sharePortion: Minor,
  occurrenceKey: string,
): Posting {
  if (amount <= 0n) throw new RangeError(`cash deduction amount must be positive, got ${amount}`)
  if (sharePortion < 0n || sharePortion > amount) {
    throw new RangeError(
      `cash deduction share portion must satisfy 0 <= share <= amount, got ${sharePortion}/${amount}`,
    )
  }

  const overflow = sub(amount, sharePortion)
  const lines: PostingLine[] = []
  if (sharePortion > 0n) {
    lines.push(D({ kind: 'driver_share_payable', driverId }, sharePortion, 'cash_deduction_share'))
  }
  if (overflow > 0n) {
    lines.push(D({ kind: 'driver_receivable_cash', driverId }, overflow, 'cash_deduction_overflow'))
  }
  lines.push(C({ kind: 'driver_cash', driverId }, amount, 'cash_deduction'))
  return assertBalanced({ eventType: 'driver_cash_deduction', occurrenceKey, lines })
}

// ── Approval posting (BR4) ────────────────────────────────────────────────────────────────

/**
 * The tier split, posted at approval time — never in the field.
 *
 * Closes the whole of `fee_earned` into the three shares. It balances by construction because
 * `splitBlock()` guarantees driver + company + yalago === feeTotal exactly, for arbitrary
 * integer fees. That is the same exhaustiveness invariant acceptance criterion #5 asks for, and
 * it is why the company holds the rounding remainder rather than anyone else (BR4).
 *
 * ── A share may be NEGATIVE, and on an ordinary day it IS ────────────────────────────────
 * The caller does not hand this function a day's shares. It hands it the day's `trueUp` DELTAS,
 * which are `sub()` of two allocations and therefore SIGNED — because decision D-6 makes the tier
 * band a property of the whole day, so a later shift restates the earlier ones («تسوية شريحة اليوم»).
 *
 * In **whole-amount mode** — the configured default — the company's delta goes negative on every
 * band crossing, by construction. Yallago's 20% is fixed and the driver's percentage rises, so the
 * company's percentage is what falls, and BR4 says exactly that: *tier changes come only out of the
 * company's side*. A driver on 14 orders at 5,000 crossing to 15:
 *
 *     prior  driver 24,500  company 31,500  yalago 14,000   (35%)
 *     day    driver 30,000  company 30,000  yalago 15,000   (40%)
 *     delta         +5,500          −1,500          +1,000
 *
 * Dropping a non-positive line left debits and credits unequal by that amount — `D 500000 <> C
 * 650000` — and `assertBalanced` threw `UnbalancedPostingError`. That is a 500 in the branch
 * manager's face at approval, on the second shift of any day that crosses a band: precisely the
 * case the whole day-tier true-up exists to handle, and the shift could not be approved at all.
 * Marginal mode never produces a negative delta, which is why the mode switch hid this.
 *
 * A negative share is a **debit of that account**, not a line to be dropped. All three are
 * naturally credit-side — `driver_share_payable` is a liability, `company_revenue` and
 * `yalago_income` are revenue — so debiting one is "give back what was over-credited", which is the
 * arithmetic meaning of a downward restatement. The three still sum to `feeTotal` (asserted above),
 * so moving −d out of the credit column and +|d| into the debit column changes both totals by the
 * same |d| and the posting stays balanced by construction.
 *
 * A ZERO share is omitted, and must be: `assertBalanced` requires every amount to be strictly
 * positive, because direction is carried by `side` and a zero has no direction to carry.
 */
export function shareSplit(driverId: string, totals: FeeTotals, split: BlockSplit, occurrenceKey = '1'): Posting {
  const allocated = add(add(split.driverShare, split.companyShare), split.yalagoShare)
  if (allocated !== totals.feeTotal) {
    throw new RangeError(
      `share split does not exhaust the fee total: ${allocated} allocated vs ${totals.feeTotal} earned`,
    )
  }
  const lines: PostingLine[] = []
  // A restatement that adds no new fees is a real posting — shares move between parties while
  // `fee_earned` does not. `postingsForApproval` never calls with zero today, but a zero-amount
  // debit is not a line this ledger is allowed to hold, so it is omitted rather than pushed.
  if (totals.feeTotal > 0n) lines.push(D({ kind: 'fee_earned' }, totals.feeTotal))
  const share = (fund: FundRef, amount: Minor, role: string): void => {
    if (amount > 0n) lines.push(C(fund, amount, role))
    else if (amount < 0n) lines.push(D(fund, minor(-amount), role))
  }
  share({ kind: 'driver_share_payable', driverId }, split.driverShare, 'driver_share')
  share({ kind: 'company_revenue' }, split.companyShare, 'company_share')
  share({ kind: 'yalago_income' }, split.yalagoShare, 'yalago_share')
  return assertBalanced({ eventType: 'share_split', occurrenceKey, lines })
}

// ── Expenses (G) ──────────────────────────────────────────────────────────────────────────

export function expense(costCenterId: string, amount: Minor, occurrenceKey = '1'): Posting {
  return assertBalanced({
    eventType: 'expense',
    occurrenceKey,
    lines: [D({ kind: 'cost_center', costCenterId }, amount), C({ kind: 'office_cash' }, amount)],
  })
}

// ── «الترميم» — the daily restoration (owner decision 10) ─────────────────────────────────
//
// The owner's own process, in his own words: «راس مال المكتب رقم ثابت لكل من المحفظة و كاش المكتب.
// في نهاية كل يوم عمل يتم عملية اسمها ترميم، الهدف منها سحب الارباح و ترميم النقص و اعادة راس المال
// على وضعه السابق مع مراعاة توزع الذمم.»
//
// His spreadsheet proves the arithmetic: كاش المكتب 3,600,000 + ذمم 400,000 = 4,000,000 target, and
// محفظة المكتب 970,000 + ذمم 30,000 = 1,000,000. Both land exactly on capital — a day already
// restored. The planner lives in `treasury/restoration.ts`; these are the two postings it emits.

/**
 * «كييش» — profit leaves the branch box for صندوق الشركة.
 *
 * Not an expense, though his cash book records it as one: nothing was consumed, the money simply
 * moved between two funds the company owns. Filing it as an expense would understate profit by
 * exactly the amount of the profit.
 */
export function sweepToCompany(office: OfficeFund, amount: Minor, occurrenceKey = '1'): Posting {
  return assertBalanced({
    eventType: 'restoration',
    occurrenceKey,
    lines: [D({ kind: 'company_box' }, amount, 'kaish'), C({ kind: office }, amount)],
  })
}

/** «شحن من الصندوق» — صندوق الشركة restores the office box to its capital. The exact inverse. */
export function fundFromCompany(office: OfficeFund, amount: Minor, occurrenceKey = '1'): Posting {
  return assertBalanced({
    eventType: 'restoration',
    occurrenceKey,
    lines: [D({ kind: office }, amount, 'shahn'), C({ kind: 'company_box' }, amount)],
  })
}

// ── Corrections (BR7) ─────────────────────────────────────────────────────────────────────

/**
 * Reverse a posting. A locked week is never edited — a correction is a visible, dated reversal
 * plus a repost. `occurrenceKey` carries the correction sequence so repeated corrections remain
 * possible under the idempotency index.
 */
export function reverse(posting: Posting, occurrenceKey: string): Posting {
  return assertBalanced({
    eventType: 'correction',
    occurrenceKey,
    lines: posting.lines.map((l) =>
      l.side === 'D' ? C(l.fund, l.amount, l.role) : D(l.fund, l.amount, l.role),
    ),
  })
}

// ── Whole-shift assembly ──────────────────────────────────────────────────────────────────

export interface CashDeduction {
  /** Positive magnitude of the cash operation. */
  readonly amount: Minor
  /** Amount allocated against driver share; the recipe enforces `0 <= sharePortion <= amount`. */
  readonly sharePortion: Minor
  /** Stable identity supplied by the scan/application layer for ledger idempotency. */
  readonly occurrenceKey: string
}

export interface ShiftPostingInput {
  readonly driverId: string
  /** Whose books the unexplained wallet movements land in. Only needed when there are any. */
  readonly branchId?: string
  readonly floatTranches: readonly Minor[]
  readonly topupTranches: readonly Minor[]
  /** Wallet value advanced earlier and consumed automatically at this shift's open. */
  readonly carriedWalletTranches?: readonly Minor[]
  readonly orders: readonly ShiftOrder[]
  /** Wallet movements no order explains (incentive, top-up, withdrawal) — same term BR1 uses. */
  readonly walletAdjustments?: readonly Minor[]
  /** Classified cash operations. These reduce cash only and are never treated as orders. */
  readonly cashDeductions?: readonly CashDeduction[]
  /**
   * ذمم carried in from an earlier shift — cash the driver already had in his hands at open.
   *
   * DISJOINT from `floatTranches`, and it must stay that way: these two lists are summed together
   * into the closing cash, so putting an amount in both would return it twice and leave the office
   * over by that much. The repo loads them from separate `float_tranches.kind` values for exactly
   * this reason.
   */
  readonly carriedTranches?: readonly Minor[]
  /** «يبقى ذمة على السائق» — how much of tonight's cash stays with him. The manager decides it. */
  readonly keptAsReceivable?: Minor
  /** «يُعاد للسائق» — his share, kept out of the cash in his hands (owner decision f). */
  readonly driverSharePaid?: Minor
  readonly rounding?: Rounding
}

/** Everything posted when a shift OPENS: the float and top-up tranches. */
export function postingsForOpen(input: ShiftPostingInput): Posting[] {
  return [
    ...input.floatTranches.map((amount, i) => floatOut(input.driverId, amount, i + 1)),
    // A ذمة he already holds: his cash rises the same way, but the branch box pays nothing,
    // because it paid yesterday. Clears the receivable in the same movement.
    ...(input.carriedTranches ?? []).map((amount, i) => floatCarry(input.driverId, amount, i + 1)),
    ...input.topupTranches.map((amount, i) => walletTopup(input.driverId, amount, i + 1)),
    ...(input.carriedWalletTranches ?? []).map((amount, i) => walletCarry(input.driverId, amount, i + 1)),
  ]
}

/**
 * Everything posted when a shift is APPROVED: order fees, Yallago's cuts, the tier split,
 * classified cash deductions, and the return of both the float and the wallet.
 *
 * `split` comes from the caller because the tier band is a property of the DAY, not the shift —
 * a second shift can push the day across a band and restate the first (see tier/split.ts
 * `trueUp`). The ledger must post what the day says, not what the shift alone would have said.
 */
function approvalActivityPostings(input: ShiftPostingInput, split: BlockSplit): Posting[] {
  const rounding = input.rounding ?? 'floor'
  // Per ORDER, not per fee: a manual job carries no Yallago cut, and totalling the bare fees would
  // charge one anyway — leaving `shareSplit` unable to exhaust `fee_earned` and throwing.
  const totals = totalFeesOfOrders(input.orders, rounding)

  const postings: Posting[] = []
  for (const order of input.orders) {
    if (order.fee > 0n) postings.push(orderFee(input.driverId, order))
    if (orderYalagoCut(order, rounding) > 0n) postings.push(yalagoCutPosting(input.driverId, order, rounding))
  }
  if (totals.feeTotal > 0n) postings.push(shareSplit(input.driverId, totals, split))

  // Every unexplained wallet movement gets its own posting, in the SAME order `closingBalances`
  // sums them, so the wallet the ledger holds and the wallet BR1 expects are built from one list.
  // Without these the return below credits a wallet nothing ever debited.
  const adjustments = input.walletAdjustments ?? []
  if (adjustments.length > 0 && input.branchId === undefined) {
    throw new RangeError('wallet adjustments need a branchId: their counterparty is a branch cost centre')
  }
  adjustments.forEach((amount, i) => {
    if (amount !== 0n) postings.push(walletAdjustment(input.driverId, input.branchId!, amount, String(i + 1)))
  })

  for (const deduction of input.cashDeductions ?? []) {
    postings.push(
      driverCashDeduction(input.driverId, deduction.amount, deduction.sharePortion, deduction.occurrenceKey),
    )
  }

  return postings
}

export function postingsForApproval(input: ShiftPostingInput, split: BlockSplit): Posting[] {
  const postings = approvalActivityPostings(input, split)

  /*
   * Both driver funds go to EXACTLY ZERO (D-4). The cash may be distributed three ways now — the
   * box, a ذمة, and the share he keeps — but it is still ONE credit of the whole closing balance,
   * so the invariant is untouched. With no settlement supplied this is the two-line posting it has
   * always been.
   */
  const { endCash, endWallet } = closingBalances(input)
  const kept = input.keptAsReceivable ?? minor(0n)
  const sharePaid = input.driverSharePaid ?? minor(0n)
  if (endCash !== 0n) postings.push(floatReturnSplit(input.driverId, endCash, kept, sharePaid))
  if (endWallet !== 0n) postings.push(walletReturn(input.driverId, endWallet))

  return postings
}

/**
 * Fixed-40 approval assembly used once the manager has reviewed the full-wallet/cash settlement.
 *
 * It emits the same order, Yallago, share and deduction entries as the legacy approval path, then
 * replaces its computed-balance returns with {@link cashSettledReturnPostings}. The validations
 * below make the settlement snapshot and the postings one fact: a stale or independently-derived
 * plan fails before any repository sees a journal entry.
 */
export function postingsForCashSettledApproval(
  input: ShiftPostingInput,
  split: BlockSplit,
  settlement: FixedShareSettlementPlan,
): Posting[] {
  const yallagoFeeTotal = sum(
    input.orders.filter((order) => order.kind !== 'manual').map((order) => order.fee),
  )
  if (settlement.deliveryFeeTotal !== yallagoFeeTotal) {
    throw new RangeError(
      `settlement delivery fee total ${settlement.deliveryFeeTotal} does not match approval ${yallagoFeeTotal}`,
    )
  }
  const manualDriverShare = sum(
    input.orders
      .filter((order) => order.kind === 'manual')
      .map((order) => order.driverShare ?? ZERO),
  )
  if (settlement.manualDriverShare !== manualDriverShare) {
    throw new RangeError(
      `settlement manual driver share ${settlement.manualDriverShare} does not match approval ${manualDriverShare}`,
    )
  }
  const expected = closingBalances(input)
  if (settlement.expectedCash !== expected.endCash || settlement.expectedWallet !== expected.endWallet) {
    throw new RangeError(
      `settlement expected balances do not match approval: ` +
      `${settlement.expectedCash}/${settlement.expectedWallet} vs ${expected.endCash}/${expected.endWallet}`,
    )
  }
  if (settlement.grossDriverShare !== split.driverShare) {
    throw new RangeError(
      `settlement gross driver share ${settlement.grossDriverShare} does not match split ${split.driverShare}`,
    )
  }

  const deductions = input.cashDeductions ?? []
  const deductionTotal = sum(deductions.map((deduction) => deduction.amount))
  if (deductionTotal !== settlement.cashDeductionTotal) {
    throw new RangeError(
      `settlement cash deductions ${settlement.cashDeductionTotal} do not match postings ${deductionTotal}`,
    )
  }
  const allocatedToShare = sum(deductions.map((deduction) => deduction.sharePortion))
  const expectedShareAllocation =
    deductionTotal < settlement.grossDriverShare ? deductionTotal : settlement.grossDriverShare
  if (allocatedToShare !== expectedShareAllocation) {
    throw new RangeError(
      `cash-deduction share allocation ${allocatedToShare} does not consume ${expectedShareAllocation}`,
    )
  }

  return [
    ...approvalActivityPostings(input, split),
    ...cashSettledReturnPostings({ driverId: input.driverId, settlement }),
  ]
}

export interface ClosingBalances {
  readonly endCash: Minor
  readonly endWallet: Minor
}

/** What the driver's two funds hold at close, before the returns. Mirrors BR1's expectations. */
export function closingBalances(input: ShiftPostingInput): ClosingBalances {
  const rounding = input.rounding ?? 'floor'
  // The same one rule BR1 uses: what did NOT reach the wallet is in his hand, and what did reach it
  // is there less Yallago's cut. Mirrors `evaluateBr1` exactly — these two must never drift, or the
  // ledger would return a different amount from the one the equation just balanced.
  // A carried ذمة is cash he was ALREADY holding at open, so it is part of the closing balance
  // exactly as a float tranche is. `evaluateShift` adds it to `floatTotal` on the BR1 side by the
  // same rule. Classified cash deductions then reduce only that cash balance, matching BR1.
  const endCash = sub(
    add(
      add(sum(input.floatTranches), sum(input.carriedTranches ?? [])),
      sum(input.orders.map((o) => sub(o.fee, orderWalletAmount(o)))),
    ),
    sum(
      (input.cashDeductions ?? []).map((deduction) => {
        if (deduction.amount <= 0n) {
          throw new RangeError(`cash deductions must be positive magnitudes, got ${deduction.amount}`)
        }
        return deduction.amount
      }),
    ),
  )
  const walletFromOrders = sum(input.orders.map((o) => sub(orderWalletAmount(o), orderYalagoCut(o, rounding))))
  const adjustments = sum(input.walletAdjustments ?? [])
  return {
    endCash,
    endWallet: add(
      add(add(sum(input.topupTranches), sum(input.carriedWalletTranches ?? [])), walletFromOrders),
      adjustments,
    ),
  }
}

/**
 * The lowest the driver's wallet reaches at any point during the shift, processing orders in
 * sequence.
 *
 * A negative result means Yallago was asked to take more out of the wallet than it held. That
 * is physically reachable in ordinary operation — many cash orders on a small top-up — and BR1
 * can still evaluate to exactly zero while it happens, so the zero equation alone will NOT
 * catch it. The close gate surfaces it separately.
 *
 * ⚠ OPEN QUESTION FOR THE PRODUCT OWNER: what does Yallago's app actually do here — refuse the
 * order, allow a negative balance, or auto-settle? The answer decides whether this blocks the
 * shift or merely warns. Until the first real sample arrives (SRS م-4) it warns.
 */
export function minWalletBalance(input: ShiftPostingInput): Minor {
  const rounding = input.rounding ?? 'floor'
  let balance = add(sum(input.topupTranches), sum(input.carriedWalletTranches ?? []))
  let lowest = balance
  for (const order of input.orders) {
    balance = add(balance, sub(orderWalletAmount(order), orderYalagoCut(order, rounding)))
    if (balance < lowest) lowest = balance
  }
  return lowest
}

/** Net effect of a set of postings on one fund, for assertions and balance derivation. */
export function balanceOf(postings: readonly Posting[], predicate: (fund: FundRef) => boolean): Minor {
  let total = 0n
  for (const posting of postings) {
    for (const line of posting.lines) {
      if (!predicate(line.fund)) continue
      total += line.side === 'D' ? line.amount : -line.amount
    }
  }
  return minor(total)
}

export const isFund =
  (kind: FundRef['kind']) =>
  (fund: FundRef): boolean =>
    fund.kind === kind

/**
 * Stable string identity for a fund. The database stores this in `funds.code`.
 */
export function fundCode(fund: FundRef): string {
  switch (fund.kind) {
    case 'driver_cash':
    case 'driver_wallet':
    case 'driver_share_payable':
    // A receivable belongs to ONE named driver. Without the suffix every driver's ذمة would
    // collapse into a single fund, and «who owes this» — the only question a ذمة exists to
    // answer — becomes unanswerable while the totals still look right.
    case 'driver_receivable_cash':
    case 'driver_receivable_wallet':
    case 'driver_shift_funding_cash':
    case 'driver_shift_funding_wallet':
      return `${fund.kind}:${fund.driverId}`
    case 'cost_center':
      return `cost_center:${fund.costCenterId}`
    default:
      return fund.kind
  }
}

/**
 * The inverse of `fundCode`.
 *
 * A manual entry (E-3) names its funds by code, and mapping every one of them to a cost centre
 * — as a first version did — means `office_cash` becomes `cost_center:office_cash` and a manual
 * correction silently fails to touch the fund the operator meant. The money appears to move and
 * the real balance never changes.
 *
 * An UNRECOGNISED code becomes a cost centre deliberately: an operator needs contra accounts
 * ("opening_balance", "adjustments") that are not part of the client's fixed tree, and refusing
 * them would make E-3 unusable. What must never happen is a *known* fund name being silently
 * re-pointed.
 */
export function fundRefFromCode(code: string): FundRef {
  const [head, ...rest] = code.split(':')
  const tail = rest.join(':')

  switch (head) {
    case 'office_cash':
    case 'office_wallet':
    case 'yalago_share':
    case 'company_revenue':
    case 'yalago_income':
    case 'fee_earned':
    // WITHOUT THIS LINE a manual entry naming «company_box» silently becomes
    // `cost_center:company_box` — a different account that looks right in the UI and never moves
    // the fund the operator meant. Exactly the failure this function's own header describes.
    case 'company_box':
      return { kind: head }
    case 'driver_cash':
    case 'driver_wallet':
    case 'driver_share_payable':
    case 'driver_receivable_cash':
    case 'driver_receivable_wallet':
    case 'driver_shift_funding_cash':
    case 'driver_shift_funding_wallet':
      if (tail === '') throw new RangeError(`${head} requires a driver id, got ${JSON.stringify(code)}`)
      return { kind: head, driverId: tail }
    case 'cost_center':
      if (tail === '') throw new RangeError(`cost_center requires an id, got ${JSON.stringify(code)}`)
      return { kind: 'cost_center', costCenterId: tail }
    default:
      return { kind: 'cost_center', costCenterId: code }
  }
}
