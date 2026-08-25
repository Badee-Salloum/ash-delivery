import { type Minor, type PayMode, WALLET_LOG_FEEDS_BR1, evaluateBr1, hasVisibleText, minor, parseMinor } from '@ash/domain'

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
  /** Stable close-draft identity. Unlike `scanProvenance`, this crosses the wire. */
  clientKey?: string
  providerOrderNo: string
  payMode: PayMode
  /** As typed, so the field round-trips exactly what the driver sees. */
  feeText: string
  /** Last canonical value, used to send a row edit only when the driver actually changed it. */
  persistedFeeText?: string
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
   * The fee's own strip of pixels as a PNG data URL, kept so a real shift can teach the reader.
   *
   * Training data, not evidence: it holds the amount and nothing else. The evidence screenshot is
   * compressed to ~300 KB / 1280 px / quality 0.4 before upload, which at 12x16 pixels a glyph
   * destroys exactly the strokes a model would learn from — this is cut from the original.
   */
  feeStrip?: string | null
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
  /** Automatically excluded until both printed day and minute are verified by the reader. */
  timeReviewRequired?: boolean
  /** How much of the fee reached the wallet, as typed/measured. '' = unmeasured, the mode decides. */
  walletAmountText?: string
  /** «HH:MM» off the dashboard — what a payments-log row is paired to. */
  timeText?: string
  /** Canonical clock baseline, so an autosave never claims an unchanged OCR field as human input. */
  persistedTimeText?: string
  /**
   * «YYYY-MM-DD» from the screen's own day header, when one could be read.
   *
   * NOT the shift's day. «الطلبات الحديثة» scrolls back through previous days, so a list read at
   * close routinely holds yesterday's orders — and until this was shown, the only thing standing
   * between them and the shift's money was the driver noticing.
   */
  dateText?: string
  /** Canonical printed-day baseline paired with `persistedTimeText`. */
  persistedDateText?: string
  /** Where it went: «A» the pickup, «B» the dropoff, as the screen wrote them. */
  pointA?: string | null
  pointB?: string | null
  /**
   * Stable identity of a row whose printed clock AI refused to verify.
   *
   * A known (day, minute) is enough to merge overlapping screenshots. With no minute, using an
   * empty string as identity makes unrelated deliveries on different pages look identical. The
   * evidence slot plus row position keeps a retry of the SAME image idempotent, while deliberately
   * retaining uncertain rows from DIFFERENT images for the manager to resolve instead of silently
   * discarding money. It is local provenance only and never crosses the operations wire.
   */
  scanProvenance?: string
  /** Server-owned provenance for a durable close-draft row. */
  draftSource?: 'manual' | 'local_ocr' | 'cloud_ocr'
  readId?: string | null
  observationId?: string | null
  rowIndex?: number | null
  dateSection?: string | null
  evidence?: { mediaId: string; attachmentToken: string; slot: string } | null
  sightings?: Array<{
    readId: string
    observationId: string
    rowIndex: number
    dateSection: string | null
    evidence: { mediaId: string; attachmentToken: string; slot: string }
  }>
  windowBasis?: 'printed_time' | 'screen_position' | 'manager' | null
  position?: {
    lowerInstant: string | null
    upperInstant: string | null
    anchorObservationIds?: string[]
  } | null
}

/** A «سجل المدفوعات» row as the driver's list holds it, before the server gives it an identity. */
export interface DraftMovement {
  localId: string
  clientKey?: string
  /** SIGNED money as typed: «-99», «107.50». Negative left the wallet. */
  amountText: string
  persistedAmountText?: string
  timeText: string
  persistedTimeText?: string
  included?: boolean
  /** Which order it answers to, by number, when the matcher paired them. */
  providerOrderNo?: string | null
  role?: 'yalago_cut' | 'order_credit' | 'unmatched'
  ambiguous?: boolean
  persistedAmbiguous?: boolean
  /**
   * What the on-device reader made of this amount, before any cloud correction. Identity only —
   * see `mergeScannedMovements` for why a movement's key cannot drop the amount the way an
   * order's key drops the fee.
   */
  scannedAs?: string
  notes?: string | null
  persistedNotes?: string | null
  draftSource?: 'manual' | 'local_ocr' | 'cloud_ocr'
  readId?: string | null
  observationId?: string | null
  rowIndex?: number | null
  dateSection?: string | null
  evidence?: { mediaId: string; attachmentToken: string; slot: string } | null
  sightings?: Array<{
    readId: string
    observationId: string
    rowIndex: number
    dateSection: string | null
    evidence: { mediaId: string; attachmentToken: string; slot: string }
  }>
}

/** A negative Recent-Orders operation, represented as a positive cash-out magnitude. */
export interface DraftCashDeduction {
  localId: string
  clientKey?: string
  /** Deterministic across overlapping pages/retries; never a random order id. */
  operationKey: string
  amountText: string
  persistedAmountText?: string
  amountOcrText: string | null
  amountStrip?: string | null
  timeText: string
  persistedTimeText?: string
  dateText: string
  persistedDateText?: string
  pointA?: string | null
  pointB?: string | null
  source: 'ocr' | 'refused' | 'manual'
  included?: boolean
  /**
   * Stable identity of this row in the dashboard evidence while its printed time is unverified.
   *
   * A negative amount remains financially important even when AI refuses every other field. The
   * evidence slot plus row position lets a retry heal that same draft instead of appending a second
   * deduction. It is local-only and never becomes ledger identity (`operationKey` owns that).
   */
  scanProvenance?: string
  /**
   * The amount is trusted, but its time boundary is not. Such a row stays visible/retryable and
   * remains excluded from the phone's BR1 preview until AI has verified both its minute and date.
   */
  timeReviewRequired?: boolean
  /** Already persisted by the API. Local reconciliation must never hide a server ledger row. */
  recorded?: boolean
  draftSource?: 'manual' | 'local_ocr' | 'cloud_ocr'
  readId?: string | null
  observationId?: string | null
  rowIndex?: number | null
  dateSection?: string | null
  evidence?: { mediaId: string; attachmentToken: string; slot: string } | null
  sightings?: Array<{
    readId: string
    observationId: string
    rowIndex: number
    dateSection: string | null
    evidence: { mediaId: string; attachmentToken: string; slot: string }
  }>
  windowBasis?: 'printed_time' | 'screen_position' | 'manager' | null
  position?: {
    lowerInstant: string | null
    upperInstant: string | null
    anchorObservationIds?: string[]
  } | null
}

/** The canonical deduction shape returned after the server commits an operations batch. */
export interface StoredCashDeductionView {
  id: string
  operationKey: string
  amount: string
  amountOcr?: string | null
  occurredMinute: string | null
  occurredDate: string | null
  source: 'ocr' | 'manual'
  pointA: string | null
  pointB: string | null
  included: boolean
  windowStatus?: string
  decisionReason?: string | null
  decidedBy?: string | null
  decidedAt?: string | null
}

/**
 * Replace the phone's draft with the exact rows that survived the atomic server batch.
 *
 * A server may heal an already-recorded partial/full OCR overlap. Merely marking every submitted
 * local row as recorded would leave the deleted duplicate visible and would keep subtracting it
 * from the phone preview until a reload. The server list is authoritative for identity and money;
 * the only local-only field retained is the training strip for the surviving operation key.
 */
