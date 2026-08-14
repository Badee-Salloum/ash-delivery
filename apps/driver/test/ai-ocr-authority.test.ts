import { describe, expect, it } from 'vitest'
import {
  type AiOcrAuthorityState,
  reduceAiOcrAuthority,
} from '../src/ai-ocr-authority.ts'

const idle = (): AiOcrAuthorityState<string, object> => ({
  generation: null,
  phase: 'idle',
  value: null,
  aiValue: null,
  humanEdited: false,
})

describe('cloud-AI OCR authority', () => {
  it('never publishes a local-first wallet guess before AI succeeds', () => {
    const photo = {}
    const reading = reduceAiOcrAuthority(idle(), { type: 'started', generation: photo })
    const local = reduceAiOcrAuthority(reading, {
      type: 'local_observed',
      generation: photo,
      value: '214.0',
    })

    expect(local.value).toBeNull()
    expect(local.aiValue).toBeNull()

    const ai = reduceAiOcrAuthority(local, { type: 'ai_read', generation: photo, value: '279.50' })
    expect(ai).toMatchObject({ phase: 'read', value: '279.50', aiValue: '279.50' })
  })

  it('keeps the wallet blank when AI fails, even if local read first', () => {
    const photo = {}
    const reading = reduceAiOcrAuthority(idle(), { type: 'started', generation: photo })
    const local = reduceAiOcrAuthority(reading, {
      type: 'local_observed',
      generation: photo,
      value: '214.0',
    })
    const failed = reduceAiOcrAuthority(local, { type: 'ai_failed', generation: photo })

    expect(failed).toMatchObject({ phase: 'failed', value: null, aiValue: null })
  })

  it('does not publish a late local result after AI has already failed', () => {
    const photo = {}
    const reading = reduceAiOcrAuthority(idle(), { type: 'started', generation: photo })
    const failed = reduceAiOcrAuthority(reading, { type: 'ai_failed', generation: photo })
    const lateLocal = reduceAiOcrAuthority(failed, {
      type: 'local_observed',
      generation: photo,
      value: '214.0',
    })

    expect(lateLocal).toBe(failed)
    expect(lateLocal.value).toBeNull()
  })

  it('keeps explicit human typing while retaining the AI baseline', () => {
    const photo = {}
    const reading = reduceAiOcrAuthority(idle(), { type: 'started', generation: photo })
    const typed = reduceAiOcrAuthority(reading, { type: 'human_edited', value: '280.00' })
    const ai = reduceAiOcrAuthority(typed, { type: 'ai_read', generation: photo, value: '279.50' })

    expect(ai).toMatchObject({ value: '280.00', aiValue: '279.50', humanEdited: true })
  })

  it('ignores both local and AI answers from a replaced photograph', () => {
    const oldPhoto = {}
    const currentPhoto = {}
    const current = reduceAiOcrAuthority(
      reduceAiOcrAuthority(idle(), { type: 'started', generation: oldPhoto }),
      { type: 'started', generation: currentPhoto },
    )

    expect(
      reduceAiOcrAuthority(current, { type: 'local_observed', generation: oldPhoto, value: '214.0' }),
    ).toBe(current)
    expect(
      reduceAiOcrAuthority(current, { type: 'ai_read', generation: oldPhoto, value: '279.50' }),
    ).toBe(current)
  })
})
