import type { Minor } from '../money/minor.ts'

/**
 * Two scans of one list that share rows.
 *
 * A driver photographing the Yallago Recent Orders list often takes more than one shot, scrolling
 * between them. When the shots overlap, the same delivery appears on both — and if the second shot
 * scrolled past the date header, its rows carry no clock at all, so none of the time-keyed matchers
 * elsewhere in this codebase can see the repeat. On 2026-08-25 that put five undated rows in front
 * of a manager with nothing to say that two of them were rows he had already counted.
 *
 * The list is ordered newest-first, so a re-scroll always produces the same shape: a maximal
 * SUFFIX of the earlier page equal to the PREFIX of the later one. That ordering — not the amounts
 * alone — is the evidence, which is why this looks for a contiguous run at the two ends rather than
 * for values that happen to appear twice.
 *
 * ADVISORY ONLY. This decides nothing. It emits cause codes for a human to read, and the manager
 * still records an attributed include/exclude decision. Nothing here may reach money.
 */

/** One row exactly as a reader saw it. `rowRef` is opaque — the caller's identity for the row. */
export interface ScannedPageRow {
  readonly rowRef: string
  /** Ascending down the screen. */
  readonly rowIndex: number
  /** Signed: a negative row is a cash deduction and never matches a positive order. */
  readonly amount: Minor | null
  readonly occurredDate: string | null
  readonly occurredMinute: string | null
  readonly pointA: string | null
  readonly pointB: string | null
}

/** One scanned image. `pageRef` is opaque and must be stable — ties are broken with it. */
export interface ScannedPage {
  readonly pageRef: string
  readonly rows: readonly ScannedPageRow[]
}

/**
 * Runtime lists, not bare unions, so the wire schema can be checked against them by a test.
 *
 * A cause the wire enum does not know makes the manager's review throw on parse — a 500 on the one
 * screen this feature exists to serve. That must be a failing test, not a production incident.
 */
export const SCAN_OVERLAP_CAUSES = [
  /** The printed date and minute identified the same operation on both pages. The strong one. */
  'scan_overlap_timed_match',
  /** No row carried a clock, so the pages were aligned end-to-start instead. */
  'scan_overlap_suffix_prefix',
  'scan_overlap_amount_only',
  'scan_overlap_direction_ambiguous',
  /**
   * The pages overlap, and a row inside the overlap was read with two DIFFERENT amounts.
   *
   * Its own cause because it is a different fact from every other one here: not «these pages share
   * rows», but «these pages disagree about what one row says», which is a reader error a manager
   * must settle before either number is counted.
   */
  'scan_overlap_amount_disagrees',
] as const

export const SCAN_OVERLAP_PAIR_CAUSES = [
  'scan_overlap_pair_amount_agrees',
  'scan_overlap_pair_minute_agrees',
  'scan_overlap_pair_route_agrees',
  /**
   * Same day, same printed clock, same full route — and two different amounts.
   *
   * The amount is the anchor of `rowsMayBeTheSameOperation`, and on 2026-09-01 the amount was the
   * one field a clipped capture corrupted: the top of a `٣` faded under a sticky header and read as
   * `٢`, so 330 became 230 while the clock and both address lines survived intact. The pair was
   * refused, both rows were counted, and the phantom raised `expectedTotal` by 0.8 × its fee —
   * which pulled a real 218.25 surplus down to 34.25 and made the shift look almost perfect.
   *
   * A HINT ONLY, and deliberately never an input to run length or page direction: two readings that
   * disagree about the money cannot be evidence of where two pages align. Decision 16 is untouched —
   * nothing merges on this, and the manager still chooses which row is the real delivery.
   */
  'scan_overlap_pair_amount_disagrees',
  /**
   * A row that falls INSIDE the established overlap window but paired with nothing.
   *
   * Once the alignment is known, every row in the shared span is claimed by the other page whether
   * or not the two readings agree. An unclaimed one is either a real row the other capture missed
   * or a reading too corrupted to pair — and the second is exactly the case that reaches settlement
   * as a duplicate. It is reported so a manager looks, never acted on.
   */
  'scan_overlap_pair_unaccounted',
] as const

export type ScanOverlapCause = (typeof SCAN_OVERLAP_CAUSES)[number]

export type ScanOverlapPairCause = (typeof SCAN_OVERLAP_PAIR_CAUSES)[number]

export interface ScanOverlapPair {
  readonly earlierRowRef: string
  readonly laterRowRef: string
  readonly causes: readonly ScanOverlapPairCause[]
}

