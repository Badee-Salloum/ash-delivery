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
const supersedable = (row: DraftOrder | DraftCashDeduction): SupersedableRow => {
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

export function isSupersededRemnant(
  row: DraftOrder | DraftCashDeduction,
  siblings: readonly (DraftOrder | DraftCashDeduction)[],
): boolean {
  return isSupersededScanRow(supersedable(row), siblings.map(supersedable))
}

/** The rows worth putting in front of the driver: everything except superseded copies. */
export function withoutSupersededRemnants<T extends DraftOrder | DraftCashDeduction>(
  rows: readonly T[],
): T[] {
  const shapes = rows.map(supersedable)
  return rows.filter((_, index) => !isSupersededScanRow(shapes[index]!, shapes))
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
