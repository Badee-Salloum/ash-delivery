import { describe, expect, it } from 'vitest'
import { classifyOperationWindow } from '@ash/contracts'
import { migrate } from '../src/migrate.ts'
import { createPool } from '../src/pool.ts'
import { assertDisposableDatabaseUrl } from './disposable-database.ts'

/**
 * The operation-window rule exists TWICE — once in TypeScript for the write path, and once in SQL
 * for `reclassify_shift_operations`, which is the authority for rows already persisted. Whichever
 * ran last decides whether a delivery counts, so a disagreement between them is a disagreement
 * about money.
 *
 * Until now nothing compared them. `migration-0030.test.ts` asserts only that the SQL text
 * *contains* `classify_operation_window(` — true of an implementation that returned the wrong
 * answer for every input. This file runs one truth table through both.
 *
 * It became worth paying for when the window's lower bound moved to the driver's confirmation
 * (2026-08-31): that change touches both implementations, and hand-editing one rule in two places
 * is exactly how the two drift.
 */
const DATABASE_URL = process.env.DATABASE_URL
if (DATABASE_URL) assertDisposableDatabaseUrl(DATABASE_URL)

/** Opens 2026-08-13 19:49 Damascus, submitted 2026-08-14 01:30 — the canonical fixture. */
const OPENS_AT = new Date(Date.UTC(2026, 7, 13, 16, 49, 30)).toISOString()
const SUBMITTED_AT = new Date(Date.UTC(2026, 7, 13, 22, 30, 45)).toISOString()

const CASES: ReadonlyArray<readonly [string | null, string | null, string]> = [
  ['2026-08-13', '19:48', 'pre_open'],
  ['2026-08-13', '19:49', 'open_minute_boundary'],
  ['2026-08-13', '23:59', 'in_window'],
  ['2026-08-14', '00:00', 'in_window'],
  ['2026-08-14', '01:30', 'close_minute_boundary'],
  ['2026-08-14', '01:31', 'post_close'],
  [null, '20:00', 'unknown'],
  ['2026-08-13', null, 'unknown'],
  ['2026-08-13', '7:5', 'unknown'],
]

if (!DATABASE_URL) {
  describe('operation-window TS/SQL parity', () => {
    it.skip('skipped: set DATABASE_URL to run against real PostgreSQL', () => {})
  })
} else {
  const pool = createPool(DATABASE_URL)

  describe('operation-window TS/SQL parity', () => {
    it('classifies every case identically in TypeScript and in PostgreSQL', async () => {
      await migrate(pool)
      for (const [occurredDate, occurredMinute, expected] of CASES) {
        const inTypeScript = classifyOperationWindow({
          occurredDate,
          occurredMinute,
          windowOpensAt: OPENS_AT,
          submittedAt: SUBMITTED_AT,
          timeZone: 'Asia/Damascus',
          offsetMinutes: 180,
        })
        const { rows } = await pool.query<{ status: string }>(
          'SELECT classify_operation_window($1::date, $2, $3::timestamptz, $4::timestamptz, $5)::text AS status',
          [occurredDate, occurredMinute, OPENS_AT, SUBMITTED_AT, 'Asia/Damascus'],
        )
        // Named in the message so a failure says WHICH minute disagreed, not just that one did.
        expect(`${occurredDate} ${occurredMinute} → ${inTypeScript}`).toBe(`${occurredDate} ${occurredMinute} → ${expected}`)
        expect(`${occurredDate} ${occurredMinute} → ${rows[0]!.status}`).toBe(`${occurredDate} ${occurredMinute} → ${expected}`)
      }
      await pool.end()
    })

    it('agrees that a missing lower bound is unknown, not an open window', async () => {
      // The dangerous default. If either side treated a null bound as "no lower limit" it would
      // silently include every row of a shift whose bound failed to write.
      expect(classifyOperationWindow({
        occurredDate: '2026-08-13',
        occurredMinute: '20:00',
        windowOpensAt: null,
        submittedAt: SUBMITTED_AT,
        timeZone: 'Asia/Damascus',
      })).toBe('unknown')
      const probe = createPool(DATABASE_URL)
      const { rows } = await probe.query<{ status: string }>(
        'SELECT classify_operation_window($1::date, $2, NULL::timestamptz, $3::timestamptz, $4)::text AS status',
        ['2026-08-13', '20:00', SUBMITTED_AT, 'Asia/Damascus'],
      )
      expect(rows[0]!.status).toBe('unknown')
      await probe.end()
    })
  })
}