export function syncRecordedCashDeductions(
  current: readonly DraftCashDeduction[],
  stored: readonly StoredCashDeductionView[],
): DraftCashDeduction[] {
  const currentByKey = new Map(current.map((row) => [row.operationKey, row]))
  return stored.map((row) => {
    const local = currentByKey.get(row.operationKey)
    const missingBoundary = row.occurredMinute === null || row.occurredDate === null
    const auditedUnknownDecision = row.windowStatus === 'unknown'
      && row.decidedBy != null
      && row.decidedAt != null
      && hasVisibleText(row.decisionReason)
    const unresolvedBoundary = row.windowStatus === 'unknown'
      ? !auditedUnknownDecision
      : row.windowStatus === undefined && row.source === 'ocr' && missingBoundary
    return {
      localId: local?.localId ?? `deduction-${row.id}`,
      operationKey: row.operationKey,
      amountText: row.amount,
      amountOcrText: row.amountOcr ?? null,
      ...(local?.amountStrip === undefined ? {} : { amountStrip: local.amountStrip }),
      timeText: row.occurredMinute ?? '',
      dateText: row.occurredDate ?? '',
      pointA: row.pointA,
      pointB: row.pointB,
      source: row.source,
      included: unresolvedBoundary ? false : row.included,
      ...(local?.scanProvenance ? { scanProvenance: local.scanProvenance } : {}),
      ...(unresolvedBoundary
        ? { timeReviewRequired: true }
        : {}),
      recorded: true,
    }
  })
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

/**
 * The fees already on this shift, most-used first — tap targets for a row the reader refused.
 *
 * The reader is right about the money it reads; what it costs the driver is the handful of empty
 * boxes it honestly declines. Typing «١٣٠» on a phone at the end of a shift is slower than it
 * sounds, and Yallago's fares repeat hard — 120, 130, 135, 170, 235 all day. Offering what is
 * already on his own list turns a refusal into one tap, which is the cheapest way to make the
 * remaining failures stop mattering.
 *
 * Drawn from the shift itself, so it needs no configuration and follows a price change by itself.
 * Ties break toward the LARGER fee: understating is the error that costs the driver money.
 */
export function frequentFees(orders: readonly DraftOrder[], limit = 5): string[] {
  const seen = new Map<string, number>()
  for (const o of orders) {
    const fee = o.feeText.trim()
    if (fee === '' || o.cancelled === true) continue
    try {
      if (parseMinor(fee) <= 0n) continue
    } catch {
      continue
    }
    seen.set(fee, (seen.get(fee) ?? 0) + 1)
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]))
    .slice(0, limit)
    .map(([fee]) => fee)
}

/**
 * WHERE A FEE CAME FROM. Three answers, and one field already separates all three.
 *
 * The driver has never been told which numbers on his screen the app guessed and which he typed —
 * provenance is captured, shipped, and shown only to the manager. That is backwards: he is the one
 * who can still check it against the screen in his hand.
 *
 *   'read'     the reader produced this fee     → `feeOcrText` holds what it said
 *   'refused'  the reader saw the row and declined → he typed it, over a machine's admission
 *   'typed'    no screenshot behind it at all   → he added the row himself
 */
export type FeeSource = 'read' | 'refused' | 'typed'

export const feeSourceOf = (o: DraftOrder): FeeSource =>
  o.feeOcrText != null ? 'read' : o.feeRefused === true ? 'refused' : 'typed'

/**
 * WHAT HE WORKED — the fees of the deliveries he is claiming, added up.
 *
 * The one number the driver actually wants at a glance, and the screen never showed it: he could
 * see ten rows and the count, but not the day's own total. It is also the term BR1 multiplies by
 * 0.80, so seeing it move as rows are checked and unchecked makes the equation legible instead of
 * mysterious.
 *
 * Only CHECKED rows count, matching `previewBr1` and the server: an unchecked row is one he is not
 * claiming. A malformed fee contributes nothing rather than throwing — the total is a live display
 * on a screen where a half-typed number is normal.
 *
 * Returns a DECIMAL STRING, like every other money value this module hands the UI (`expectedCashText`
 * and the rest). Minor units are the arithmetic; the string is what a screen renders.
 */
export function workedTotalText(orders: readonly DraftOrder[]): string {
  let sum = minor(0n)
  for (const o of orders) {
    if (!draftOrderCounts(o)) continue
    try {
      const fee = parseMinor(o.feeText || '0')
      if (fee > 0n) sum = minor(sum + fee)
    } catch {
      // A row mid-typing is not an error here; it simply has nothing to add yet.
    }
  }
  return format(sum)
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
  /** The fee's own pixels, for training the reader. The amount only — no address, no name. */
  feeStrip?: string | null
  /** A “تم إلغاؤه” card: no fee on screen, and normally no money either. */
  cancelled?: boolean
  /** Local evidence-slot/row identity used only when the verified clock is absent. */
  scanProvenance?: string
}

/**
 * Fill only a date gap bounded on both sides by the same known day.
 *
 * The on-device reader already applies the nearest legible day header above a row. This closes the
 * narrower cloud/neighbor gap. A leading/trailing gap, or one between different days, remains null:
 * scrolling Recent Orders crosses days and either guess could move money across a shift/week gate.
 */
export function inferMissingOrderDates<T extends ScannedOrderRow>(rows: readonly T[]): T[] {
  const out = rows.map((row) => ({ ...row }))
  let i = 0
  while (i < out.length) {
    if (out[i]!.dateIso !== null && out[i]!.dateIso !== '') {
      i += 1
      continue
    }
    const start = i
    while (i < out.length && (out[i]!.dateIso === null || out[i]!.dateIso === '')) i += 1
    const left = start > 0 ? out[start - 1]!.dateIso : null
    const right = i < out.length ? out[i]!.dateIso : null
    if (left && right && left === right) {
      for (let j = start; j < i; j++) out[j] = { ...out[j]!, dateIso: left }
    }
  }
  return out
}

/** A valid negative money string -> its positive magnitude, otherwise null. */
export function cashDeductionMagnitude(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.trim().replace(/^[−–—]\s*/, '-').replace(/^\+\s*/, '+')
  if (!normalized.startsWith('-')) return null
  const magnitude = normalized.slice(1).trim()
  if (magnitude === '') return null
  try {
    return parseMinor(normalized) < 0n ? magnitude : null
  } catch {
    return null
  }
}

