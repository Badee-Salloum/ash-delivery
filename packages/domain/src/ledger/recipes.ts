import { type Minor, ZERO, abs, add, minor, neg, sub, sum } from '../money/minor.ts'
import { type Currency, isCurrency } from '../money/currency.ts'
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
  /** «مدخول مباشر» — money reaching the branch that is not a delivery fee. The mirror of `expense`. */
  | 'income'
  | 'manual'
  | 'correction'
  /** «الترميم» — the daily sweep of profit to صندوق الشركة, or the replenishment of office capital. */
  | 'restoration'
  /** The driver taking his share. */
  | 'driver_payout'
  /** Direct driver receivable creation or later collection, outside a shift. */
  | 'receivable_adjustment'
  /**
   * «السلفة» — money paid out like a صرفية that must come back in full (owner decision 17).
   *
   * Three events rather than one because they are three different facts about the same money and a
   * reader must be able to tell them apart without reconstructing the lines: it went out, some of
   * it came back, or the company gave up on the rest and finally spent it.
   */
  | 'advance'
  | 'advance_repayment'
  | 'advance_conversion'
  | CompanyLedgerEvent

/**
 * «صندوق الشركة» as its own ledger (finance redesign C1, migration 0065).
 *
 * Every one of these belongs to the company (HQ) ledger and to no branch: migration 0066 refuses
 * them in a branch and refuses every other event in the company ledger. They are listed apart so
 * the API, the recipes and the database guard can all name the same set.
 */
export type CompanyLedgerEvent =
  /** The branch `company_box` balance moved as-is into the company SYP pocket at cutover. */
  | 'company_opening_transfer'
  /** The HQ half of a branch entry that moved `company_box` («كييش» / «شحن») after cutover. */
  | 'company_restoration_mirror'
  | 'company_deposit'
  | 'company_withdrawal'
  | 'company_expense'
  | 'company_income'
  /** USD⇄SYP: both actual amounts, the resulting rate frozen on the entry. The only two-currency event. */
  | 'company_fx_exchange'
  | 'company_debt_open'
  | 'company_debt_payment'
  | 'company_debt_writeoff'
  | 'asset_purchase'
  /** «نقل الاهتلاك» — the month's depreciation from the company pocket into «الاهتلاك». */
  | 'depreciation_transfer'
  /** Money released back from «الاهتلاك» to the company pocket, with a written reason. */
  | 'depreciation_release'
  | 'company_correction'

export const COMPANY_LEDGER_EVENTS = [
  'company_opening_transfer',
  'company_restoration_mirror',
  'company_deposit',
  'company_withdrawal',
  'company_expense',
  'company_income',
  'company_fx_exchange',
  'company_debt_open',
  'company_debt_payment',
  'company_debt_writeoff',
  'asset_purchase',
  'depreciation_transfer',
  'depreciation_release',
  'company_correction',
] as const satisfies readonly CompanyLedgerEvent[]

/** Every value PostgreSQL's `ledger_event` enum accepts, in one runtime list for strict APIs. */
export const LEDGER_EVENTS = [
  'float_out',
  'wallet_topup',
  'order_fee',
  'yalago_cut',
  'wallet_adjustment',
  'driver_cash_deduction',
  'share_split',
  'float_return',
  'wallet_return',
  'expense',
  'income',
  'manual',
  'correction',
  'restoration',
  'driver_payout',
  'receivable_adjustment',
  'advance',
  'advance_repayment',
  'advance_conversion',
  ...COMPANY_LEDGER_EVENTS,
] as const satisfies readonly LedgerEvent[]

type MissingLedgerEvents = Exclude<LedgerEvent, (typeof LEDGER_EVENTS)[number]>
/** Compile-time proof that a newly-added ledger event cannot be omitted from strict filters. */
const LEDGER_EVENTS_EXHAUSTIVE: [MissingLedgerEvents] extends [never] ? true : false = true
void LEDGER_EVENTS_EXHAUSTIVE

type MissingCompanyEvents = Exclude<CompanyLedgerEvent, (typeof COMPANY_LEDGER_EVENTS)[number]>
/** Compile-time proof that the list above names every company event. */
const COMPANY_EVENTS_EXHAUSTIVE: [MissingCompanyEvents] extends [never] ? true : false = true
void COMPANY_EVENTS_EXHAUSTIVE

