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
   * Scanned, but the reader REFUSED its fee — so `feeText` starts empty and there is no OCR
   * baseline. Distinct from a hand-added row: this one's clock and route came off a screenshot.
   *
   * It exists for de-duplication. Once the driver types the fee, the row looks exactly like a
   * successfully-read one, and re-scanning the overlapping page would otherwise add a second copy.
   */
  feeRefused?: boolean
  /**
   * A «تم إلغاؤه» card carved off the screenshot. Arrives unchecked and priceless.
   *
   * Kept rather than dropped because a cancelled delivery is not always a free one — the driver may
   * still have been paid something — so he can check it and type what he got. Left unchecked it
   * never reaches the wire.
   */
  cancelled?: boolean
  /**
   * The screen showed COORDINATES for the dropoff instead of a place — the customer dropped a pin.
   *
   * Kept as a flag rather than as text because the coordinates are Arabic-Indic digits Tesseract
   * cannot read; printing what it returns would be printing debris. The UI says «موقع على الخريطة»,
   * which is what the screen actually means.
   */
  pointBIsPin?: boolean
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
  /**
   * «YYYY-MM-DD» from the screen's own day header, when one could be read.
   *
   * NOT the shift's day. «الطلبات الحديثة» scrolls back through previous days, so a list read at
   * close routinely holds yesterday's orders — and until this was shown, the only thing standing
   * between them and the shift's money was the driver noticing.
   */
  dateText?: string
  /** Where it went: «A» the pickup, «B» the dropoff, as the screen wrote them. */
  pointA?: string | null
  pointB?: string | null
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
  | { kind: 'empty_fee' }

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

  // A row the driver is NOT claiming needs no price. That is what carries an unchecked cancelled
  // card, and an unchecked refused row he decided was not this shift's: both leave the list without
  // ever being priced, and `submittableOrders` keeps them off the wire entirely.
  if (row.included === false) return null

  // Refused by the reader and not yet typed. This is the whole point of showing refused rows: an
  // empty fee the driver is claiming must stop the close, exactly as a wrong one would — otherwise
  // a surfaced row is no better than the silently-dropped row it replaced.
  if (row.feeText.trim() === '') return { kind: 'empty_fee' }

  let fee: Minor
  try {
    fee = parseMinor(row.feeText)
  } catch {
    return { kind: 'bad_fee' }
  }
  if (fee < 0n) return { kind: 'negative_fee' }
  return null
}

/**
 * The rows that may go to the server.
 *
 * Two kinds never do, and both are new: a card the driver left unchecked with no price at all —
 * a cancelled order, or a refused row he judged was not this shift's. `moneySchema` rejects an
 * empty fee, so sending one would 400 the WHOLE request and lose every good row with it. They stay
 * in the list, visible, and the screenshot remains the evidence they existed.
 *
 * An unchecked row WITH a fee still travels, exactly as before: `included: false` is a statement
 * about which shift's money it is, and the manager sees it at the review.
 */
export function submittableOrders(orders: readonly DraftOrder[]): DraftOrder[] {
  return orders.filter((o) => !(o.included === false && o.feeText.trim() === ''))
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
  /**
   * Null when the reader REFUSED this row's fee.
   *
   * The row still arrives, because the screenshot proves the delivery happened even when it cannot
   * price it. It becomes a card with an empty «الأجرة» for the driver to type — which is strictly
   * better than the delivery vanishing, which is what used to happen.
   */
  fee: string | null
  pointA?: string | null
  pointB?: string | null
  /** The dropoff was a dropped PIN, not a place name — its coordinates are not readable text. */
  pointBIsPin?: boolean
  /** A “تم إلغاؤه” card: no fee on screen, and normally no money either. */
  cancelled?: boolean
}

/** One row as the payments-log reader produced it. `amount` is signed. */
export interface ScannedMovementRow {
  amount: string
  time: string
}

/**
 * The order's identity ON THE WIRE. Opaque, and unique for all time.
 *
 * `shift_orders.provider_order_no` is UNIQUE across the whole table — not per shift, not per driver,
 * not per day. So any key derived from what the screen SHOWS is a collision waiting to happen: two
 * bikes delivering in the same minute both produce «YAL-20260804-1806», and the second 120-lira fee
 * ever scanned without a clock produces the same «YAL-F120» as the first one, on another day, for
 * another driver. The loser is a 409 nobody can see, nobody can clear, and nobody caused. At ten
 * bikes that is a weekly event; at a hundred it is constant.
 *
 * So the key comes from the ROW's own id, which is a UUID. Nothing reads it and nothing types it:
 * an order is known by its value, its route and its clock — which is what the screen has.
 */
export const newOrderKey = (localId: string): string => `YAL-${localId}`

