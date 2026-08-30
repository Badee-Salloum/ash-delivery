import { formatMinor, minor, parseMinor } from '@ash/domain'

export type DifferenceDirection = 'increase' | 'shortage' | 'none'

export interface DifferenceView {
  direction: DifferenceDirection
  /** Signed value, retained for accounting comparisons. */
  signed: string
  /** Absolute value, used beside a direction word so the UI never says "shortage -50". */
  amount: string
}

export interface RestorationLegLike {
  fundCode: string
  officeBalance: string
  receivables: string
  position: string
  capitalTarget: string
  delta: string
  direction: 'to_company' | 'from_company' | null
  amount: string
}

export interface ReceivableDriverLike {
  cash: string
  wallet: string
}

/** Per-driver total, using minor-unit integer math so large balances never pass through Number. */
export function receivableDriverTotal(driver: ReceivableDriverLike): string {
  return formatMinor(minor(parseMinor(driver.cash) + parseMinor(driver.wallet)))
}

/** Turn a signed wire-money value into an explicit direction plus an unsigned amount. */
export function differenceView(value: string): DifferenceView {
  const signed = parseMinor(value)
  const direction: DifferenceDirection = signed > minor(0n) ? 'increase' : signed < minor(0n) ? 'shortage' : 'none'
  const absolute = signed < minor(0n) ? -signed : signed
  return { direction, signed: formatMinor(signed), amount: formatMinor(minor(absolute)) }
}

/** Aggregate the two restoration legs without hiding opposing cash and wallet movements. */
export function summarizeRestoration(legs: readonly RestorationLegLike[]): {
  position: string
  target: string
  delta: DifferenceView
} {
  let position = 0n
  let target = 0n
  for (const leg of legs) {
    position += parseMinor(leg.position)
    target += parseMinor(leg.capitalTarget)
  }
  return {
    position: formatMinor(minor(position)),
    target: formatMinor(minor(target)),
    delta: differenceView(formatMinor(minor(position - target))),
  }
}