export interface ScanPageOverlap {
  readonly earlierPageRef: string
  readonly laterPageRef: string
  readonly length: number
  readonly pairs: readonly ScanOverlapPair[]
  readonly causes: readonly ScanOverlapCause[]
}

/**
 * Route text as printed, compared without punctuation-level noise.
 *
 * Deliberately `toLowerCase`, not `toLocaleLowerCase`: this package is pure and must not read a
 * host locale. Arabic is caseless, so the fold only affects the Latin fragments Yallago mixes in.
 */
const normalizeText = (value: string): string =>
  value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()

type PairVerdict = { readonly matches: false } | { readonly matches: true; readonly causes: ScanOverlapPairCause[] }

const REFUTED: PairVerdict = { matches: false }

/**
 * Could these two rows be one operation seen twice?
 *
 * An amount must be present on both sides and equal — an unread amount corroborates nothing, so it
 * can never anchor a match. A clock or a route present on BOTH sides and differing REFUTES the
 * pair outright. A field missing on either side is neutral: it neither confirms nor denies.
 */
const rowsMayBeTheSameOperation = (earlier: ScannedPageRow, later: ScannedPageRow): PairVerdict => {
  if (earlier.amount === null || later.amount === null) return REFUTED
  if (earlier.amount !== later.amount) return REFUTED
  const causes: ScanOverlapPairCause[] = ['scan_overlap_pair_amount_agrees']

  const bothTimed =
    earlier.occurredDate !== null && earlier.occurredMinute !== null &&
    later.occurredDate !== null && later.occurredMinute !== null
  if (bothTimed) {
    if (earlier.occurredDate !== later.occurredDate || earlier.occurredMinute !== later.occurredMinute) return REFUTED
    causes.push('scan_overlap_pair_minute_agrees')
  }

  const bothRouted =
    earlier.pointA !== null && earlier.pointB !== null && later.pointA !== null && later.pointB !== null
  if (bothRouted) {
    const sameRoute =
      normalizeText(earlier.pointA) === normalizeText(later.pointA) &&
      normalizeText(earlier.pointB) === normalizeText(later.pointB)
    if (!sameRoute) return REFUTED
    causes.push('scan_overlap_pair_route_agrees')
  }

  return { matches: true, causes }
}

/**
 * Two readings of ONE row that disagree about the money.
 *
 * Everything the screen prints to identify a delivery agrees — the day, the printed clock, and both
 * address lines in full — and only the amount differs. That is not two deliveries; it is one row
 * read twice with one reading corrupted, and it is what a clipped or header-faded capture does.
 *
 * DELIBERATELY STRICT. The full route must be present and equal on both sides, not merely
 * compatible: a missing route is neutral for `rowsMayBeTheSameOperation` because the amount already
 * anchors that rule, but here the amount is the thing in doubt, so the route has to carry the whole
 * identity by itself. Two genuine deliveries would need the same minute AND the same pickup AND the
 * same dropoff while charging different fees. Measured against production rather than assumed: zero
 * occurrences across 59 shifts other than the misread this exists for.
 */
const rowsAreOneRowMisread = (earlier: ScannedPageRow, later: ScannedPageRow): PairVerdict => {
  if (earlier.amount === null || later.amount === null) return REFUTED
  if (earlier.amount === later.amount) return REFUTED

  if (earlier.occurredDate === null || later.occurredDate === null) return REFUTED
  if (earlier.occurredMinute === null || later.occurredMinute === null) return REFUTED
  if (earlier.occurredDate !== later.occurredDate) return REFUTED
  if (earlier.occurredMinute !== later.occurredMinute) return REFUTED

  if (earlier.pointA === null || earlier.pointB === null) return REFUTED
  if (later.pointA === null || later.pointB === null) return REFUTED
  if (normalizeText(earlier.pointA) !== normalizeText(later.pointA)) return REFUTED
  if (normalizeText(earlier.pointB) !== normalizeText(later.pointB)) return REFUTED

  return {
    matches: true,
    causes: [
      'scan_overlap_pair_amount_disagrees',
      'scan_overlap_pair_minute_agrees',
      'scan_overlap_pair_route_agrees',
    ],
  }
}

type Directed = { readonly length: number; readonly pairs: ScanOverlapPair[] }

/** A row the printed screen identifies on its own: an amount, a day and a minute. */
const isTimed = (row: ScannedPageRow): boolean =>
  row.amount !== null && row.occurredDate !== null && row.occurredMinute !== null

/**
 * Rows the two pages identify as the same operation by what is PRINTED on them.
 *
 * This is the primary rule, and it is the one the canonical merge already keys on — date, printed
 * clock and amount. It needs no assumption about how the two photos line up, which is what the
 * contiguous run below could not survive: on shift 7be4dbb5 the shared row sat directly behind a
 * row the screenshot had cut in half, and one unreadable row at the edge ended the search.
 *
 * Greedy and one-to-one: a page that legitimately shows the same amount at the same minute twice
 * must not have one of those rows answer for both.
 */
