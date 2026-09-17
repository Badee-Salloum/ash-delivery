import { type Currency } from '../money/currency.ts'
import { type Minor, ZERO, minor } from '../money/minor.ts'
import { companyExpenseSource, type CompanyPaidFrom } from './company.ts'
import { assertBalanced, type FundRef, type Posting, type PostingLine } from './recipes.ts'

export type AssetPaidFrom = CompanyPaidFrom | 'opening'

export const ASSET_LINE_ROLES = {
  acquired: 'asset_acquired',
  paid: 'asset_paid',
  financed: 'asset_financed',
  depreciationReserved: 'depreciation_reserved',
  depreciationFunded: 'depreciation_funded',
  depreciationReleased: 'depreciation_released',
  depreciationReturned: 'depreciation_returned',
} as const

const D = (fund: FundRef, amount: Minor, role: string): PostingLine => ({ fund, side: 'D', amount, role })
const C = (fund: FundRef, amount: Minor, role: string): PostingLine => ({ fund, side: 'C', amount, role })

function segment(label: string, value: string): string {
  const clean = value.trim()
  if (clean === '' || clean.includes(':')) throw new RangeError(`${label} must be a non-empty fund-code segment`)
  return clean
}

function positive(label: string, amount: Minor): void {
  if (amount <= ZERO) throw new RangeError(`${label} must be positive, got ${amount}`)
}

function occurrence(value: string): string {
  if (value.trim() === '') throw new RangeError('an asset command needs its occurrence key')
  return value
}

function assetSource(currency: Currency, source: AssetPaidFrom): FundRef {
  return source === 'opening'
    ? { kind: 'company_equity', currency, account: 'opening' }
    : companyExpenseSource(currency, source)
}

/** Purchase an asset, optionally splitting its price between money paid now and one linked payable. */
export function assetPurchase(input: {
  assetId: string
  currency: Currency
  price: Minor
  paidNow: Minor
  paidFrom: AssetPaidFrom
  /** Required exactly when `paidNow < price`. */
  debtId?: string
  occurrenceKey: string
}): { posting: Posting; financed: Minor } {
  positive('asset price', input.price)
  if (input.paidNow < ZERO) throw new RangeError(`asset paid-now amount cannot be negative, got ${input.paidNow}`)
  if (input.paidNow > input.price) {
    throw new RangeError(`asset paid-now amount ${input.paidNow} exceeds price ${input.price}`)
  }
  const assetId = segment('asset id', input.assetId)
  const financed = minor(input.price - input.paidNow)
  if (financed > ZERO && input.debtId === undefined) throw new RangeError('a financed asset purchase needs its debt id')
  if (financed === ZERO && input.debtId !== undefined) throw new RangeError('a fully paid asset purchase cannot name a debt')

  const lines: PostingLine[] = [
    D({ kind: 'fixed_asset', currency: input.currency, assetId }, input.price, ASSET_LINE_ROLES.acquired),
  ]
  if (input.paidNow > ZERO) {
    lines.push(C(assetSource(input.currency, input.paidFrom), input.paidNow, ASSET_LINE_ROLES.paid))
  }
  if (financed > ZERO) {
    lines.push(
      C(
        { kind: 'company_payable', currency: input.currency, debtId: segment('debt id', input.debtId!) },
        financed,
        ASSET_LINE_ROLES.financed,
      ),
    )
  }

  return {
    financed,
    posting: assertBalanced({
      eventType: 'asset_purchase',
      occurrenceKey: occurrence(input.occurrenceKey),
      lines,
    }),
  }
}

/** Move cash into the depreciation reserve. Profit is deliberately untouched. */
export function depreciationTransfer(currency: Currency, amount: Minor, occurrenceKey: string): Posting {
  positive('depreciation transfer', amount)
  return assertBalanced({
    eventType: 'depreciation_transfer',
    occurrenceKey: occurrence(occurrenceKey),
    lines: [
      D({ kind: 'depreciation_reserve', currency }, amount, ASSET_LINE_ROLES.depreciationReserved),
      C({ kind: 'company_cash', currency }, amount, ASSET_LINE_ROLES.depreciationFunded),
    ],
  })
}

/** Release reserve cash back to the company pocket; the command row carries the required reason. */
export function depreciationRelease(currency: Currency, amount: Minor, occurrenceKey: string): Posting {
  positive('depreciation release', amount)
  return assertBalanced({
    eventType: 'depreciation_release',
    occurrenceKey: occurrence(occurrenceKey),
    lines: [
      D({ kind: 'company_cash', currency }, amount, ASSET_LINE_ROLES.depreciationReturned),
      C({ kind: 'depreciation_reserve', currency }, amount, ASSET_LINE_ROLES.depreciationReleased),
    ],
  })
}
