import type { CloseDraftObservationRecord, Deps, OcrRow } from '@ash/contracts'
import {
  type ScanOverlapCause,
  type ScanOverlapPairCause,
  type ScannedPage,
  type ScannedPageRow,
  detectScannedPageOverlaps,
  parseMinor,
} from '@ash/domain'
import { closeDraftClientKeyFor } from './close-draft.service.ts'

/**
 * Advisory duplicate detection for the manager's review screen.
 *
 * A driver scrolling the Recent Orders list often photographs it more than once, and the shots
 * overlap. When the later shot scrolled past its date header, none of its rows carry a clock, so
 * every time-keyed matcher in this codebase is blind to the repeat and the rows land in front of a
 * manager as undated `unknown` operations with nothing to say two of them were already counted.
 *
 * This service READS ONLY. It writes no order, no deduction, no audit row, and it never changes
 * whether an operation is included. Decision 11 requires an attributed manager decision, and this
 * exists to inform that decision, not to pre-empt it.
 */

/** Which operation a scanned row became, if any. */
export type ScanDuplicateHintOperationRef =
  | { kind: 'order'; providerOrderNo: string; observationId: string; rowIndex: number }
  | { kind: 'cash_deduction'; id: string; observationId: string; rowIndex: number }
  | { kind: 'unmatched_row'; observationId: string; rowIndex: number }

export interface ScanDuplicateHintPair {
  earlier: ScanDuplicateHintOperationRef
  later: ScanDuplicateHintOperationRef
  causes: ScanOverlapPairCause[]
}

export interface ScanDuplicateHint {
  earlier: { slot: string; mediaId: string }
  later: { slot: string; mediaId: string }
  length: number
  causes: ScanOverlapCause[]
  pairs: ScanDuplicateHintPair[]
}

const PAGE_SEPARATOR = '|'

const pageRefFor = (mediaId: string, attachmentToken: string): string =>
  `${mediaId}${PAGE_SEPARATOR}${attachmentToken}`

/** OCR text that is not parseable money is evidence of nothing and must never anchor a match. */
const amountOf = (row: OcrRow): ScannedPageRow['amount'] => {
  if (row.value === null || row.value === undefined) return null
  try {
    return parseMinor(row.value)
  } catch {
    return null
  }
}

/**
 * One page per attachment generation, keeping only its newest read.
 *
 * Before migration 0045 an attachment could be read twice, writing two full sets of observations
 * for one image. Left alone, such a page overlaps ITSELF perfectly and would produce a hint saying
 * every row is a duplicate of itself. Production already holds exactly that data, so this is not a
 * hypothetical — it is what makes the feature correct on the shift that motivated it.
 */
const pagesFrom = (observations: readonly CloseDraftObservationRecord[]): ScannedPage[] => {
  const newestRead = new Map<string, { readId: string; createdAtMs: number }>()
  for (const observation of observations) {
    const pageRef = pageRefFor(observation.mediaId, observation.attachmentToken)
    const current = newestRead.get(pageRef)
    const better = current === undefined ||
      observation.createdAtMs > current.createdAtMs ||
      (observation.createdAtMs === current.createdAtMs && observation.readId > current.readId)
    if (better) newestRead.set(pageRef, { readId: observation.readId, createdAtMs: observation.createdAtMs })
  }

  const byPage = new Map<string, ScannedPageRow[]>()
  for (const observation of observations) {
    const pageRef = pageRefFor(observation.mediaId, observation.attachmentToken)
    if (newestRead.get(pageRef)?.readId !== observation.readId) continue
    const rows = byPage.get(pageRef) ?? []
    rows.push({
      rowRef: observation.id,
      rowIndex: observation.rowIndex,
      amount: amountOf(observation.row),
      occurredDate: observation.row.dateIso ?? null,
      occurredMinute: observation.row.time ?? null,
      pointA: observation.row.pointA ?? null,
      pointB: observation.row.pointB ?? null,
    })
    byPage.set(pageRef, rows)
  }

  return [...byPage.entries()]
    .map(([pageRef, rows]) => ({ pageRef, rows: rows.sort((a, b) => a.rowIndex - b.rowIndex) }))
    .sort((a, b) => (a.pageRef < b.pageRef ? -1 : a.pageRef > b.pageRef ? 1 : 0))
}

/** Which stored screenshot a money row was read from, and where on it. */
export interface RowEvidenceSource {
  slot: string
  mediaId: string
}

export interface ShiftEvidenceSources {
  orders: Map<string, RowEvidenceSource>
  deductions: Map<string, RowEvidenceSource>
}

/**
 * Resolve every scanned row back to the page it came from.
 *
 * The link has always existed — an observation records `{mediaId, attachmentToken, slot}` and each
 * row carries `observationId` — it simply never reached the client, so the approval screen could
 * only offer a manager the whole end package and let him find the right page himself. With two
 * dashboard pages that is also a way to re-read the WRONG one.
 *
 * Resolved through the SAME two keys `buildScanDuplicateHints` uses, in the same order, so the
 * thumbnail on a row and the duplicate hint about it can never point at different pages: the
 * client key first, the observation id as the pre-0034 fallback.
 */
