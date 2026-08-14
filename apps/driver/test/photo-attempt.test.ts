import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  executePhotoAttempt,
  isCurrentPhotoAttempt,
  nextPhotoAttempt,
} from '../src/photo-attempt.ts'

const photoSlot = readFileSync(new URL('../src/screens/PhotoSlot.tsx', import.meta.url), 'utf8')

describe('photo upload and OCR attempt ownership', () => {
  it('retries a failed upload without launching local or cloud readers again', async () => {
    const file = { name: 'wallet.jpg' }
    const attempt = nextPhotoAttempt(0, file)
    const startReaders = vi.fn()
    const upload = vi.fn()

    await executePhotoAttempt(attempt, 'selection', { startReaders, upload })
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

  it('wires the red upload tile to upload-only retry rather than onPick', () => {
    expect(photoSlot).toContain("void execute(attempt, 'upload_retry')")
    expect(photoSlot).not.toContain('onPick(picked)')
  })
})
