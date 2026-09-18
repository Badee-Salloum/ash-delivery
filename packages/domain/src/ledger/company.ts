import { type Minor, ZERO, minor } from '../money/minor.ts'
import { type Currency, type Money, usdToSypMinor } from '../money/currency.ts'
import { FxError } from '../fx/rate.ts'
import type { RestorationPlan } from '../treasury/restoration.ts'
import {
  type CompanyExpenseCentre,
  type CompanyLedgerEvent,
  type FundRef,
  type Posting,
  type PostingLine,
  assertBalanced,
} from './recipes.ts'

/**
 * «صندوق الشركة» — the company ledger's commands (finance redesign C2).
 *
 * Every posting here lives in the company (HQ) ledger. Each is the exact line set migration 0067's
 * guard demands of its command row: the same funds, sides, amounts and LINE ROLES. The roles are not
 * decoration — the guard compares them one to one, a reversal keeps them, and the readers classify
 * by them — so they are declared once, here, and the SQL spells the same literals.
 *
 * Convention as everywhere: DEBIT increases a fund, CREDIT decreases it.
 */

export const COMPANY_LINE_ROLES = {
  depositReceived: 'deposit_received',
  depositSource: 'deposit_source',
  withdrawalDestination: 'withdrawal_destination',
  withdrawalPaid: 'withdrawal_paid',
  expenseCost: 'expense_cost',
  expensePaid: 'expense_paid',
  incomeReceived: 'income_received',
  incomeEarned: 'income_earned',
  fxSold: 'fx_sold',
  fxPaid: 'fx_paid',
  fxReceived: 'fx_received',
  fxBought: 'fx_bought',
  openingTransfer: 'opening_transfer',
  kaishMirror: 'kaish_mirror',
  shahnMirror: 'shahn_mirror',
} as const

export type CompanyMoveKind = 'deposit' | 'withdrawal'
/** Where a deposit comes from: the owner's own money, or an opening balance entered by hand. */
export type CompanyDepositAccount = 'owner_funding' | 'opening'
/**
 * Which pocket paid a company expense.
 *
 *  • `pocket`        — the company cash pocket in that currency;
 *  • `reserve`       — «الاهتلاك» in that currency (the owner allowed the reserve to buy and pay);
 *  • `owner_outside` — the owner paid it himself outside the system: no pocket moves, the cost is
 *    recorded against his funding so the books still see it.
 */
export type CompanyPaidFrom = 'pocket' | 'reserve' | 'owner_outside'
export const COMPANY_PAID_FROM = ['pocket', 'reserve', 'owner_outside'] as const satisfies readonly CompanyPaidFrom[]

/** The direction of a branch `company_box` movement, as the restoration names it. */
export type MirrorDirection = 'to_company' | 'from_company'

/** The commands a `company_correction` may undo — each by the exact inverse of its own lines. */
export const REVERSIBLE_COMPANY_EVENTS = [
  'company_deposit',
  'company_withdrawal',
  'company_expense',
  'company_income',
  'company_fx_exchange',
] as const satisfies readonly CompanyLedgerEvent[]
export type ReversibleCompanyEvent = (typeof REVERSIBLE_COMPANY_EVENTS)[number]

export const isReversibleCompanyEvent = (event: string): event is ReversibleCompanyEvent =>
  (REVERSIBLE_COMPANY_EVENTS as readonly string[]).includes(event)

const D = (fund: FundRef, amount: Minor, role: string): PostingLine => ({ fund, side: 'D', amount, role })
const C = (fund: FundRef, amount: Minor, role: string): PostingLine => ({ fund, side: 'C', amount, role })

function positive(what: string, amount: Minor): void {
  if (amount <= ZERO) throw new RangeError(`${what} must be positive, got ${amount}`)
}

function key(occurrenceKey: string): string {
  if (occurrenceKey.trim() === '') throw new RangeError('a company command needs its occurrence key')
  return occurrenceKey
}

const cash = (currency: Currency): FundRef => ({ kind: 'company_cash', currency })

/** «إيداع المالك» — money into a company pocket, from the owner or as an opening balance. */
export function companyDeposit(
  currency: Currency,
  amount: Minor,
  account: CompanyDepositAccount,
  occurrenceKey: string,
): Posting {
  positive('company deposit', amount)
  return assertBalanced({
    eventType: 'company_deposit',
    occurrenceKey: key(occurrenceKey),
    lines: [
      D(cash(currency), amount, COMPANY_LINE_ROLES.depositReceived),
      C({ kind: 'company_equity', currency, account }, amount, COMPANY_LINE_ROLES.depositSource),
    ],
  })
}

/** «سحب المالك» — money out of a company pocket to the owner. The database refuses it below zero. */
export function companyWithdrawal(currency: Currency, amount: Minor, occurrenceKey: string): Posting {
  positive('company withdrawal', amount)
  return assertBalanced({
    eventType: 'company_withdrawal',
    occurrenceKey: key(occurrenceKey),
    lines: [
      D({ kind: 'company_equity', currency, account: 'owner_drawings' }, amount, COMPANY_LINE_ROLES.withdrawalDestination),
      C(cash(currency), amount, COMPANY_LINE_ROLES.withdrawalPaid),
    ],
  })
}

