/**
 * The wire shape, mirrored locally.
 *
 * The admin bundle depends on `@ash/client` and `@ash/domain` only, never on the server contracts —
 * the same reason `operation-window.ts` restates `OperationWindowStatus` instead of importing it.
 */
export type ScanOverlapCause =
  | 'scan_overlap_suffix_prefix'
  | 'scan_overlap_amount_only'
  | 'scan_overlap_direction_ambiguous'

export type ScanOverlapPairCause =
  | 'scan_overlap_pair_amount_agrees'
  | 'scan_overlap_pair_minute_agrees'
  | 'scan_overlap_pair_route_agrees'

export type ScanDuplicateHintOperationRef =
  | { kind: 'order'; providerOrderNo: string; observationId: string; rowIndex: number }
  | { kind: 'cash_deduction'; id: string; observationId: string; rowIndex: number }
  | { kind: 'unmatched_row'; observationId: string; rowIndex: number }

export interface ScanDuplicateHintWire {
  earlier: { slot: string; mediaId: string }
  later: { slot: string; mediaId: string }
  length: number
  causes: ScanOverlapCause[]
  pairs: Array<{
    earlier: ScanDuplicateHintOperationRef
    later: ScanDuplicateHintOperationRef
    causes: ScanOverlapPairCause[]
  }>
}

/**
 * Resolve a server duplicate hint down to the one row a card should show.
 *
 * The server reports the overlap between two pages; a card shows one operation. This picks out the
 * pairs that touch that operation and names its counterpart, so the manager reads
 * «يطابق الصف N في <page>» instead of being handed a page-level fact he has to apply himself.
 *
 * Advisory only. Nothing here excludes, includes, or changes an amount — acting on a hint is still
 * the existing audited «تثبيت كتكرار» button with its required reason.
 */

export interface ResolvedDuplicateHint {
  /** The page the counterpart row was scanned from. */
  counterpartSlot: string
  /** 0-based row index of the counterpart on its own page. */
  counterpartRowIndex: number
  /** What the counterpart became, when it became anything. */
  counterpart: ScanDuplicateHintOperationRef
  /** True when this operation is the LATER sighting — the one a manager would normally exclude. */
  isLaterSighting: boolean
  causes: ScanOverlapPairCause[]
  pageCauses: ScanOverlapCause[]
}

type Side = 'earlier' | 'later'

const matches = (
  ref: ScanDuplicateHintOperationRef,
  target: { kind: 'order'; providerOrderNo: string } | { kind: 'cash_deduction'; id: string },
): boolean => {
  if (ref.kind === 'order' && target.kind === 'order') return ref.providerOrderNo === target.providerOrderNo
  if (ref.kind === 'cash_deduction' && target.kind === 'cash_deduction') return ref.id === target.id
  return false
}

const resolve = (
  hints: readonly ScanDuplicateHintWire[] | undefined,
  target: { kind: 'order'; providerOrderNo: string } | { kind: 'cash_deduction'; id: string },
): ResolvedDuplicateHint[] => {
  // An older API has no such field. Render nothing rather than break the review screen — the same
  // staggered-rollout tolerance `operation-window.ts` applies to windowStatus.
  if (!hints) return []
  const found: ResolvedDuplicateHint[] = []
  for (const hint of hints) {
    for (const pair of hint.pairs) {
      const sides: Side[] = ['earlier', 'later']
      for (const side of sides) {
        if (!matches(pair[side], target)) continue
        const other: Side = side === 'earlier' ? 'later' : 'earlier'
        found.push({
          counterpartSlot: other === 'earlier' ? hint.earlier.slot : hint.later.slot,
          counterpartRowIndex: pair[other].rowIndex,
          counterpart: pair[other],
          isLaterSighting: side === 'later',
          causes: pair.causes,
          pageCauses: hint.causes,
        })
      }
    }
  }
  return found
}

export const duplicateHintsForOrder = (
  hints: readonly ScanDuplicateHintWire[] | undefined,
  providerOrderNo: string,
): ResolvedDuplicateHint[] => resolve(hints, { kind: 'order', providerOrderNo })

export const duplicateHintsForDeduction = (
  hints: readonly ScanDuplicateHintWire[] | undefined,
  id: string,
): ResolvedDuplicateHint[] => resolve(hints, { kind: 'cash_deduction', id })
