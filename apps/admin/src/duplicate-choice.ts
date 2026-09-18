/**
 * «أيّ الصفّين هو التوصيلة الحقيقية؟» — the two operations a duplicate hint is about, side by side,
 * and the one audited revision that acts on the answer.
 *
 * Today a hint names a POSITION: «يطابق الصف ٣ في صفحة ١». A manager cannot decide which of two
 * readings is the real delivery without seeing both, and this is exactly what August produced —
 * shift `d0a5a7ec` carried 21 rows for 10 deliveries, and Haidar's 205.00 was counted twice because
 * nobody saw the two copies together. Worse, «تثبيت كتكرار» only ever acts on the row being
 * displayed: when the DISPLAYED row is the good one and the other is the copy, the manager has to
 * find the other row in the list and act there — which is not what happens.
 *
 * Pure by design and free of `Review` types, the way `duplicate-hints.ts` and `operation-window.ts`
 * are: the screen supplies rows through `lookup`, this decides what is comparable and what one
 * click should post.
 *
 * ADVISORY, still. Nothing here excludes or includes anything; `duplicateChoiceRevision` builds the
 * same audited body the existing button builds, with the same mandatory reason, aimed at whichever
 * side the manager did not choose.
 */
import type { ScanDuplicateHintOperationRef, ScanOverlapPairCause } from './duplicate-hints.ts'

export type DuplicateChoiceTarget =
  | { kind: 'order'; providerOrderNo: string }
  | { kind: 'cash_deduction'; id: string }

/** One money row, as much of it as a comparison needs. */
export interface DuplicateChoiceRow {
  amount: string
  occurredMinute: string | null
  occurredDate: string | null
  included: boolean
  evidenceSlot?: string | null | undefined
  evidenceMediaId?: string | null | undefined
  positionEvidence?:
    | { yTop?: number | null; yBottom?: number | null; rowIndex?: number }
    | null
    | undefined
  hasScanOrigin: boolean
}

export interface DuplicateChoiceSide {
  /** Radio value and revise address in one. */
  key: string
  target: DuplicateChoiceTarget
  row: DuplicateChoiceRow
  /** The page this side was read from, per the hint — the label under its thumbnail. */
  slot: string
  /** 0-based row ordinal on that page. Rendered +1, because managers count from one. */
  rowIndex: number
}

/** What the two sides disagree about — derived from the rows themselves, never from the hint. */
export type DuplicateChoiceDifference = 'amount' | 'minute' | 'date' | 'inclusion'

export interface DuplicateChoiceView {
  self: DuplicateChoiceSide
  counterpart: DuplicateChoiceSide
  agreements: ScanOverlapPairCause[]
  differences: DuplicateChoiceDifference[]
  /**
   * The side carrying a printed clock, when exactly one does.
   *
   * Decision 16 makes the printed time part of an order's identity, so this is the natural
   * candidate to keep — but it is a FACT READ OFF THE TABLE, not a verdict, and deliberately not a
   * pre-selected radio. A pre-checked default beside a save button means one click excludes a real
   * delivery; the manager picks, and this only tells him what distinguishes the two.
   */
  timedKey: string | null
  /**
   * The two readings are almost certainly ONE row, and one of them got the money wrong.
   *
   * True when the only thing that differs is the amount, while the printed clock and the whole
   * route agree. That is not a judgement about which figure is right — it is the shape of a capture
   * clipped or faded at a page seam, which is how 330 was read as 230 on 2026-09-01 and both copies
   * reached settlement. The panel says so plainly, because «two rows for one delivery» and «two
   * deliveries a minute apart» call for completely different reading of the same screen.
   */
  likelyOneRowMisread: boolean
}

export const duplicateChoiceKey = (target: DuplicateChoiceTarget): string =>
  target.kind === 'order' ? `order:${target.providerOrderNo}` : `cash_deduction:${target.id}`

const targetOf = (ref: ScanDuplicateHintOperationRef): DuplicateChoiceTarget | null => {
  if (ref.kind === 'order') return { kind: 'order', providerOrderNo: ref.providerOrderNo }
  if (ref.kind === 'cash_deduction') return { kind: 'cash_deduction', id: ref.id }
  return null
}

/**
 * Build the comparison, or refuse it.
 *
 * `null` means there is nothing to choose BETWEEN — the other sighting never became an operation
 * (`unmatched_row`), or the row it names is not in this snapshot. The card falls back to the
 * position-only note rather than inventing a second column, because a phantom counterpart is a
 * worse answer than the plain hint.
 */
