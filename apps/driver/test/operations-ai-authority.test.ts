import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const shift = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')
const pageGrid = readFileSync(new URL('../src/screens/PageGrid.tsx', import.meta.url), 'utf8')
const photoSlot = readFileSync(new URL('../src/screens/PhotoSlot.tsx', import.meta.url), 'utf8')

describe('durable operations OCR authority guards', () => {
  it('reads only an accepted attachment generation and applies canonical server rows', () => {
    expect(shift).toContain('api.readCloseDraftAttachment(shift.id, slot, {')
    expect(shift).toContain('mediaId: attachment.mediaId')
    expect(shift).toContain('attachmentToken: attachment.attachmentToken')
    expect(shift).toContain('expectedRevision: revision')
    expect(shift).toContain('applyLinkedScalarRead(state, response, field, attachment.attachmentToken)')
    expect(shift).toContain('const rawOperations = closeDraftOperations(view)')
  })

  it('wires every paged tile to its canonical attachment and revision', () => {
    expect(pageGrid).toContain('attachment={attachments[slot] ?? null}')
    expect(pageGrid).toContain('closeDraftRevision={closeDraftRevision}')
    expect(pageGrid).toContain('onImage={(file, result) => onImage(file, slot, result)}')
    expect(pageGrid).toContain('onRetryRead: () => onRetryRead(slot)')
    expect(shift.match(/attachments=\{draft\.closeDraftAttachments\}/gu)).toHaveLength(2)
  })

  it('uploads first and never starts a reader after a rejected attachment', () => {
    expect(photoSlot).toContain('executePhotoAttempt(attempt, phase, {')
    expect(photoSlot).toContain('upload,')
    expect(photoSlot).toContain('startReaders: async')
    expect(photoSlot).toContain('if (!confirmable) throw candidateError')
    expect(photoSlot).toContain('return false')
  })

  it('makes a retry explicit on the linked endpoint', () => {
    expect(shift).toContain("readLinkedAttachment(slot, 'orders', true)")
    expect(shift).toContain("readLinkedAttachment(slot, 'payments_log', true)")
    expect(shift).toContain('...(retryFailed ? { retryFailed: true } : {})')
    expect(photoSlot).toContain("read?.status !== 'running'")
    expect(photoSlot).toContain("read?.status !== 'complete'")
  })

  it('restores canonical rows and never posts the legacy operations payload', () => {
    expect(shift).toContain('orders: operations.orders')
    expect(shift).toContain('cashDeductions: operations.cashDeductions')
    expect(shift).toContain('movements: operations.movements')
    expect(shift).toContain('applyCloseDraftOperationsOverlay(')
    expect(shift).toContain('saved.operations')
    expect(shift).not.toContain('ignoredLegacyOperationsPayload')
    expect(shift).not.toContain("api.put(`/shifts/${shift.id}/operations`")
  })

  it('autosaves only the strict human allowlist and restores the local overlay after canonical GET', () => {
    expect(shift).toContain('runCloseDraftSaveWithRetry({')
    expect(shift).toContain('rebaseStoredCloseDraft(current, view, saved)')
    expect(shift).toContain('rebaseCloseDraft(current, result.value, false)')
    expect(shift).toContain(
      'setEndDraft((current) => rebaseCloseDraft(current, result.value))',
    )
    expect(shift).not.toContain('closeDraftConflictCanonical: result.value')
    expect(shift).toContain('api.closeDraft(requestedShiftId).then((latest) =>')
    expect(shift).toContain('activeDraftShiftIdRef.current')
    expect(shift).toContain('latest.shiftId')
    expect(shift).toContain('draft.closeDraftMergeConflict')
    expect(shift).toContain("onResolveSaveConflict('phone')")
    expect(shift).toContain("onResolveSaveConflict('server')")
    expect(shift).toContain("resolveCloseDraftMergeConflict(current, 'phone')")
    expect(shift).toContain('return resolveCloseDraftMergeConflict(')
    expect(shift).toContain('rebaseCloseDraft(current, latest),')
    expect(shift).not.toContain('walletDeclaredOcr: endDraft.walletOcr')
    expect(shift).not.toContain('odometerKmOcr: endDraft.odoOcr')
    expect(shift).not.toContain('batteryPercent: endDraft')
  })

  it('shows wrong-screen as a specific read failure instead of manufacturing rows', () => {
    expect(photoSlot).toContain("read.failure === 'wrong_screen'")
    expect(photoSlot).toContain('t.shift.wrongScreen')
    expect(photoSlot).toContain('text-red-700')
  })

  it('discards terminally rejected candidate bytes while preserving the canonical attachment', () => {
    expect(photoSlot).toContain("apiError.error === 'wrong_screen' || apiError.error === 'evidence_already_attached'")
    expect(photoSlot).toContain('await deletePendingEvidence(shiftId, pkg, slot, prepared.generationId)')
    expect(photoSlot).toContain('currentAttempt.current = null')
    expect(photoSlot).toContain('setPicked(null)')
    expect(photoSlot).toContain('state === \'error\' && !currentAttempt.current')
    expect(photoSlot).toContain('t.shift.chooseAnotherImage')
  })

  it('offers an audited attachment-history restore with revision and generation locks', () => {
    expect(photoSlot).toContain('api.closeDraftAttachmentHistory(shiftId)')
    expect(photoSlot).toContain('api.restoreCloseDraftAttachment(shiftId, item.historyId, {')
    expect(photoSlot).toContain('expectedRevision: closeDraftRevision')
    expect(photoSlot).toContain('expectedAttachmentToken: attachment?.attachmentToken ?? null')
    expect(photoSlot).toContain('reason,')
    expect(photoSlot).toContain('onCloseDraft?.(response.draft)')
  })

  it('labels BR1 as surplus or shortage and displays an absolute amount', () => {
    expect(shift).toContain('br1DifferencePresentation(preview.differenceText)')
    expect(shift).toContain('br1DifferencePresentation(br1.difference)')
    expect(shift).toContain('{t.br1[previewDifference.direction]}')
    expect(shift).toContain('value={previewDifference.amountText}')
  })
})
