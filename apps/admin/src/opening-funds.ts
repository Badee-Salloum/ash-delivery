import { parseMinor } from '@ash/domain'

/**
 * Convert the two optional opening-fund inputs into the tranche wire shape.
 *
 * An empty or explicitly zero field means the office handed over no tranche, so it must be an
 * empty array. Keeping a zero placeholder creates a fake disbursement and is rejected by the API.
 * Invalid and negative text is deliberately left present: the request boundary can then reject it
 * instead of silently turning an operator's bad value into "no money".
 */
function oneOpeningTranche(raw: string): string[] {
  const value = raw.trim()
  if (value === '') return []
  try {
    return parseMinor(value) === 0n ? [] : [value]
  } catch {
    return [value]
  }
}

/** Blank and zero mean no handover; every entered tranche must otherwise be valid and positive. */
export function isValidOpeningFundInput(raw: string): boolean {
  const value = raw.trim()
  if (value === '') return true
  try {
    return parseMinor(value) >= 0n
  } catch {
    return false
  }
}

export function openingFundTranches(
  floatText: string,
  topupText: string,
): { floatTranches: string[]; topupTranches: string[] } {
  return {
    floatTranches: oneOpeningTranche(floatText),
    topupTranches: oneOpeningTranche(topupText),
  }
}
