import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  executePhotoAttempt,
  isCurrentPhotoAttempt,
  nextPhotoAttempt,
  planAcceptedUpload,
} from '../src/photo-attempt.ts'

const photoSlot = readFileSync(new URL('../src/screens/PhotoSlot.tsx', import.meta.url), 'utf8')
const photoAttemptSource = readFileSync(new URL('../src/photo-attempt.ts', import.meta.url), 'utf8')

describe('photo upload and OCR attempt ownership', () => {
  it('starts readers once, only after a failed upload retry is accepted', async () => {
    const file = { name: 'wallet.jpg' }
    const attempt = nextPhotoAttempt(0, file)
    const startReaders = vi.fn()
    const upload = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await executePhotoAttempt(attempt, 'selection', { startReaders, upload })
    expect(startReaders).not.toHaveBeenCalled()
    await executePhotoAttempt(attempt, 'upload_retry', { startReaders, upload })

    expect(startReaders).toHaveBeenCalledTimes(1)
    expect(startReaders).toHaveBeenCalledWith(attempt)
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it('gives a replacement selection a new nonce and rejects late effects from the old one', () => {
    const file = { name: 'same-file-object.jpg' }
    const first = nextPhotoAttempt(0, file)
    const second = nextPhotoAttempt(first.id, file)

    expect(second.id).toBe(first.id + 1)
    expect(isCurrentPhotoAttempt(second, first)).toBe(false)
    expect(isCurrentPhotoAttempt(second, second)).toBe(true)

    // The newer AI answer has landed; a terminal failure from the older attempt owns nothing.
    let visibleAiState = 'read'
    if (isCurrentPhotoAttempt(second, first)) visibleAiState = 'failed'
    expect(visibleAiState).toBe('read')
  })

  it('wires the red upload tile to the retained compressed generation', () => {
    expect(photoSlot).toContain("void execute(attempt, 'upload_retry')")
    expect(photoSlot).toContain('putPendingEvidence')
    expect(photoAttemptSource).toContain('const accepted = await actions.upload(attempt)')
  })

  it('keeps a failed replacement retryable after reload while showing the accepted thumbnail', async () => {
    const recovered = nextPhotoAttempt(0, { name: 'pending-replacement.jpg' })
    const upload = vi.fn().mockResolvedValue(true)
    const startReaders = vi.fn()

    // The recovery effect must not let an older attachment turn this pending upload green.
    expect(photoSlot).toContain("setPendingGenerationId(record.generationId)\n      // A retained generation")
    expect(photoSlot).toContain("setState('error')")
    expect(photoSlot).toContain("!(state === 'error' && currentAttempt.current)")
    expect(photoSlot.indexOf('{restoredThumbnail ? (')).toBeLessThan(
      photoSlot.indexOf(') : preview ? ('),
    )

    await executePhotoAttempt(recovered, 'upload_retry', { upload, startReaders })
    expect(upload).toHaveBeenCalledOnce()
    expect(startReaders).toHaveBeenCalledOnce()
  })
})

describe('an upload the server accepted is never silently dropped', () => {
  // The bug this prevents: a driver picks a second photo while the first is still uploading. The
  // first PUT lands on a slot that is no longer on screen, and the old code returned right there —
  // before telling the parent anything. The server held the photo; the start gate went on demanding
  // «صورة العداد»; and the only way out was discarding the shift. Evidence the server holds is a
  // fact, and a fact does not stop being true because the driver tapped again.
  const attempt = nextPhotoAttempt(0, 'photo-1')
  const newer = nextPhotoAttempt(1, 'photo-2')

  it('reports the attachment even when a newer selection owns the screen', () => {
    const plan = planAcceptedUpload(newer, attempt)
    expect(plan.notifyAttached).toBe(true)
    expect(plan.ownsUi).toBe(false)
  })

  it('refuses to let a superseded attempt move the close-draft revision', () => {
    // Rewinding a revision to a superseded generation would trade a stuck gate for a corrupted
    // draft, which is the worse of the two.
    expect(planAcceptedUpload(newer, attempt).advanceDraft).toBe(false)
  })

  it('gives the newest selection all three: the attachment, the tile and the draft', () => {
    expect(planAcceptedUpload(attempt, attempt)).toEqual({
      notifyAttached: true,
      ownsUi: true,
      advanceDraft: true,
    })
  })

  it('still reports the attachment when no attempt is current at all', () => {
    // A remount or a delete clears `currentAttempt`. The bytes are still on the server.
    expect(planAcceptedUpload(null, attempt).notifyAttached).toBe(true)
    expect(planAcceptedUpload(null, attempt).ownsUi).toBe(false)
  })
})