/** The fund a company expense is paid from. */
export function companyExpenseSource(currency: Currency, paidFrom: CompanyPaidFrom): FundRef {
  switch (paidFrom) {
    case 'pocket':
      return cash(currency)
    case 'reserve':
      return { kind: 'depreciation_reserve', currency }
    case 'owner_outside':
      return { kind: 'company_equity', currency, account: 'owner_funding' }
  }
}

/** «صرفية الشركة» — a cost filed under its centre, paid from a pocket, the reserve, or by the owner. */
export function companyExpense(
  currency: Currency,
  amount: Minor,
  centre: CompanyExpenseCentre,
  paidFrom: CompanyPaidFrom,
  occurrenceKey: string,
): Posting {
  positive('company expense', amount)
  return assertBalanced({
    eventType: 'company_expense',
    occurrenceKey: key(occurrenceKey),
    lines: [
      D({ kind: 'company_expense', currency, centre }, amount, COMPANY_LINE_ROLES.expenseCost),
      C(companyExpenseSource(currency, paidFrom), amount, COMPANY_LINE_ROLES.expensePaid),
    ],
  })
}

/** «مدخول الشركة» — income that is not a branch delivery fee, into the pocket of its currency. */
export function companyIncome(currency: Currency, amount: Minor, occurrenceKey: string): Posting {
  positive('company income', amount)
  return assertBalanced({
    eventType: 'company_income',
    occurrenceKey: key(occurrenceKey),
    lines: [
      D(cash(currency), amount, COMPANY_LINE_ROLES.incomeReceived),
      C({ kind: 'company_income', currency, account: 'general' }, amount, COMPANY_LINE_ROLES.incomeEarned),
    ],
  })
}

/**
 * «تصريف عملة» — both ACTUAL amounts, four lines, no profit or loss.
 *
 * Each currency balances through its own FX position account, so the entry is balanced per currency
 * without inventing a conversion: what left one pocket and what arrived in the other are both what
 * physically changed hands. The rate those two amounts imply is frozen on the entry by the caller
 * (`exchangeRate`).
 */
export function companyFxExchange(from: Money, to: Money, occurrenceKey: string): Posting {
  if (from.currency === to.currency) {
    throw new RangeError(`an exchange needs two different currencies, got ${from.currency} twice`)
  }
  positive('exchange amount paid', from.amount)
  positive('exchange amount received', to.amount)
  return assertBalanced({
    eventType: 'company_fx_exchange',
    occurrenceKey: key(occurrenceKey),
    lines: [
      D({ kind: 'company_fx_position', currency: from.currency }, from.amount, COMPANY_LINE_ROLES.fxSold),
      C(cash(from.currency), from.amount, COMPANY_LINE_ROLES.fxPaid),
      D(cash(to.currency), to.amount, COMPANY_LINE_ROLES.fxReceived),
      C({ kind: 'company_fx_position', currency: to.currency }, to.amount, COMPANY_LINE_ROLES.fxBought),
    ],
  })
}

/**
 * The frozen rate two actual amounts imply: SYP minor units per ONE dollar, the unit `fx_days` and
 * `journal_entries.syp_minor_per_usd` store.
 *
 *     rate = round_half_up(sypMinor × 100 / usdCents)
 *
 * The rate is an integer and the two amounts are whatever changed hands, so the rate cannot always
 * reproduce the lira side to the last minor unit — $37 for 4,820.00 implies 13,027.03 per dollar.
 * What IS exact: this is the one integer nearest the true ratio, and whenever SOME integer rate
 * reproduces the lira amount under `usdToSypMinor`, this one does. Migration 0067 recomputes it in
 * `numeric` and refuses any other value, so a frozen rate can never be typed in by hand.
 */
export function fxRateFromAmounts(usdCents: Minor, sypMinor: Minor): bigint {
  if (usdCents <= ZERO) throw new FxError(`an exchange needs a positive dollar amount, got ${usdCents}`)
  if (sypMinor <= ZERO) throw new FxError(`an exchange needs a positive lira amount, got ${sypMinor}`)
  const rate = (sypMinor * 200n + usdCents) / (usdCents * 2n)
  if (rate < 1n) {
    throw new FxError(`${sypMinor} lira minor for ${usdCents} cents implies a rate below one minor unit per dollar`)
  }
  return rate
}

/** The rate of an exchange, whichever way it went. */
export function exchangeRate(from: Money, to: Money): bigint {
  if (from.currency === to.currency) throw new FxError('an exchange needs two different currencies')
  const usd = from.currency === 'USD' ? from : to
  const syp = from.currency === 'USD' ? to : from
  return fxRateFromAmounts(usd.amount, syp.amount)
}

/**
 * How far the lira side of an exchange sits from what its frozen rate converts the dollars to.
 * Zero for every representable pair; never more than half a cent's worth plus half a minor unit.
 */