export async function evidenceSourcesForShift(deps: Deps, shiftId: string): Promise<ShiftEvidenceSources> {
  const empty: ShiftEvidenceSources = { orders: new Map(), deductions: new Map() }
  const observations = await deps.closeDrafts.listObservationsByShift(shiftId)
  if (observations.length === 0) return empty

  const [orders, deductions] = await Promise.all([
    deps.orders.listByShift(shiftId),
    deps.cashDeductions.listByShift(shiftId),
  ])

  const byClientKey = new Map<string, CloseDraftObservationRecord>()
  const byId = new Map<string, CloseDraftObservationRecord>()
  for (const observation of observations) {
    byId.set(observation.id, observation)
    byClientKey.set(
      closeDraftClientKeyFor(observation.field, observation.attachmentToken, observation.rowIndex),
      observation,
    )
  }

  const sourceFor = (
    field: 'orders' | 'cash_deductions',
    clientKey: string | null | undefined,
    observationId: string | null | undefined,
  ): RowEvidenceSource | null => {
    const observation =
      (clientKey ? byClientKey.get(clientKey) : undefined) ??
      (observationId ? byId.get(observationId) : undefined)
    // A row typed by hand has no observation at all, and must stay without a page rather than
    // borrow one: showing a manager the wrong screenshot is worse than showing him none.
    if (!observation || observation.field !== field) return null
    return { slot: observation.slot, mediaId: observation.mediaId }
  }

  const result: ShiftEvidenceSources = { orders: new Map(), deductions: new Map() }
  for (const order of orders) {
    const source = sourceFor('orders', order.closeDraftClientKey, order.observationId)
    if (source) result.orders.set(order.providerOrderNo, source)
  }
  for (const deduction of deductions) {
    const source = sourceFor('cash_deductions', deduction.closeDraftClientKey, deduction.observationId)
    if (source) result.deductions.set(deduction.id, source)
  }
  return result
}

export async function buildScanDuplicateHints(deps: Deps, shiftId: string): Promise<ScanDuplicateHint[]> {
  const all = await deps.closeDrafts.listObservationsByShift(shiftId)
  const observations = all.filter((observation) => observation.field === 'orders')
  if (observations.length === 0) return []

  const pages = pagesFrom(observations)
  const overlaps = detectScannedPageOverlaps(pages)
  if (overlaps.length === 0) return []

  const [orders, deductions] = await Promise.all([
    deps.orders.listByShift(shiftId),
    deps.cashDeductions.listByShift(shiftId),
  ])
  const byId = new Map<string, CloseDraftObservationRecord>(
    observations.map((observation) => [observation.id, observation] as const),
  )

  // Resolve through the SAME key the linked reader wrote, so the two can never drift apart. The
  // observation id is the older identity and stays as a fallback for pre-0034 rows.
  const orderByClientKey = new Map<string, string>()
  const orderByObservation = new Map<string, string>()
  for (const order of orders) {
    if (order.closeDraftClientKey) orderByClientKey.set(order.closeDraftClientKey, order.providerOrderNo)
    if (order.observationId) orderByObservation.set(order.observationId, order.providerOrderNo)
  }
  const deductionByClientKey = new Map<string, string>()
  const deductionByObservation = new Map<string, string>()
  for (const deduction of deductions) {
    if (deduction.closeDraftClientKey) deductionByClientKey.set(deduction.closeDraftClientKey, deduction.id)
    if (deduction.observationId) deductionByObservation.set(deduction.observationId, deduction.id)
  }

  const refFor = (rowRef: string): ScanDuplicateHintOperationRef => {
    const observation = byId.get(rowRef)
    if (!observation) return { kind: 'unmatched_row', observationId: rowRef, rowIndex: -1 }
    const base = { observationId: observation.id, rowIndex: observation.rowIndex }
    const clientKey = closeDraftClientKeyFor('orders', observation.attachmentToken, observation.rowIndex)
    const providerOrderNo = orderByClientKey.get(clientKey) ?? orderByObservation.get(observation.id)
    if (providerOrderNo !== undefined) return { kind: 'order', providerOrderNo, ...base }
    const deductionId = deductionByClientKey.get(clientKey) ?? deductionByObservation.get(observation.id)
    if (deductionId !== undefined) return { kind: 'cash_deduction', id: deductionId, ...base }
    // A cancelled row produces an observation and no operation. Naming it is still useful: it tells
    // the manager the overlap is real even where it did not become something he can act on.
    return { kind: 'unmatched_row', ...base }
  }

  const slotOf = (pageRef: string): { slot: string; mediaId: string } => {
    const match = observations.find(
      (observation) => pageRefFor(observation.mediaId, observation.attachmentToken) === pageRef,
    )
    return { slot: match?.slot ?? '', mediaId: match?.mediaId ?? pageRef.split(PAGE_SEPARATOR)[0]! }
  }

  return overlaps.map((overlap) => ({
    earlier: slotOf(overlap.earlierPageRef),
    later: slotOf(overlap.laterPageRef),
    length: overlap.length,
    causes: [...overlap.causes],
    pairs: overlap.pairs.map((pair) => ({
      earlier: refFor(pair.earlierRowRef),
      later: refFor(pair.laterRowRef),
      causes: [...pair.causes],
    })),
  }))
}