const timedMatches = (earlier: ScannedPage, later: ScannedPage): Directed => {
  const taken = new Set<string>()
  const pairs: ScanOverlapPair[] = []
  for (const left of earlier.rows) {
    if (!isTimed(left)) continue
    for (const right of later.rows) {
      if (taken.has(right.rowRef) || !isTimed(right)) continue
      if (left.occurredDate !== right.occurredDate || left.occurredMinute !== right.occurredMinute) continue
      const verdict = rowsMayBeTheSameOperation(left, right)
      if (!verdict.matches) continue
      taken.add(right.rowRef)
      pairs.push({ earlierRowRef: left.rowRef, laterRowRef: right.rowRef, causes: verdict.causes })
      break
    }
  }
  return { length: pairs.length, pairs }
}

/**
 * The single row offset every confirmed pair agrees on, or null.
 *
 * Two captures of one scrolling list are related by ONE shift: row `i` on the earlier page is row
 * `i + offset` on the later one. When every confirmed pair reports the same offset the alignment is
 * known, and every other row in the shared span can be checked against it. When they disagree the
 * pages are not a simple re-scroll — a retake, a filter change, a different day — and nothing is
 * inferred, because a wrong alignment would manufacture pairs out of unrelated rows.
 */
const sharedOffset = (
  earlier: ScannedPage,
  later: ScannedPage,
  pairs: readonly ScanOverlapPair[],
): number | null => {
  if (pairs.length === 0) return null
  const leftIndex = new Map(earlier.rows.map((row, index) => [row.rowRef, index]))
  const rightIndex = new Map(later.rows.map((row, index) => [row.rowRef, index]))
  let offset: number | null = null
  for (const pair of pairs) {
    const left = leftIndex.get(pair.earlierRowRef)
    const right = rightIndex.get(pair.laterRowRef)
    if (left === undefined || right === undefined) return null
    const candidate = right - left
    if (offset === null) offset = candidate
    else if (offset !== candidate) return null
  }
  return offset
}

/**
 * Every row the known alignment says the two pages SHARE, whether or not the readings agree.
 *
 * This is the guard that was missing on 2026-09-01. Both existing strategies stop at the rows they
 * can confirm: `timedMatches` returns the moment it has one pair and never reaches the run search,
 * and `suffixPrefixRun` abandons a whole run at its first mismatched position. So a single row the
 * capture corrupted — the top of a `٣` faded under a sticky header, read as `٢` — was
 * simply not in anybody's output, and both copies of one delivery reached settlement.
 *
 * Once the offset is known there is nothing left to infer. Any row inside the shared span belongs
 * to the other page by position alone, so it is reported: with the ordinary causes when the two
 * readings still agree, as `amount_disagrees` when only the money differs, and otherwise as
 * `unaccounted` — «the alignment says these are the same row and the readings do not match».
 *
 * ADVISORY, like everything else here. It adds rows a manager must look at; it never removes one,
 * never merges, and never touches `length`, which stays the count of CONFIRMED pairs so that every
 * existing caller ordering or tie-breaking on it behaves exactly as before.
 */
const accountForWindow = (
  earlier: ScannedPage,
  later: ScannedPage,
  confirmed: readonly ScanOverlapPair[],
  offset: number,
): ScanOverlapPair[] => {
  const claimed = new Set(confirmed.map((pair) => pair.earlierRowRef))
  const extra: ScanOverlapPair[] = []
  for (let left = 0; left < earlier.rows.length; left += 1) {
    const right = left + offset
    if (right < 0 || right >= later.rows.length) continue
    const leftRow = earlier.rows[left]!
    const rightRow = later.rows[right]!
    if (claimed.has(leftRow.rowRef)) continue
    // Both sides must carry an amount. This exists to catch a row COUNTED TWICE, and a row whose
    // amount no reader could make out is never counted once — it reaches the manager as a missing
    // value, not as money. Reporting those would bury the real signal under every half-cut row at
    // the edge of every capture, which is most of them.
    if (leftRow.amount === null || rightRow.amount === null) continue
    const same = rowsMayBeTheSameOperation(leftRow, rightRow)
    const misread = same.matches ? REFUTED : rowsAreOneRowMisread(leftRow, rightRow)
    const causes: readonly ScanOverlapPairCause[] = same.matches
      ? same.causes
      : misread.matches
        ? misread.causes
        : ['scan_overlap_pair_unaccounted']
    extra.push({ earlierRowRef: leftRow.rowRef, laterRowRef: rightRow.rowRef, causes })
  }
  return extra
}

