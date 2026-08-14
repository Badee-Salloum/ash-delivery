import { describe, expect, it } from 'vitest'
import { evidenceReviewWarning } from './evidence-warning.ts'

const iso = (minute: number): string => new Date(Date.UTC(2026, 7, 14, 0, minute)).toISOString()

describe('manager evidence provenance warning', () => {
  it('measures age against the current attachment rather than the blob first receipt', () => {
    expect(
      evidenceReviewWarning({
        clientTakenAt: iso(0),
        receivedAt: iso(1),
        attachedAt: iso(60),
      }).age,
    ).toEqual({ kind: 'stale', minutes: 60 })
  })

  it('retains reuse and requires both acknowledgement actor and timestamp', () => {
    expect(
      evidenceReviewWarning({
        reusedFromShiftId: 'older-shift',
        staleAcknowledgedAt: iso(5),
        staleAcknowledgedBy: 'driver-1',
      }),
    ).toMatchObject({
      reusedFromShiftId: 'older-shift',
      acknowledged: true,
      acknowledgedAt: iso(5),
    })

    expect(
      evidenceReviewWarning({
        reusedFromShiftId: 'older-shift',
        staleAcknowledgedAt: iso(5),
        staleAcknowledgedBy: null,
      }).acknowledged,
    ).toBe(false)
  })

  it('falls back to receipt time for an older API response without attachment metadata', () => {
    expect(evidenceReviewWarning({ clientTakenAt: iso(0), receivedAt: iso(10) }).age).toEqual({
      kind: 'fresh',
      minutes: 10,
    })
  })
})
