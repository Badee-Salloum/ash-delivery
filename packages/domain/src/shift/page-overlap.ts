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

export type ScanOverlapCause =
  | 'scan_overlap_suffix_prefix'
  | 'scan_overlap_amount_only'
  | 'scan_overlap_direction_ambiguous'

export type ScanOverlapPairCause =
  | 'scan_overlap_pair_amount_agrees'
  | 'scan_overlap_pair_minute_agrees'
  | 'scan_overlap_pair_route_agrees'

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
