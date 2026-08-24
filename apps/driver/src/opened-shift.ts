/** Funding and identity returned when a start-package submission or approval poll finds `open`. */
export interface OpenedShiftFunds {
  shiftId: string
  floatText: string
  topupText: string
  businessDate: string
  odoStart: number | null
}

export interface OpenedShiftState {
  id: string
  floatText: string
  topupText: string
  businessDate: string
  /** The opening odometer is restored independently; preserve it when a poll completes. */
  odoStart: number | null
}

/**
 * Enter the running phase with a complete shift identity.
 *
 * Automatic approval can happen on the first start-package response, before the ordinary waiting
 * path has created local shift state. Building it here prevents an `orders` phase with `shift=null`.
 */
export function openedShiftState(
  current: Pick<OpenedShiftState, 'odoStart'> | null,
  funds: OpenedShiftFunds,
): OpenedShiftState {
  return {
    id: funds.shiftId,
    floatText: funds.floatText,
    topupText: funds.topupText,
    businessDate: funds.businessDate,
    odoStart: funds.odoStart ?? current?.odoStart ?? null,
  }
}