/**
 * Append what a dashboard screenshot read, skipping what the list already holds.
 *
 * The screen scrolls, so it is photographed in several OVERLAPPING images: page two re-shows the
 * bottom of page one. Appending blindly would double every order in the overlap, and the driver
 * would have to spot and uncheck each duplicate himself.
 *
 * A MULTISET merge on the minute and the fee — what the screen actually shows — exactly as the
 * payments log is merged. Only the SURPLUS of each (minute, fee) is new, because two deliveries
 * genuinely can share both: matching on distinct values would silently drop the second one, and
 * that is a delivery the driver was paid for and the system never counted.
 */
export function mergeScannedOrders(
  existing: readonly DraftOrder[],
  scanned: readonly ScannedOrderRow[],
  newId: () => string,
): DraftOrder[] {
  // The DAY is part of the key. Without it a 120-lira delivery at 13:10 yesterday and another at
  // 13:10 today are one row, and scanning the second page silently swallows one of them.
  //
  // The fee in the key is the fee as SCANNED, never as edited. A row is identified by what the
  // screen said, and the driver correcting a misread «١٦» to «١٦٥» does not make it a different
  // delivery — keying on `feeText` meant re-scanning the overlap after any correction added a
  // duplicate. A REFUSED row therefore keys on an empty fee and keeps doing so after it is typed
  // into, which is what lets it survive a rescan.
  const keyOf = (o: DraftOrder): string => {
    const fee = o.cancelled === true ? '' : o.feeRefused === true ? '' : (o.feeOcrText ?? o.feeText)
    const head = o.cancelled === true ? 'C' : ''
    return `${head}|${o.dateText ?? ''}|${o.timeText ?? ''}|${fee}|${cardKey(o.pointA, o.pointB, o.cancelled === true)}`
  }
  const tally = new Map<string, number>()
  for (const o of existing) {
    const key = keyOf(o)
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  const added: DraftOrder[] = []
  for (const row of scanned) {
    const cancelled = row.cancelled === true
    // A cancelled card has no clock and no fee — its route is the only identity it has.
    const key = `${cancelled ? 'C' : ''}|${row.dateIso ?? ''}|${cancelled ? '' : row.time}|${row.fee ?? ''}|${cardKey(row.pointA, row.pointB, cancelled)}`
    const already = tally.get(key) ?? 0
    // Counted against what was ALREADY HELD, never against rows added by this same scan. One page
    // is one set of observations: if it lists «١٢٠» twice then two deliveries cost 120.
    if (already > 0) {
      tally.set(key, already - 1)
      continue
    }
    const localId = newId()
    added.push({
      localId,
      providerOrderNo: newOrderKey(localId),
      // The screen carries no pay mode; cash is the safe default because it is the mode that
      // expects the driver to be HOLDING the money, which is the claim easiest to check.
      payMode: 'cash',
      feeText: row.fee ?? '',
      // `feeOcrText` is the OCR BASELINE the manager's review compares against. A refused row has
      // no baseline — the reader read nothing — so the key is OMITTED rather than set to ''. That
      // is also what makes the row submit as `source: 'manual'`, which is the truth about it.
      ...(row.fee !== null ? { feeOcrText: row.fee } : { feeRefused: true }),
      ...(cancelled ? { cancelled: true } : {}),
      timeText: row.time,
      dateText: row.dateIso ?? '',
      // A cancelled card arrives UNCHECKED: it is normally not money. The driver checks it only if
      // he was in fact paid for it, and then types what he got.
      included: !cancelled,
      pointA: row.pointA ?? null,
      pointB: row.pointB ?? null,
      ...(row.pointBIsPin === true ? { pointBIsPin: true } : {}),
    })
  }
  return added
}

/**
 * The route, reduced to something stable enough to identify a card that has no clock and no fee.
 *
 * Only cancelled cards need it: every other row is identified by its minute and its value. Two
 * genuinely different cancelled orders to the same pair of addresses collapse into one, which is
 * the safe direction — a cancelled order is not money, and the alternative (a fresh copy on every
 * rescan of an overlapping page) is a list the driver has to clean by hand.
 */
const cardKey = (a: string | null | undefined, b: string | null | undefined, cancelled: boolean): string =>
  cancelled ? `${(a ?? '').slice(0, 24)}→${(b ?? '').slice(0, 24)}` : ''

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
  /**
   * THE DIFFERENCE, EXPRESSED AS A DELIVERY FEE — the equation used as a check on the READER.
   *
   * Every other stage of reading a screenshot is a guess with nobody to contradict it: is this
   * pixel ink, where does one digit end, which digit is it. The money is the one thing that
   * answers back. Of a delivery's fee the driver keeps 80% between his cash and his wallet, so
   * whatever the shift is short or over by is 80% of a fee that is wrong or missing — and dividing
   * back out names the amount to look for.
   *
   * A fare misread as «1105» instead of «235» would have shown up here as 870 before any manager
   * approved it. That is worth more than any amount of tuning the classifier, because it does not
   * depend on the classifier being right.
   *
   * Null until the driver has entered his cash and wallet, and when the shift balances.
   */
  feeGapText: string | null
  /**
   * The rows worth checking first: the ones a MACHINE read rather than a person typed.
   *
   * A hand-typed fee has a driver's memory behind it; an OCR-read fee has only a classifier's
   * opinion. When the equation disagrees, those are the numbers to doubt.
   */
  suspectLocalIds: readonly string[]
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

  // The shortfall, turned back into the fee that would explain it. The driver keeps 80% of a fee,
  // so a gap of 696 is a fee of 870 — either one read wrongly or one order never scanned at all.
  // Integer arithmetic throughout: × 100 ÷ 80, never a float, because this is money.
  const gap = r.scalarDiff < 0n ? -r.scalarDiff : r.scalarDiff
  const unbalanced = hasDeclared && !r.balanced && gap > 0n
  const suspects = unbalanced ? valid.filter((o) => o.feeOcrText != null).map((o) => o.localId) : []

  return {
    expectedCashText: format(r.expectedCash),
    expectedWalletText: format(r.expectedWallet),
    expectedTotalText: format(r.expectedTotal),
    blockText: format(r.totals.blockTotal),
    differenceText: hasDeclared ? format(r.scalarDiff) : null,
    balanced: hasDeclared ? r.balanced : null,
    feeGapText: unbalanced ? format(minor((gap * 100n) / 80n)) : null,
    suspectLocalIds: suspects,
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

/**
 * What the zero equation actually says, in three states rather than two.
 *
 * `scalarDiff` alone is blind to a pay-mode error. Flip one order cash↔electronic and it stays
 * exactly zero while the cash is short by the fee and the wallet is over by the same amount — the
 * one failure the equation exists to catch, reported as perfect. The domain has always returned
 * `splitBalanced` for this; the approval screen read `balanced` only, painted the ring green and
 * left the approve button live.
 *
 * `off` is what a UI must gate on: it is true whenever the manager should not sign without looking
 * further, whichever of the two ways the shift is wrong.
 */
export type Br1Verdict = 'balanced' | 'split_off' | 'not_balanced'

export function br1Verdict(r: { balanced: boolean; splitBalanced: boolean }): { verdict: Br1Verdict; off: boolean } {
  if (!r.balanced) return { verdict: 'not_balanced', off: true }
  if (!r.splitBalanced) return { verdict: 'split_off', off: true }
  return { verdict: 'balanced', off: false }
}

/**
 * Group the thousands of a money string for DISPLAY only.
 *
 * «1500000.00» against «150000.00» is read by counting zeros — at the exact moment a manager is
 * deciding whether a shift balances, in a currency where one day's fees run to seven digits. The
 * wire string is never touched: this returns a new string for the screen, and every parse still
 * happens on the original.
 */
export function groupThousands(money: string): string {
  const m = money.trim().match(/^([-+−]?)(\d+)(\.\d+)?$/)
  if (!m) return money
  return `${m[1]}${m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${m[3] ?? ''}`
}

/**
 * What a driver's screen should do when the server reports the shift's state.
 *
 * The driver app asked the server once, on mount, and never again — so a manager could cancel a
 * shift and the phone would go on showing «جارية» for the rest of the day, the driver delivering
 * against something that no longer exists. Reloading always fixed it, which is exactly why it went
 * unnoticed: the one person who never reloads is a driver mid-shift.
 *
 * `gone` means the shift is over and the screen must stop showing it. `phase` is the screen to move
 * to, or `null` to leave him where he is — the server still says `open` while he is filling in the
 * closing package, and dragging him backwards out of it would lose his work.
 */
export type DriverPhase = 'start' | 'awaiting' | 'orders' | 'suspended' | 'end' | 'done'

export function driverPhaseFor(
  serverState: string,
  current: DriverPhase,
): { gone: 'cancelled' | 'closed' | null; phase: DriverPhase | null } {
  if (serverState === 'cancelled') return { gone: 'cancelled', phase: null }
  // Force-closed by the manager from «النوبات الجارية»: finished, and nothing is owed.
  if (serverState === 'approved' || serverState === 'week_locked') return { gone: 'closed', phase: 'done' }
  if (serverState === 'suspended' && (current === 'orders' || current === 'end')) return { gone: null, phase: 'suspended' }
  if (serverState === 'open' && current === 'suspended') return { gone: null, phase: 'orders' }
  if (serverState === 'pending_review' && (current === 'orders' || current === 'end')) return { gone: null, phase: 'done' }
  return { gone: null, phase: null }
}
