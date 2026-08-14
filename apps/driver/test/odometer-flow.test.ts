import { describe, expect, it } from 'vitest'
import {
  endOdometerSubmission,
  localOdometerEvent,
  localOdometerFailureCopyKey,
  odometerValueForRetake,
} from '../src/odometer-flow.ts'

describe('odometer evidence ownership', () => {
  it('clears an old machine prefill on retake but preserves explicit driver input', () => {
    expect(odometerValueForRetake('6948', false)).toBe('')
    expect(odometerValueForRetake('6948', true)).toBe('6948')
  })

  it('sends the explicit anomaly acknowledgement with normalized end-reading fields', () => {
    expect(endOdometerSubmission('۶۹۰۰', 6948, true)).toEqual({
      odometerKm: 6900,
      odometerKmOcr: 6948,
      odometerAnomalyConfirmed: true,
    })
    expect(endOdometerSubmission('', null, false)).toBeNull()
  })

  it('retains the exact local-reader failure and makes every failure retryable in the UI', () => {
    expect(localOdometerEvent({ ok: false, reason: 'timeout' })).toEqual({ status: 'failed', reason: 'timeout' })
    expect(localOdometerEvent({ ok: false, reason: 'unavailable' })).toEqual({ status: 'failed', reason: 'unavailable' })
    expect(localOdometerEvent({ ok: true, odometer: null })).toEqual({ status: 'failed', reason: 'no_fields' })
    expect(localOdometerEvent({ ok: true, odometer: 6030 })).toEqual({ status: 'read' })
    expect(localOdometerFailureCopyKey('timeout')).toBe('localOcrTimeout')
    expect(localOdometerFailureCopyKey('unavailable')).toBe('localOcrUnavailable')
    expect(localOdometerFailureCopyKey('no_fields')).toBe('localOcrNoFields')
  })
})
