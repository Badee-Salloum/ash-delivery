import { describe, expect, it, vi } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { confirmReadinessWithFreshFix, describeGpsTimingFailure } from '../src/gps-readiness.ts'

const stale = { status: 422, error: 'gps_fix_not_fresh', detail: { reason: 'stale', ageMs: 31_001 } }
const future = { status: 422, error: 'gps_fix_not_fresh', detail: { reason: 'future', ageMs: -8_000 } }

describe('GPS readiness timestamp recovery', () => {
  it.each([stale, future])('requests a different capture after timing rejection without rewriting its time', async error => {
    const read = vi.fn().mockResolvedValueOnce({ capturedAtMs: 100, accuracyM: 12 })
      .mockResolvedValueOnce({ capturedAtMs: 200, accuracyM: 15 })
    const confirm = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ ready: true })
    const onRefreshing = vi.fn()
    expect(await confirmReadinessWithFreshFix({ read, confirm, onRefreshing })).toBe(true)
    expect(read.mock.calls).toEqual([[false], [true]])
    expect(confirm.mock.calls).toEqual([[{ capturedAtMs: 100, accuracyM: 12 }], [{ capturedAtMs: 200, accuracyM: 15 }]])
    expect(onRefreshing).toHaveBeenCalledTimes(1)
  })

  it('stops after one automatic fresh-fix retry when the phone timestamp still fails', async () => {
    const read = vi.fn().mockResolvedValueOnce({ capturedAtMs: 100 }).mockResolvedValueOnce({ capturedAtMs: 200 })
    const confirm = vi.fn().mockRejectedValue(future)
    await expect(confirmReadinessWithFreshFix({ read, confirm, onRefreshing: vi.fn() })).rejects.toBe(future)
    expect(read).toHaveBeenCalledTimes(2)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('does not replay a cached point returned by a shell which ignores forceFresh', async () => {
    const read = vi.fn().mockResolvedValue({ capturedAtMs: 100 })
    const confirm = vi.fn().mockRejectedValue(stale)
    await expect(confirmReadinessWithFreshFix({ read, confirm, onRefreshing: vi.fn() })).rejects.toBe(stale)
    expect(read).toHaveBeenCalledTimes(2)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 409, 503])('does not retry authentication, permission or server failures (%s)', async status => {
    const read = vi.fn().mockResolvedValue({ capturedAtMs: 100 })
    const failure = { status, error: status === 409 ? 'gps_background_permission_required' : 'other' }
    const confirm = vi.fn().mockRejectedValue(failure)
    const onRefreshing = vi.fn()
    await expect(confirmReadinessWithFreshFix({ read, confirm, onRefreshing })).rejects.toBe(failure)
    expect(read).toHaveBeenCalledTimes(1)
    expect(onRefreshing).not.toHaveBeenCalled()
  })

  it('keeps the gate closed if obtaining the new point fails its native checks', async () => {
    const read = vi.fn().mockResolvedValueOnce({ capturedAtMs: 100 }).mockResolvedValueOnce(null)
    const confirm = vi.fn().mockRejectedValue(stale)
    expect(await confirmReadinessWithFreshFix({ read, confirm, onRefreshing: vi.fn() })).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('manual recheck begins with a forced fresh capture and successful checks have no retry', async () => {
    const read = vi.fn().mockResolvedValue({ capturedAtMs: 100 })
    const confirm = vi.fn().mockResolvedValue({ ready: true }), onRefreshing = vi.fn()
    expect(await confirmReadinessWithFreshFix({ read, confirm, onRefreshing, forceFresh: true })).toBe(true)
    expect(read.mock.calls).toEqual([[true]])
    expect(onRefreshing).not.toHaveBeenCalled()
  })

  it('explains late and future fixes in Arabic and English using the signed server difference', () => {
    expect(describeGpsTimingFailure(stale, ar.gpsTracking)).toContain('32 ثانية')
    expect(describeGpsTimingFailure(future, ar.gpsTracking)).toContain('متقدّم على وقت الخادم بـ8 ثانية')
    expect(describeGpsTimingFailure(future, en.gpsTracking)).toContain('8 seconds ahead')
    expect(describeGpsTimingFailure(stale, en.gpsTracking)).toContain('32 seconds late')
  })

  it.each([undefined, { reason: 'stale', ageMs: 'private' }, { reason: 'future', ageMs: 12 },
    { reason: 'future', ageMs: Infinity }, { reason: 'injected text', ageMs: 200 }])('uses safe copy for an old or malformed refusal', detail => {
    expect(describeGpsTimingFailure({ error: 'gps_fix_not_fresh', detail }, ar.gpsTracking)).toBe(ar.gpsTracking.fixTimingRejected)
  })

  it('leaves unrelated failures for the existing permission-specific handler', () => {
    expect(describeGpsTimingFailure({ error: 'gps_background_permission_required' }, ar.gpsTracking)).toBeNull()
  })
})
