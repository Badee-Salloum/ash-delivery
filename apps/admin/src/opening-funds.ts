import {
  type ApproveOpenShiftBody,
  type ShiftFundingPreviewView,
  normalizeDecimalDigits,
} from '@ash/client'
import { parseMinor } from '@ash/domain'

function normalizedOpeningFund(raw: string): string {
  // A manager using an Arabic/Persian numeric keyboard can enter ٠/۰ even though money on the
  // wire is deliberately ASCII. Normalize before both validation and payload construction so those
  // two paths cannot disagree.
  return normalizeDecimalDigits(raw).trim()
}

/**
 * Convert the two optional opening-fund inputs into the tranche wire shape.
 *
 * An empty or explicitly zero field means the office handed over no tranche, so it must be an
 * empty array. Keeping a zero placeholder creates a fake disbursement and is rejected by the API.
 * Invalid and negative text is deliberately left present: the request boundary can then reject it
 * instead of silently turning an operator's bad value into "no money".
 */
function oneOpeningTranche(raw: string): string[] {
  const value = normalizedOpeningFund(raw)
  if (value === '') return []
  try {
    return parseMinor(value) === 0n ? [] : [value]
  } catch {
    return [value]
  }
}

/** Blank and zero mean no handover; every entered tranche must otherwise be valid and positive. */
export function isValidOpeningFundInput(raw: string): boolean {
  const value = normalizedOpeningFund(raw)
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

/**
 * Build the whole approval command from the amounts visible in this review. Both funding keys are
 * always present: an empty array is an explicit reviewed zero, not permission to consume whatever
 * happens to be live when the click reaches the server.
 */
export function openingApprovalRequest(
  floatText: string,
  topupText: string,
  shiftFunding: ShiftFundingPreviewView,
): ApproveOpenShiftBody {
  return {
    ...openingFundTranches(floatText, topupText),
    carriedTranches: oneOpeningTranche(shiftFunding.cash),
    carriedWalletTranches: oneOpeningTranche(shiftFunding.wallet),
  }
}
