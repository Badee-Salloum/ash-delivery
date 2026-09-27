import { describe, expect, it } from 'vitest'
import { GPS_OUTBOX_TTL_MS, gpsBatchDisposition, nextFlushBatch, outboxSweepPlan, type QueuedFix } from './gps-outbox.ts'

const fix = (pointId: string, capturedAtMs: number, rejectedReason?: string): QueuedFix => ({
  key: pointId,
  shiftId: 'shift-1',
  pointId,
  lat: 33,
  lng: 36,
  accuracyM: 10,
  capturedAtMs,
  ...(rejectedReason ? { rejectedReason } : {}),
})

describe('offline GPS queue', () => {
  it('keeps six-day-old fixes and expires them after seven days', () => {
    const now = 2_000_000_000_000
    expect(outboxSweepPlan([fix('six-days', now - GPS_OUTBOX_TTL_MS + 60_000)], now)).toEqual([])
    expect(outboxSweepPlan([fix('eight-days', now - GPS_OUTBOX_TTL_MS - 1)], now)).toEqual(['eight-days'])
  })

  it('acknowledges only stored and duplicate IDs from a partial reply', () => {
    const pending = [fix('a', 100), fix('b', 200), fix('c', 300), fix('d', 400)]
    const result = gpsBatchDisposition(pending, {
      accepted: 1, duplicates: 1, rejected: 1,
      results: [
        { pointId: 'a', status: 'stored' },
        { pointId: 'b', status: 'duplicate' },
        { pointId: 'c', status: 'rejected', reason: 'after_tracking_ended' },
      ],
    })
    expect(result.acknowledged).toEqual(['a', 'b'])
    expect(result.rejected.get('c')).toBe('after_tracking_ended')
    expect(result.rejected.has('d')).toBe(false)
  })

  it('does not repeatedly upload a rejected fix', () => {
    expect(nextFlushBatch([fix('rejected', 100, 'older_than_7_days'), fix('pending', 200)], 'shift-1', 10)
      .map((row) => row.pointId)).toEqual(['pending'])
  })
})
