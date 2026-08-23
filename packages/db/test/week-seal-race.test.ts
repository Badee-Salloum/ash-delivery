import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createPool } from '../src/pool.ts'
import { migrate } from '../src/migrate.ts'
import { assertDisposableDatabaseUrl } from './disposable-database.ts'

const DATABASE_URL = process.env.DATABASE_URL
if (DATABASE_URL) assertDisposableDatabaseUrl(DATABASE_URL)

if (!DATABASE_URL) {
  describe('PostgreSQL posting/week-seal race', () => {
    it.skip('skipped: set DATABASE_URL to run against real PostgreSQL', () => {})
  })
} else {
  const pool = createPool(DATABASE_URL, 5)

  afterAll(async () => {
    await pool.end()
  })

  describe('PostgreSQL posting/week-seal race', () => {
    it('waits for a posting that already passed the guard, then stamps it before closing', async () => {
      await migrate(pool)

      const branchId = randomUUID()
      const userId = randomUUID()
      const suffix = branchId.replaceAll('-', '').slice(0, 12)

      await pool.query(
        `INSERT INTO branches
           (id, code, name_ar, name_en, governorate_id, branch_no)
         SELECT $1, $2, 'اختبار سباق الإقفال', 'Week seal race', g.id, n.branch_no
           FROM governorates g
           CROSS JOIN LATERAL (
             SELECT candidate AS branch_no
               FROM generate_series(1, 99) AS candidate
              WHERE NOT EXISTS (
                SELECT 1 FROM branches b
                 WHERE b.governorate_id = g.id AND b.branch_no = candidate
              )
              ORDER BY candidate
              LIMIT 1
           ) n
          WHERE g.no = 1`,
        [branchId, `RACE-${suffix}`],
      )
      await pool.query(
        `INSERT INTO roles (key, name_ar, name_en)
         VALUES ('system_admin', 'مدير النظام', 'System Admin')
         ON CONFLICT (key) DO NOTHING`,
      )
      await pool.query(
        `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
         VALUES ($1, $2, 'system_admin', $3, 'اختبار السباق', 'x')`,
        [userId, branchId, `race-${suffix}`],
      )
      const fx = await pool.query<{ id: bigint }>(
        `INSERT INTO fx_days (business_date, syp_minor_per_usd)
         VALUES (DATE '2026-07-21', 13000)
         ON CONFLICT (business_date) DO UPDATE
           SET syp_minor_per_usd = fx_days.syp_minor_per_usd
         RETURNING id`,
      )
      const week = await pool.query<{ id: bigint }>(
        `INSERT INTO week_locks (branch_id, week_start_date, week_end_date)
         VALUES ($1, DATE '2026-07-19', DATE '2026-07-25')
         RETURNING id`,
        [branchId],
      )

      const poster = await pool.connect()
      const sealer = await pool.connect()
      const observer = await pool.connect()
      let posterOpen = false
      let sealerRoleSet = false
      let sealerTempCreated = false

      try {
        await poster.query('BEGIN')
        posterOpen = true
        const inserted = await poster.query<{ id: bigint }>(
          `INSERT INTO journal_entries
             (branch_id, event_type, occurrence_key, business_date, posting_date,
              week_start_date, fx_day_id, reason, created_by)
           VALUES ($1, 'manual', $2, DATE '2026-07-21', DATE '2026-07-21',
                   DATE '2026-07-19', $3, 'race regression fixture', $4)
           RETURNING id`,
          [branchId, `race-${suffix}`, fx.rows[0]!.id, userId],
        )

        // A SECURITY DEFINER function still sees the caller session's temp namespace. An empty
        // same-named table made the historical public-only search_path report "no such week" and
        // could redirect the seal. The hardened function must operate on public.week_locks.
        await sealer.query(
          `CREATE TEMP TABLE week_locks
             (id bigint, branch_id uuid, week_start_date date, week_end_date date,
              closed_at timestamptz, closed_by uuid)`,
        )
        sealerTempCreated = true
        await sealer.query('SET ROLE app_user')
        sealerRoleSet = true

        const sealerPid = await sealer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        const sealOutcome = sealer
          .query<{ sealed: number }>('SELECT public.fin_seal_week($1, $2) AS sealed', [
            week.rows[0]!.id,
            userId,
          ])
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          )

        // Prove the sealer reached the exclusive advisory lock and is waiting on the poster. This
        // is deterministic evidence of the interleaving that used to create an orphan entry.
        let waiting = false
        for (let attempt = 0; attempt < 100; attempt++) {
          const activity = await observer.query<{ wait_event: string | null }>(
            'SELECT wait_event FROM pg_stat_activity WHERE pid = $1',
            [sealerPid.rows[0]!.pid],
          )
          if (activity.rows[0]?.wait_event === 'advisory') {
            waiting = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(waiting).toBe(true)

        await poster.query('COMMIT')
        posterOpen = false

        const sealed = await sealOutcome
        if (!sealed.ok) throw sealed.error
        expect(Number(sealed.value.rows[0]!.sealed)).toBe(1)
        await sealer.query('RESET ROLE')
        sealerRoleSet = false
        await sealer.query('DROP TABLE pg_temp.week_locks')
        sealerTempCreated = false

        const result = await pool.query<{ week_lock_id: bigint; closed: boolean }>(
          `SELECT je.week_lock_id, wl.closed_at IS NOT NULL AS closed
             FROM journal_entries je
             JOIN week_locks wl ON wl.id = $2
            WHERE je.id = $1`,
          [inserted.rows[0]!.id, week.rows[0]!.id],
        )
        expect(result.rows[0]).toEqual({ week_lock_id: week.rows[0]!.id, closed: true })

        // The invoker-rights posting trigger needs the same protection. A closed public week must
        // still reject app_user even when the session supplies an empty pg_temp.week_locks table.
        await poster.query('BEGIN')
        posterOpen = true
        await poster.query(
          `CREATE TEMP TABLE week_locks
             (branch_id uuid, week_start_date date, week_end_date date, closed_at timestamptz)
           ON COMMIT DROP`,
        )
        await poster.query('GRANT SELECT ON pg_temp.week_locks TO app_user')
        await poster.query('SET LOCAL ROLE app_user')
        await expect(
          poster.query(
            `INSERT INTO public.journal_entries
               (branch_id, event_type, occurrence_key, business_date, posting_date,
                week_start_date, fx_day_id, reason, created_by)
             VALUES ($1, 'manual', $2, DATE '2026-07-21', DATE '2026-07-21',
                     DATE '2026-07-19', $3, 'temp-shadow regression fixture', $4)`,
            [branchId, `shadow-${suffix}`, fx.rows[0]!.id, userId],
          ),
        ).rejects.toMatchObject({ code: '25006' })
        await poster.query('ROLLBACK')
        posterOpen = false
      } finally {
        if (posterOpen) await poster.query('ROLLBACK').catch(() => undefined)
        if (sealerRoleSet) await sealer.query('RESET ROLE').catch(() => undefined)
        if (sealerTempCreated) {
          await sealer.query('DROP TABLE IF EXISTS pg_temp.week_locks').catch(() => undefined)
        }
        poster.release()
        sealer.release()
        observer.release()
      }
    })
  })
}
