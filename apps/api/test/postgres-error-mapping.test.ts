import { describe, expect, it } from 'vitest'
import { isSealedWeekPgError } from '../src/app.ts'

describe('PostgreSQL error mapping', () => {
  it.each([
    'week lock 7 is closed (2026-08-14): entries are immutable, post a correction instead',
    'week lock 7 is already closed and cannot be reopened by UPDATE',
    'week 2026-08-09 is closed (2026-08-14): post a dated correction into the open week instead',
    'business date 2026-08-13 falls inside sealed week 2026-08-09 (2026-08-14): post a dated correction instead',
  ])('recognizes only an actual sealed-week 25006: %s', (message) => {
    expect(isSealedWeekPgError(Object.assign(new Error(message), { code: '25006' }))).toBe(true)
  })

  it.each([
    'shift open_approved_at is immutable',
    'shift open_approved_by is immutable',
    'shift_media_attachment_history is append-only',
    'cannot execute INSERT in a read-only transaction',
  ])('does not mislabel another 25006 invariant as week_locked: %s', (message) => {
    expect(isSealedWeekPgError(Object.assign(new Error(message), { code: '25006' }))).toBe(false)
  })

  it('requires SQLSTATE 25006 as well as a matching message', () => {
    expect(isSealedWeekPgError(Object.assign(new Error('week 2026-08-09 is closed'), { code: '23514' }))).toBe(false)
  })
})
