import { type Minor, add, minor, sub, sum } from '../money/minor.ts'
import { type FeeTotals, type Rounding, orderBlock, totalFees, yalagoCut } from '../money/allocate.ts'
import type { BlockSplit } from '../money/allocate.ts'
import type { PayMode, ShiftOrder } from '../br1/equation.ts'

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
  | 'share_split'
  | 'float_return'
  | 'wallet_return'
  | 'expense'
  | 'manual'
  | 'correction'

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
  | { readonly kind: 'cost_center'; readonly costCenterId: string }

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

// ── Gate postings ─────────────────────────────────────────────────────────────────────────

/** Cash float handed to the driver at open. One posting per tranche (C-5). */
export function floatOut(driverId: string, amount: Minor, trancheNo = 1): Posting {
  return assertBalanced({
    eventType: 'float_out',
    occurrenceKey: String(trancheNo),
    lines: [D({ kind: 'driver_cash', driverId }, amount), C({ kind: 'office_cash' }, amount)],
  })
}

/** Wallet top-up at open. One posting per tranche (C-5). */
export function walletTopup(driverId: string, amount: Minor, trancheNo = 1): Posting {
  return assertBalanced({
    eventType: 'wallet_topup',
    occurrenceKey: String(trancheNo),
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

// ── Order postings (BR3) ──────────────────────────────────────────────────────────────────

/** Which fund physically receives the fee, by payment mode. */
function receivingFund(payMode: PayMode, driverId: string): FundRef {
  return payMode === 'cash'
    ? { kind: 'driver_cash', driverId }
    : { kind: 'driver_wallet', driverId }
}

/**
 * Fee revenue for one order. Debits whichever asset received it, credits `fee_earned`.
 * `yalagoCutPosting` then removes Yallago's 20% from the wallet, for every mode alike.
 */
export function orderFee(driverId: string, order: ShiftOrder): Posting {
  return assertBalanced({
    eventType: 'order_fee',
    occurrenceKey: order.orderNo,
    lines: [
      D(receivingFund(order.payMode, driverId), order.fee, `fee_${order.payMode}`),
      C({ kind: 'fee_earned' }, order.fee),
    ],
  })
}

/** BR2 — Yallago's 20%, deducted from the wallet the moment the order completes. */
export function yalagoCutPosting(driverId: string, order: ShiftOrder, rounding: Rounding = 'floor'): Posting {
  const cut = yalagoCut(order.fee, rounding)
  return assertBalanced({
    eventType: 'yalago_cut',
    occurrenceKey: order.orderNo,
    lines: [D({ kind: 'yalago_share' }, cut), C({ kind: 'driver_wallet', driverId }, cut)],
  })
}

// ── Approval posting (BR4) ────────────────────────────────────────────────────────────────

/**
 * The tier split, posted at approval time — never in the field.
 *
 * Closes the whole of `fee_earned` into the three shares. It balances by construction because
 * `splitBlock()` guarantees driver + company + yalago === feeTotal exactly, for arbitrary
 * integer fees. That is the same exhaustiveness invariant acceptance criterion #5 asks for, and
 * it is why the company holds the rounding remainder rather than anyone else (BR4).
 */
export function shareSplit(driverId: string, totals: FeeTotals, split: BlockSplit, occurrenceKey = '1'): Posting {
  const allocated = add(add(split.driverShare, split.companyShare), split.yalagoShare)
  if (allocated !== totals.feeTotal) {
    throw new RangeError(
      `share split does not exhaust the fee total: ${allocated} allocated vs ${totals.feeTotal} earned`,
    )
  }
  const lines: PostingLine[] = [D({ kind: 'fee_earned' }, totals.feeTotal)]
  if (split.driverShare > 0n) {
    lines.push(C({ kind: 'driver_share_payable', driverId }, split.driverShare, 'driver_share'))
  }
  if (split.companyShare > 0n) lines.push(C({ kind: 'company_revenue' }, split.companyShare, 'company_share'))
  if (split.yalagoShare > 0n) lines.push(C({ kind: 'yalago_income' }, split.yalagoShare, 'yalago_share'))
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

export interface ShiftPostingInput {
  readonly driverId: string
  readonly floatTranches: readonly Minor[]
  readonly topupTranches: readonly Minor[]
  readonly orders: readonly ShiftOrder[]
  readonly rounding?: Rounding
}

/** Everything posted when a shift OPENS: the float and top-up tranches. */
export function postingsForOpen(input: ShiftPostingInput): Posting[] {
  return [
    ...input.floatTranches.map((amount, i) => floatOut(input.driverId, amount, i + 1)),
    ...input.topupTranches.map((amount, i) => walletTopup(input.driverId, amount, i + 1)),
  ]
}

/**
 * Everything posted when a shift is APPROVED: order fees, Yallago's cuts, the tier split, and
 * the return of both the float and the wallet.
 *
 * `split` comes from the caller because the tier band is a property of the DAY, not the shift —
 * a second shift can push the day across a band and restate the first (see tier/split.ts
 * `trueUp`). The ledger must post what the day says, not what the shift alone would have said.
 */
export function postingsForApproval(input: ShiftPostingInput, split: BlockSplit): Posting[] {
  const rounding = input.rounding ?? 'floor'
  const totals = totalFees(
    input.orders.map((o) => o.fee),
    rounding,
  )

  const postings: Posting[] = []
  for (const order of input.orders) {
    if (order.fee > 0n) postings.push(orderFee(input.driverId, order))
    if (yalagoCut(order.fee, rounding) > 0n) postings.push(yalagoCutPosting(input.driverId, order, rounding))
  }
  if (totals.feeTotal > 0n) postings.push(shareSplit(input.driverId, totals, split))

  // Both are returned in full at end of day (D-4), leaving both driver funds at exactly zero.
  const { endCash, endWallet } = closingBalances(input)
  if (endCash !== 0n) postings.push(floatReturn(input.driverId, endCash))
  if (endWallet !== 0n) postings.push(walletReturn(input.driverId, endWallet))

  return postings
}

export interface ClosingBalances {
  readonly endCash: Minor
  readonly endWallet: Minor
}

/** What the driver's two funds hold at close, before the returns. Mirrors BR1's expectations. */
export function closingBalances(input: ShiftPostingInput): ClosingBalances {
  const rounding = input.rounding ?? 'floor'
  const endCash = add(
    sum(input.floatTranches),
    sum(input.orders.filter((o) => o.payMode === 'cash').map((o) => o.fee)),
  )
  const walletIn = sum(input.orders.filter((o) => o.payMode !== 'cash').map((o) => orderBlock(o.fee, rounding)))
  const walletOut = sum(input.orders.filter((o) => o.payMode === 'cash').map((o) => yalagoCut(o.fee, rounding)))
  return { endCash, endWallet: sub(add(sum(input.topupTranches), walletIn), walletOut) }
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
  let balance = sum(input.topupTranches)
  let lowest = balance
  for (const order of input.orders) {
    balance =
      order.payMode === 'cash'
        ? sub(balance, yalagoCut(order.fee, rounding))
        : add(balance, orderBlock(order.fee, rounding))
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
      return { kind: head }
    case 'driver_cash':
    case 'driver_wallet':
    case 'driver_share_payable':
      if (tail === '') throw new RangeError(`${head} requires a driver id, got ${JSON.stringify(code)}`)
      return { kind: head, driverId: tail }
    case 'cost_center':
      if (tail === '') throw new RangeError(`cost_center requires an id, got ${JSON.stringify(code)}`)
      return { kind: 'cost_center', costCenterId: tail }
    default:
      return { kind: 'cost_center', costCenterId: code }
  }
}