export const isCompanyLedgerEvent = (event: LedgerEvent): event is CompanyLedgerEvent =>
  (COMPANY_LEDGER_EVENTS as readonly LedgerEvent[]).includes(event)

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
   * «مدخول مباشر» — income that is NOT a delivery fee: a scrap sale, a damage recovery, a sponsor.
   *
   * Deliberately its own account rather than `company_revenue`. BR4 defines `company_revenue` as
   * the company's residual share of delivery fees, and `/dashboard/profit` reports it under that
   * name; folding a battery sale into it would silently overstate the delivery business.
   */
  | { readonly kind: 'other_income' }
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
  /**
   * «السلفة» — one named advance, still outstanding (owner decision 17).
   *
   * NOT a ذمة and not `driver_shift_funding_*`. A ذمة belongs to a driver by uuid and is forgivable
   * by write-off; shift funding is money already handed over for a specific next shift open. An
   * advance belongs to whoever the manager wrote on the line — a driver, a workshop, a landlord —
   * and its only endings are repayment or an audited conversion into an ordinary صرفية.
   *
   * SUFFIXED BY THE ADVANCE, not by the party. The party is free text, so it has no id and two
   * spellings of one name would otherwise be two funds. Suffixing by the advance also buys back the
   * proven guard: `0037`'s over-collection trigger refuses to drive a NAMED asset below zero, and a
   * single pooled fund would hide over-repaying one advance behind another still outstanding.
   *
   * Two kinds, like the ذمم, because الترميم restores each box against its own capital target and
   * must know which one an outstanding advance counts toward.
   *
   * In the database these carry `owner_kind='none'` with the identity in the code — the shape
   * `cost_center:cash_count_variance:<branchId>:<fundCode>` already uses.
   */
  | { readonly kind: 'advance_receivable_cash'; readonly advanceId: string }
  | { readonly kind: 'advance_receivable_wallet'; readonly advanceId: string }
  | { readonly kind: 'cost_center'; readonly costCenterId: string }
  | CompanyFundRef

/**
 * «صندوق الشركة» — the company (HQ) ledger's accounts (finance redesign C1, migrations 0065/0066).
 *
 * They live ONLY in the company branch row and never in a branch; the database refuses both
 * directions. Each carries its currency where it has one — the currency is part of the fund's
 * identity and of its code, so `company_cash:SYP_NEW` and `company_cash:USD` are two pockets and a
 * code read back from the ledger always says which.
 *
 * Codes (the enum literal is the `<CUR>` segment):
 *   company_cash:<CUR>                       the company's own cash, per currency
 *   depreciation_reserve:<CUR>               «الاهتلاك»
 *   company_fx_position:<CUR>                the transit account an exchange passes through
 *   company_equity:<CUR>:<account>           owner_funding | owner_drawings | opening
 *   company_expense:<CUR>:<centre>           general | receivable_writeoff | vehicle:<id> | asset:<id>
 *   company_income:<CUR>:<account>           general | payable_forgiven
 *   branch_clearing:<branchId>               «حساب الشركة لدى الفرع», SYP only
 *   company_payable:<CUR>:<debtId>           one debt the company owes
 *   company_receivable:<CUR>:<debtId>        one debt owed to the company
 *   fixed_asset:<CUR>:<assetId>              one purchased asset
 */
export type CompanyFundRef =
  | { readonly kind: 'company_cash'; readonly currency: Currency }
  | { readonly kind: 'depreciation_reserve'; readonly currency: Currency }
  | { readonly kind: 'company_fx_position'; readonly currency: Currency }
  | { readonly kind: 'company_equity'; readonly currency: Currency; readonly account: CompanyEquityAccount }
  | { readonly kind: 'company_expense'; readonly currency: Currency; readonly centre: CompanyExpenseCentre }
  | { readonly kind: 'company_income'; readonly currency: Currency; readonly account: CompanyIncomeAccount }
  | { readonly kind: 'branch_clearing'; readonly branchId: string }
  | { readonly kind: 'company_payable'; readonly debtId: string; readonly currency: Currency }
  | { readonly kind: 'company_receivable'; readonly debtId: string; readonly currency: Currency }
  | { readonly kind: 'fixed_asset'; readonly assetId: string; readonly currency: Currency }

export type CompanyEquityAccount = 'owner_funding' | 'owner_drawings' | 'opening'
export const COMPANY_EQUITY_ACCOUNTS = ['owner_funding', 'owner_drawings', 'opening'] as const satisfies readonly CompanyEquityAccount[]

export type CompanyIncomeAccount = 'general' | 'payable_forgiven'
export const COMPANY_INCOME_ACCOUNTS = ['general', 'payable_forgiven'] as const satisfies readonly CompanyIncomeAccount[]

/** Where a company expense is filed. A vehicle or asset centre names its id. */
export type CompanyExpenseCentre = 'general' | 'receivable_writeoff' | `vehicle:${string}` | `asset:${string}`

export type CompanyFundKind = CompanyFundRef['kind']

/** Every company account kind — the same ten `fund_type` values 0065 added. */
export const COMPANY_FUND_KINDS = [
  'company_cash',
  'depreciation_reserve',
  'company_fx_position',
  'branch_clearing',
  'company_payable',
  'company_receivable',
  'fixed_asset',
  'company_expense',
  'company_income',
  'company_equity',
] as const satisfies readonly CompanyFundKind[]

/**
 * Which company events may move which company account — the domain copy of 0066's
 * `ash_company_fund_event_allowed`. A PostgreSQL test compares every pair between the two.
 */
