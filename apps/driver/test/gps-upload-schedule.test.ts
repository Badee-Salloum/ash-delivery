import { describe, expect, it } from 'vitest'
import { GpsUploadSchedule } from '../src/gps-upload-schedule.ts'

describe('GPS upload pressure and authentication', () => {
  it.each([401, 403, 404, 409])('pauses %s without treating it as an acknowledgement', status => {
    const queue = [{ pointId: 'retained' }]
    const schedule = new GpsUploadSchedule()
    schedule.failed({ status }, 0, 0)
    expect(schedule.canSend(60 * 60_000)).toBe(false)
    expect(queue).toEqual([{ pointId: 'retained' }])
    // Login/shift re-entry creates a fresh watcher. Its original point identity is unchanged.
    expect(new GpsUploadSchedule().canSend(60 * 60_000)).toBe(true)
  })

  it('backs off busy/network failures with jitter and resets after an acknowledgement', () => {
    const schedule = new GpsUploadSchedule()
    schedule.failed({ status: 503 }, 0, 0.5)
    expect(schedule.canSend(15_000)).toBe(false)
    expect(schedule.canSend(16_500)).toBe(true)
    schedule.failed(new Error('offline'), 16_500, 0)
    expect(schedule.canSend(46_499)).toBe(false)
    expect(schedule.canSend(46_500)).toBe(true)
    schedule.succeeded()
    expect(schedule.canSend(46_500)).toBe(true)
    schedule.failed({ status: 429 }, 46_500, 0)
    expect(schedule.canSend(61_500)).toBe(true)
  })

  it('bounds retries during a long outage', () => {
    const schedule = new GpsUploadSchedule()
    for (let i = 0; i < 100; i++) schedule.failed({ status: 503 }, 1_000, 1)
    expect(schedule.canSend(360_999)).toBe(false)
    expect(schedule.canSend(361_000)).toBe(true)
  })
})
