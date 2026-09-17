import { FxError, toUsdMinor } from '../fx/rate.ts'
import { type Minor, minor } from './minor.ts'

/**
 * Currencies — «صندوق الشركة» holds dollars as well as lira (finance redesign C1).
 *
 * The branch ledger is, and stays, new Syrian lira end to end. The company ledger holds USD too,
 * and the rule that keeps the two honest is that a currency lives on the FUND: a journal line never
 * names its own currency, it inherits its fund's. `Money<C>` is how the rest of the code carries an
 * amount together with that currency, so that adding dollars to lira is a type error rather than a
 * figure that merely looks plausible.
 *
 * `SYP_NEW` and `USD` are the literal strings stored in `funds.currency` (migration 0066) and used
 * as the `<CUR>` segment of every company fund code — one spelling everywhere.
 *
 * Minor units: 1 SYP_NEW minor = 1/100 new lira (see `minor.ts`); 1 USD minor = 1 cent.
 */
export type Currency = 'SYP_NEW' | 'USD'

export const CURRENCIES = ['SYP_NEW', 'USD'] as const satisfies readonly Currency[]

export const isCurrency = (value: unknown): value is Currency => value === 'SYP_NEW' || value === 'USD'

/** An amount that knows which currency it is in. Construct with {@link money}. */
export interface Money<C extends Currency = Currency> {
  readonly currency: C
  readonly amount: Minor
}

export class CurrencyMismatchError extends Error {
  readonly left: Currency
  readonly right: Currency
  constructor(left: Currency, right: Currency) {
    super(`cannot combine ${left} with ${right}: convert explicitly at a frozen rate first`)
    this.name = 'CurrencyMismatchError'
    this.left = left
    this.right = right
  }
}

export function money<C extends Currency>(currency: C, amount: Minor): Money<C> {
  if (!isCurrency(currency)) throw new RangeError(`unknown currency ${JSON.stringify(currency)}`)
  return { currency, amount }
}

/**
 * The runtime half of the type rule. `NoInfer` makes the SECOND argument's currency follow the
 * first rather than widen the type parameter to a union — so `addMoney(usd, syp)` does not compile —
 * while a `Money<Currency>` read from the wire still type-checks and is refused here instead.
 */
function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency)
}

export function addMoney<C extends Currency>(a: Money<C>, b: Money<NoInfer<C>>): Money<C> {
  sameCurrency(a, b)
  return { currency: a.currency, amount: minor(a.amount + b.amount) }
}

export function subMoney<C extends Currency>(a: Money<C>, b: Money<NoInfer<C>>): Money<C> {
  sameCurrency(a, b)
  return { currency: a.currency, amount: minor(a.amount - b.amount) }
}

/** Σ of same-currency amounts. The currency is named up front so an empty list still has one. */
export function sumMoney<C extends Currency>(currency: C, values: readonly Money<NoInfer<C>>[]): Money<C> {
  let total = 0n
  for (const value of values) {
    if (value.currency !== currency) throw new CurrencyMismatchError(currency, value.currency)
    total += value.amount
  }
  return money(currency, minor(total))
}

export const isZeroMoney = (value: Money): boolean => value.amount === 0n

/**
 * USD cents → SYP_NEW minor units at a frozen rate (`syp_minor_per_usd`, as `fx_days` and
 * `journal_entries` store it: SYP minor units per ONE dollar).
 *
 *   sypMinor = usdCents × rate / 100
 *
 * Rounded half-up on the MAGNITUDE, so the conversion is sign-symmetric: −x converts to exactly the
 * negation of x. A floor would make a reversal of a converted amount differ from the original by a
 * minor unit, which is precisely the kind of drift a reversal exists to rule out.
 */
export function usdToSypMinor(usdCents: Minor, sypMinorPerUsd: bigint): Minor {
  if (sypMinorPerUsd <= 0n) throw new FxError(`invalid rate ${sypMinorPerUsd}`)
  const negative = usdCents < 0n
  const magnitude = negative ? -usdCents : usdCents
  const converted = (magnitude * sypMinorPerUsd + 50n) / 100n
  return minor(negative ? -converted : converted)
}

/**
 * SYP_NEW minor units → USD cents, half-up and sign-symmetric. The existing BR6 display conversion
 * under the name that says which way it goes; there is exactly one implementation.
 */
export const sypToUsdMinor = toUsdMinor