/**
 * One row read twice with the money corrupted — used ONLY to find an alignment nothing else could.
 *
 * Tried last, and only when both ordinary strategies came back empty, so it can add hints where
 * there were none and can never change one that already exists. The pair it returns is not evidence
 * of page order either: `meanPosition` decides that, from where the rows sit.
 */
const misreadAnchors = (earlier: ScannedPage, later: ScannedPage): Directed => {
  const taken = new Set<string>()
  const pairs: ScanOverlapPair[] = []
  for (const left of earlier.rows) {
    for (const right of later.rows) {
      if (taken.has(right.rowRef)) continue
      const verdict = rowsAreOneRowMisread(left, right)
      if (!verdict.matches) continue
      taken.add(right.rowRef)
      pairs.push({ earlierRowRef: left.rowRef, laterRowRef: right.rowRef, causes: verdict.causes })
      break
    }
  }
  return { length: pairs.length, pairs }
}

/**
 * How far down its own page the matched rows sit, 0 at the top and 1 at the bottom.
 *
 * The list is newest-first, so the capture still showing newer orders ABOVE the shared rows is the
 * one taken first. Position is the only evidence of capture order — slot names and read timestamps
 * both pointed the wrong way on the shift that motivated this.
 */
const meanPosition = (page: ScannedPage, refs: readonly string[]): number => {
  if (page.rows.length <= 1 || refs.length === 0) return 0
  const wanted = new Set(refs)
  const positions = page.rows
    .map((row, index) => (wanted.has(row.rowRef) ? index / (page.rows.length - 1) : null))
    .filter((value): value is number => value !== null)
  if (positions.length === 0) return 0
  return positions.reduce((total, value) => total + value, 0) / positions.length
}

/** The longest run where `earlier` ends exactly where `later` begins. */
const suffixPrefixRun = (earlier: ScannedPage, later: ScannedPage): Directed => {
  const limit = Math.min(earlier.rows.length, later.rows.length)
  for (let length = limit; length >= 1; length -= 1) {
    const pairs: ScanOverlapPair[] = []
    let ok = true
    for (let offset = 0; offset < length; offset += 1) {
      const left = earlier.rows[earlier.rows.length - length + offset]!
      const right = later.rows[offset]!
      const verdict = rowsMayBeTheSameOperation(left, right)
      if (!verdict.matches) { ok = false; break }
      pairs.push({ earlierRowRef: left.rowRef, laterRowRef: right.rowRef, causes: verdict.causes })
    }
    if (ok) return { length, pairs }
  }
  return { length: 0, pairs: [] }
}

/**
 * The overlap between two scanned pages, or null when they share no end-to-end run.
 *
 * Both directions are tried and the longer wins. Slot names and read timestamps are deliberately
 * NOT consulted: on the shift that motivated this, the slot called `dashboard_2` held the EARLIER
 * page and was read first, so either signal would have been backwards.
 */