export function duplicateChoiceView(input: {
  self: { target: DuplicateChoiceTarget; row: DuplicateChoiceRow; slot: string; rowIndex: number }
  hint: {
    counterpart: ScanDuplicateHintOperationRef
    counterpartSlot: string
    counterpartRowIndex: number
    causes: ScanOverlapPairCause[]
  }
  lookup(target: DuplicateChoiceTarget): DuplicateChoiceRow | null
}): DuplicateChoiceView | null {
  const target = targetOf(input.hint.counterpart)
  if (!target) return null
  const row = input.lookup(target)
  if (!row) return null

  const self: DuplicateChoiceSide = {
    key: duplicateChoiceKey(input.self.target),
    target: input.self.target,
    row: input.self.row,
    slot: input.self.slot,
    rowIndex: input.self.rowIndex,
  }
  const counterpart: DuplicateChoiceSide = {
    key: duplicateChoiceKey(target),
    target,
    row,
    slot: input.hint.counterpartSlot,
    rowIndex: input.hint.counterpartRowIndex,
  }
  // A row is never its own duplicate. A hint that says so is a bug upstream, not a choice to offer.
  if (self.key === counterpart.key) return null

  const differences: DuplicateChoiceDifference[] = []
  if (self.row.amount !== counterpart.row.amount) differences.push('amount')
  if (self.row.occurredMinute !== counterpart.row.occurredMinute) differences.push('minute')
  if (self.row.occurredDate !== counterpart.row.occurredDate) differences.push('date')
  if (self.row.included !== counterpart.row.included) differences.push('inclusion')

  const timed = (side: DuplicateChoiceSide): boolean =>
    side.row.occurredMinute !== null && side.row.occurredMinute !== ''

  // A DISagreement is not an agreement. `scan_overlap_pair_amount_disagrees` travels in the same
  // `causes` array because the wire has one field for both, but rendering it under «they agree on»
  // would state the opposite of the fact. `differences` already carries `'amount'`, derived from
  // the rows themselves, so nothing is lost by dropping it here.
  const agreements = input.hint.causes.filter(
    (cause) => cause !== 'scan_overlap_pair_amount_disagrees' && cause !== 'scan_overlap_pair_unaccounted',
  )
  const amountOnly = differences.length === 1 && differences[0] === 'amount'

  return {
    self,
    counterpart,
    agreements,
    differences,
    likelyOneRowMisread:
      amountOnly &&
      agreements.includes('scan_overlap_pair_minute_agrees') &&
      agreements.includes('scan_overlap_pair_route_agrees'),
    timedKey:
      timed(self) === timed(counterpart) ? null : timed(self) ? self.key : counterpart.key,
  }
}

export interface DuplicateChoiceRevision {
  orders: Array<{ providerOrderNo: string; included: boolean; reason: string }>
  cashDeductions: Array<{ id: string; included: boolean; reason: string }>
}

/**
 * One click, two outcomes, both audited: the chosen row stays, the other is excluded.
 *
 * Only rows that actually CHANGE are posted. Re-asserting a value a row already holds would still
 * rotate `orders_hash` and force a full re-review for nothing — the same reason `FeeCell` refuses to
 * save an unchanged draft. When neither side changes, this returns `null` and the button has
 * nothing to do.
 *
 * The excluded row is not deleted: it keeps its reason and stays in the record, which is why the
 * decision is reversible and why a manager should not hesitate over it.
 */
export function duplicateChoiceRevision(
  view: DuplicateChoiceView,
  keepKey: string,
  reason: string,
): DuplicateChoiceRevision | null {
  const keep = [view.self, view.counterpart].find((side) => side.key === keepKey)
  const drop = [view.self, view.counterpart].find((side) => side.key !== keepKey)
  if (!keep || !drop) return null

  const revision: DuplicateChoiceRevision = { orders: [], cashDeductions: [] }
  const add = (side: DuplicateChoiceSide, included: boolean): void => {
    if (side.row.included === included) return
    if (side.target.kind === 'order') {
      revision.orders.push({ providerOrderNo: side.target.providerOrderNo, included, reason })
    } else {
      revision.cashDeductions.push({ id: side.target.id, included, reason })
    }
  }
  add(keep, true)
  add(drop, false)
  if (revision.orders.length === 0 && revision.cashDeductions.length === 0) return null
  return revision
}