export const COMPANY_FUND_ALLOWED_EVENTS: Readonly<Record<CompanyFundKind, readonly CompanyLedgerEvent[]>> = {
  company_cash: [
    'company_deposit',
    'company_withdrawal',
    'company_expense',
    'company_income',
    'company_fx_exchange',
    'company_opening_transfer',
    'company_restoration_mirror',
    'company_debt_open',
    'company_debt_payment',
    'asset_purchase',
    'depreciation_transfer',
    'depreciation_release',
    'company_correction',
  ],
  depreciation_reserve: [
    'depreciation_transfer',
    'depreciation_release',
    'company_expense',
    'company_debt_payment',
    'asset_purchase',
    'company_correction',
  ],
  company_fx_position: ['company_fx_exchange', 'company_correction'],
  branch_clearing: ['company_opening_transfer', 'company_restoration_mirror'],
  company_payable: [
    'company_debt_open',
    'company_debt_payment',
    'company_debt_writeoff',
    'asset_purchase',
    'company_correction',
  ],
  company_receivable: [
    'company_debt_open',
    'company_debt_payment',
    'company_debt_writeoff',
    'asset_purchase',
    'company_correction',
  ],
  fixed_asset: ['asset_purchase', 'company_correction'],
  company_expense: ['company_expense', 'company_debt_open', 'company_debt_writeoff', 'company_correction'],
  company_income: ['company_income', 'company_debt_open', 'company_debt_writeoff', 'company_correction'],
  company_equity: [
    'company_deposit',
    'company_withdrawal',
    'company_expense',
    'company_debt_open',
    'company_debt_payment',
    'asset_purchase',
    'company_correction',
  ],
}

export const isCompanyFund = (fund: FundRef): fund is CompanyFundRef =>
  (COMPANY_FUND_KINDS as readonly string[]).includes(fund.kind)

/**
 * Every fund kind, branch and company. Exhaustive by construction — the check below fails to
 * compile the day a `FundRef` kind is added without being listed — so a test iterating it covers
 * every code `fundCode` can produce.
 */
export const FUND_KINDS = [
  'office_cash',
  'office_wallet',
  'driver_cash',
  'driver_wallet',
  'yalago_share',
  'driver_share_payable',
  'company_revenue',
  'yalago_income',
  'fee_earned',
  'other_income',
  'company_box',
  'driver_receivable_cash',
  'driver_receivable_wallet',
  'driver_shift_funding_cash',
  'driver_shift_funding_wallet',
  'advance_receivable_cash',
  'advance_receivable_wallet',
  'cost_center',
  ...COMPANY_FUND_KINDS,
] as const satisfies readonly FundRef['kind'][]

type MissingFundKinds = Exclude<FundRef['kind'], (typeof FUND_KINDS)[number]>
/** Compile-time proof that `FUND_KINDS` names every `FundRef` kind. */
const FUND_KINDS_EXHAUSTIVE: [MissingFundKinds] extends [never] ? true : false = true
void FUND_KINDS_EXHAUSTIVE

/**
 * The currency a fund holds. Every branch fund is new lira; a company fund says so itself, and the
 * branch clearing account mirrors a branch's SYP `company_box`.
 */
export function currencyOf(fund: FundRef): Currency {
  return 'currency' in fund ? fund.currency : 'SYP_NEW'
}

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
  /** The currency whose debits and credits disagree. */
  readonly currency: Currency
  constructor(posting: Posting, debits: Minor, credits: Minor, currency: Currency = 'SYP_NEW') {
    super(
      `posting ${posting.eventType}/${posting.occurrenceKey} is unbalanced: D ${debits} <> C ${credits}` +
        (currency === 'SYP_NEW' ? '' : ` (${currency})`),
    )
    this.name = 'UnbalancedPostingError'
    this.posting = posting
    this.debits = debits
    this.credits = credits
    this.currency = currency
  }
}

/** A posting that spans currencies without being a two-currency exchange. */
export class MixedCurrencyPostingError extends Error {
  readonly posting: Posting
  readonly currencies: readonly Currency[]
  constructor(posting: Posting, currencies: readonly Currency[]) {
    super(
      `posting ${posting.eventType}/${posting.occurrenceKey} spans ${currencies.join(' + ')}; ` +
        'only company_fx_exchange (or its company_correction reversal) may span exactly two currencies',
    )
    this.name = 'MixedCurrencyPostingError'
    this.posting = posting
    this.currencies = currencies
  }
}

/** Σ debits over every line, currency-blind. Meaningful for a single-currency posting. */
export function debitsOf(posting: Posting): Minor {
  return sum(posting.lines.filter((l) => l.side === 'D').map((l) => l.amount))
}

/** Σ credits over every line, currency-blind. Meaningful for a single-currency posting. */
export function creditsOf(posting: Posting): Minor {
  return sum(posting.lines.filter((l) => l.side === 'C').map((l) => l.amount))
}

export interface CurrencyBalance {
  readonly currency: Currency
  readonly debits: Minor
  readonly credits: Minor
}

/** Debits and credits per currency, in `CURRENCIES` order, for the currencies the posting uses. */
export function currencyBalances(posting: Posting): CurrencyBalance[] {
  const totals = new Map<Currency, { debits: bigint; credits: bigint }>()
  for (const line of posting.lines) {
    const currency = currencyOf(line.fund)
    const total = totals.get(currency) ?? { debits: 0n, credits: 0n }
    if (line.side === 'D') total.debits += line.amount
    else total.credits += line.amount
    totals.set(currency, total)
  }
  return (['SYP_NEW', 'USD'] as const)
    .filter((currency) => totals.has(currency))
    .map((currency) => {
      const total = totals.get(currency)!
      return { currency, debits: minor(total.debits), credits: minor(total.credits) }
    })
}