export function detectScannedPageOverlap(a: ScannedPage, b: ScannedPage): ScanPageOverlap | null {
  if (a.pageRef === b.pageRef) return null

  // What the pages PRINT about themselves comes first. Only when no row on either page carries a
  // clock — the shift-4f40640e case, where the date header had scrolled out of the capture — is
  // there nothing to match on but the order of the rows.
  const timed = timedMatches(a, b)
  if (timed.length > 0) {
    const aPos = meanPosition(a, timed.pairs.map((pair) => pair.earlierRowRef))
    const bPos = meanPosition(b, timed.pairs.map((pair) => pair.laterRowRef))
    const tied = aPos === bPos
    const aIsEarlier = tied ? a.pageRef <= b.pageRef : aPos > bPos
    const causes: ScanOverlapCause[] = ['scan_overlap_timed_match']
    // Derived from the CONFIRMED pairs only, and computed before the window is swept: the window
    // adds pairs carrying a route or a minute, and letting those count here would silently retire
    // the «matched on the amount alone» warning on hints that are exactly as weak as before.
    if (!timed.pairs.some((pair) => pair.causes.length > 1)) causes.push('scan_overlap_amount_only')
    if (tied) causes.push('scan_overlap_direction_ambiguous')
    return finish(a, b, aIsEarlier, timed, causes)
  }

  const forward = suffixPrefixRun(a, b)
  const backward = suffixPrefixRun(b, a)
  if (forward.length > 0 || backward.length > 0) {
    const ambiguous = forward.length === backward.length && forward.length > 0
    // On a tie the page order is genuinely unknown, so say so and break it on the opaque refs. The
    // alternative — picking by argument order — would make the same two pages answer differently
    // depending on how the caller happened to iterate them.
    const forwardWins = ambiguous ? a.pageRef <= b.pageRef : forward.length > backward.length
    const chosen = forwardWins ? forward : backward
    const causes: ScanOverlapCause[] = ['scan_overlap_suffix_prefix']
    if (!chosen.pairs.some((pair) => pair.causes.length > 1)) causes.push('scan_overlap_amount_only')
    if (ambiguous) causes.push('scan_overlap_direction_ambiguous')
    // `suffixPrefixRun` already reports its pairs in (earlier, later) order for the direction it
    // won, so the window is swept in that same direction and nothing is flipped again.
    return forwardWins
      ? finish(a, b, true, chosen, causes)
      : finish(b, a, true, chosen, causes)
  }

  // LAST, and only when nothing else found anything, so this can add hints where there were none
  // and can never alter one that already exists. This is the 2026-09-01 case: the only shared row
  // either page could be identified by had its amount corrupted, so both strategies above returned
  // empty and two copies of one delivery went to settlement uncontested.
  const misreadForward = misreadAnchors(a, b)
  const misreadBackward = misreadAnchors(b, a)
  if (misreadForward.length === 0 && misreadBackward.length === 0) return null

  const misTied = misreadForward.length === misreadBackward.length
  const misForwardWins = misTied ? a.pageRef <= b.pageRef : misreadForward.length > misreadBackward.length
  const misChosen = misForwardWins ? misreadForward : misreadBackward
  const [misEarlier, misLater] = misForwardWins ? [a, b] : [b, a]
  const misPos = meanPosition(misEarlier, misChosen.pairs.map((pair) => pair.earlierRowRef))
  const misOther = meanPosition(misLater, misChosen.pairs.map((pair) => pair.laterRowRef))
  const misCauses: ScanOverlapCause[] = ['scan_overlap_amount_disagrees']
  if (misPos === misOther) misCauses.push('scan_overlap_direction_ambiguous')
  return finish(misEarlier, misLater, misPos >= misOther, misChosen, misCauses)
}

/**
 * Orient the result, sweep the shared window, and say what the sweep found.
 *
 * Every exit above funnels through here so the window is accounted for exactly once, in exactly one
 * place. `length` stays the count of CONFIRMED pairs — callers order and tie-break on it, and a
 * number that grew because a corrupted row was reported would change which hint a manager sees
 * first for reasons that have nothing to do with how much the pages actually share.
 */
const finish = (
  a: ScannedPage,
  b: ScannedPage,
  aIsEarlier: boolean,
  confirmed: Directed,
  causes: ScanOverlapCause[],
): ScanPageOverlap => {
  const earlier = aIsEarlier ? a : b
  const later = aIsEarlier ? b : a
  const pairs = aIsEarlier
    ? confirmed.pairs
    : confirmed.pairs.map((pair) => ({ ...pair, earlierRowRef: pair.laterRowRef, laterRowRef: pair.earlierRowRef }))

  const offset = sharedOffset(earlier, later, pairs)
  const extra = offset === null ? [] : accountForWindow(earlier, later, pairs, offset)
  const all = [...pairs, ...extra]
  if (
    extra.some((pair) => pair.causes.includes('scan_overlap_pair_amount_disagrees')) &&
    !causes.includes('scan_overlap_amount_disagrees')
  ) {
    causes.push('scan_overlap_amount_disagrees')
  }

  return {
    earlierPageRef: earlier.pageRef,
    laterPageRef: later.pageRef,
    length: confirmed.length,
    pairs: all,
    causes,
  }
}

/**
 * Every overlapping page pair, longest overlap first.
 *
 * Ordered deterministically — length, then the two refs — so a caller rendering the top hint always
 * renders the same one.
 */
export function detectScannedPageOverlaps(pages: readonly ScannedPage[]): readonly ScanPageOverlap[] {
  const found: ScanPageOverlap[] = []
  for (let i = 0; i < pages.length; i += 1) {
    for (let j = i + 1; j < pages.length; j += 1) {
      const overlap = detectScannedPageOverlap(pages[i]!, pages[j]!)
      if (overlap !== null) found.push(overlap)
    }
  }
  return found.sort((left, right) =>
    right.length - left.length ||
    (left.earlierPageRef < right.earlierPageRef ? -1 : left.earlierPageRef > right.earlierPageRef ? 1 : 0) ||
    (left.laterPageRef < right.laterPageRef ? -1 : left.laterPageRef > right.laterPageRef ? 1 : 0))
}
