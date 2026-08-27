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
] as const

export const SCAN_OVERLAP_PAIR_CAUSES = [
  'scan_overlap_pair_amount_agrees',
  'scan_overlap_pair_minute_agrees',
  'scan_overlap_pair_route_agrees',
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
    if (!timed.pairs.some((pair) => pair.causes.length > 1)) causes.push('scan_overlap_amount_only')
    if (tied) causes.push('scan_overlap_direction_ambiguous')
    return {
      earlierPageRef: aIsEarlier ? a.pageRef : b.pageRef,
      laterPageRef: aIsEarlier ? b.pageRef : a.pageRef,
      length: timed.length,
      pairs: aIsEarlier
        ? timed.pairs
        : timed.pairs.map((pair) => ({ ...pair, earlierRowRef: pair.laterRowRef, laterRowRef: pair.earlierRowRef })),
      causes,
    }
  }

  const forward = suffixPrefixRun(a, b)
  const backward = suffixPrefixRun(b, a)
  if (forward.length === 0 && backward.length === 0) return null

  const ambiguous = forward.length === backward.length && forward.length > 0
  // On a tie the page order is genuinely unknown, so say so and break it on the opaque refs. The
  // alternative — picking by argument order — would make the same two pages answer differently
  // depending on how the caller happened to iterate them.
  const forwardWins = ambiguous ? a.pageRef <= b.pageRef : forward.length > backward.length
  const chosen = forwardWins ? forward : backward
  const earlierPageRef = forwardWins ? a.pageRef : b.pageRef
  const laterPageRef = forwardWins ? b.pageRef : a.pageRef

  const causes: ScanOverlapCause[] = ['scan_overlap_suffix_prefix']
  const corroborated = chosen.pairs.some((pair) => pair.causes.length > 1)
  if (!corroborated) causes.push('scan_overlap_amount_only')
  if (ambiguous) causes.push('scan_overlap_direction_ambiguous')

  return { earlierPageRef, laterPageRef, length: chosen.length, pairs: chosen.pairs, causes }
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
