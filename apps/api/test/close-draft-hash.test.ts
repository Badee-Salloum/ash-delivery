import { describe, expect, it } from 'vitest'
import { sameCloseDraftEvidence } from '../src/close-draft.hash.ts'

describe('close-draft evidence equality', () => {
  it('is stable when PostgreSQL jsonb reorders keys inside an evidence generation', () => {
    const live = {
      dashboard: {
        mediaId: 'media-1',
        attachmentToken: 'token-1',
        attachedAtMs: 1_786_000_000_000,
      },
    }
    const jsonbShaped = {
      dashboard: {
        attachedAtMs: 1_786_000_000_000,
        attachmentToken: 'token-1',
        mediaId: 'media-1',
      },
    }

    expect(JSON.stringify(live)).not.toBe(JSON.stringify(jsonbShaped))
    expect(sameCloseDraftEvidence(live, jsonbShaped)).toBe(true)
    expect(sameCloseDraftEvidence(live, {
      dashboard: { ...jsonbShaped.dashboard, attachmentToken: 'replacement-token' },
    })).toBe(false)
  })
})
