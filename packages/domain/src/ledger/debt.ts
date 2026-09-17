import { type Currency } from '../money/currency.ts'
import { type Minor, ZERO, minor } from '../money/minor.ts'
import { companyExpenseSource, type CompanyPaidFrom } from './company.ts'
import {
  assertBalanced,
  type CompanyExpenseCentre,
  type FundRef,
  type Posting,
  type PostingLine,
} from './recipes.ts'

/** Both sides of the company debt register (finance redesign C3). */
export type CompanyDebtDirection = 'payable' | 'receivable'

/** Why the balance exists. The database stores this alongside the immutable opening command. */
export type CompanyDebtOrigin = 'cash' | 'expense' | 'income' | 'opening' | 'asset_purchase'

export const COMPANY_DEBT_LINE_ROLES = {
  openCounterpart: 'debt_open_counterpart',
  openBalance: 'debt_open_balance',
  paymentBalance: 'debt_payment_balance',
  paymentSource: 'debt_payment_source',
  collectionReceived: 'debt_collection_received',
  collectionBalance: 'debt_collection_balance',
  writeoffBalance: 'debt_writeoff_balance',
  writeoffCounterpart: 'debt_writeoff_counterpart',
} as const

const D = (fund: FundRef, amount: Minor, role: string): PostingLine => ({ fund, side: 'D', amount, role })
const C = (fund: FundRef, amount: Minor, role: string): PostingLine => ({ fund, side: 'C', amount, role })

function positive(label: string, value: Minor): void {
  if (value <= ZERO) throw new RangeError(`${label} must be positive, got ${value}`)
}

function id(label: string, value: string): string {
  const clean = value.trim()
  if (clean === '' || clean.includes(':')) throw new RangeError(`${label} must be a non-empty fund-code segment`)
  return clean
}

function occurrence(value: string): string {
  if (value.trim() === '') throw new RangeError('a company debt command needs its occurrence key')
  return value
}

export type CompanyDebtOpenInput = {
  debtId: string
  direction: CompanyDebtDirection
  currency: Currency
  principal: Minor
  origin: CompanyDebtOrigin
  occurrenceKey: string
  /** Required only for an expense-origin payable; defaults to the general company cost centre. */
  expenseCentre?: CompanyExpenseCentre
  /** Required only for an asset-purchase payable. */
  assetId?: string
}

/**
 * The non-debt side of a new balance.
 *
 * Direction/origin combinations are deliberately narrow: a payable can arise from borrowed cash,
 * an incurred expense, opening books, or a financed asset. A receivable can arise from cash lent,
 * earned income not yet collected, or opening books. Other combinations are accounting mistakes,
 * not alternate spellings of the same fact.
 */
export function companyDebtCounterpart(input: CompanyDebtOpenInput): FundRef {
  const { currency, direction, origin } = input
  if (direction === 'payable') {
    switch (origin) {
      case 'cash':
        return { kind: 'company_cash', currency }
      case 'expense':
        return { kind: 'company_expense', currency, centre: input.expenseCentre ?? 'general' }
      case 'opening':
        return { kind: 'company_equity', currency, account: 'opening' }
      case 'asset_purchase':
        return { kind: 'fixed_asset', currency, assetId: id('asset id', input.assetId ?? '') }
      case 'income':
        throw new RangeError('income can open a receivable, not a payable')
    }
  }

  switch (origin) {
    case 'cash':
      return { kind: 'company_cash', currency }
    case 'income':
      return { kind: 'company_income', currency, account: 'general' }
    case 'opening':
      return { kind: 'company_equity', currency, account: 'opening' }
    case 'expense':
      throw new RangeError('an expense can open a payable, not a receivable')
    case 'asset_purchase':
      throw new RangeError('an asset purchase can open a payable, not a receivable')
  }
}

/** Open one debt at its principal. Payments and write-offs are separate immutable events. */
export function companyDebtOpen(input: CompanyDebtOpenInput): Posting {
  positive('company debt principal', input.principal)
  const debtId = id('debt id', input.debtId)
  const counterpart = companyDebtCounterpart(input)
  const debt: FundRef =
    input.direction === 'payable'
      ? { kind: 'company_payable', currency: input.currency, debtId }
      : { kind: 'company_receivable', currency: input.currency, debtId }

  return assertBalanced({
    eventType: 'company_debt_open',
    occurrenceKey: occurrence(input.occurrenceKey),
    lines:
      input.direction === 'payable'
        ? [
            D(counterpart, input.principal, COMPANY_DEBT_LINE_ROLES.openCounterpart),
            C(debt, input.principal, COMPANY_DEBT_LINE_ROLES.openBalance),
          ]
        : [
            D(debt, input.principal, COMPANY_DEBT_LINE_ROLES.openBalance),
            C(counterpart, input.principal, COMPANY_DEBT_LINE_ROLES.openCounterpart),
          ],
  })
}

