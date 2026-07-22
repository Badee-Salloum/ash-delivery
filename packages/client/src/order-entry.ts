import { type Minor, type PayMode, evaluateBr1, minor, parseMinor } from '@ash/domain'

/**
 * The driver's order-entry model — the single most-used screen in the product, and the one that
 * decides whether drivers use the software or go back to paper.
 *
 * With OCR deferred (Bundle 2), a driver types ~20 rows on a cheap Android, twice a day. This is
 * the logic behind that screen: a remembered default fee, duplicate detection as you type, and a
 * LIVE BR1 preview so the driver fixes his own mistakes before the manager ever sees them. It is
 * pure and tested here so the React component is a thin shell over proven behaviour.
 */

export interface DraftOrder {
  /** Local id; the server assigns the real one. */
  localId: string
  providerOrderNo: string
  payMode: PayMode
  /** As typed, so the field round-trips exactly what the driver sees. */
  feeText: string
}

export interface OrderEntryState {
  orders: DraftOrder[]
  /** Remembered from the last confirmed row — most orders share a fee, so this saves typing. */
  defaultFeeText: string
}

export function emptyState(defaultFeeText = ''): OrderEntryState {
  return { orders: [], defaultFeeText }
}

export type RowProblem =
  | { kind: 'empty_order_no' }
  | { kind: 'duplicate_order_no'; firstIndex: number }
  | { kind: 'bad_fee' }
  | { kind: 'negative_fee' }

/** Validate one row in the context of all rows (duplicates need the whole list). */
export function validateRow(orders: readonly DraftOrder[], index: number): RowProblem | null {
  const row = orders[index]
  if (!row) return null

  if (row.providerOrderNo.trim() === '') return { kind: 'empty_order_no' }

  // Duplicate detection as you type: Yallago's order number is unique, and a duplicate is the
  // single most common data-entry slip. Report the FIRST occurrence so the UI can point at it.
  const firstIndex = orders.findIndex(
    (o) => o.providerOrderNo.trim() !== '' && o.providerOrderNo.trim() === row.providerOrderNo.trim(),
  )
  if (firstIndex !== -1 && firstIndex < index) return { kind: 'duplicate_order_no', firstIndex }

  let fee: Minor
  try {
    fee = parseMinor(row.feeText)
  } catch {
    return { kind: 'bad_fee' }
  }
  if (fee < 0n) return { kind: 'negative_fee' }
  return null
}

export function allProblems(orders: readonly DraftOrder[]): Map<string, RowProblem> {
  const out = new Map<string, RowProblem>()
  for (let i = 0; i < orders.length; i++) {
    const problem = validateRow(orders, i)
    if (problem) out.set(orders[i]!.localId, problem)
  }
  return out
}

export const isComplete = (orders: readonly DraftOrder[]): boolean =>
  orders.length > 0 && allProblems(orders).size === 0

/** Cycle a pay mode with one tap: cash → electronic → free → cash. */
export function nextPayMode(mode: PayMode): PayMode {
  return mode === 'cash' ? 'electronic' : mode === 'electronic' ? 'free' : 'cash'
}

export interface Br1Preview {
  expectedCashText: string
  expectedWalletText: string
  expectedTotalText: string
  blockText: string
  /** Only shown once the driver has entered his declared figures. */
  differenceText: string | null
  balanced: boolean | null
}

/**
 * The live preview under the order list. Given the shift's gates and the orders so far, it shows
 * what the driver's cash and wallet SHOULD read at close — so a wrong pay mode or a missing order
 * is visible immediately, not discovered by the manager.
 */
export function previewBr1(input: {
  floatText: string
  topupText: string
  orders: readonly DraftOrder[]
  declaredCashText?: string
  declaredWalletText?: string
}): Br1Preview | null {
  let floatTotal: Minor
  let topupTotal: Minor
  try {
    floatTotal = parseMinor(input.floatText || '0')
    topupTotal = parseMinor(input.topupText || '0')
  } catch {
    return null
  }

  // Only valid rows contribute — a half-typed row must not make the preview flicker to nonsense.
  const valid = input.orders.filter((_, i) => validateRow(input.orders, i) === null)
  const orders = valid.map((o) => ({ orderNo: o.providerOrderNo, payMode: o.payMode, fee: safeFee(o.feeText) }))

  const hasDeclared = input.declaredCashText !== undefined && input.declaredWalletText !== undefined
  const declaredCash = hasDeclared ? safeFee(input.declaredCashText!) : minor(0n)
  const declaredWallet = hasDeclared ? safeFee(input.declaredWalletText!) : minor(0n)

  const r = evaluateBr1({
    floatTotal,
    topupTotal,
    endCashDeclared: declaredCash,
    endWalletDeclared: declaredWallet,
    orders,
  })

  return {
    expectedCashText: format(r.expectedCash),
    expectedWalletText: format(r.expectedWallet),
    expectedTotalText: format(r.expectedTotal),
    blockText: format(r.totals.blockTotal),
    differenceText: hasDeclared ? format(r.scalarDiff) : null,
    balanced: hasDeclared ? r.balanced : null,
  }
}

function safeFee(text: string): Minor {
  try {
    const v = parseMinor(text || '0')
    return v < 0n ? minor(0n) : v
  } catch {
    return minor(0n)
  }
}

function format(m: Minor): string {
  const neg = m < 0n
  const digits = (neg ? -m : m).toString().padStart(3, '0')
  const cut = digits.length - 2
  return `${neg ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`
}

/** Payloads ready for POST /shifts/:id/orders, in list order. */
export function toApiPayloads(orders: readonly DraftOrder[]): Array<{ providerOrderNo: string; payMode: PayMode; fee: string; zone: null }> {
  return orders.map((o) => ({ providerOrderNo: o.providerOrderNo.trim(), payMode: o.payMode, fee: o.feeText, zone: null }))
}