const cleanOperationPart = (value: string | null | undefined): string =>
  (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

const validOperationMinute = (value: string | null | undefined): boolean =>
  /^(?:[01]\d|2[0-3]):[0-5]\d$/.test((value ?? '').trim())

const validOperationDate = (value: string | null | undefined): boolean => {
  const text = (value ?? '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
}

const hasVerifiedOperationBoundary = (
  time: string | null | undefined,
  date: string | null | undefined,
): boolean => validOperationMinute(time) && validOperationDate(date)

const draftOrderCounts = (row: DraftOrder): boolean =>
  row.included !== false && row.timeReviewRequired !== true

const draftDeductionCounts = (row: DraftCashDeduction): boolean =>
  row.included !== false && row.timeReviewRequired !== true

/**
 * Restore a server order without letting legacy `unknown + included=true` enter the phone preview.
 * A reason attributed to a manager is the state endpoint's audited-window marker; explicit manager
 * include/exclude decisions remain authoritative, while an unresolved legacy default is unchecked.
 */
export function resumedOrderWindowState(row: {
  included: boolean
  windowStatus: string
  decisionReason: string | null
  decidedBy: string | null
  decidedAt: string | null
}): Pick<DraftOrder, 'included' | 'timeReviewRequired'> {
  const unresolvedUnknown = row.windowStatus === 'unknown'
    && (row.decidedBy === null || row.decidedAt === null || !hasVisibleText(row.decisionReason))
  return unresolvedUnknown
    ? { included: false, timeReviewRequired: true }
    : { included: row.included }
}

/**
 * The part of a Recent-Orders operation that does not change when an overlapping screenshot fills
 * in a missing minute, day or route. The OCR amount is source identity here; metadata disambiguates
 * equal-amount rows during the multiset merge, and a later human correction never recomputes the
 * key stored on the draft row.
 */
const operationIdentity = (row: ScannedOrderRow): string => {
  const magnitude = cashDeductionMagnitude(row.fee)
  const amountMinor = magnitude === null ? cleanOperationPart(row.fee) : String(parseMinor(magnitude))
  return amountMinor
}

/** Small deterministic FNV-1a key; the readable prefix identifies its source screen. */
export function cashDeductionOperationKey(row: ScannedOrderRow): string {
  let hash = 0xcbf29ce484222325n
  for (const char of operationIdentity(row)) {
    hash ^= BigInt(char.codePointAt(0)!)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `recent-orders:${hash.toString(16).padStart(16, '0')}`
}

/** `~2`, `~3`, … preserve equal amounts whose known date/minute proves they are distinct. */
const nextOperationKey = (base: string, occupied: ReadonlySet<string>): string => {
  if (!occupied.has(base)) return base
  let occurrence = 2
  while (occupied.has(`${base}~${occurrence}`)) occurrence += 1
  return `${base}~${occurrence}`
}

type DeductionRouteEvidence = Pick<DraftCashDeduction, 'pointA' | 'pointB'>
type DeductionTimingEvidence = {
  timeText?: string | null
  dateText?: string | null
}

const routeEvidenceCount = (row: DeductionRouteEvidence): number =>
  [row.pointA, row.pointB].filter((part) => cleanOperationPart(part) !== '').length

const compatibleKnownDeductionDates = (
  left: Pick<DeductionTimingEvidence, 'dateText'>,
  right: Pick<DeductionTimingEvidence, 'dateText'>,
): boolean => {
  const leftDate = cleanOperationPart(left.dateText)
  const rightDate = cleanOperationPart(right.dateText)
  return leftDate === '' || rightDate === '' || leftDate === rightDate
}

/**
 * Recent Orders OCR identifies a cash deduction by its printed minute and OCR amount. Routes are
 * evidence for the review, not identity: overlapping screenshots can produce wholly different
 * route text for the same card. A known day still separates two real rows at the same clock time;
 * a missing day may be healed from the other sighting.
 */
const sameCashDeductionTiming = (
  left: Pick<DeductionTimingEvidence, 'timeText' | 'dateText'>,
  right: Pick<DeductionTimingEvidence, 'timeText' | 'dateText'>,
): boolean => {
  const leftMinute = cleanOperationPart(left.timeText)
  const rightMinute = cleanOperationPart(right.timeText)
  return leftMinute !== '' && leftMinute === rightMinute && compatibleKnownDeductionDates(left, right)
}

/**
 * A retry of one evidence row may move from an unknown clock to a verified one.
 *
 * Amount equality is checked by the caller. Provenance is allowed to bridge the missing-clock gap,
 * but never two conflicting known clocks or dates. This is intentionally narrower than ordinary
 * overlap matching: different evidence slots with the same -50 remain two visible candidates.
 */
const sameCashDeductionProvenance = (
  existing: DraftCashDeduction,
  scanned: ScannedOrderRow,
): boolean => {
  const existingProvenance = cleanOperationPart(existing.scanProvenance)
  const scannedProvenance = cleanOperationPart(scanned.scanProvenance)
  if (
    existingProvenance === '' ||
    scannedProvenance === '' ||
    existingProvenance !== scannedProvenance ||
    !compatibleKnownDeductionDates(existing, { dateText: scanned.dateIso })
  ) return false

  const existingMinute = cleanOperationPart(existing.timeText)
  const scannedMinute = cleanOperationPart(scanned.time)
  return existingMinute === '' || scannedMinute === '' || existingMinute === scannedMinute
}

const enrichmentMatchScore = (existing: DraftCashDeduction, scanned: ScannedOrderRow): number => {
  if (!sameCashDeductionTiming(
    existing,
    { timeText: scanned.time, dateText: scanned.dateIso },
  )) return -1

  const knownDateScore = cleanOperationPart(existing.dateText) !== '' ? 1 : 0
  return knownDateScore + routeEvidenceCount(existing)
}

const bestExistingDeduction = (
  existing: readonly DraftCashDeduction[],
  consumed: ReadonlySet<DraftCashDeduction>,
  scanned: ScannedOrderRow,
): DraftCashDeduction | null => {
  const scannedAmount = operationIdentity(scanned)
  const eligible = existing.filter((candidate) => {
    if (consumed.has(candidate)) return false
    // A manual row is a separate human claim. OCR rows, including keys made by an older cached PWA,
    // match by the printed timing and OCR magnitude rather than by route-derived key history.
    return hasUneditedOcrAmount(candidate) && draftDeductionAmountIdentity(candidate) === scannedAmount
  })

  const byProvenance = eligible.filter((candidate) => sameCashDeductionProvenance(candidate, scanned))
  // Duplicate provenance is corrupt/ambiguous draft state. Do not guess which monetary row a retry
  // should heal; both remain visible for the manager.
  if (byProvenance.length === 1) return byProvenance[0]!
  if (byProvenance.length > 1) return null

  let best: DraftCashDeduction | null = null
  let bestScore = -1
  for (const candidate of eligible) {
    const score = enrichmentMatchScore(candidate, scanned)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

const preferredMatchedDate = (existing: DraftCashDeduction, scanned: ScannedOrderRow): string => {
  const existingDate = cleanOperationPart(existing.dateText)
  const scannedDate = cleanOperationPart(scanned.dateIso)
  if (existingDate === '') return scanned.dateIso ?? ''
  if (scannedDate === '' || scannedDate === existingDate) return existing.dateText
  // The matcher rejects two known, different dates; retain the stable value defensively.
  return existing.dateText
}

const hasVerifiedDeductionBoundary = hasVerifiedOperationBoundary

const mergedDeductionDetails = (existing: DraftCashDeduction, scanned: ScannedOrderRow) => {
  const timeText = existing.timeText || scanned.time
  const dateText = preferredMatchedDate(existing, scanned)
  const boundaryVerified = hasVerifiedDeductionBoundary(timeText, dateText)
  return {
    timeText,
    dateText,
    ...(existing.scanProvenance || scanned.scanProvenance
      ? { scanProvenance: existing.scanProvenance || scanned.scanProvenance }
      : {}),
    ...(existing.timeReviewRequired === true && boundaryVerified
      ? { timeReviewRequired: false, included: true }
      : {}),
    // Prefer the sighting with more route evidence. Equal-length conflicting OCR keeps the stable
    // first sighting; the route is for review and never changes timing identity.
    pointA:
      routeEvidenceCount(scanned) > routeEvidenceCount(existing)
        ? (scanned.pointA ?? existing.pointA ?? null)
        : (existing.pointA ?? scanned.pointA ?? null),
    pointB:
      routeEvidenceCount(scanned) > routeEvidenceCount(existing)
        ? (scanned.pointB ?? existing.pointB ?? null)
        : (existing.pointB ?? scanned.pointB ?? null),
  }
}

const deductionAsScannedRow = (row: DraftCashDeduction): ScannedOrderRow => ({
  dateIso: cleanOperationPart(row.dateText) === '' ? null : row.dateText,
  time: row.timeText,
  fee: null,
  pointA: row.pointA ?? null,
  pointB: row.pointB ?? null,
  ...(row.amountStrip ? { feeStrip: row.amountStrip } : {}),
  ...(row.scanProvenance ? { scanProvenance: row.scanProvenance } : {}),
})

const draftDeductionAmountIdentity = (row: DraftCashDeduction): string | null => {
  try {
    const amount = parseMinor(row.amountOcrText || row.amountText)
    return amount > 0n ? String(amount) : null
  } catch {
    return null
  }
}

const hasUneditedOcrAmount = (row: DraftCashDeduction): boolean => {
  if (row.source !== 'ocr' || cleanOperationPart(row.amountOcrText) === '') return false
  try {
    return parseMinor(row.amountText) === parseMinor(row.amountOcrText!)
  } catch {
    return false
  }
}

const isUntouchedLocalOcrDeduction = (row: DraftCashDeduction): boolean =>
  row.recorded !== true && hasUneditedOcrAmount(row)

/**
 * Remove only a duplicated timed OCR sighting already present in a phone draft.
 *
 * Both rows must be untouched, unrecorded OCR rows with the same OCR amount and nonblank minute.
 * Route OCR is deliberately ignored for identity. The first row keeps its stable local/wire
 * identities while a more complete sighting supplies missing date and route evidence.
 */
export function reconcileLocalCashDeductions(rows: readonly DraftCashDeduction[]): DraftCashDeduction[] {
  const reconciled: DraftCashDeduction[] = []
  for (const source of rows) {
    const row = { ...source }
    if (!isUntouchedLocalOcrDeduction(row)) {
      reconciled.push(row)
      continue
    }
    const amountIdentity = draftDeductionAmountIdentity(row)
    const minute = cleanOperationPart(row.timeText)
    const matchIndex = reconciled.findIndex((candidate) => {
      if (!isUntouchedLocalOcrDeduction(candidate) || amountIdentity === null || minute === '') return false
      if (draftDeductionAmountIdentity(candidate) !== amountIdentity) return false
      return sameCashDeductionTiming(candidate, row)
    })
    if (matchIndex === -1) {
      reconciled.push(row)
      continue
    }

    const first = reconciled[matchIndex]!
    reconciled[matchIndex] = {
      ...first,
      ...mergedDeductionDetails(first, deductionAsScannedRow(row)),
      ...(!first.amountStrip && row.amountStrip ? { amountStrip: row.amountStrip } : {}),
    }
  }
  return reconciled
}

/** Route negative operations away from delivery/tier arithmetic and merge overlapping sightings. */
export function mergeScannedCashDeductions(
  existing: readonly DraftCashDeduction[],
  scanned: readonly ScannedOrderRow[],
  newId: () => string,
): DraftCashDeduction[] {
  const occupied = new Set(existing.map((row) => row.operationKey))
  const consumed = new Set<DraftCashDeduction>()
  const consumedDetails = new Map<DraftCashDeduction, DraftCashDeduction>()
  const added: DraftCashDeduction[] = []
  for (const row of inferMissingOrderDates(scanned)) {
    const magnitude = cashDeductionMagnitude(row.fee)
    if (magnitude === null) continue
    const base = cashDeductionOperationKey(row)
    const match = bestExistingDeduction(existing, consumed, row)
    if (match) {
      consumed.add(match)
      consumedDetails.set(match, { ...match, ...mergedDeductionDetails(match, row) })
      continue
    }
    // The AI may repeat one card in overlapping crops. Timing and OCR amount own identity; route
    // text can disagree completely and is retained only as the richer review evidence.
    const repeatedMatch = bestExistingDeduction([...consumedDetails.values()], new Set(), row)
    if (repeatedMatch) {
      Object.assign(repeatedMatch, mergedDeductionDetails(repeatedMatch, row))
      continue
    }
    const batchMatch = bestExistingDeduction(added, new Set(), row)
    if (batchMatch) {
      Object.assign(batchMatch, mergedDeductionDetails(batchMatch, row))
      if (!batchMatch.amountStrip && row.feeStrip) batchMatch.amountStrip = row.feeStrip
      continue
    }
    const operationKey = nextOperationKey(base, occupied)
    occupied.add(operationKey)
    added.push({
      localId: newId(),
      operationKey,
      amountText: magnitude,
      amountOcrText: magnitude,
      ...(row.feeStrip ? { amountStrip: row.feeStrip } : {}),
      timeText: row.time,
      dateText: row.dateIso ?? '',
      pointA: row.pointA ?? null,
      pointB: row.pointB ?? null,
      source: 'ocr',
      included: hasVerifiedDeductionBoundary(row.time, row.dateIso),
      ...(!hasVerifiedDeductionBoundary(row.time, row.dateIso) ? { timeReviewRequired: true } : {}),
      ...(row.scanProvenance ? { scanProvenance: row.scanProvenance } : {}),
    })
  }
  return added
}

/** Fill missing date/route evidence from an overlapping sighting without changing operation keys. */
export function healCashDeductionDetails(
  existing: readonly DraftCashDeduction[],
  scanned: readonly ScannedOrderRow[],
): Array<{
  localId: string
  timeText: string
  dateText: string
  pointA: string | null
  pointB: string | null
  included?: boolean
  timeReviewRequired?: boolean
  scanProvenance?: string
}> {
  const consumed = new Set<DraftCashDeduction>()
  const consumedDetails = new Map<DraftCashDeduction, DraftCashDeduction>()
  for (const row of inferMissingOrderDates(scanned)) {
    if (cashDeductionMagnitude(row.fee) === null) continue
    const match = bestExistingDeduction(existing, consumed, row)
    if (match) {
      consumed.add(match)
      // A persisted ledger row still consumes this sighting so the merge cannot append a duplicate,
      // but the phone may never rewrite its time/date/inclusion from fresh OCR. Any such correction
      // belongs to the server's audited manager path.
      if (match.recorded === true) continue
      consumedDetails.set(match, { ...match, ...mergedDeductionDetails(match, row) })
      continue
    }
    const repeatedMatch = bestExistingDeduction([...consumedDetails.values()], new Set(), row)
    if (repeatedMatch) Object.assign(repeatedMatch, mergedDeductionDetails(repeatedMatch, row))
  }

  const patches: Array<{
    localId: string
    timeText: string
    dateText: string
    pointA: string | null
    pointB: string | null
    included?: boolean
    timeReviewRequired?: boolean
    scanProvenance?: string
  }> = []
  for (const [match, next] of consumedDetails) {
    if (
      next.timeText !== match.timeText ||
      next.dateText !== match.dateText ||
      next.pointA !== match.pointA ||
      next.pointB !== match.pointB ||
      next.included !== match.included ||
      next.timeReviewRequired !== match.timeReviewRequired ||
      next.scanProvenance !== match.scanProvenance
    ) {
      patches.push({
        localId: match.localId,
        timeText: next.timeText,
        dateText: next.dateText,
        pointA: next.pointA ?? null,
        pointB: next.pointB ?? null,
        ...(next.included !== match.included ? { included: next.included !== false } : {}),
        ...(next.timeReviewRequired !== match.timeReviewRequired
          ? { timeReviewRequired: next.timeReviewRequired === true }
          : {}),
        ...(next.scanProvenance ? { scanProvenance: next.scanProvenance } : {}),
      })
    }
  }
  return patches
}

/** Every deduction sent to the server must remain a strictly positive magnitude after correction. */
export function cashDeductionsAreValid(rows: readonly DraftCashDeduction[]): boolean {
  return rows.every((row) => {
    // A row the driver is NOT claiming needs no amount — the same exemption `validateRow` gives an
    // unchecked order, and for the same reason. Without it a deduction the operation window had
    // already excluded still blocked the close, with the footer misdirecting the driver to
    // «أصلح صفوف الطلبات» — a row he cannot price, cannot delete, and was never claiming.
    if (row.included === false) return true
    try {
      return parseMinor(row.amountText) > 0n
    } catch {
      return false
    }
  })
}

/** One row as the payments-log reader produced it. `amount` is signed. */
export interface ScannedMovementRow {
  amount: string
  time: string
  /**
   * What the ON-DEVICE reader made of this amount, before any cloud correction.
   *
   * Identity only — never shown, never submitted. It exists because the merge key contains the
   * amount (a payments-log minute is not unique) and the amount is now written by whichever reader
   * answered. Pinning identity to the phone's own reading keeps one movement to one key whether the
   * cloud answered on this page, on the previous one, or on neither.
   */
  scannedAs?: string
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
 * A row's identity: WHEN it happened and WHERE it went. Never how much it was worth.
 *
 * The day is part of it. Without it a delivery at 13:10 yesterday and another at 13:10 today are
 * one row, and scanning the second page silently swallows one of them.
 *
 * ── THE FEE USED TO BE IN HERE, and taking it out is the point ──────────────────────────────
 *
 * It was the fee *as scanned* rather than as edited, so that a driver correcting a misread «١٦» to
 * «١٦٥» did not turn one delivery into two. That reasoning was right and it is exactly why the fee
 * cannot stay: identity has to come from something that does not change after the row is created,
 * and with a second reader in play the scanned fee changes.
 *
 * Concretely, the failure this fixes. The dashboard is photographed page by page and the pages
 * overlap, so one delivery is commonly read twice. Suppose the cloud reader answers on page 1 and
 * times out on page 2:
 *
 *     page 1   local reads ٧٥,  cloud corrects to 750   →  key …|750|route
 *     page 2   local reads ٧٥,  cloud times out         →  key …|75 |route
 *
 * Two keys, one delivery, and the second sighting is appended as a new order. The driver is paid
 * once and credited twice. Nothing on his screen says so.
 *
 * Measured before changing it: across the corpus's orders screens, **0 of 26 rows share a
 * (date, minute)** with another row on the same screen — and the route is in the key besides, so
 * two deliveries would have to share a minute AND both addresses to collide. On the payments log
 * the same measurement is 36%, which is why `mergeScannedMovements` keeps its amount and pins it to
 * the local reader instead (see there).
 *
 * If a collision ever does happen the driver sees one row where there were two, and BR1 refuses the
 * close because the cash does not match — which is the same place the old duplicate surfaced. This
 * trades a silent double-count for a visible short-count, on a screen the driver can add a row to.
 */
const keyOf = (o: DraftOrder): string => {
  const head = o.cancelled === true ? 'C' : ''
  const time = cleanOperationPart(o.timeText)
  return `${head}|${o.dateText ?? ''}|${o.timeText ?? ''}|${cardKey(
    o.pointA,
    o.pointB,
    o.cancelled === true,
    time === '',
    o.scanProvenance,
  )}`
}

/** The same identity, computed from a freshly scanned row. Kept beside `keyOf` so they cannot drift. */
const scannedKey = (row: ScannedOrderRow): string => {
  const cancelled = row.cancelled === true
  // A cancelled card has no clock — its route is the only identity it has.
  const time = cleanOperationPart(row.time)
  return `${cancelled ? 'C' : ''}|${row.dateIso ?? ''}|${cancelled ? '' : row.time}|${cardKey(
    row.pointA,
    row.pointB,
    cancelled,
    time === '',
    row.scanProvenance,
  )}`
}

const authoritativeDeliveryFee = (row: ScannedOrderRow): string | null => {
  if (row.cancelled === true || row.fee === null) return null
  const fee = row.fee.trim()
  if (fee === '') return null
  try {
    return parseMinor(fee) >= 0n ? fee : null
  } catch {
    return null
  }
}

const compatibleEvidencePart = (
  left: string | null | undefined,
  right: string | null | undefined,
): boolean => {
  const held = cleanOperationPart(left)
  const retried = cleanOperationPart(right)
  return held === '' || retried === '' || held === retried
}

/** Same evidence slot is a hint, never permission to replace conflicting money. */
const compatibleKnownDeliveryFees = (existing: DraftOrder, scanned: ScannedOrderRow): boolean => {
  const retried = authoritativeDeliveryFee(scanned)
  if (retried === null) return true
  const retriedMinor = parseMinor(retried)

  for (const held of [existing.feeOcrText, existing.feeText]) {
    if (cleanOperationPart(held) === '') continue
    try {
      if (parseMinor(held!) !== retriedMinor) return false
    } catch {
      // Malformed held evidence cannot establish that two monetary rows are the same. Keeping both
      // visible is safer than allowing source position to discard one.
      return false
    }
  }
  return true
}

/**
 * Row position may shift between AI attempts. Require one exact, non-empty route endpoint before a
 * verified clock is allowed to heal an unknown-clock row from the same slot/index. Fee and day are
 * not enough: the incident image itself contains two 155-lira deliveries on the same day.
 */
const hasSharedRouteEvidence = (existing: DraftOrder, scanned: ScannedOrderRow): boolean =>
  ([
    [existing.pointA, scanned.pointA],
    [existing.pointB, scanned.pointB],
  ] as const).some(([held, retried]) => {
    const heldPart = cleanOperationPart(held)
    const retriedPart = cleanOperationPart(retried)
    return heldPart !== '' && heldPart === retriedPart
  })

/**
 * Whether a same-photo retry can safely refer to this held row.
 *
 * A blank held clock is the unresolved case provenance exists to heal. Once the held clock is
 * known, provenance may only confirm the same minute; it must never swallow a different row that
 * moved into the same ordinal position on a retry. Known day/route/fee conflicts likewise force a
 * second visible row for manager review.
 */
const compatibleRetryProvenance = (existing: DraftOrder, scanned: ScannedOrderRow): boolean => {
  const heldMinute = cleanOperationPart(existing.timeText)
  const retriedMinute = cleanOperationPart(scanned.time)
  if (heldMinute !== '' && (retriedMinute === '' || heldMinute !== retriedMinute)) return false
  if ((heldMinute === '' || retriedMinute === '') && !hasSharedRouteEvidence(existing, scanned)) {
    return false
  }
  return (
    compatibleEvidencePart(existing.dateText, scanned.dateIso) &&
    compatibleEvidencePart(existing.pointA, scanned.pointA) &&
    compatibleEvidencePart(existing.pointB, scanned.pointB) &&
    compatibleKnownDeliveryFees(existing, scanned)
  )
}

const routeSupportScore = (existing: DraftOrder, scanned: ScannedOrderRow): number => {
  let score = 0
  for (const [left, right] of [
    [existing.pointA, scanned.pointA],
    [existing.pointB, scanned.pointB],
  ] as const) {
    const existingPart = cleanOperationPart(left)
    const scannedPart = cleanOperationPart(right)
    if (existingPart === '' || scannedPart === '') continue
    if (existingPart === scannedPart) score += 2
    else if (existingPart.includes(scannedPart) || scannedPart.includes(existingPart)) score += 1
  }
  return score
}

/**
 * Replace an unresolved clock from one evidence slot with the verified clock from its retry.
 *
 * A row with no verified minute is deliberately keyed by `scanProvenance` so it remains visible.
 * Once a retry verifies the minute, however, its ordinary identity becomes (day, minute). Without
 * this reconciliation the old unknown row and the new timed row have different keys, so the retry
 * appends a second delivery and leaves the original warning unresolved.
 *
 * Provenance is deliberately used only to enrich an unrecorded, non-cancelled row whose clock is
 * still blank. The original local and provider ids (and the driver's include decision) survive.
 * The successful AI retry supplies the clock and fills missing day/route/fee evidence. It never
 * overwrites conflicting evidence merely because row positions happen to match: a changed row
 * count can move another delivery into the same ordinal position, and both must remain visible.
 */
export function reconcileUnverifiedOrderTimes(
  existing: readonly DraftOrder[],
  scanned: readonly ScannedOrderRow[],
): DraftOrder[] {
  const next = existing.map((row) => ({ ...row }))

  for (const row of inferMissingOrderDates(scanned)) {
    const provenance = cleanOperationPart(row.scanProvenance)
    const verifiedMinute = row.time.trim()
    if (
      provenance === '' ||
      verifiedMinute === '' ||
      row.cancelled === true ||
      cashDeductionMagnitude(row.fee) !== null
    ) continue

    const matches: number[] = []
    for (let index = 0; index < next.length; index += 1) {
      const candidate = next[index]!
      if (
        candidate.recorded === true ||
        candidate.cancelled === true ||
        cleanOperationPart(candidate.timeText) !== '' ||
        cleanOperationPart(candidate.scanProvenance) !== provenance
      ) continue
      matches.push(index)
    }

    // Duplicate provenance is corrupted/ambiguous local state. Never guess which monetary row a
    // verified clock belongs to; leave both visible for manager review.
    if (matches.length !== 1) continue

    const index = matches[0]!
    const target = next[index]!
    if (!compatibleRetryProvenance(target, row)) continue
    const fee = authoritativeDeliveryFee(row)
    const retryDate = row.dateIso?.trim() ?? ''
    const verifiedDate = target.dateText?.trim() ? target.dateText.trim() : retryDate
    if (!hasVerifiedOperationBoundary(verifiedMinute, verifiedDate)) continue
    const retryPointA = cleanOperationPart(row.pointA) === '' ? null : (row.pointA ?? null)
    const retryPointB = cleanOperationPart(row.pointB) === '' ? null : (row.pointB ?? null)
    const heldFeeKnown = cleanOperationPart(target.feeText) !== '' || cleanOperationPart(target.feeOcrText) !== ''
    const shouldFillFee = fee !== null && !heldFeeKnown
    const { feeRefused: _refusal, ...withoutRefusal } = target
    const base = shouldFillFee ? withoutRefusal : target
    const retryProvenance = target.scanProvenance ?? row.scanProvenance

    next[index] = {
      ...base,
      timeText: verifiedMinute,
      dateText: verifiedDate,
      included: true,
      timeReviewRequired: false,
      pointA: cleanOperationPart(target.pointA) === '' ? retryPointA : (target.pointA ?? null),
      pointB: cleanOperationPart(target.pointB) === '' ? retryPointB : (target.pointB ?? null),
      ...(shouldFillFee ? { feeText: fee, feeOcrText: fee } : {}),
      ...(target.feeStrip ? {} : row.feeStrip ? { feeStrip: row.feeStrip } : {}),
      ...(target.pointBIsPin === true || row.pointBIsPin === true ? { pointBIsPin: true } : {}),
      ...(retryProvenance ? { scanProvenance: retryProvenance } : {}),
    }
  }

  return next
}

/**
 * Let a successful second AI attempt price the refused card created by the first attempt.
 *
 * This is deliberately stricter than ordinary overlap de-duplication because it writes money. The
 * target must still be the untouched, unrecorded refusal: a driver-entered fee, an OCR baseline or
 * a server-recorded row makes it ineligible. A nonblank minute must match and at least one sighting
 * must carry a day; two known different days can never be the same delivery. Route text only helps
 * choose between otherwise eligible candidates — imperfect route OCR cannot veto a timing match.
 *
 * The returned rows retain the original local/wire identities. Missing day/route evidence is filled
 * without overwriting an existing value, and `feeRefused` is removed once AI supplied the baseline.
 */
export function reconcileRefusedOrderFees(
  existing: readonly DraftOrder[],
  scanned: readonly ScannedOrderRow[],
): DraftOrder[] {
  const next = existing.map((row) => ({ ...row }))
  const consumed = new Set<number>()

  for (const row of inferMissingOrderDates(scanned)) {
    const fee = authoritativeDeliveryFee(row)
    const scannedMinute = cleanOperationPart(row.time)
    const scannedDate = cleanOperationPart(row.dateIso)
    if (fee === null || scannedMinute === '') continue

    const matches: Array<{ index: number; score: number }> = []
    for (let index = 0; index < next.length; index += 1) {
      if (consumed.has(index)) continue
      const candidate = next[index]!
      if (
        candidate.recorded === true ||
        candidate.cancelled === true ||
        candidate.feeRefused !== true ||
        candidate.feeText.trim() !== '' ||
        cleanOperationPart(candidate.feeOcrText) !== ''
      ) continue

      const candidateMinute = cleanOperationPart(candidate.timeText)
      const candidateDate = cleanOperationPart(candidate.dateText)
      if (candidateMinute === '' || candidateMinute !== scannedMinute) continue
      // A known day is the minimum safe boundary. Missing evidence may be enriched; conflicting
      // evidence may never be reconciled into one monetary row.
      if (candidateDate === '' && scannedDate === '') continue
      if (candidateDate !== '' && scannedDate !== '' && candidateDate !== scannedDate) continue

      const exactDateScore = candidateDate !== '' && scannedDate !== '' ? 4 : 0
      matches.push({ index, score: exactDateScore + routeSupportScore(candidate, row) })
    }

    if (matches.length === 0) continue
    matches.sort((left, right) => right.score - left.score)
    // When timing and route evidence cannot distinguish two refused cards, assigning a fee would
    // be a guess. Leave both untouched for explicit review rather than writing money to either.
    if (matches.length > 1 && matches[0]!.score === matches[1]!.score) continue

    const index = matches[0]!.index
    const target = next[index]!
    const { feeRefused: _refusal, ...withoutRefusal } = target
    const pointA = cleanOperationPart(target.pointA) === '' ? (row.pointA ?? null) : (target.pointA ?? null)
    const pointB = cleanOperationPart(target.pointB) === '' ? (row.pointB ?? null) : (target.pointB ?? null)
    next[index] = {
      ...withoutRefusal,
      feeText: fee,
      feeOcrText: fee,
      dateText: target.dateText?.trim() ? target.dateText : (row.dateIso ?? ''),
      pointA,
      pointB,
      ...(target.pointBIsPin === true || (cleanOperationPart(target.pointB) === '' && row.pointBIsPin === true)
        ? { pointBIsPin: true }
        : {}),
    }
    consumed.add(index)
  }

  return next
}

/**
 * A card the screen cut in half, HEALED by the page that shows it whole.
 *
 * The screenshots overlap, so the delivery sliced off the bottom of one page is usually complete at
 * the top of the next. Its fee and clock were already right — those sit on the fully-drawn price
 * row — but its route was withheld, and the second sighting was then de-duplicated away and its
 * addresses thrown out with it. The driver saw a delivery to nowhere and no way to fix it.
 *
 * Deliberately narrow: a route is filled in ONLY where the row has none. An existing route is never
 * overwritten, and the FEE is never upgraded at all. The key is specific — day, minute and scanned
 * fee — but two deliveries genuinely can share a minute, and handing a read fee to the wrong row is
 * exactly the accepted-wrong failure this whole effort exists to prevent. A route is not money.
 *
 * Returns the patches to apply; `mergeScannedOrders` still decides what to append.
 */
export function healCutOffRoutes(
  existing: readonly DraftOrder[],
  scanned: readonly ScannedOrderRow[],
): Array<{ localId: string; pointA: string | null; pointB: string | null }> {
  const blank = new Map<string, DraftOrder[]>()
  for (const o of existing) {
    if (o.pointA != null || o.pointB != null) continue
    const key = keyOf(o)
    const bucket = blank.get(key)
    if (bucket) bucket.push(o)
    else blank.set(key, [o])
  }
  if (blank.size === 0) return []

  const out: Array<{ localId: string; pointA: string | null; pointB: string | null }> = []
  for (const row of scanned) {
    if (cashDeductionMagnitude(row.fee) !== null) continue
    if (row.pointA == null && row.pointB == null) continue
    const bucket = blank.get(scannedKey(row))
    // One sighting heals one row: shift it out so a page listing the same delivery twice cannot
    // write the same addresses over two different rows.
    const target = bucket?.shift()
    if (!target) continue
    out.push({ localId: target.localId, pointA: row.pointA ?? null, pointB: row.pointB ?? null })
  }
  return out
}

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
  // Each held row can consume exactly one sighting. A retry of the same evidence slot is matched
  // by provenance first because an unknown-time first answer and a verified-time retry necessarily
  // have different ordinary keys. The ordinary key remains the fallback across overlapping photos.
  const byKey = new Map<string, number[]>()
  const byProvenance = new Map<string, number[]>()
  const pushIndex = (map: Map<string, number[]>, key: string, index: number): void => {
    const bucket = map.get(key)
    if (bucket) bucket.push(index)
    else map.set(key, [index])
  }
  for (let index = 0; index < existing.length; index += 1) {
    const order = existing[index]!
    pushIndex(byKey, keyOf(order), index)
    const provenance = cleanOperationPart(order.scanProvenance)
    if (provenance !== '') {
      pushIndex(byProvenance, `${order.cancelled === true ? 'C' : 'O'}|${provenance}`, index)
    }
  }
  const consumed = new Set<number>()
  const consume = (bucket: readonly number[] | undefined): boolean => {
    if (!bucket) return false
    for (const index of bucket) {
      if (consumed.has(index)) continue
      consumed.add(index)
      return true
    }
    return false
  }
  const consumeCompatibleProvenance = (
    bucket: readonly number[] | undefined,
    row: ScannedOrderRow,
  ): boolean => {
    if (!bucket) return false
    const available = bucket.filter((index) => !consumed.has(index))
    // Provenance is only safe when it points to one unresolved/healed-compatible row. Duplicate
    // local provenance is ambiguous state and must fall through to ordinary identity/review.
    if (available.length !== 1) return false
    const index = available[0]!
    if (!compatibleRetryProvenance(existing[index]!, row)) return false
    consumed.add(index)
    return true
  }
  const added: DraftOrder[] = []
  for (const row of inferMissingOrderDates(scanned)) {
    // Negative Recent-Orders rows are cash operations, not delivery fees. Their dedicated merge
    // preserves the direction once, as a positive magnitude, and keeps them out of tier math.
    if (cashDeductionMagnitude(row.fee) !== null) continue
    const cancelled = row.cancelled === true
    const provenance = cleanOperationPart(row.scanProvenance)
    if (
      provenance !== '' &&
      consumeCompatibleProvenance(
        byProvenance.get(`${cancelled ? 'C' : 'O'}|${provenance}`),
        row,
      )
    ) continue
    const key = scannedKey(row)
    // Counted against what was ALREADY HELD, never against rows added by this same scan. One page
    // is one set of observations: if it lists «١٢٠» twice then two deliveries cost 120.
    if (consume(byKey.get(key))) continue
    const localId = newId()
    const boundaryVerified = hasVerifiedOperationBoundary(row.time, row.dateIso)
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
      included: !cancelled && boundaryVerified,
      ...(!cancelled && !boundaryVerified ? { timeReviewRequired: true } : {}),
      pointA: row.pointA ?? null,
      pointB: row.pointB ?? null,
      ...(row.pointBIsPin === true ? { pointBIsPin: true } : {}),
      ...(row.feeStrip ? { feeStrip: row.feeStrip } : {}),
      ...(row.scanProvenance ? { scanProvenance: row.scanProvenance } : {}),
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
const cardKey = (
  a: string | null | undefined,
  b: string | null | undefined,
  cancelled: boolean,
  uncertainTime: boolean,
  uncertainProvenance?: string,
): string => {
  if (cancelled) return `${(a ?? '').slice(0, 24)}→${(b ?? '').slice(0, 24)}`
  if (!uncertainTime) return ''
  if (uncertainProvenance) return `evidence:${uncertainProvenance}`
  // Legacy/unit callers may not have page provenance. Route is the next safest identity; when it
  // too is blank the multiset behaviour remains conservative and visible rather than inventing a
  // clock. The live cloud path always supplies provenance.
  const route = `${(a ?? '').slice(0, 24)}→${(b ?? '').slice(0, 24)}`
  return route === '→' ? '' : `route:${route}`
}

/**
 * Append what a payments-log screenshot read, skipping what the list already holds.
 *
 * A MULTISET merge, mirroring the server's: a minute genuinely can hold two identical amounts, so
 * only the surplus of each (minute, amount) is new. Matching by value alone would silently discard
 * the second of two real 24-lira cuts.
 *
 * ── WHY THIS ONE KEEPS THE AMOUNT, when the orders key dropped it ────────────────────────────
 *
 * Because a payments-log minute is not unique and cannot be made so. Measured on the corpus:
 * **8 of 22 rows share a (date, minute)** with another row on the same screen — 36% — and it is
 * structural rather than coincidental. One delivery posts a credit and its Yallago cut at the same
 * instant: «+153» and «−42» both at 17:42. Key those on the minute alone and the wallet
 * reconciliation collapses to a single row. A movement also has no route to fall back on; time and
 * amount are the whole of what the screen gives.
 *
 * So the amount stays — but pinned to `scannedAs`, the value the ON-DEVICE reader produced, which
 * no cloud read can move. `overlayCloudAmounts` carries it through for exactly this. Without it,
 * the same page read twice with the cloud answering only once yields two keys for one movement.
 */
export function mergeScannedMovements(
  existing: readonly DraftMovement[],
  scanned: readonly ScannedMovementRow[],
  newId: () => string,
): DraftMovement[] {
  const tally = new Map<string, number>()
  for (const m of existing) {
    const key = `${m.timeText}|${m.scannedAs ?? m.amountText}`
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  const added: DraftMovement[] = []
  for (const row of scanned) {
    // `scannedAs` is what the phone read before any cloud correction; it is the stable half.
    const identity = row.scannedAs ?? row.amount
    const key = `${row.time}|${identity}`
    const already = tally.get(key) ?? 0
    if (already > 0) {
      tally.set(key, already - 1)
      continue
    }
    added.push({
      localId: newId(),
      amountText: row.amount,
      timeText: row.time,
      included: true,
      ...(row.scannedAs !== undefined ? { scannedAs: row.scannedAs } : {}),
    })
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
 * Human meaning of BR1's signed scalar difference.
 *
 * The domain equation is `declared cash + declared wallet - expected total`. A positive value is
 * therefore money ABOVE expectation (a surplus), while a negative value is money BELOW it (a
 * shortage). UI code used to label both merely "difference" and colour both red, leaving an Arabic
 * reader to guess what the missing sign meant. Keep the sign interpretation here so the driver and
 * manager screens cannot drift.
 */
export type Br1DifferenceDirection = 'balanced' | 'surplus' | 'shortage'

export interface Br1DifferencePresentation {
  direction: Br1DifferenceDirection
  /** Absolute amount for display beside the directional label. */
  amountText: string
}

export function br1DifferencePresentation(differenceText: string): Br1DifferencePresentation {
  const difference = parseMinor(differenceText)
  return {
    direction: difference > 0n ? 'surplus' : difference < 0n ? 'shortage' : 'balanced',
    amountText: format(minor(difference < 0n ? -difference : difference)),
  }
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
  /** Negative Recent-Orders operations, held as positive cash-out magnitudes. */
  cashDeductions?: readonly DraftCashDeduction[]
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
  const valid = input.orders.filter((o, i) => draftOrderCounts(o) && validateRow(input.orders, i) === null)
  const orders = valid.map((o) => ({
    orderNo: o.providerOrderNo,
    payMode: o.payMode,
    fee: safeFee(o.feeText),
    ...(o.walletAmountText ? { walletAmount: safeFee(o.walletAmountText) } : {}),
  }))
  // The payments log is EVIDENCE AND TRAINING DATA, not a term in the equation — owner's decision.
  // It is still scanned, still shown and still stored, but it never moves anyone's money. The
  // shared switch keeps this preview aligned with API review and posting policy.
  //
  // The rule it replaces, kept because it is what gets restored: a logged Yallago cut is
  // corroboration and an order's credit is already inside its `walletAmount`, so only the
  // UNMATCHED rows were ever a term here.
  const walletAdjustments = WALLET_LOG_FEEDS_BR1
    ? (input.movements ?? [])
        .filter((m) => m.included !== false && (m.role ?? 'unmatched') === 'unmatched')
        .map((m) => safeSigned(m.amountText))
    : []

  const cashDeductions = (input.cashDeductions ?? [])
    .filter(draftDeductionCounts)
    .map((d) => safeFee(d.amountText))

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
    cashDeductions,
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
  // `split_off` is no longer reachable in practice, and deliberately so.
  //
  // It meant "the total is right but the money is in the wrong pocket" — which could only be known
  // because every delivery carried a pay mode. Pay mode is no longer collected (SRS BR3 retired,
  // decision 8), so `expectedCash` and `expectedWallet` are computed as though everything were
  // cash: on a perfectly correct shift where the driver took some electronically they disagree by
  // exactly the amount that moved, and the split would fire amber on every honest close.
  //
  // The branch stays rather than being deleted: `splitBalanced` is still computed and still true
  // whenever the modes ARE right, so restoring the split later means restoring the input, not
  // rewriting this. It is simply never a warning while the input is a constant.
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
  // A submitted close normally stays `pending_review`. Seeing the same shift return to `open` while
  // its phone is already on done means the manager reopened it for correction/rephoto.
  if (serverState === 'open' && current === 'done') return { gone: null, phase: 'end' }
  if (serverState === 'pending_review' && (current === 'orders' || current === 'end')) return { gone: null, phase: 'done' }
  return { gone: null, phase: null }
}

/**
 * Put the cloud reader's amounts onto the on-device reader's rows — WITHOUT merging twice.
 *
 * This exists because the obvious thing is catastrophic. `mergeScannedOrders` identifies a row by
 * (day, minute, fee-as-scanned), so if both readers merged their own rows into the same draft, the
 * keys would differ wherever they disagreed — which is exactly where the cloud is useful — and
 * every one of those deliveries would appear TWICE. A driver paid once, counted twice, in a
 * ledger that must balance to zero.
 *
 * So exactly one merge happens, over one list. The local reader owns the list: it is the one that
 * cut the fee strips, found the addresses, and knows which cards were sliced by the screen edge.
 * The cloud owns the NUMBERS, which is what it is measurably better at — 290 of 311 rows against
 * 136 across the real corpus.
 *
 * THE COUNTS MUST MATCH, or nothing is overlaid.
 *
 * Joining by position is only meaningful when both readers saw the same rows. With one row missing
 * from either side, every row below it shifts up and a positional join silently reassigns a dozen
 * amounts to the wrong deliveries — far worse than the misreads it was trying to fix. That is the
 * same rule `scripts/ocr-failures.mjs:9-11` applies when scoring, and for the same reason. A
 * mismatch is not an error; it just means the driver keeps the local reading, as he did last week.
 */
export function overlayCloudAmounts<K extends string, T extends Record<K, string | null>>(
  local: readonly T[],
  cloud: readonly {
    value: string | null
    cancelled: boolean
    reviewRequired?: boolean
    /** Filled onto the local row when the phone read no clock. See below. */
    time?: string | null
    dateIso?: string | null
  }[],
  key: K,
): { rows: (T & { scannedAs?: string })[]; overlaid: number } {
  if (local.length === 0 || local.length !== cloud.length) return { rows: [...local], overlaid: 0 }

  let overlaid = 0
  const rows = local.map((rawRow, i) => {
    const said = cloud[i]!

    /*
     * THE CLOCK AND THE DAY, filled where the phone has none.
     *
     * This function used to carry the amount and nothing else, and the amount is not the only thing
     * the phone gets wrong. On a live close the phone produced four rows off «الطلبات الحديثة» with
     * their clocks blank — it reads «١٠:٣١ م» far less reliably than it reads a fee — while the
     * cloud had returned 22:31, 21:48, 21:22, 20:28 and the correct 2026-08-05 for every one. The
     * overlay replaced the four fees, kept the four blanks, and the driver saw «/» where the time
     * should be on all four cards.
     *
     * FILLED, NEVER OVERWRITTEN, and that distinction is load-bearing. A row's merge identity is
     * (day, minute, route), so changing a clock the phone DID read would change the row's identity
     * between one page and the next depending on whether the cloud answered — the same instability
     * that took the fee out of the key. Going from blank to a value is monotonic: it can only make
     * two sightings of one delivery agree, never disagree.
     */
    const row = fillClock(rawRow, said)

    // A cancelled order has no amount. Never let a value land on one — the commonest way a reader
    // invents money is copying the row above into a row that has none.
    if (said.cancelled) return row[key] === null ? row : { ...row, [key]: null }
    if (said.value === null || said.value === row[key]) return row
    overlaid += 1
    /*
     * KEEP WHAT THE PHONE READ. This is not bookkeeping — it is the identity.
     *
     * The payments-log merge keys on the amount, because a minute there routinely holds two rows
     * (a delivery's credit and its Yallago cut, both at 17:42). Overwriting the amount without
     * keeping the original means the same movement, read on two overlapping pages, produces two
     * different keys the moment the cloud answers on one page and not the other — and the driver
     * is credited twice for one delivery. The orders key solved this by dropping the fee entirely;
     * a movement has no route to fall back on, so it keeps the amount and pins it here instead.
     */
    const asRead = row[key]
    return { ...row, [key]: said.value, ...(asRead !== null ? { scannedAs: asRead } : {}) }
  })
  return { rows, overlaid }
}

/** Fill a blank `time` / `dateIso` from the cloud's reading. Never replaces one that is present. */
function fillClock<T extends object>(
  row: T,
  said: { time?: string | null; dateIso?: string | null },
): T {
  const held = row as { time?: string | null; dateIso?: string | null }
  const blank = (v: string | null | undefined): boolean => v === null || v === undefined || v === ''
  const takeTime = blank(held.time) && !blank(said.time)
  const takeDate = blank(held.dateIso) && !blank(said.dateIso)
  if (!takeTime && !takeDate) return row
  return {
    ...row,
    ...(takeTime ? { time: said.time } : {}),
    ...(takeDate ? { dateIso: said.dateIso } : {}),
  }
}

/**
 * The cloud reader's rows, standing on their own — for when the phone's reader found nothing.
 *
 * `overlayCloudAmounts` treats the on-device list as authoritative about WHICH rows exist and lets
 * the cloud correct only the amounts. That is right whenever the phone produced a list. It is
 * exactly wrong when it produced none: the counts differ, the overlay returns the empty local list
 * unchanged, and a perfectly good cloud reading of four deliveries is discarded in silence.
 *
 * Seen on a real close: «لم تُضَف أي عملية من هذه الصورة · ٤٠ صفوف لم تُقرأ بثقة». The phone saw
 * forty candidate rows on that screenshot and confidently read zero; the cloud had read it fine and
 * the driver was told to type four deliveries by hand, having already paid for the answer.
 *
 * A cancelled card is kept as a row with no fee. It is a delivery that happened and the screen
 * still shows it — dropping it here would make the page look shorter than it is, and the driver
 * would re-add it by hand as a paid order.
 */
export function cloudRowsToScannedOrders(
  rows: readonly {
    value: string | null
    cancelled: boolean
    reviewRequired?: boolean
    time: string | null
    dateIso: string | null
    pointA?: string | null
    pointB?: string | null
    /** Accepted and ignored — the caller passes whole cloud rows, which also carry the glyphs. */
    printed?: string
  }[],
  /**
   * The phone's rows for the same image, used ONLY to carry each fee's strip of pixels across.
   *
   * A strip is training data — the amount's own pixels beside what a reader made of them — and the
   * cloud cannot produce one; it never sees the image as pixels we hold. So when both readers
   * emitted the same NUMBER of rows they are describing the same cards in the same order, and the
   * strip can ride along positionally. When the counts differ nothing is carried: a strip attached
   * to the wrong row is a mislabelled training example, which is worse than none.
   *
   * The reading itself is never taken from here. That is the whole point of this function.
   */
  local?: readonly { feeStrip?: string | null; pointBIsPin?: boolean }[],
  /** Stable photo slot. A retry uses the same slot; another overlapping photo uses another one. */
  evidenceSlot?: string,
): ScannedOrderRow[] {
  const alignable = local !== undefined && local.length === rows.length
  const out: ScannedOrderRow[] = []
  rows.forEach((row, i) => {
    const deduction = cashDeductionMagnitude(row.cancelled ? null : row.value) !== null
    // A positive delivery with an unverified clock must remain visible. Dropping it here discards
    // correctly-read money and prevents the manager from making the required window decision.
    // The live path supplies evidenceSlot, so slot+position gives it a retry-stable identity until
    // it is submitted with occurredMinute=null and classified `unknown` by the server.
    //
    // A trusted negative amount is itself enough evidence to keep a cash deduction. Its evidence
    // provenance owns retry identity while its missing clock keeps it out of BR1/window arithmetic.
    if (row.time === null || row.time.trim() === '') {
      // A cancellation-contested card is explicitly marked by the server. Preserve that refused
      // financial candidate, but keep dropping ordinary clipped edge fragments that have neither
      // money nor a clock and carry no such safety signal.
      const positiveDelivery =
        !row.cancelled && !deduction && (row.value !== null || row.reviewRequired === true)
      if (!positiveDelivery && !deduction) return
    }
    const mate = alignable ? local[i] : undefined
    out.push({
      dateIso: row.dateIso,
      time: row.time ?? '',
      fee: row.cancelled ? null : row.value,
      ...(row.cancelled ? { cancelled: true } : {}),
      ...(row.pointA != null ? { pointA: row.pointA } : {}),
      ...(row.pointB != null ? { pointB: row.pointB } : {}),
      ...(mate?.feeStrip ? { feeStrip: mate.feeStrip } : {}),
      ...(mate?.pointBIsPin === true ? { pointBIsPin: true } : {}),
      ...(evidenceSlot ? { scanProvenance: `${evidenceSlot}:${i}` } : {}),
    })
  })
  return inferMissingOrderDates(out)
}

/** The same, for the payments log — which needs only a signed amount and a clock. */
export function cloudRowsToScannedMovements(
  rows: readonly { value: string | null; time: string | null }[],
): ScannedMovementRow[] {
  const out: ScannedMovementRow[] = []
  for (const row of rows) {
    if (row.value === null || row.time === null || row.time.trim() === '') continue
    out.push({ amount: row.value, time: row.time })
  }
  return out
}