type DebtSettlementBase = {
  debtId: string
  currency: Currency
  amount: Minor
  /** Frozen immediately before posting while the debt is locked. */
  outstanding: Minor
  occurrenceKey: string
}

export type CompanyDebtPaymentInput = DebtSettlementBase &
  (
    | { direction: 'payable'; paidFrom: CompanyPaidFrom }
    | { direction: 'receivable'; paidFrom?: never }
  )

function assertWithinOutstanding(input: DebtSettlementBase): void {
  positive('company debt payment', input.amount)
  if (input.outstanding < ZERO) throw new RangeError(`company debt outstanding cannot be negative, got ${input.outstanding}`)
  if (input.amount > input.outstanding) {
    throw new RangeError(`company debt payment ${input.amount} exceeds outstanding ${input.outstanding}`)
  }
}

/** Pay what the company owes, or collect what is owed to it. */
export function companyDebtPayment(input: CompanyDebtPaymentInput): Posting {
  assertWithinOutstanding(input)
  const debtId = id('debt id', input.debtId)
  const debt: FundRef =
    input.direction === 'payable'
      ? { kind: 'company_payable', currency: input.currency, debtId }
      : { kind: 'company_receivable', currency: input.currency, debtId }

  return assertBalanced({
    eventType: 'company_debt_payment',
    occurrenceKey: occurrence(input.occurrenceKey),
    lines:
      input.direction === 'payable'
        ? [
            D(debt, input.amount, COMPANY_DEBT_LINE_ROLES.paymentBalance),
            C(companyExpenseSource(input.currency, input.paidFrom), input.amount, COMPANY_DEBT_LINE_ROLES.paymentSource),
          ]
        : [
            D({ kind: 'company_cash', currency: input.currency }, input.amount, COMPANY_DEBT_LINE_ROLES.collectionReceived),
            C(debt, input.amount, COMPANY_DEBT_LINE_ROLES.collectionBalance),
          ],
  })
}

export type CompanyDebtWriteoffInput = DebtSettlementBase & { direction: CompanyDebtDirection }

/** Forgive a payable as income, or recognise an uncollectable receivable as expense. */
export function companyDebtWriteoff(input: CompanyDebtWriteoffInput): Posting {
  assertWithinOutstanding(input)
  const debtId = id('debt id', input.debtId)
  const debt: FundRef =
    input.direction === 'payable'
      ? { kind: 'company_payable', currency: input.currency, debtId }
      : { kind: 'company_receivable', currency: input.currency, debtId }

  return assertBalanced({
    eventType: 'company_debt_writeoff',
    occurrenceKey: occurrence(input.occurrenceKey),
    lines:
      input.direction === 'payable'
        ? [
            D(debt, input.amount, COMPANY_DEBT_LINE_ROLES.writeoffBalance),
            C(
              { kind: 'company_income', currency: input.currency, account: 'payable_forgiven' },
              input.amount,
              COMPANY_DEBT_LINE_ROLES.writeoffCounterpart,
            ),
          ]
        : [
            D(
              { kind: 'company_expense', currency: input.currency, centre: 'receivable_writeoff' },
              input.amount,
              COMPANY_DEBT_LINE_ROLES.writeoffCounterpart,
            ),
            C(debt, input.amount, COMPANY_DEBT_LINE_ROLES.writeoffBalance),
          ],
  })
}

/**
 * Convert the signed ledger balance of the debt fund into the positive figure shown to a user.
 * Payables carry a credit (negative) balance; receivables carry a debit (positive) balance.
 */
export function companyDebtOutstanding(direction: CompanyDebtDirection, fundBalance: Minor): Minor {
  const value = direction === 'payable' ? minor(-fundBalance) : fundBalance
  if (value < ZERO) throw new RangeError(`${direction} fund has the wrong balance sign: ${fundBalance}`)
  return value
}
