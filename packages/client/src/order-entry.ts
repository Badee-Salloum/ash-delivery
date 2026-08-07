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
  /** SRS D-1/D-3: the OCR-read fee, set only on rows scanned off «Recent orders» — the baseline. */
  feeOcrText?: string
  /**
   * Already posted to the server.
   *
   * There is no way for a driver to take an order back: `provider_order_no` is globally unique and
   * no delete endpoint exists — by design, since an order is money. So a recorded row is shown but
   * not editable, and a mistake in one is a manager's to correct at the review. Editing it locally
   * changed nothing on the server and quietly desynchronised the BR1 preview from the figure the
   * server would compute.
   */
  recorded?: boolean
  /**
   * Checked. The screenshots overlap and scroll back into previous days, so a read list always
   * contains rows that are not this shift's — unchecking one keeps it with the shift and out of the
   * money. Absent means checked: every row typed by hand is one the driver is asserting.
   */
  included?: boolean
  /** How much of the fee reached the wallet, as typed/measured. '' = unmeasured, the mode decides. */
  walletAmountText?: string
  /** «HH:MM» off the dashboard — what a payments-log row is paired to. */
  timeText?: string
}

/** A «سجل المدفوعات» row as the driver's list holds it, before the server gives it an identity. */
export interface DraftMovement {
  localId: string
  /** SIGNED money as typed: «-99», «107.50». Negative left the wallet. */
  amountText: string
  timeText: string
  included?: boolean
  /** Which order it answers to, by number, when the matcher paired them. */
  providerOrderNo?: string | null
  role?: 'yalago_cut' | 'order_credit' | 'unmatched'
  ambiguous?: boolean
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

/**
 * What a submit should actually SEND: the rows not already on the server.
 *
 * The driver can leave the closing package and come back to this list to add a delivery he forgot,
 * so «تم» runs a second time over a list whose earlier rows are already posted. `provider_order_no`
 * is globally unique, so re-sending one is a 409 — and a 409 here reads to the driver as "my orders
 * failed", on a list where nothing is wrong and nothing he can do will clear it.
 *
 * Two signals, deliberately: the `recorded` flag, and the order numbers already known. The flag
 * alone would miss the window where the resumed rows have loaded into the list but not yet been
 * marked, and that window ends in exactly the 409 above.
 */
export function unsentOrders(orders: readonly DraftOrder[], alreadySent: readonly DraftOrder[] = []): DraftOrder[] {
  const sent = new Set(alreadySent.map((o) => o.providerOrderNo.trim()))
  return orders.filter((o) => o.recorded !== true && !sent.has(o.providerOrderNo.trim()))
}

// ── Folding a screenshot into the list ──────────────────────────────────────────────────────

/** One row as the orders reader produced it. */
export interface ScannedOrderRow {
  dateIso: string | null
  time: string
  fee: string
}

/** One row as the payments-log reader produced it. `amount` is signed. */
export interface ScannedMovementRow {
  amount: string
  time: string
}

/**
 * A globally-unique, editable order key from the order's day and time.
 *
 * The dashboard screen carries no order id, so one has to be made. Day+time is unique in practice
 * and readable by a human comparing it against the screenshot, which a random id would not be.
 */
export const orderKeyFor = (s: ScannedOrderRow, ordinal = 1): string => {
  const day = (s.dateIso ?? '').replace(/-/g, '')
  const time = s.time.replace(':', '')
  // Two deliveries genuinely can land in the same minute, and without the ordinal the second one
  // silently takes the first one's key — one of the two orders then vanishes from the day.
  return ordinal <= 1 ? `YAL-${day}-${time}` : `YAL-${day}-${time}-${ordinal}`
}

/**
 * Append what a dashboard screenshot read, skipping what the list already holds.
 *
 * The screen scrolls, so it is photographed in several OVERLAPPING images: page two re-shows the
 * bottom of page one. Appending blindly would double every order in the overlap, and the driver
 * would have to spot and uncheck each duplicate himself.
 */
export function mergeScannedOrders(
  existing: readonly DraftOrder[],
  scanned: readonly ScannedOrderRow[],
  newId: () => string,
): DraftOrder[] {
  const taken = new Set(existing.map((o) => o.providerOrderNo))
  const added: DraftOrder[] = []
  for (const row of scanned) {
    // Walk the ordinal up until the key is free — that both de-duplicates the overlap and gives a
    // genuine second order in the same minute a key of its own.
    let ordinal = 1
    let key = orderKeyFor(row, ordinal)
    let duplicate = false
    while (taken.has(key)) {
      // Same minute AND same fee as one already held: this is the overlap, not a new delivery.
      const twin = [...existing, ...added].find((o) => o.providerOrderNo === key)
      if (twin && twin.feeText === row.fee) {
        duplicate = true
        break
      }
      ordinal += 1
      key = orderKeyFor(row, ordinal)
    }
    if (duplicate) continue
    taken.add(key)
    added.push({
      localId: newId(),
      providerOrderNo: key,
      // The screen carries no pay mode; cash is the safe default because it is the mode that
      // expects the driver to be HOLDING the money, which is the claim easiest to check.
      payMode: 'cash',
      feeText: row.fee,
      feeOcrText: row.fee,
      timeText: row.time,
      included: true,
    })
  }
  return added
}

/**
 * Append what a payments-log screenshot read, skipping what the list already holds.
 *
 * A MULTISET merge, mirroring the server's: a minute genuinely can hold two identical amounts, so
 * only the surplus of each (minute, amount) is new. Matching by value alone would silently discard
 * the second of two real 24-lira cuts.
 */
export function mergeScannedMovements(
  existing: readonly DraftMovement[],
  scanned: readonly ScannedMovementRow[],
  newId: () => string,
): DraftMovement[] {
  const tally = new Map<string, number>()
  for (const m of existing) {
    const key = `${m.timeText}|${m.amountText}`
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  const added: DraftMovement[] = []
  for (const row of scanned) {
    const key = `${row.time}|${row.amount}`
    const already = tally.get(key) ?? 0
    if (already > 0) {
      tally.set(key, already - 1)
      continue
    }
    added.push({ localId: newId(), amountText: row.amount, timeText: row.time, included: true })
  }
  return added
}

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
  /** The wallet's own rows. Only the ones no order explains reach the equation — see `movementsTerm`. */
  movements?: readonly DraftMovement[]
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

  // Only valid rows contribute — a half-typed row must not make the preview flicker to nonsense —
  // and only CHECKED ones, mirroring `includedOrders` on the server so the driver's own preview and
  // the figure the manager will see are the same arithmetic.
  const valid = input.orders.filter((o, i) => o.included !== false && validateRow(input.orders, i) === null)
  const orders = valid.map((o) => ({
    orderNo: o.providerOrderNo,
    payMode: o.payMode,
    fee: safeFee(o.feeText),
    ...(o.walletAmountText ? { walletAmount: safeFee(o.walletAmountText) } : {}),
  }))
  // The same three-way rule the server uses: a logged Yallago cut is corroboration and an order's
  // credit is already inside its `walletAmount`, so only the unexplained rows are a term here.
  const walletAdjustments = (input.movements ?? [])
    .filter((m) => m.included !== false && (m.role ?? 'unmatched') === 'unmatched')
    .map((m) => safeSigned(m.amountText))

  const hasDeclared = input.declaredCashText !== undefined && input.declaredWalletText !== undefined
  const declaredCash = hasDeclared ? safeFee(input.declaredCashText!) : minor(0n)
  const declaredWallet = hasDeclared ? safeFee(input.declaredWalletText!) : minor(0n)

  const r = evaluateBr1({
    floatTotal,
    topupTotal,
    endCashDeclared: declaredCash,
    endWalletDeclared: declaredWallet,
    orders,
    walletAdjustments,
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

/**
 * A movement's amount, SIGN AND ALL.
 *
 * `safeFee` floors at zero because a fee cannot be negative. A movement can: money leaves the
 * wallet as often as it arrives, and clamping a withdrawal to zero would quietly drop it out of
 * the preview and make the driver's screen disagree with the server by exactly its value.
 */
function safeSigned(text: string): Minor {
  const trimmed = (text || '0').trim()
  const negative = trimmed.startsWith('-') || trimmed.startsWith('−')
  const magnitude = safeFee(trimmed.replace(/^[-−+]/, ''))
  return negative ? minor(-magnitude) : magnitude
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
