import type {
  CloseDraftPatch,
  CloseDraftView,
  CloseDraftWindowBasis,
} from './api.ts'
import {
  type SupersedableRow,
  formatMinor,
  isSupersededScanRow,
  parseMinor,
} from '@ash/domain'
import type { DraftCashDeduction, DraftMovement, DraftOrder } from './order-entry.ts'

export type OperationDecisionState = 'included' | 'pending' | 'excluded'

export interface OperationSummaryGroup {
  total: number
  included: number
  pending: number
  excluded: number
  missingAmount: number
}

export interface CloseOperationsSummary {
  orders: OperationSummaryGroup
  cashDeductions: OperationSummaryGroup
  pendingTotal: number
  missingAmountTotal: number
}

export function operationDecisionState(row: {
  included?: boolean | undefined
  timeReviewRequired?: boolean | undefined
}): OperationDecisionState {
  if (row.timeReviewRequired === true) return 'pending'
  return row.included === false ? 'excluded' : 'included'
}

/**
 * The driver's view of the domain rule.
 *
 * The decision itself lives in `@ash/domain` (`isSupersededScanRow`) and is shared with the
 * server's close-draft materialisation, because this exact rule has drifted between server and
 * driver three times in this codebase already. This only adapts the driver's row shape to it.
 */
const printedSupersedable = (row: DraftOrder | DraftCashDeduction): SupersedableRow => {
  // The driver's identity is what is PRINTED, because a retake gives the same delivery a new
  // providerOrderNo — it is synthesised from a page-scoped clientKey.
  const date = row.dateText?.trim() ?? ''
  const minute = row.timeText?.trim() ?? ''
  const money = (('feeText' in row ? row.feeText : row.amountText) ?? '').trim()
  return {
    identity: date === '' || minute === '' || money === '' ? null : `${date}|${minute}|${money}`,
    included: row.included !== false,
    sightingCount: row.sightings?.length ?? 0,
  }
}

const sameMoney = (left: string | null | undefined, right: string | null | undefined): boolean => {
  const a = (left ?? '').trim()
  const b = (right ?? '').trim()
  if (a === '' || b === '') return a === b
  try {
    return parseMinor(a) === parseMinor(b)
  } catch {
    return a === b
  }
}

/**
 * A very narrow compatibility rule for the exact recovery artifact emitted by old clients.
 * Provider number alone is not identity: two legitimate rows may share it while differing in a
 * corrected amount, payment mode, date or time. Cash deductions never used this recovery shape.
 */
const isAlreadyRecoveryShadow = (row: DraftOrder, siblings: readonly DraftOrder[]): boolean => {
  const providerOrderNo = row.providerOrderNo.trim()
  const key = row.clientKey ?? row.localId
  if (
    providerOrderNo === '' ||
    row.draftSource !== 'manual' ||
    key !== `already-${providerOrderNo}`
  ) return false
  return siblings.some((candidate) =>
    candidate !== row &&
    candidate.draftSource !== undefined &&
    candidate.draftSource !== 'manual' &&
    candidate.providerOrderNo.trim() === providerOrderNo &&
    candidate.payMode === row.payMode &&
    sameMoney(candidate.feeText, row.feeText) &&
    (candidate.dateText ?? '').trim() === (row.dateText ?? '').trim() &&
    (candidate.timeText ?? '').trim() === (row.timeText ?? '').trim(),
  )
}

const supersededBy = <T extends DraftOrder | DraftCashDeduction>(
  row: T,
  siblings: readonly T[],
  shape: (candidate: T) => SupersedableRow,
): boolean => {
  const existingIndex = siblings.indexOf(row)
  const rows = existingIndex === -1 ? [...siblings, row] : siblings
  const index = existingIndex === -1 ? rows.length - 1 : existingIndex
  const shapes = rows.map(shape)
  return isSupersededScanRow(shapes[index]!, shapes)
}