/**
 * The only events that may move two currencies at once — and never more than two.
 *
 * An exchange, and its reversal (C2). `company_correction` undoes a company command line for line,
 * and the undo of a four-line exchange is itself a four-line, two-currency entry. Each currency still
 * balances on its own — that part of the rule has no exception — and the database requires every
 * `company_correction` to be the exact inverse of a reversible command (migration 0067), so a
 * two-currency correction can only ever be an exchange taken back.
 */
export const TWO_CURRENCY_EVENTS = ['company_fx_exchange', 'company_correction'] as const satisfies readonly LedgerEvent[]

const mayCrossCurrencies = (posting: Posting, currencies: number): boolean =>
  currencies <= 1 ||
  (currencies === 2 && (TWO_CURRENCY_EVENTS as readonly LedgerEvent[]).includes(posting.eventType))

/**
 * The balance rule the database enforces at COMMIT (0066's `assert_entry_balanced`, widened by 0067),
 * without the throw: per currency, debits equal credits; and a posting spans two currencies only as
 * an exchange or its reversal. `null` when the posting is sound. Shared by `assertBalanced` and both ledger adapters so
 * the three can never disagree about what «balanced» means.
 */
export function postingBalanceProblem(
  posting: Posting,
):
  | { readonly kind: 'unbalanced'; readonly currency: Currency; readonly debits: Minor; readonly credits: Minor }
  | { readonly kind: 'mixed_currency'; readonly currencies: readonly Currency[] }
  | null {
  const balances = currencyBalances(posting)
  const unbalanced = balances.find((b) => b.debits !== b.credits)
  if (unbalanced) return { kind: 'unbalanced', ...unbalanced }
  if (!mayCrossCurrencies(posting, balances.length)) {
    return { kind: 'mixed_currency', currencies: balances.map((b) => b.currency) }
  }
  return null
}

/**
 * The invariant the database also enforces with a deferred constraint trigger. Checked here so
 * a recipe bug fails in a unit test rather than at COMMIT in production.
 *
 * Balanced PER CURRENCY (0066): $100 against 100 lira is not a balanced entry, it is two unbalanced
 * ones. For a single-currency posting this is exactly the old Σ D = Σ C.
 */
