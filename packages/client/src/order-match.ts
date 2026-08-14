import { type Minor, formatMinor, minor, parseMinor, sub, yalagoCut } from '@ash/domain'

/**
 * Pair scanned orders with an archival payments log for later reconciliation.
 *
 * The orders screen remains the financial source for fees. The log is evidence only: these
 * correlations describe what it appears to show but never change BR1, order totals or postings.
 *
 * What the client's real data shows, and what this encodes:
 *
 *   • every order leaves Yallago's 20% in the log at its own minute — ٤٩٥→−٩٩, ٤٠٠→−٨٠, ٢١٠→−٤٢.
 *     Finding that row is how an order is CONFIRMED against the wallet.
 *   • a positive row at the same minute is the part of the order the customer settled
 *     electronically… OR an unrelated incentive Yallago paid. The owner says it is genuinely
 *     either, so nothing here decides: it is PROPOSED, and a manager confirms.
 *   • whatever is left over — a top-up, a withdrawal, an incentive on its own minute — is retained
 *     as unexplained archival evidence for a later explicit reconciliation workflow.
 *
 * Pure and total: no I/O, no clock, and it never invents. Anything it cannot explain comes back in
 * `unexplained` as a question, which is the whole point — a guess here becomes a wrong wallet.
 */

export interface ScannedOrder {
  /** The key the driver's app generated for this row. */
  readonly orderNo: string
  /** The delivery fee, as a money decimal string. */
  readonly fee: string
  /** «HH:MM», or '' when the row's clock could not be read. */
  readonly time: string
}

export interface ScannedMovement {
  /** Signed money as a decimal string: «-80», «107.50». */
  readonly amount: string
  /** «HH:MM», or '' when the row's clock could not be read. */
  readonly time: string
}

export interface MatchedOrder {
  readonly order: ScannedOrder
  /** Yallago's 20% was found in the log at this order's minute — the order is corroborated. */
  readonly cutConfirmed: boolean
  /**
   * How much of the fee reached the wallet, as a money string. `'0'` when only the cut was found
   * (an all-cash order). Null when a positive row was found but might be an incentive instead —
   * see `needsReview`.
   */
  readonly walletAmount: string | null
  /** A positive row shared this minute, and only a human can say whether it belongs to this order. */
  readonly needsReview: boolean
}

export interface MatchResult {
  readonly orders: readonly MatchedOrder[]
  /** Log rows no order accounts for. Each is a wallet movement someone must classify. */
  readonly unexplained: readonly ScannedMovement[]
  /** Orders whose Yallago cut is nowhere in the log — the log may be scrolled short, or the fee wrong. */
  readonly ordersWithoutCut: readonly ScannedOrder[]
}

const isNegative = (amount: string): boolean => amount.trimStart().startsWith('-')
const magnitude = (amount: string): Minor => parseMinor(amount.replace('-', ''))

/**
 * Match, without deciding anything a human should decide.
 *
 * Rounding: Yallago's cut is compared with `yalagoCut`'s own floor, and a ±1 minor unit tolerance,
 * because the app rounds its display and we must not reject a real match over the last unit.
 */
export function matchOrdersToPayments(
  orders: readonly ScannedOrder[],
  movements: readonly ScannedMovement[],
): MatchResult {
  const claimed = new Set<number>()
  const matched: MatchedOrder[] = []
  const withoutCut: ScannedOrder[] = []

  for (const order of orders) {
    const fee = parseMinor(order.fee)
    const expectedCut = yalagoCut(fee)
    // Only rows at the SAME minute are candidates. An order's cut lands with it, so a wider window
    // would start pairing one order's money with another's.
    const sameMinute = movements
      .map((m, i) => ({ m, i }))
      .filter(({ m, i }) => !claimed.has(i) && m.time !== '' && order.time !== '' && m.time === order.time)

    const cutAt = sameMinute.find(
      ({ m }) => isNegative(m.amount) && absDiff(magnitude(m.amount), expectedCut) <= 1n,
    )
    if (cutAt) claimed.add(cutAt.i)
    else withoutCut.push(order)

    const credit = sameMinute.find(({ m, i }) => !isNegative(m.amount) && i !== cutAt?.i)
    if (credit) {
      // Proposed, never assumed: this is the row that is either the electronic part of THIS order
      // or an incentive that merely happened at the same minute.
      claimed.add(credit.i)
      matched.push({ order, cutConfirmed: cutAt !== undefined, walletAmount: null, needsReview: true })
    } else {
      matched.push({
        order,
        cutConfirmed: cutAt !== undefined,
        // Nothing but the cut moved, so nothing of this fee reached the wallet: all of it is cash.
        walletAmount: cutAt ? '0' : null,
        needsReview: cutAt === undefined,
      })
    }
  }

  return {
    orders: matched,
    unexplained: movements.filter((_, i) => !claimed.has(i)),
    ordersWithoutCut: withoutCut,
  }
}

const absDiff = (a: Minor, b: Minor): bigint => (a > b ? sub(a, b) : sub(b, a))

/**
 * The wallet movements that belong to no order, totalled for archival reconciliation analysis.
 *
 * Sums signed strings exactly, in minor units. Never with a float: these are amounts like
 * «107.50» and «-144.15», and the equation they feed admits no tolerance at all.
 */
export function unexplainedTotal(movements: readonly ScannedMovement[]): string {
  let total = minor(0n)
  for (const m of movements) {
    total = minor(isNegative(m.amount) ? total - magnitude(m.amount) : total + magnitude(m.amount))
  }
  return formatMinor(total)
}