const withoutBy = <T extends DraftOrder | DraftCashDeduction>(
  rows: readonly T[],
  shape: (candidate: T) => SupersedableRow,
): T[] => {
  const shapes = rows.map(shape)
  return rows.filter((_, index) => !isSupersededScanRow(shapes[index]!, shapes))
}

export function isSupersededRemnant(
  row: DraftOrder | DraftCashDeduction,
  siblings: readonly (DraftOrder | DraftCashDeduction)[],
): boolean {
  return ('providerOrderNo' in row && isAlreadyRecoveryShadow(
    row,
    siblings.filter((candidate): candidate is DraftOrder => 'providerOrderNo' in candidate),
  )) || supersededBy(row, siblings, printedSupersedable)
}

/** The rows worth putting in front of the driver: everything except superseded copies. */
export function withoutSupersededRemnants<T extends DraftOrder | DraftCashDeduction>(
  rows: readonly T[],
): T[] {
  const orders = rows.filter((row): row is T & DraftOrder => 'providerOrderNo' in row)
  return withoutBy(rows.filter((row) => !('providerOrderNo' in row && isAlreadyRecoveryShadow(row, orders))), printedSupersedable)
}

/** Remove only old `already-*` manual order snapshots that exactly mirror a canonical OCR row. */
export function sanitizeCloseDraftOperationsOverlay(
  current: EditableCloseDraftOperations,
  overlay: NonNullable<CloseDraftPatch['operations']>,
): NonNullable<CloseDraftPatch['operations']> {
  if (overlay.manualOrders === undefined) return overlay
  const canonical = current.orders.filter(
    (row) => row.draftSource !== undefined && row.draftSource !== 'manual',
  )
  return {
    ...overlay,
    manualOrders: overlay.manualOrders.filter((saved) => {
      const shadow: DraftOrder = {
        localId: saved.clientKey,
        clientKey: saved.clientKey,
        draftSource: 'manual',
        providerOrderNo: saved.providerOrderNo,
        payMode: saved.payMode,
        feeText: saved.fee ?? '',
        timeText: saved.occurredMinute ?? '',
        dateText: saved.occurredDate ?? '',
      }
      return !isAlreadyRecoveryShadow(shadow, [...canonical, shadow])
    }),
  }
}

/**
 * Merge a possibly stale human snapshot without interpreting absence as deletion. The close UI has
 * no delete operation, so canonical rows win same-key conflicts and phone-only keys are additions.
 */
