import { formatMinor, minor, parseMinor } from '@ash/domain'

export type DifferenceDirection = 'increase' | 'shortage' | 'none'

export interface DifferenceView {
  direction: DifferenceDirection
  /** Signed value, retained for accounting comparisons. */
  signed: string
  /** Absolute value, used beside a direction word so the UI never says "shortage -50". */
  amount: string
}

export interface CountLineDraft {
  fundCode: string
  counted: string
  computed: string
  variance: string
  resolution: string | null
}

export interface RestorationLegLike {
  fundCode: string
  position: string
  capitalTarget: string
  delta: string
  direction: 'to_company' | 'from_company' | null
  amount: string
}

/** Turn a signed wire-money value into an explicit direction plus an unsigned amount. */
export function differenceView(value: string): DifferenceView {
  const signed = parseMinor(value)
  const direction: DifferenceDirection = signed > minor(0n) ? 'increase' : signed < minor(0n) ? 'shortage' : 'none'
  const absolute = signed < minor(0n) ? -signed : signed
  return { direction, signed: formatMinor(signed), amount: formatMinor(minor(absolute)) }
}

/** Live count difference: counted minus the balance frozen by the system. Invalid drafts stay unset. */
export function countDifference(counted: string, computed: string): DifferenceView | null {
  if (counted.trim() === '') return null
  try {
    return differenceView(formatMinor(minor(parseMinor(counted) - parseMinor(computed))))
  } catch {
    return null
  }
}

/** Restore the exact values and audited reasons from a count that was already sealed. */
export function restoreCountDraft(lines: readonly CountLineDraft[]): {
  counted: Record<string, string>
  resolutions: Record<string, string>
} {
  const counted: Record<string, string> = {}
  const resolutions: Record<string, string> = {}
  for (const line of lines) {
    counted[line.fundCode] = line.counted
    resolutions[line.fundCode] = line.resolution ?? ''
  }
  return { counted, resolutions }
}

/** A count can be submitted only when every box has a valid value and every difference has a reason. */
export function countDraftReady(
  funds: readonly { fundCode: string; computed: string }[],
  counted: Readonly<Record<string, string>>,
  resolutions: Readonly<Record<string, string>>,
): boolean {
  return funds.every((fund) => {
    const variance = countDifference(counted[fund.fundCode] ?? '', fund.computed)
    if (!variance) return false
    return variance.direction === 'none' || (resolutions[fund.fundCode]?.trim().length ?? 0) > 0
  })
}

export function buildCountLines(
  funds: readonly { fundCode: string; computed: string }[],
  counted: Readonly<Record<string, string>>,
  resolutions: Readonly<Record<string, string>>,
): Array<{ fundCode: string; counted: string; resolution: string | null }> {
  return funds.map((fund) => {
    const variance = countDifference(counted[fund.fundCode] ?? '', fund.computed)
    return {
      fundCode: fund.fundCode,
      counted: counted[fund.fundCode] ?? '',
      resolution: variance?.direction === 'none' ? null : (resolutions[fund.fundCode]?.trim() ?? null),
    }
  })
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