export function assertBalanced(posting: Posting): Posting {
  const problem = postingBalanceProblem(posting)
  if (problem?.kind === 'unbalanced') {
    throw new UnbalancedPostingError(posting, problem.debits, problem.credits, problem.currency)
  }
  if (posting.lines.length === 0) throw new UnbalancedPostingError(posting, ZERO, ZERO)
  if (problem?.kind === 'mixed_currency') throw new MixedCurrencyPostingError(posting, problem.currencies)
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

/**
 * Dedicated loss account for an ordinary receivable the company deliberately writes off.
 *
 * It is a cost centre rather than either office fund because no cash or wallet moved. Keeping one
 * stable code also prevents callers from choosing an arbitrary counterpart and disguising a
 * collection, withdrawal, or owner movement as a write-off.
 */
export const RECEIVABLE_WRITEOFF_LOSS_COST_CENTER = 'receivable_writeoff_loss' as const

/**
 * Write off part of a named driver's ordinary receivable without pretending it was collected.
 *
 * The receivable asset falls (credit) and the dedicated loss rises (debit). `office_cash` and
 * `office_wallet` are deliberately absent: a write-off is an accounting loss, not money returning
 * to either box. Shift-funding is intentionally unsupported because it represents money the driver
 * still physically holds for the next shift, not an ordinary debt eligible for this workflow.
 */
export function receivableWriteoff(
  driverId: string,
  channel: 'cash' | 'wallet',
  amount: Minor,
  occurrenceKey: string,
): Posting {
  if (amount <= ZERO) throw new RangeError(`receivable write-off must be positive, got ${amount}`)
  const receivable: FundRef = channel === 'cash'
    ? { kind: 'driver_receivable_cash', driverId }
    : { kind: 'driver_receivable_wallet', driverId }
  return assertBalanced({
    eventType: 'receivable_adjustment',
    occurrenceKey,
    lines: [
      D(
        { kind: 'cost_center', costCenterId: RECEIVABLE_WRITEOFF_LOSS_COST_CENTER },
        amount,
        'receivable_writeoff_loss',
      ),
      C(receivable, amount, 'receivable_written_off'),
    ],
  })
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
    cashShortageReceivable: settlement.cashShortageReceivable,
    managerChargeTotal: settlement.managerChargeTotal,
  })
  const scalarFields = [
    'grossDriverShare',
    'baseDriverShare',
    'managerChargeTotal',
    'expectedTotal',
    'actualTotal',
    'variance',
    'finalEmployeeCash',
    'officeEntitlement',
    'cashClaimToOffice',
    'walletClaimToOffice',
    'cashReceivableDeferred',
    'walletReceivableDeferred',
    'maximumCashShortageReceivable',
    'cashShortageReceivable',
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
  /*
   * «الحسم» raises what the office collects without touching what the employee EARNED.
   *
   * `baseDriverShare` stays his earned share — he earned it — and the charge is money he pays out
   * of it. Folding the charge into `baseDriverShare` instead would post a smaller
   * `driver_share_payable` and let the extra cash land in `office_cash` unnamed, so the books would
   * show the company holding more money for no stated reason. The credit below is that reason.
   */
  const managerCharge = settlement.managerChargeTotal
  const cashClaimToOffice = add(sub(cashAfterWallet, settlement.baseDriverShare), managerCharge)
  if (cashClaimToOffice !== settlement.cashClaimToOffice) {
    throw new RangeError(
      `cash-settled claim disagrees with reviewed plan: ${cashClaimToOffice} vs ${settlement.cashClaimToOffice}`,
    )
  }
  const cashToOffice = sub(
    sub(cashClaimToOffice, settlement.cashReceivableDeferred),
    settlement.cashShortageReceivable,
  )
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
  if (settlement.cashShortageReceivable > ZERO) {
    // The operational custody is cleared exactly once below. This debit preserves the unpaid part
    // as an ordinary receivable while office_cash records only what was physically received. It is
    // deliberately not a direct receivable adjustment (which would credit office_cash again) and
    // not shift funding (which would be consumed automatically at the next open).
    cashLines.push(
      D(
        { kind: 'driver_receivable_cash', driverId },
        settlement.cashShortageReceivable,
        'cash_shortage_receivable',
      ),
    )
  }
  if (managerCharge > ZERO) {
    /*
     * The charge, as INCOME — not as a quietly larger cash box.
     *
     * `other_income` and deliberately not `company_revenue`: BR4 defines that account as the
     * company's residual share of DELIVERY fees and `/dashboard/profit` reports it under that name,
     * so booking damage recovered from a driver there would overstate the delivery business by
     * exactly the charge. It is the same account a battery sale uses, for the same reason.
     *
     * This is also the line that makes the posting balance. The driver's full earned share still
     * debits `driver_share_payable` while `office_cash` receives the charge on top, so without a
     * credit of the same size the entry would be out by exactly `managerCharge`.
     */
    cashLines.push(C({ kind: 'other_income' }, managerCharge, 'manager_charge'))
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

/**
 * «كل ليرة تخرج» (SRS G) — and it does not always leave the cash box.
 *
 * THE CALLER NAMES A CHANNEL, NEVER A FUND, for the reason `income` states below: an operator who
 * types a fund code instead reaches `fundRefFromCode`'s default clause, which turns anything it
 * does not recognise into `cost_center:<code>` — a look-alike account no cost report sums and no
 * error is ever raised about.
 *
 * The wallet channel is not decoration. Yallago's cut leaves the wallet, so a cost that falls on
 * the wallet is ordinary here; before it existed the only honest record of one was a raw manual
 * entry, which never appears in «الصرفيات» and so silently understates every cost report.
 */
export function expense(
  channel: OfficeFund,
  costCenterId: string,
  amount: Minor,
  occurrenceKey = '1',
): Posting {
  if (amount <= ZERO) throw new RangeError(`expense must be positive, got ${amount}`)
  return assertBalanced({
    eventType: 'expense',
    occurrenceKey,
    lines: [D({ kind: 'cost_center', costCenterId }, amount), C({ kind: channel }, amount)],
  })
}

/**
 * «مدخول مباشر» — the mirror of `expense`: money arriving that is not a delivery fee.
 *
 * THE CALLER NAMES A CHANNEL, NEVER A FUND. `channel` is a physical fact the person recording it
 * knows — the notes went into the drawer, or the transfer landed in the branch wallet. Letting an
 * operator type a fund code instead is the trap `fundRefFromCode`'s own header describes: its
 * default clause turns any unrecognised string into `cost_center:<code>`, a look-alike account no
 * profit reader sums and no error is ever raised about.
 *
 * The wallet channel is not decoration. An office wallet can also be the side that FALLS on a
 * correction — which is precisely why a cash-only income recipe could not express Haidar's shift.
 */
export function income(channel: OfficeFund, amount: Minor, occurrenceKey = '1'): Posting {
  if (amount <= ZERO) throw new RangeError(`income must be positive, got ${amount}`)
  return assertBalanced({
    eventType: 'income',
    occurrenceKey,
    lines: [D({ kind: channel }, amount), C({ kind: 'other_income' }, amount)],
  })
}

// ── «السلفة» — an expense that must come back (owner decision 17) ─────────────────────────
//
// The owner's own framing: «هوي صرفية دفعت لكنها يجب ان ترد كاملة». Money leaves the box the way a
// صرفية does — a named person, a category, a receipt — but unlike a صرفية it is NOT consumed. It is
// still company property until it is handed back, so it stays counted as office capital and الترميم
// must not read the emptier box as a shortfall.
//
// The arithmetic carries the whole rule, so nobody has to enforce it:
//
//   pay 100,000    box 3,900,000 + ذمم 400,000 + سلف 100,000 = target → nothing moves
//   repay it       box 4,000,000 + ذمم 400,000 + سلف       0 = target → nothing moves
//   convert it     box 3,900,000 + ذمم 400,000 + سلف       0 < target → one «شحن» of 100,000
//
// Capital falls at the conversion and not one moment earlier — which is exactly what «يجب أن ترد»
// means in double entry.
//
// None of the three touches `company_box`, and none borrows the `kaish`/`shahn` line roles: the
// treasury dashboard classifies a flow by those roles, and an advance wearing one would be read as
// money that left for صندوق الشركة when it never left the branch.

/** The advance asset for one advance, on the side of the box the money left from. */
function advanceFund(channel: OfficeFund, advanceId: string): FundRef {
  return channel === 'office_cash'
    ? { kind: 'advance_receivable_cash', advanceId }
    : { kind: 'advance_receivable_wallet', advanceId }
}

/**
 * Pay an advance out of a named box. The box falls; a named advance asset rises by the same amount.
 *
 * Working capital is unchanged by construction — that is the whole point, and a test pins it.
 */
export function advance(
  channel: OfficeFund,
  advanceId: string,
  amount: Minor,
  occurrenceKey = '1',
): Posting {
  if (amount <= ZERO) throw new RangeError(`advance must be positive, got ${amount}`)
  return assertBalanced({
    eventType: 'advance',
    occurrenceKey,
    lines: [
      D(advanceFund(channel, advanceId), amount, 'advance_created'),
      C({ kind: channel }, amount, 'office_value_advanced'),
    ],
  })
}

/**
 * Reclassify a driver's «ذمة» as a «سلفة» — the debt is the same money, filed differently.
 *
 * NOTHING PHYSICAL HAPPENS HERE, and the posting says so: one counted asset falls and another
 * rises, no box is touched, and office capital is unchanged. That is the whole reason this recipe
 * exists rather than composing the two routes that already exist. Collecting the receivable and
 * then paying an advance reaches the same end state, but it writes a COLLECTION into the driver's
 * history — «تحصيل» for money that never came back — and shows cash entering and leaving the box
 * on a day neither happened. `ReceivableEventRecord.intent` carries a comment naming that exact lie
 * as the thing the ledger exists to prevent.
 *
 * The channel is inherited from the receivable, never chosen: a debt owed in cash stays owed in
 * cash, so a later repayment lands in the box it was always owed to.
 */
export function advanceFromReceivable(
  channel: OfficeFund,
  advanceId: string,
  driverId: string,
  amount: Minor,
  occurrenceKey = '1',
): Posting {
  if (amount <= ZERO) throw new RangeError(`advance from receivable must be positive, got ${amount}`)
  const receivable: FundRef =
    channel === 'office_cash'
      ? { kind: 'driver_receivable_cash', driverId }
      : { kind: 'driver_receivable_wallet', driverId }
  return assertBalanced({
    eventType: 'advance',
    occurrenceKey,
    lines: [
      D(advanceFund(channel, advanceId), amount, 'advance_created'),
      C(receivable, amount, 'receivable_converted_to_advance'),
    ],
  })
}

/**
 * Money coming back — the exact reverse of the payment, whole or in part.
 *
 * IT RETURNS TO THE BOX IT LEFT. Not tidiness: الترميم plans each box against its own target, so an
 * advance repaid into the other box would push one leg up and the other down at different moments,
 * letting a single advance's own balance go negative in between — which every reader in the system
 * treats as corruption. If the notes are physically handed over for a wallet advance, record the
 * repayment to the wallet and move it with `officeTransfer`, which is proven to leave capital alone.
 */
export function advanceRepayment(
  channel: OfficeFund,
  advanceId: string,
  amount: Minor,
  occurrenceKey = '1',
): Posting {
  if (amount <= ZERO) throw new RangeError(`advance repayment must be positive, got ${amount}`)
  return assertBalanced({
    eventType: 'advance_repayment',
    occurrenceKey,
    lines: [
      D({ kind: channel }, amount, 'advance_repaid'),
      C(advanceFund(channel, advanceId), amount, 'advance_cleared'),
    ],
  })
}

/**
 * The advance is never coming back: recognise it as the صرفية it turned out to be.
 *
 * No box moves — the cash left weeks ago. The advance asset falls and the cost centre rises, which
 * is the moment office capital finally drops. `costCenterId` is derived the way an ordinary expense
 * derives it (`vehicleId ?? '<costCenterKind>:<branchId>'`), never from the category: the category
 * is a column on `expenses` and has never been an account, so debiting it would mint a look-alike
 * cost centre that no profitability reader sums.
 */
export function advanceConversion(
  channel: OfficeFund,
  advanceId: string,
  costCenterId: string,
  amount: Minor,
  occurrenceKey = '1',
): Posting {
  if (amount <= ZERO) throw new RangeError(`advance conversion must be positive, got ${amount}`)
  return assertBalanced({
    eventType: 'advance_conversion',
    occurrenceKey,
    lines: [
      D({ kind: 'cost_center', costCenterId }, amount, 'advance_converted_cost'),
      C(advanceFund(channel, advanceId), amount, 'advance_converted'),
    ],
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

/**
 * Move money between the branch's two office boxes — cash to wallet, or wallet to cash.
 *
 * Owner request, 2026-08-31. It is an everyday act: the wallet runs dry while cash piles up because
 * Yallago takes its cut from the wallet and the drivers hand back notes, so the office tops one from
 * the other. Until now the only route that could do it took a free-form fund code, and
 * `fundRefFromCode` turns any string it does not recognise into `cost_center:<code>` — a look-alike
 * account no reader sums and no error is raised about. Naming the two ends closes that door.
 *
 * WORKING CAPITAL DOES NOT MOVE, and that is the whole character of this posting: both legs are
 * office funds, so the branch holds exactly what it held a second ago. It is a reshaping, not an
 * income, an expense, or a sweep — which is why it carries its own line roles rather than borrowing
 * `kaish`/`shahn`. Those two mean «money left for صندوق الشركة» and the treasury reader classifies
 * by them; a transfer wearing one would be counted as company money that never moved.
 */
export function officeTransfer(
  from: OfficeFund,
  to: OfficeFund,
  amount: Minor,
  occurrenceKey = '1',
): Posting {
  if (amount <= ZERO) throw new RangeError(`office transfer must be positive, got ${amount}`)
  if (from === to) throw new RangeError(`office transfer needs two different boxes, got ${from} twice`)
  return assertBalanced({
    eventType: 'manual',
    occurrenceKey,
    lines: [D({ kind: to }, amount, 'office_transfer_in'), C({ kind: from }, amount, 'office_transfer_out')],
  })
}

/**
 * «كييش» BY HAND — the manager moving money out of a box without running الترميم.
 *
 * Identical lines and identical roles to `sweepToCompany`, and deliberately a DIFFERENT event type.
 * `restoration` is not a label, it is a promise: `restoration_journal_fact_from_entry` refuses any
 * `restoration` entry that does not have an immutable `restorations` row in the same transaction —
 * a sealed count, a feasible plan, the whole atomic ceremony. A hand sweep has none of that, so
 * calling it one made the route answer 500 in production every time it was pressed, while the
 * memory-backed tests passed because no trigger exists there.
 *
 * The shared MEANING lives where the reader actually looks: the `kaish` line role. The dashboard
 * classifies by role first and falls back to event type, so «كييش» still sums as «كييش» whichever
 * of the two produced the row — which was the point of sharing a recipe in the first place.
 */
export function manualKaish(office: OfficeFund, amount: Minor, occurrenceKey = '1'): Posting {
  return assertBalanced({
    eventType: 'manual',
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

/** A company fund's id segment: present, and free of the `:` that separates code segments. */
function codeId(kind: string, what: string, id: string): string {
  if (id === '' || id.includes(':')) {
    throw new RangeError(`${kind} requires a ${what} without ':', got ${JSON.stringify(id)}`)
  }
  return id
}

function codeCurrency(kind: string, currency: string | undefined): Currency {
  if (!isCurrency(currency)) {
    throw new RangeError(`${kind} requires a currency (SYP_NEW or USD), got ${JSON.stringify(currency)}`)
  }
  return currency
}

function expenseCentre(centre: string): CompanyExpenseCentre {
  if (centre === 'general' || centre === 'receivable_writeoff') return centre
  const [scope, id, ...extra] = centre.split(':')
  if ((scope === 'vehicle' || scope === 'asset') && id !== undefined && extra.length === 0) {
    return `${scope}:${codeId('company_expense', `${scope} id`, id)}`
  }
  throw new RangeError(
    `company_expense requires a centre (general | receivable_writeoff | vehicle:<id> | asset:<id>), got ${JSON.stringify(centre)}`,
  )
}

function oneOf<T extends string>(kind: string, what: string, allowed: readonly T[], value: string | undefined): T {
  if (value === undefined || !(allowed as readonly string[]).includes(value)) {
    throw new RangeError(`${kind} requires ${what} (${allowed.join(' | ')}), got ${JSON.stringify(value)}`)
  }
  return value as T
}

/**
 * Stable string identity for a fund. The database stores this in `funds.code`.
 *
 * THE ONE COPY. `packages/db` and the memory adapter both import this; the conformance suite
 * compares what each stores against it. A company code is validated on the way out as well as on
 * the way in, so a malformed id can never become a fund that `fundRefFromCode` cannot read back.
 */
export function fundCode(fund: FundRef): string {
  switch (fund.kind) {
    case 'office_cash':
    case 'office_wallet':
    case 'yalago_share':
    case 'company_revenue':
    case 'yalago_income':
    case 'fee_earned':
    case 'other_income':
    case 'company_box':
      return fund.kind
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
    // An advance is suffixed by the ADVANCE, not the party — the party is free text and has no id.
    case 'advance_receivable_cash':
    case 'advance_receivable_wallet':
      return `${fund.kind}:${fund.advanceId}`
    case 'cost_center':
      return `cost_center:${fund.costCenterId}`
    // ── The company ledger. The enum literal is the currency segment. ──────────────────────
    case 'company_cash':
    case 'depreciation_reserve':
    case 'company_fx_position':
      return `${fund.kind}:${codeCurrency(fund.kind, fund.currency)}`
    case 'company_equity':
      return `${fund.kind}:${codeCurrency(fund.kind, fund.currency)}:${oneOf(fund.kind, 'an account', COMPANY_EQUITY_ACCOUNTS, fund.account)}`
    case 'company_income':
      return `${fund.kind}:${codeCurrency(fund.kind, fund.currency)}:${oneOf(fund.kind, 'an account', COMPANY_INCOME_ACCOUNTS, fund.account)}`
    case 'company_expense':
      return `${fund.kind}:${codeCurrency(fund.kind, fund.currency)}:${expenseCentre(fund.centre)}`
    case 'branch_clearing':
      return `${fund.kind}:${codeId(fund.kind, 'branch id', fund.branchId)}`
    case 'company_payable':
    case 'company_receivable':
      return `${fund.kind}:${codeCurrency(fund.kind, fund.currency)}:${codeId(fund.kind, 'debt id', fund.debtId)}`
    case 'fixed_asset':
      return `${fund.kind}:${codeCurrency(fund.kind, fund.currency)}:${codeId(fund.kind, 'asset id', fund.assetId)}`
    default: {
      const unreachable: never = fund
      throw new RangeError(`unknown fund kind ${JSON.stringify(unreachable)}`)
    }
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
 *
 * STRICT for every known name (C1). A known name with a segment it does not take — `company_box:x`,
 * `office_cash:x` — used to be read as the bare fund with the suffix silently dropped; it now
 * throws, exactly as a missing driver id always has. A company code must carry a valid currency,
 * id and account, or it throws: a company account read back wrong is a different pocket.
 */
export function fundRefFromCode(code: string): FundRef {
  const [head = '', ...rest] = code.split(':')
  const tail = rest.join(':')
  const noSuffix = (): void => {
    if (rest.length > 0) throw new RangeError(`${head} takes no suffix, got ${JSON.stringify(code)}`)
  }
  const segments = (count: number, shape: string): void => {
    if (rest.length !== count) throw new RangeError(`${head} is ${shape}, got ${JSON.stringify(code)}`)
  }

  switch (head) {
    case 'office_cash':
    case 'office_wallet':
    case 'yalago_share':
    case 'company_revenue':
    case 'yalago_income':
    case 'fee_earned':
    case 'other_income':
    // WITHOUT THIS LINE a manual entry naming «company_box» silently becomes
    // `cost_center:company_box` — a different account that looks right in the UI and never moves
    // the fund the operator meant. Exactly the failure this function's own header describes.
    case 'company_box':
      noSuffix()
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
    // WITHOUT THESE TWO LINES an advance fund read back from the ledger becomes
    // `cost_center:advance_receivable_cash:<uuid>` — a look-alike account that الترميم does not
    // count toward office capital, so every night would read a phantom shortfall and «شحن» real
    // money out of صندوق الشركة. Nothing would raise; the totals would simply be wrong.
    case 'advance_receivable_cash':
    case 'advance_receivable_wallet':
      if (tail === '') throw new RangeError(`${head} requires an advance id, got ${JSON.stringify(code)}`)
      return { kind: head, advanceId: tail }
    case 'cost_center':
      if (tail === '') throw new RangeError(`cost_center requires an id, got ${JSON.stringify(code)}`)
      return { kind: 'cost_center', costCenterId: tail }
    // ── The company ledger ──────────────────────────────────────────────────────────────────
    case 'company_cash':
    case 'depreciation_reserve':
    case 'company_fx_position':
      segments(1, `${head}:<CUR>`)
      return { kind: head, currency: codeCurrency(head, rest[0]) }
    case 'company_equity':
      segments(2, `${head}:<CUR>:<account>`)
      return {
        kind: head,
        currency: codeCurrency(head, rest[0]),
        account: oneOf(head, 'an account', COMPANY_EQUITY_ACCOUNTS, rest[1]),
      }
    case 'company_income':
      segments(2, `${head}:<CUR>:<account>`)
      return {
        kind: head,
        currency: codeCurrency(head, rest[0]),
        account: oneOf(head, 'an account', COMPANY_INCOME_ACCOUNTS, rest[1]),
      }
    case 'company_expense':
      if (rest.length < 2) throw new RangeError(`${head} is ${head}:<CUR>:<centre>, got ${JSON.stringify(code)}`)
      return { kind: head, currency: codeCurrency(head, rest[0]), centre: expenseCentre(rest.slice(1).join(':')) }
    case 'branch_clearing':
      segments(1, `${head}:<branchId>`)
      return { kind: head, branchId: codeId(head, 'branch id', rest[0] ?? '') }
    case 'company_payable':
    case 'company_receivable':
      segments(2, `${head}:<CUR>:<debtId>`)
      return { kind: head, currency: codeCurrency(head, rest[0]), debtId: codeId(head, 'debt id', rest[1] ?? '') }
    case 'fixed_asset':
      segments(2, `${head}:<CUR>:<assetId>`)
      return { kind: head, currency: codeCurrency(head, rest[0]), assetId: codeId(head, 'asset id', rest[1] ?? '') }
    default:
      return { kind: 'cost_center', costCenterId: code }
  }
}