export function mergeCanonicalManualOperations(
  current: EditableCloseDraftOperations,
  overlay: NonNullable<CloseDraftPatch['operations']>,
  base?: EditableCloseDraftOperations,
  conflictPreference: 'canonical' | 'local' = 'canonical',
): { overlay: NonNullable<CloseDraftPatch['operations']>; conflicts: string[] } {
  const cleaned = sanitizeCloseDraftOperationsOverlay(current, overlay)
  const conflicts: string[] = []
  const semanticRow = (kind: string, row: Record<string, unknown>): string => {
    const moneyKey = kind === 'order' ? 'fee' : 'amount'
    return JSON.stringify(Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => key !== moneyKey)
        .sort(([left], [right]) => left.localeCompare(right)),
    ))
  }
  const sameManualRow = (kind: string, left: Record<string, unknown>, right: Record<string, unknown>): boolean =>
    semanticRow(kind, left) === semanticRow(kind, right) &&
    sameMoney(
      left[kind === 'order' ? 'fee' : 'amount'] as string | null,
      right[kind === 'order' ? 'fee' : 'amount'] as string | null,
    )
  const appendMissing = <T extends { clientKey: string }>(
    kind: string,
    canonical: readonly T[],
    local: readonly T[],
    prior: readonly T[],
  ): T[] => {
    const result = [...canonical]
    const byKey = new Map(canonical.map((row, index) => [row.clientKey, { row, index }]))
    const priorByKey = new Map(prior.map((row) => [row.clientKey, row]))
    for (const row of local) {
      const held = byKey.get(row.clientKey)
      if (held === undefined) {
        result.push(row)
        byKey.set(row.clientKey, { row, index: result.length - 1 })
        continue
      }
      const server = held.row
      if (sameManualRow(kind, server, row)) continue
      const baseline = priorByKey.get(row.clientKey)
      if (baseline !== undefined && sameManualRow(kind, server, baseline)) {
        // Only this phone changed the row. Reapply it over an unrelated newer revision.
        result[held.index] = row
        byKey.set(row.clientKey, { row, index: held.index })
        continue
      }
      if (baseline !== undefined && sameManualRow(kind, row, baseline)) {
        // Only the server changed the row. The phone has no edit to replay.
        continue
      }
      conflicts.push(`${kind}:${row.clientKey}`)
      if (conflictPreference === 'local') {
        result[held.index] = row
        byKey.set(row.clientKey, { row, index: held.index })
      }
    }
    return result
  }
  const canonicalPatch = closeDraftOperationsPatch(
    current.orders,
    current.cashDeductions,
    current.movements,
  )
  const baselinePatch = base === undefined
    ? null
    : closeDraftOperationsPatch(
        base.orders
          .filter((row) =>
            row.persistedFeeText !== undefined &&
            row.persistedTimeText !== undefined &&
            row.persistedDateText !== undefined,
          )
          .map((row) => ({
            ...row,
            feeText: row.persistedFeeText ?? '',
            timeText: row.persistedTimeText ?? '',
            dateText: row.persistedDateText ?? '',
          })),
        base.cashDeductions
          .filter((row) =>
            row.persistedAmountText !== undefined &&
            row.persistedTimeText !== undefined &&
            row.persistedDateText !== undefined,
          )
          .map((row) => ({
            ...row,
            amountText: row.persistedAmountText ?? '',
            timeText: row.persistedTimeText ?? '',
            dateText: row.persistedDateText ?? '',
          })),
        base.movements
          .filter((row) =>
            row.persistedAmountText !== undefined &&
            row.persistedTimeText !== undefined &&
            'persistedNotes' in row &&
            'persistedAmbiguous' in row,
          )
          .map((row) => ({
            ...row,
            amountText: row.persistedAmountText ?? '',
            timeText: row.persistedTimeText ?? '',
            notes: row.persistedNotes ?? null,
            ambiguous: row.persistedAmbiguous ?? false,
          })),
      )
  const safeRowEdits = (cleaned.rowEdits ?? []).filter((edit) => {
    const serverRows = edit.kind === 'order'
      ? current.orders
      : edit.kind === 'cash_deduction'
        ? current.cashDeductions
        : current.movements
    const server = serverRows.find((row) => (row.clientKey ?? row.localId) === edit.clientKey)
    // A canonical OCR row withdrawn by a newer server revision cannot be resurrected by a row
    // edit: its evidence identity and inclusion decision are server-owned. Treat the withdrawal as
    // authoritative instead of offering a phone choice that the API cannot actually materialise.
    if (server === undefined) return false
    if (base === undefined) {
      conflicts.push(`row_edit:${edit.clientKey}`)
      return conflictPreference === 'local'
    }
    const baseRows = edit.kind === 'order'
      ? base.orders
      : edit.kind === 'cash_deduction'
        ? base.cashDeductions
        : base.movements
    const prior = baseRows.find((row) => (row.clientKey ?? row.localId) === edit.clientKey)
    if (prior === undefined) {
      conflicts.push(`row_edit:${edit.clientKey}`)
      return conflictPreference === 'local'
    }
    const checks: Array<[unknown, unknown, unknown, boolean]> = []
    if (edit.kind === 'order' && 'feeText' in prior && 'feeText' in server) {
      if ('fee' in edit) checks.push([prior.persistedFeeText, server.feeText, edit.fee, true])
      if ('occurredMinute' in edit) checks.push([prior.persistedTimeText ?? '', server.timeText ?? '', edit.occurredMinute ?? '', false])
      if ('occurredDate' in edit) checks.push([prior.persistedDateText ?? '', server.dateText ?? '', edit.occurredDate ?? '', false])
    } else if (
      edit.kind === 'cash_deduction' && 'amountText' in prior && 'amountText' in server &&
      'dateText' in prior && 'dateText' in server
    ) {
      if ('amount' in edit) checks.push([prior.persistedAmountText, server.amountText, edit.amount, true])
      if ('occurredMinute' in edit) checks.push([prior.persistedTimeText ?? '', server.timeText, edit.occurredMinute ?? '', false])
      if ('occurredDate' in edit) checks.push([prior.persistedDateText ?? '', server.dateText, edit.occurredDate ?? '', false])
    } else if (
      edit.kind === 'movement' && 'amountText' in prior && 'amountText' in server &&
      'notes' in prior && 'notes' in server
    ) {
      if ('amount' in edit) checks.push([prior.persistedAmountText, server.amountText, edit.amount, true])
      if ('occurredMinute' in edit) checks.push([prior.persistedTimeText ?? '', server.timeText, edit.occurredMinute ?? '', false])
      if ('notes' in edit) checks.push([prior.persistedNotes ?? null, server.notes ?? null, edit.notes ?? null, false])
      if ('ambiguous' in edit) checks.push([prior.persistedAmbiguous ?? false, server.ambiguous ?? false, edit.ambiguous, false])
    }
    const divergent = checks.some(([baseline, latest, desired, money]) => {
      const unchanged = money
        ? sameMoney(baseline as string | null, latest as string | null)
        : baseline === latest
      const alreadyApplied = money
        ? sameMoney(latest as string | null, desired as string | null)
        : latest === desired
      return !unchanged && !alreadyApplied
    })
    if (divergent) conflicts.push(`row_edit:${edit.clientKey}`)
    return !divergent || conflictPreference === 'local'
  })
  const merged: NonNullable<CloseDraftPatch['operations']> = {
    ...cleaned,
    // A row edit is a write against a prior canonical value. Without its base row value it cannot
    // be three-way merged silently; the caller decides which side an explicit resolution shows.
    rowEdits: safeRowEdits,
    ...(cleaned.manualOrders !== undefined
      ? {
          manualOrders: appendMissing(
            'order',
            canonicalPatch.manualOrders ?? [],
            cleaned.manualOrders,
            baselinePatch?.manualOrders ?? [],
          ),
        }
      : {}),
    ...(cleaned.manualCashDeductions !== undefined
      ? {
          manualCashDeductions: appendMissing(
            'cash_deduction',
            canonicalPatch.manualCashDeductions ?? [],
            cleaned.manualCashDeductions,
            baselinePatch?.manualCashDeductions ?? [],
          ),
        }
      : {}),
    ...(cleaned.manualMovements !== undefined
      ? {
          manualMovements: appendMissing(
            'movement',
            canonicalPatch.manualMovements ?? [],
            cleaned.manualMovements,
            baselinePatch?.manualMovements ?? [],
          ),
        }
      : {}),
  }
  return { overlay: merged, conflicts }
}

