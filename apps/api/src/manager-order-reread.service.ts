import type { Actor } from '@ash/domain'
import type { Deps, OcrResult, ShiftCloseTransactionDeps } from '@ash/contracts'
import { ServiceError, settlementFor } from './shifts.service.ts'
import { readScreen, type ReadOutput } from './ocr.service.ts'

/** Only Recent Orders evidence pages are meaningful inputs to the orders reader. */
const isDashboardSlot = (slot: string): boolean =>
  slot === 'dashboard' || /^dashboard_[1-9][0-9]*$/.test(slot)

export interface ManagerOrderEvidenceRereadInput {
  shiftId: string
  package: 'end'
  slot: string
  target:
    | { kind: 'order'; providerOrderNo: string }
    | { kind: 'cash_deduction'; id?: string | undefined; operationKey?: string | undefined }
  reason: string
  requestId: string | null
  maxReadsPerShift: number
}

export interface ManagerOrderEvidenceRereadResult {
  result: OcrResult
  cached: boolean
  retryable: boolean
  reads: ReadOutput['reads']
  evidence: {
    package: 'end'
    slot: string
    mediaId: string
    attachmentToken: string
  }
  /** Context only. There is no persisted row-to-photo provenance, so this is never a claimed link. */
  target:
    | { kind: 'order'; providerOrderNo: string; provenanceLinked: false }
    | { kind: 'cash_deduction'; id: string; operationKey: string; provenanceLinked: false }
  reviewedOrdersHash: string
  settlementHash: string
}

const transactionDeps = (deps: Deps, transaction: ShiftCloseTransactionDeps): Deps => ({
  ...deps,
  ...transaction,
})

/**
 * Re-read the exact immutable evidence attachment a manager selected.
 *
 * This is deliberately read-only financially. Persisted operations do not carry their dashboard
 * slot/row provenance, so automatically applying a candidate would invent a relationship the
 * database cannot prove. The endpoint returns every row from the selected page; the manager can
 * copy one explicit suggestion into the existing audited operation-revision action.
 */
