import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/migrate.ts'
import { createPool, withTransaction } from '../src/pool.ts'
import { PgOperationWindowRepo } from '../src/repos.ts'

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  describe('PostgreSQL operation-window integrity', () => {
    it.skip('skipped: set DATABASE_URL to run against real PostgreSQL', () => {})
  })
} else {
  const pool = createPool(DATABASE_URL)

  afterAll(async () => {
    await pool.end()
  })

  describe('PostgreSQL operation-window integrity', () => {
    it('rejects raw changes, permits a fresh manager decision, and audits deterministic healing', async () => {
      await migrate(pool)

      const branchId = randomUUID()
      const managerId = randomUUID()
      const driverId = randomUUID()
      const vehicleId = randomUUID()
      const shiftId = randomUUID()
      const managerOrderId = randomUUID()
      const automaticOrderId = randomUUID()
      const unknownOrderId = randomUUID()
      const automaticUnknownOrderId = randomUUID()
      const appUserOrderId = randomUUID()
      const deductionId = randomUUID()
      const suffix = shiftId.replaceAll('-', '').slice(0, 12)

      await pool.query(
        `INSERT INTO branches (id, code, name_ar, name_en, timezone, governorate_id, branch_no)
         SELECT $1, $2, 'فرع اختبار النافذة', 'Window integrity', 'Asia/Damascus', g.id, n.branch_no
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
        [branchId, `WIN-${suffix}`],
      )
      await pool.query(
        `INSERT INTO roles (key, name_ar, name_en)
         VALUES ('branch_manager', 'مدير فرع', 'Branch manager')
         ON CONFLICT (key) DO NOTHING`,
      )
      await pool.query(
        `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
         VALUES ($1, $2, 'branch_manager', $3, 'مدير اختبار النافذة', 'x')`,
        [managerId, branchId, `window-manager-${suffix}`],
      )
      await pool.query(
        `INSERT INTO drivers (id, branch_id, code, full_name_ar)
         VALUES ($1, $2, $3, 'سائق اختبار النافذة')`,
        [driverId, branchId, `WIN-DRV-${suffix}`],
      )
      await pool.query(
        `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no)
         SELECT $1, $2, t.id, $3, 1
           FROM vehicle_types t
          WHERE t.code = 'e_motorbike'`,
        [vehicleId, branchId, `WIN-VEH-${suffix}`],
      )
      await pool.query(
        `INSERT INTO shifts
           (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date, state,
            open_approved_at, open_approved_by, submitted_at)
         VALUES
           ($1, $2, $3, $4, 1, DATE '2026-08-13', DATE '2026-08-09', 'pending_review',
            TIMESTAMPTZ '2026-08-13 16:49:30+00', $5, TIMESTAMPTZ '2026-08-13 22:30:45+00')`,
        [shiftId, branchId, driverId, vehicleId, managerId],
      )
      await pool.query(
        `INSERT INTO shift_orders
           (id, shift_id, provider_order_no, pay_mode, fee_minor, driver_confirmed, source, kind,
            included, occurred_date, occurred_minute, window_status, created_by)
         VALUES
           ($1, $4, $5, 'cash', 1000, true, 'ocr', 'yallago', true,
            DATE '2026-08-13', '20:00', 'unknown', $7),
           ($2, $4, $6, 'cash', 1000, true, 'ocr', 'yallago', true,
            DATE '2026-08-13', '19:48', 'unknown', $7),
           ($3, $4, $8, 'cash', 1000, true, 'ocr', 'yallago', true,
            NULL, NULL, 'unknown', $7),
           ($9, $4, $10, 'cash', 1000, true, 'ocr', 'yallago', true,
            NULL, NULL, 'unknown', $7)`,
        [
          managerOrderId,
          automaticOrderId,
          unknownOrderId,
          shiftId,
          `WIN-MANAGER-${suffix}`,
          `WIN-AUTO-${suffix}`,
          managerId,
          `WIN-UNKNOWN-${suffix}`,
          automaticUnknownOrderId,
          `WIN-AUTO-UNKNOWN-${suffix}`,
        ],
      )
      await pool.query(
        `INSERT INTO cash_deductions
           (id, shift_id, operation_key, amount_minor, occurred_date, occurred_minute, source,
            included, window_status, created_by)
         VALUES ($1, $2, $3, 500, DATE '2026-08-14', '01:31', 'ocr', true, 'unknown', $4)`,
        [deductionId, shiftId, `WIN-DEDUCTION-${suffix}`, managerId],
      )

      await expect(
        pool.query('UPDATE shift_orders SET included = false WHERE id = $1', [managerOrderId]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'shift_orders_window_decision_reason_guard' })
      await expect(
        pool.query("UPDATE cash_deductions SET occurred_minute = '20:01' WHERE id = $1", [deductionId]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'cash_deductions_window_decision_reason_guard' })
      await expect(
        pool.query(
          `UPDATE shift_orders
              SET decision_reason = 'forged metadata-only resolution',
                  decided_by = $2,
                  decided_at = clock_timestamp()
            WHERE id = $1`,
          [unknownOrderId, managerId],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'shift_orders_window_decision_reason_guard' })

      await expect(
        withTransaction(pool, { actorId: managerId }, async (client) => {
          await client.query(
            `UPDATE shift_orders
                SET decision_reason = NULL,
                    decided_by = $2,
                    decided_at = clock_timestamp()
              WHERE id = $1`,
            [unknownOrderId, managerId],
          )
        }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'shift_orders_window_decision_reason_guard' })

      const inactiveActorId = randomUUID()
      await expect(
        withTransaction(pool, { actorId: inactiveActorId }, async (client) => {
          await client.query(
            `UPDATE shift_orders
                SET decision_reason = 'not an active manager',
                    decided_by = $2,
                    decided_at = clock_timestamp()
              WHERE id = $1`,
            [unknownOrderId, inactiveActorId],
          )
        }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'shift_orders_window_decision_reason_guard' })

      // A SECURITY DEFINER function shares the caller's temporary namespace. A public-only
      // search_path would therefore let app_user manufacture both the manager and shift rows used
      // by the authorization check. The fixed path and qualified relations must ignore them.
      await expect(
        withTransaction(pool, { actorId: inactiveActorId }, async (client) => {
          await client.query(
            `CREATE TEMP TABLE users
               (id uuid, active boolean, role_key text, branch_id uuid)
             ON COMMIT DROP`,
          )
          await client.query(
            `CREATE TEMP TABLE shifts (id uuid, branch_id uuid) ON COMMIT DROP`,
          )
          await client.query(
            `INSERT INTO pg_temp.users (id, active, role_key, branch_id)
             VALUES ($1, true, 'general_manager', $2)`,
            [inactiveActorId, branchId],
          )
          await client.query(
            `INSERT INTO pg_temp.shifts (id, branch_id) VALUES ($1, $2)`,
            [shiftId, branchId],
          )
          await client.query('SET LOCAL ROLE app_user')
          await client.query(
            `UPDATE public.shift_orders
                SET decision_reason = 'forged through temporary authorization rows',
                    decided_by = $2,
                    decided_at = clock_timestamp()
              WHERE id = $1`,
            [unknownOrderId, inactiveActorId],
          )
        }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'shift_orders_window_decision_reason_guard' })

      // The protected automatic-classification marker is equally sensitive: a same-named temp
      // table must not turn an ordinary direct UPDATE into the internal reasonless pathway.
      await expect(
        withTransaction(pool, { actorId: managerId }, async (client) => {
          await client.query(
            `CREATE TEMP TABLE operation_window_reclassification_context
               (backend_pid integer, transaction_id bigint, shift_id uuid)
             ON COMMIT DROP`,
          )
          await client.query(
            `INSERT INTO pg_temp.operation_window_reclassification_context
               (backend_pid, transaction_id, shift_id)
             VALUES (pg_backend_pid(), txid_current(), $1)`,
            [shiftId],
          )
          await client.query('SET LOCAL ROLE app_user')
          await client.query(
            `UPDATE public.shift_orders
                SET included = false, window_status = 'pre_open'
              WHERE id = $1`,
            [automaticOrderId],
          )
        }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'shift_orders_window_decision_reason_guard' })

      await withTransaction(pool, { actorId: managerId }, async (client) => {
        await client.query(
          `UPDATE shift_orders
              SET decision_reason = 'manager resolved unreadable printed time',
                  decided_by = $2,
                  decided_at = clock_timestamp()
            WHERE id = $1`,
          [unknownOrderId, managerId],
        )
      })
      expect((await pool.query(
        'SELECT window_status::text, included, decision_reason, decided_by::text FROM shift_orders WHERE id = $1',
        [unknownOrderId],
      )).rows[0]).toMatchObject({
        window_status: 'unknown',
        included: true,
        decision_reason: 'manager resolved unreadable printed time',
        decided_by: managerId,
      })

      await withTransaction(pool, { actorId: managerId }, async (client) => {
        await client.query(
          `UPDATE shift_orders
              SET included = false,
                  window_status = 'in_window',
                  decision_reason = 'verified against original provider screenshot',
                  decided_by = $2,
                  decided_at = clock_timestamp()
            WHERE id = $1`,
          [managerOrderId, managerId],
        )
      })

      const classified = await new PgOperationWindowRepo(pool).reclassify(shiftId, managerId)
      expect(classified).toEqual({ orders: 2, cashDeductions: 1 })

      const orders = await pool.query<{
        id: string
        included: boolean
        window_status: string
        decision_reason: string | null
      }>(
        `SELECT id::text, included, window_status::text, decision_reason
           FROM shift_orders WHERE shift_id = $1 ORDER BY provider_order_no`,
        [shiftId],
      )
      expect(orders.rows.find((row) => row.id === managerOrderId)).toMatchObject({
        included: false,
        window_status: 'in_window',
        decision_reason: 'verified against original provider screenshot',
      })
      expect(orders.rows.find((row) => row.id === automaticOrderId)).toMatchObject({
        included: false,
        window_status: 'pre_open',
      })
      expect(orders.rows.find((row) => row.id === unknownOrderId)).toMatchObject({
        included: true,
        window_status: 'unknown',
      })
      expect(orders.rows.find((row) => row.id === automaticUnknownOrderId)).toMatchObject({
        included: false,
        window_status: 'unknown',
      })
      expect((await pool.query(
        'SELECT included, window_status::text FROM cash_deductions WHERE id = $1',
        [deductionId],
      )).rows[0]).toMatchObject({ included: false, window_status: 'post_close' })

      const audit = await pool.query<{ actor_id: string | null }>(
        `SELECT actor_id::text
           FROM audit_log
          WHERE table_name IN ('shift_orders', 'cash_deductions')
            AND record_id IN ($1, $2, $3, $4)
            AND action = 'UPDATE'
          ORDER BY id`,
        [managerOrderId, automaticOrderId, automaticUnknownOrderId, deductionId],
      )
      expect(audit.rows).toHaveLength(4)
      expect(audit.rows.every((row) => row.actor_id === managerId)).toBe(true)
      expect((await pool.query(
        `SELECT has_table_privilege('app_user', 'operation_window_reclassification_context', 'INSERT') AS can_insert,
                count(*)::int AS active_contexts
           FROM operation_window_reclassification_context`,
      )).rows[0]).toEqual({ can_insert: false, active_contexts: 0 })

      // Production connects through app_user. It may execute the narrow command, while the
      // protected marker/table writes occur with the function owner's privileges.
      await pool.query(
        `INSERT INTO shift_orders
           (id, shift_id, provider_order_no, pay_mode, fee_minor, driver_confirmed, source, kind,
            included, occurred_date, occurred_minute, window_status, created_by)
         VALUES ($1, $2, $3, 'cash', 1000, true, 'ocr', 'yallago', true,
                 DATE '2026-08-13', '19:47', 'unknown', $4)`,
        [appUserOrderId, shiftId, `WIN-APP-USER-${suffix}`, managerId],
      )
      await withTransaction(pool, { actorId: managerId }, async (client) => {
        await client.query('SET LOCAL ROLE app_user')
        const result = await client.query<{ order_updates: number; deduction_updates: number }>(
          'SELECT order_updates, deduction_updates FROM reclassify_shift_operations($1)',
          [shiftId],
        )
        expect(result.rows[0]).toEqual({ order_updates: 1, deduction_updates: 0 })
      })
      expect((await pool.query(
        'SELECT included, window_status::text FROM shift_orders WHERE id = $1',
        [appUserOrderId],
      )).rows[0]).toEqual({ included: false, window_status: 'pre_open' })
    })
  })
}