function summarize(
  rows: readonly {
    included: boolean | undefined
    timeReviewRequired: boolean | undefined
    amount: string
  }[],
): OperationSummaryGroup {
  const result: OperationSummaryGroup = {
    total: rows.length,
    included: 0,
    pending: 0,
    excluded: 0,
    missingAmount: 0,
  }
  for (const row of rows) {
    result[operationDecisionState(row)] += 1
    if (row.amount.trim() === '') result.missingAmount += 1
  }
  return result
}

/** One compact, current-state summary. It never mixes orders with archival wallet movements. */
export function closeOperationsSummary(
  orders: readonly DraftOrder[],
  cashDeductions: readonly DraftCashDeduction[],
): CloseOperationsSummary {
  const orderSummary = summarize(
    orders.map((row) => ({
      included: row.included,
      timeReviewRequired: row.timeReviewRequired,
      amount: row.feeText,
    })),
  )
  const deductionSummary = summarize(
    cashDeductions.map((row) => ({
      included: row.included,
      timeReviewRequired: row.timeReviewRequired,
      amount: row.amountText,
    })),
  )
  return {
    orders: orderSummary,
    cashDeductions: deductionSummary,
    pendingTotal: orderSummary.pending + deductionSummary.pending,
    missingAmountTotal: orderSummary.missingAmount + deductionSummary.missingAmount,
  }
}

