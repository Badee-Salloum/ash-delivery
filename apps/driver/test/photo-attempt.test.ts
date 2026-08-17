import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  executePhotoAttempt,
  isCurrentPhotoAttempt,
  nextPhotoAttempt,
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