export async function rereadManagerOrderEvidence(
  deps: Deps,
  actor: Actor,
  input: ManagerOrderEvidenceRereadInput,
): Promise<ManagerOrderEvidenceRereadResult> {
  const reason = input.reason.trim()
  if (reason === '') throw new ServiceError(422, 'operation_decision_reason_required')
  if (!isDashboardSlot(input.slot)) {
    throw new ServiceError(422, 'evidence_not_orders_screen', { slot: input.slot })
  }

  // Lock only long enough to bind the request to one exact attachment generation. Blob IO and the
  // paid network call stay outside the transaction by design.
  const prepared = await deps.closeUnitOfWork.run(
    { shiftId: input.shiftId, actorId: actor.userId, requestId: input.requestId },
    async (transaction) => {
      const shift = await transaction.shifts.findById(input.shiftId)
      if (!shift) throw new ServiceError(404, 'shift_not_found')
      if (shift.state !== 'pending_review') throw new ServiceError(409, 'shift_not_under_review')

      const targetInput = input.target
      let target: ManagerOrderEvidenceRereadResult['target']
      if (targetInput.kind === 'order') {
        const order = (await transaction.orders.listByShift(input.shiftId)).find(
          (row) => row.providerOrderNo === targetInput.providerOrderNo,
        )
        if (!order) throw new ServiceError(404, 'order_not_found', targetInput)
        // A refused dashboard row is intentionally persisted as `source: manual` after the driver
        // types the unread fee (see `storedSource`). `kind: yallago` is the durable distinction
        // from a branch/manual job; `manager_manual_entry` additionally excludes a manager-created
        // Yallago reconciliation row. Requiring `source: ocr` here rejected the exact failed-AI
        // case this action exists to inspect.
        if (order.kind === 'manual' || order.decisionReason === 'manager_manual_entry') {
          throw new ServiceError(422, 'operation_has_no_ocr_evidence')
        }
        target = {
          kind: 'order',
          providerOrderNo: targetInput.providerOrderNo,
          provenanceLinked: false,
        }
      } else {
        if (targetInput.id === undefined && targetInput.operationKey === undefined) {
          throw new ServiceError(422, 'cash_deduction_target_required')
        }
        const deduction = (await transaction.cashDeductions.listByShift(input.shiftId)).find(
          (row) =>
            (targetInput.id === undefined || row.id === targetInput.id) &&
            (targetInput.operationKey === undefined || row.operationKey === targetInput.operationKey),
        )
        if (!deduction) throw new ServiceError(404, 'cash_deduction_not_found', targetInput)
        // New dashboard deductions carry a deterministic `recent-orders:` key even when AI
        // refused and the corrected amount was consequently stored with `source: manual`.
        // Legacy/manual negative entries do not carry that evidence-origin key.
        if (deduction.source !== 'ocr' && !deduction.operationKey.startsWith('recent-orders:')) {
          throw new ServiceError(422, 'operation_has_no_ocr_evidence')
        }
        target = {
          kind: 'cash_deduction',
          id: deduction.id,
          operationKey: deduction.operationKey,
          provenanceLinked: false,
        }
      }

      const attachment = (await transaction.media.listSlots(input.shiftId)).find(
        (item) => item.package === input.package && item.slot === input.slot,
      )
      if (!attachment) {
        throw new ServiceError(404, 'evidence_slot_empty', {
          package: input.package,
          slot: input.slot,
        })
      }
      const media = await transaction.media.findById(attachment.mediaId)
      if (!media) throw new ServiceError(404, 'media_not_found')
      if (media.branchId !== shift.branchId) throw new ServiceError(409, 'evidence_branch_mismatch')
      return {
        shift,
        attachment,
        media,
        target,
      }
    },
  )

  const bytes = await deps.blobs.get(prepared.media.storageKey)
  if (!bytes) throw new ServiceError(410, 'media_blob_missing')

  const read = await readScreen(deps, {
    shiftId: input.shiftId,
    field: 'orders',
    bytes,
    requestedBy: actor.userId,
    maxReadsPerShift: input.maxReadsPerShift,
    // This is the one explicit human retry. The OCR repository still decides whether it is a cache
    // hit, a legal attempt two, or capped; this route never bypasses that spend policy.
    retryFailed: true,
  })

  // Re-lock after the network call. A result for bytes that are no longer the selected evidence
  // generation must not be presented as though it belonged to the current review.
  const snapshot = await deps.closeUnitOfWork.run(
    { shiftId: input.shiftId, actorId: actor.userId, requestId: input.requestId },
    async (transaction) => {
      const shift = await transaction.shifts.findById(input.shiftId)
      if (!shift) throw new ServiceError(404, 'shift_not_found')
      if (shift.state !== 'pending_review') throw new ServiceError(409, 'shift_not_under_review')
      const currentAttachment = (await transaction.media.listSlots(input.shiftId)).find(
        (item) => item.package === input.package && item.slot === input.slot,
      )
      if (
        !currentAttachment ||
        currentAttachment.mediaId !== prepared.attachment.mediaId ||
        currentAttachment.attachmentToken !== prepared.attachment.attachmentToken
      ) {
        throw new ServiceError(409, 'evidence_attachment_changed')
      }

      const scoped = transactionDeps(deps, transaction)
      const settlement = await settlementFor(scoped, shift)
      return {
        reviewedOrdersHash: settlement.reviewedOrdersHash,
        settlementHash: settlement.settlementHash,
      }
    },
  )

  // Append-only review event. Routes that apply a suggested time use the existing operation audit;
  // this row proves who asked AI to inspect which immutable evidence generation and why.
  await deps.audit.append({
    tableName: 'shift_order_evidence_rereads',
    recordId: input.shiftId,
    action: 'INSERT',
    actorId: actor.userId,
    actorKind: 'user',
    branchId: prepared.shift.branchId,
    requestId: input.requestId,
    before: null,
    after: {
      decision: 'reread_stored_orders_evidence',
      reason,
      package: input.package,
      slot: input.slot,
      mediaId: prepared.attachment.mediaId,
      attachmentToken: prepared.attachment.attachmentToken,
      target: prepared.target,
      provenanceLinked: false,
      result: read.result.ok ? 'suggestions_returned' : read.result.reason,
      cached: read.cached,
      retryable: read.retryable,
      reads: read.reads,
      suggestions: read.result.ok
        ? read.result.rows.map((row, index) => ({
            row: index + 1,
            value: row.value,
            cancelled: row.cancelled,
            reviewRequired: row.reviewRequired === true,
            time: row.time,
            dateIso: row.dateIso,
          }))
        : [],
      reviewedOrdersHash: snapshot.reviewedOrdersHash,
      settlementHash: snapshot.settlementHash,
    },
    occurredAtMs: deps.clock.nowMs(),
  })

  return {
    result: read.result,
    cached: read.cached,
    retryable: read.retryable,
    reads: read.reads,
    evidence: {
      package: input.package,
      slot: input.slot,
      mediaId: prepared.attachment.mediaId,
      attachmentToken: prepared.attachment.attachmentToken,
    },
    target: prepared.target,
    reviewedOrdersHash: snapshot.reviewedOrdersHash,
    settlementHash: snapshot.settlementHash,
  }
}