const provenance = <T extends {
  clientKey: string
  source: 'manual' | 'local_ocr' | 'cloud_ocr'
  readId: string | null
  observationId: string | null
  rowIndex: number | null
  dateSection: string | null
  evidence: { mediaId: string; attachmentToken: string; slot: string } | null
  sightings?: Array<{
    readId: string
    observationId: string
    rowIndex: number
    dateSection: string | null
    evidence: { mediaId: string; attachmentToken: string; slot: string }
  }>
}>(row: T) => ({
  clientKey: row.clientKey,
  draftSource: row.source,
  readId: row.readId,
  observationId: row.observationId,
  rowIndex: row.rowIndex,
  dateSection: row.dateSection,
  evidence: row.evidence,
  sightings: row.sightings ?? [],
})

/** Convert server-owned canonical rows to the existing phone editing model without losing proof. */
export function closeDraftOperations(view: CloseDraftView): {
  orders: DraftOrder[]
  cashDeductions: DraftCashDeduction[]
  movements: DraftMovement[]
} {
  return {
    orders: view.operations.orders.map((row) => ({
      localId: row.clientKey,
      ...provenance(row),
      providerOrderNo: row.providerOrderNo,
      payMode: row.payMode,
      feeText: row.fee ?? '',
      persistedFeeText: row.fee ?? '',
      ...(row.feeOcr !== null ? { feeOcrText: row.feeOcr } : {}),
      feeRefused: row.feeRefused,
      included: row.included,
      timeReviewRequired: row.reviewRequired,
      timeText: row.occurredMinute ?? '',
      persistedTimeText: row.occurredMinute ?? '',
      dateText: row.occurredDate ?? '',
      persistedDateText: row.occurredDate ?? '',
      pointA: row.pointA,
      pointB: row.pointB,
      windowBasis: row.windowBasis,
      position: row.position,
    })),
    cashDeductions: view.operations.cashDeductions.map((row) => ({
      localId: row.clientKey,
      ...provenance(row),
      operationKey: row.operationKey,
      amountText: row.amount ?? '',
      persistedAmountText: row.amount ?? '',
      amountOcrText: row.amountOcr,
      timeText: row.occurredMinute ?? '',
      persistedTimeText: row.occurredMinute ?? '',
      dateText: row.occurredDate ?? '',
      persistedDateText: row.occurredDate ?? '',
      pointA: row.pointA,
      pointB: row.pointB,
      source: row.source === 'manual' ? 'manual' : row.amountOcr === null ? 'refused' : 'ocr',
      included: row.included,
      timeReviewRequired: row.reviewRequired,
      windowBasis: row.windowBasis,
      position: row.position,
    })),
    movements: view.operations.movements.map((row) => ({
      localId: row.clientKey,
      ...provenance(row),
      amountText: row.amount,
      persistedAmountText: row.amount,
      timeText: row.occurredMinute ?? '',
      persistedTimeText: row.occurredMinute ?? '',
      role: row.role,
      providerOrderNo: row.providerOrderNo,
      ambiguous: row.ambiguous,
      persistedAmbiguous: row.ambiguous,
      included: row.included,
      notes: row.notes,
      persistedNotes: row.notes,
    })),
  }
}

const nullable = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/**
 * Persist only human-authored subsets and edits. Evidence, observations and window decisions never
 * travel back as client claims; the server keeps them on the canonical rows.
 */