export function exchangeRoundingGap(usdCents: Minor, sypMinor: Minor, rate: bigint): Minor {
  return minor(sypMinor - usdToSypMinor(usdCents, rate))
}

/**
 * «عكس» — the exact inverse of a company command: every line, same fund, same amount, same ROLE,
 * opposite side. The caller freezes the target's rate on the reversal too.
 */
export function companyReversal(target: Posting, occurrenceKey: string): Posting {
  if (!isReversibleCompanyEvent(target.eventType)) {
    throw new RangeError(`${target.eventType} is not a reversible company command`)
  }
  return assertBalanced({
    eventType: 'company_correction',
    occurrenceKey: key(occurrenceKey),
    lines: target.lines.map((l) => {
      if (l.role === undefined) throw new RangeError('a company command line always carries its role')
      return l.side === 'D' ? C(l.fund, l.amount, l.role) : D(l.fund, l.amount, l.role)
    }),
  })
}

/** The occurrence key of the HQ half of branch entry `sourceEntryId`. */
export const mirrorOccurrenceKey = (sourceEntryId: number): string => `mirror:${sourceEntryId}`

/** The occurrence key of a branch's opening transfer — one per branch, ever. */
export const openingOccurrenceKey = (branchId: string): string => `opening:${branchId}`

/**
 * The HQ half of a branch entry that moved `company_box` after cutover.
 *
 *   to_company   («كييش»): the branch's company_box rose, so the company SYP pocket rises and the
 *                clearing account records that the money is held for it at the branch.
 *   from_company («شحن»):  the reverse. The pocket may go negative — the owner's own decision — which
 *                is why 0066's pocket guard exempts exactly this event.
 *
 * After every mirror, `company_box(branch) + branch_clearing(branch) = 0`.
 */
export function restorationMirror(
  direction: MirrorDirection,
  amount: Minor,
  branchId: string,
  sourceEntryId: number,
): Posting {
  positive('mirrored amount', amount)
  if (!Number.isSafeInteger(sourceEntryId) || sourceEntryId <= 0) {
    throw new RangeError(`a mirror needs its source entry id, got ${sourceEntryId}`)
  }
  const clearing: FundRef = { kind: 'branch_clearing', branchId }
  const pocket = cash('SYP_NEW')
  const lines =
    direction === 'to_company'
      ? [D(pocket, amount, COMPANY_LINE_ROLES.kaishMirror), C(clearing, amount, COMPANY_LINE_ROLES.kaishMirror)]
      : [D(clearing, amount, COMPANY_LINE_ROLES.shahnMirror), C(pocket, amount, COMPANY_LINE_ROLES.shahnMirror)]
  return assertBalanced({
    eventType: 'company_restoration_mirror',
    occurrenceKey: mirrorOccurrenceKey(sourceEntryId),
    lines,
  })
}

/** Cutover: the branch's `company_box` balance, moved as-is into the company SYP pocket. */
export function companyOpeningTransfer(branchId: string, amount: Minor): Posting {
  positive('opening transfer', amount)
  return assertBalanced({
    eventType: 'company_opening_transfer',
    occurrenceKey: openingOccurrenceKey(branchId),
    lines: [
      D(cash('SYP_NEW'), amount, COMPANY_LINE_ROLES.openingTransfer),
      C({ kind: 'branch_clearing', branchId }, amount, COMPANY_LINE_ROLES.openingTransfer),
    ],
  })
}

/**
 * Where a branch posting moved `company_box`: the direction and the amount of its one company_box
 * line, or `null` when it did not touch the fund. More than one such line is refused — the mirror
 * guard demands exactly one, and two would leave the direction ambiguous.
 */
export function companyBoxMovement(
  lines: readonly { readonly fundCode: string; readonly side: 'D' | 'C'; readonly amount: Minor }[],
): { direction: MirrorDirection; amount: Minor } | null {
  const touching = lines.filter((line) => line.fundCode === 'company_box')
  if (touching.length === 0) return null
  if (touching.length > 1) throw new RangeError('a branch entry may move company_box on one line only')
  const [line] = touching
  return { direction: line!.side === 'D' ? 'to_company' : 'from_company', amount: line!.amount }
}

/** Sweeps before top-ups: the pocket receives before it pays, whatever order the branch posted in. */
export function mirrorOrder<T extends { readonly direction: MirrorDirection }>(movements: readonly T[]): T[] {
  return [
    ...movements.filter((m) => m.direction === 'to_company'),
    ...movements.filter((m) => m.direction === 'from_company'),
  ]
}

/**
 * What tonight's restoration leaves in the company SYP pocket — a WARNING, never a refusal.
 *
 * The owner (2026-09-17): a «شحن» larger than the company pocket is allowed to drive it negative,
 * with a visible warning, rather than leave a branch short. So this returns the figure and a flag
 * and refuses nothing.
 */
export function companyPocketAfterRestoration(
  pocket: Minor,
  plan: Pick<RestorationPlan, 'netToCompany'>,
): { pocketAfter: Minor; warning: boolean } {
  const pocketAfter = minor(pocket + plan.netToCompany)
  return { pocketAfter, warning: pocketAfter < ZERO }
}