export function closeDraftOperationsPatch(
  orders: readonly DraftOrder[],
  cashDeductions: readonly DraftCashDeduction[],
  movements: readonly DraftMovement[],
): NonNullable<CloseDraftPatch['operations']> {
  const manualOrders = orders
    .filter((row) => row.draftSource === 'manual' || row.draftSource === undefined)
    .map((row) => ({
      clientKey: row.clientKey ?? row.localId,
      providerOrderNo: row.providerOrderNo,
      payMode: row.payMode,
      fee: nullable(row.feeText),
      occurredMinute: nullable(row.timeText),
      occurredDate: nullable(row.dateText),
      pointA: row.pointA ?? null,
      pointB: row.pointB ?? null,
      source: 'manual' as const,
    }))
  const manualCashDeductions = cashDeductions
    .filter((row) => row.draftSource === 'manual' || row.draftSource === undefined)
    .map((row) => ({
      clientKey: row.clientKey ?? row.localId,
      operationKey: row.operationKey,
      amount: nullable(row.amountText),
      occurredMinute: nullable(row.timeText),
      occurredDate: nullable(row.dateText),
      pointA: row.pointA ?? null,
      pointB: row.pointB ?? null,
      source: 'manual' as const,
    }))
  const manualMovements = movements
    .filter((row) => row.draftSource === 'manual' || row.draftSource === undefined)
    .map((row) => ({
      clientKey: row.clientKey ?? row.localId,
      amount: row.amountText,
      occurredMinute: nullable(row.timeText),
      role: row.role ?? 'unmatched',
      providerOrderNo: row.providerOrderNo ?? null,
      ambiguous: row.ambiguous ?? false,
      notes: row.notes ?? null,
      source: 'manual' as const,
    }))

  const rowEdits: NonNullable<NonNullable<CloseDraftPatch['operations']>['rowEdits']> = [
    ...orders
      .filter(
        (row) =>
          row.draftSource !== undefined &&
          row.draftSource !== 'manual' &&
          (row.feeText !== row.persistedFeeText ||
            (row.timeText ?? '') !== (row.persistedTimeText ?? '') ||
            (row.dateText ?? '') !== (row.persistedDateText ?? '')),
      )
      .map((row) => ({
        clientKey: row.clientKey ?? row.localId,
        kind: 'order' as const,
        ...(row.feeText !== row.persistedFeeText ? { fee: nullable(row.feeText) } : {}),
        ...((row.timeText ?? '') !== (row.persistedTimeText ?? '')
          ? { occurredMinute: nullable(row.timeText) }
          : {}),
        ...((row.dateText ?? '') !== (row.persistedDateText ?? '')
          ? { occurredDate: nullable(row.dateText) }
          : {}),
      })),
    ...cashDeductions
      .filter(
        (row) =>
          row.draftSource !== undefined &&
          row.draftSource !== 'manual' &&
          (row.amountText !== row.persistedAmountText ||
            row.timeText !== (row.persistedTimeText ?? '') ||
            row.dateText !== (row.persistedDateText ?? '')),
      )
      .map((row) => ({
        clientKey: row.clientKey ?? row.localId,
        kind: 'cash_deduction' as const,
        ...(row.amountText !== row.persistedAmountText ? { amount: nullable(row.amountText) } : {}),
        ...(row.timeText !== (row.persistedTimeText ?? '')
          ? { occurredMinute: nullable(row.timeText) }
          : {}),
        ...(row.dateText !== (row.persistedDateText ?? '')
          ? { occurredDate: nullable(row.dateText) }
          : {}),
      })),
    ...movements
      .filter(
        (row) =>
          row.draftSource !== undefined &&
          row.draftSource !== 'manual' &&
          (row.amountText !== row.persistedAmountText ||
            row.timeText !== (row.persistedTimeText ?? '') ||
            (row.notes ?? null) !== (row.persistedNotes ?? null) ||
            (row.ambiguous ?? false) !== (row.persistedAmbiguous ?? false)),
      )
      .map((row) => ({
        clientKey: row.clientKey ?? row.localId,
        kind: 'movement' as const,
        ...(row.amountText !== row.persistedAmountText ? { amount: row.amountText } : {}),
        ...(row.timeText !== (row.persistedTimeText ?? '')
          ? { occurredMinute: nullable(row.timeText) }
          : {}),
        ...((row.ambiguous ?? false) !== (row.persistedAmbiguous ?? false)
          ? { ambiguous: row.ambiguous ?? false }
          : {}),
        ...((row.notes ?? null) !== (row.persistedNotes ?? null) ? { notes: row.notes ?? null } : {}),
      })),
  ]

  return { manualOrders, manualCashDeductions, manualMovements, rowEdits }
}

export interface EditableCloseDraftOperations {
  orders: DraftOrder[]
  cashDeductions: DraftCashDeduction[]
  movements: DraftMovement[]
}

/**
 * Reapply the small human-authored overlay kept across an offline reload. Canonical OCR rows remain
 * the base: no evidence, inclusion decision or unedited OCR row can be recreated by local storage.
 */
export function applyCloseDraftOperationsOverlay(
  current: EditableCloseDraftOperations,
  overlay: NonNullable<CloseDraftPatch['operations']>,
): EditableCloseDraftOperations {
  const orderByKey = new Map(current.orders.map((row) => [row.clientKey ?? row.localId, row]))
  const deductionByKey = new Map(
    current.cashDeductions.map((row) => [row.clientKey ?? row.localId, row]),
  )
  const movementByKey = new Map(current.movements.map((row) => [row.clientKey ?? row.localId, row]))

  const orders = overlay.manualOrders
    ? [
        ...current.orders.filter((row) => row.draftSource !== 'manual' && row.draftSource !== undefined),
        ...overlay.manualOrders.map((row): DraftOrder => {
          const existing = orderByKey.get(row.clientKey)
          return {
            ...(existing ?? {
              localId: row.clientKey,
              included: false,
              timeReviewRequired: true,
            }),
            localId: row.clientKey,
            clientKey: row.clientKey,
            draftSource: 'manual',
            providerOrderNo: row.providerOrderNo,
            payMode: row.payMode,
            feeText: row.fee ?? '',
            timeText: row.occurredMinute ?? '',
            dateText: row.occurredDate ?? '',
            pointA: row.pointA,
            pointB: row.pointB,
          }
        }),
      ]
    : [...current.orders]
  const cashDeductions = overlay.manualCashDeductions
    ? [
        ...current.cashDeductions.filter(
          (row) => row.draftSource !== 'manual' && row.draftSource !== undefined,
        ),
        ...overlay.manualCashDeductions.map((row): DraftCashDeduction => {
          const existing = deductionByKey.get(row.clientKey)
          return {
            ...(existing ?? {
              localId: row.clientKey,
              amountOcrText: null,
              source: 'manual' as const,
              included: false,
              timeReviewRequired: true,
            }),
            localId: row.clientKey,
            clientKey: row.clientKey,
            draftSource: 'manual',
            operationKey: row.operationKey,
            amountText: row.amount ?? '',
            timeText: row.occurredMinute ?? '',
            dateText: row.occurredDate ?? '',
            pointA: row.pointA,
            pointB: row.pointB,
            source: 'manual',
          }
        }),
      ]
    : [...current.cashDeductions]
  const movements = overlay.manualMovements
    ? [
        ...current.movements.filter((row) => row.draftSource !== 'manual' && row.draftSource !== undefined),
        ...overlay.manualMovements.map((row): DraftMovement => {
          const existing = movementByKey.get(row.clientKey)
          return {
            ...(existing ?? { localId: row.clientKey, included: false }),
            localId: row.clientKey,
            clientKey: row.clientKey,
            draftSource: 'manual',
            amountText: row.amount,
            timeText: row.occurredMinute ?? '',
            role: row.role,
            providerOrderNo: row.providerOrderNo,
            ambiguous: row.ambiguous,
            notes: row.notes,
          }
        }),
      ]
    : [...current.movements]

  for (const edit of overlay.rowEdits ?? []) {
    if (edit.kind === 'order') {
      const index = orders.findIndex((row) => (row.clientKey ?? row.localId) === edit.clientKey)
      if (index < 0) continue
      const row = orders[index]!
      orders[index] = {
        ...row,
        ...('fee' in edit ? { feeText: edit.fee ?? '' } : {}),
        ...('occurredMinute' in edit ? { timeText: edit.occurredMinute ?? '' } : {}),
        ...('occurredDate' in edit ? { dateText: edit.occurredDate ?? '' } : {}),
      }
    } else if (edit.kind === 'cash_deduction') {
      const index = cashDeductions.findIndex(
        (row) => (row.clientKey ?? row.localId) === edit.clientKey,
      )
      if (index < 0) continue
      const row = cashDeductions[index]!
      cashDeductions[index] = {
        ...row,
        ...('amount' in edit ? { amountText: edit.amount ?? '' } : {}),
        ...('occurredMinute' in edit ? { timeText: edit.occurredMinute ?? '' } : {}),
        ...('occurredDate' in edit ? { dateText: edit.occurredDate ?? '' } : {}),
      }
    } else {
      const index = movements.findIndex((row) => (row.clientKey ?? row.localId) === edit.clientKey)
      if (index < 0) continue
      const row = movements[index]!
      movements[index] = {
        ...row,
        ...('amount' in edit ? { amountText: edit.amount ?? '' } : {}),
        ...('occurredMinute' in edit ? { timeText: edit.occurredMinute ?? '' } : {}),
        ...('notes' in edit ? { notes: edit.notes ?? null } : {}),
        ...('ambiguous' in edit ? { ambiguous: edit.ambiguous ?? false } : {}),
      }
    }
  }
  return { orders, cashDeductions, movements }
}

/**
 * Match the server's wire representation before comparing a local overlay with a saved snapshot.
 * The server accepts `500` and persists `500.00`; treating those as different keeps autosave dirty
 * forever after a successful PATCH. Invalid/incomplete input stays byte-for-byte distinct so it
 * cannot be mistaken for persisted data.
 */
const canonicalFingerprintMoney = (value: string | null): string | null => {
  if (value === null || !/^-?\d+(?:\.\d{1,2})?$/u.test(value)) return value
  return formatMinor(parseMinor(value))
}

/** Stable comparison payload for debounced persistence; no transient Files or reader promises. */
export function closeDraftEditableFingerprint(input: {
  figures: {
    cashDeclared: string | null
    walletDeclared: string | null
    odometerKm: number | null
    odometerAnomalyConfirmed: boolean
  }
  orders: readonly DraftOrder[]
  cashDeductions: readonly DraftCashDeduction[]
  movements: readonly DraftMovement[]
}): string {
  const orders = input.orders.map((row) => ({
    ...row,
    feeText: canonicalFingerprintMoney(row.feeText) ?? '',
  }))
  const cashDeductions = input.cashDeductions.map((row) => ({
    ...row,
    amountText: canonicalFingerprintMoney(row.amountText) ?? '',
  }))
  const movements = input.movements.map((row) => ({
    ...row,
    amountText: canonicalFingerprintMoney(row.amountText) ?? '',
  }))
  return JSON.stringify({
    figures: {
      ...input.figures,
      cashDeclared: canonicalFingerprintMoney(input.figures.cashDeclared),
      walletDeclared: canonicalFingerprintMoney(input.figures.walletDeclared),
    },
    operations: closeDraftOperationsPatch(orders, cashDeductions, movements),
  })
}

/** Exposed for views that need to describe why a pending row was included. */
export function windowBasisLabelKey(
  basis: CloseDraftWindowBasis | undefined,
): 'printedTime' | 'screenPosition' | 'managerDecision' | 'unknown' {
  if (basis === 'printed_time') return 'printedTime'
  if (basis === 'screen_position') return 'screenPosition'
  if (basis === 'manager') return 'managerDecision'
  return 'unknown'
}
