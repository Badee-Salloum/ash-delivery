import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { CashDeductionRecord, OperationBatch } from '@ash/contracts'
import { minor } from '@ash/domain'
import { migrate } from '../src/migrate.ts'
import { createPool, withTransaction } from '../src/pool.ts'
import { PgCashDeductionRepo, PgOperationBatchRepo } from '../src/repos.ts'
import { assertDisposableDatabaseUrl } from './disposable-database.ts'

const DATABASE_URL = process.env.DATABASE_URL
if (DATABASE_URL) assertDisposableDatabaseUrl(DATABASE_URL)

if (!DATABASE_URL) {
  describe('PostgreSQL atomic cash-deduction healing', () => {
    it.skip('skipped: set DATABASE_URL to run against real PostgreSQL', () => {})
  })
} else {
  const pool = createPool(DATABASE_URL)

  afterAll(async () => {
    await pool.end()
  })

  describe('PostgreSQL atomic cash-deduction healing', () => {
    it('audits an exact delete and rejects a row changed by a racing manager', async () => {
      await migrate(pool)
      const branchId = randomUUID()
      const driverUserId = randomUUID()
      const managerId = randomUUID()
      const driverId = randomUUID()
      const vehicleId = randomUUID()
      const shiftId = randomUUID()
      const suffix = shiftId.replaceAll('-', '').slice(0, 12)

      await pool.query(
        `INSERT INTO branches (id, code, name_ar, name_en, timezone, governorate_id, branch_no)
         SELECT $1, $2, 'فرع اختبار حذف الحسم', 'Deduction delete', 'Asia/Damascus', g.id, n.branch_no
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
        [branchId, `DEL-${suffix}`],
      )
      await pool.query(
        `INSERT INTO roles (key, name_ar, name_en)
         VALUES ('driver', 'سائق', 'Driver'), ('branch_manager', 'مدير فرع', 'Branch manager')
         ON CONFLICT (key) DO NOTHING`,
      )
      await pool.query(
        `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
         VALUES
           ($1, $3, 'driver', $4, 'سائق اختبار حذف الحسم', 'x'),
           ($2, $3, 'branch_manager', $5, 'مدير اختبار حذف الحسم', 'x')`,
        [driverUserId, managerId, branchId, `deduction-driver-${suffix}`, `deduction-manager-${suffix}`],
      )
      await pool.query(
        `INSERT INTO drivers (id, branch_id, user_id, code, full_name_ar)
         VALUES ($1, $2, $3, $4, 'سائق اختبار حذف الحسم')`,
        [driverId, branchId, driverUserId, `DEL-DRV-${suffix}`],
      )
      await pool.query(
        `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no)
         SELECT $1, $2, t.id, $3, 1
           FROM vehicle_types t
          WHERE t.code = 'e_motorbike'`,
        [vehicleId, branchId, `DEL-VEH-${suffix}`],
      )
      await pool.query(
        `INSERT INTO shifts
           (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date, state,
            open_approved_at, open_approved_by)
         VALUES
           ($1, $2, $3, $4, 1, DATE '2026-08-13', DATE '2026-08-09', 'open',
            TIMESTAMPTZ '2026-08-13 16:49:30+00', $5)`,
        [shiftId, branchId, driverId, vehicleId, managerId],
      )

      const record = (id: string, operationKey: string, pointB: string | null): CashDeductionRecord => ({
        id,
        shiftId,
        operationKey,
        amount: minor(5_000n),
        occurredDate: '2026-08-13',
        occurredMinute: '22:36',
        source: 'ocr',
        amountOcr: minor(5_000n),
        pointA: 'Pickup',
        pointB,
        included: true,
        windowStatus: 'in_window',
        decisionReason: null,
        decidedBy: null,
        decidedAt: null,
        createdBy: driverUserId,
      })
      const deductions = new PgCashDeductionRepo(pool)
      const batches = new PgOperationBatchRepo(pool)
      const partial = record(randomUUID(), 'recent-orders:aaaaaaaaaaaaaaaa', null)
      const richer = record(randomUUID(), 'recent-orders:aaaaaaaaaaaaaaaa~2', 'Dropoff')
      await deductions.create(partial, driverUserId)
      await deductions.create(richer, driverUserId)

      const emptyBatch = (patch: Partial<OperationBatch>): OperationBatch => ({
        orderCreates: [],
        orderUpdates: [],
        orderPointReplacements: [],
        cashDeductionCreates: [],
        cashDeductionUpdates: [],
        movements: [],
        ...patch,
      })
      await expect(batches.apply(shiftId, emptyBatch({
        cashDeductionDeletes: [{ expected: partial }],
        // Fails after the DELETE; the transaction must restore the poorer row and its audit trail.
        cashDeductionCreates: [record(randomUUID(), richer.operationKey, 'Conflicting duplicate')],
      }), driverUserId)).rejects.toMatchObject({ code: 'DUPLICATE_CASH_DEDUCTION' })
      expect((await deductions.listByShift(shiftId)).map((row) => row.id).sort()).toEqual([
        partial.id,
        richer.id,
      ].sort())
      expect((await pool.query(
        `SELECT 1 FROM audit_log
          WHERE table_name = 'cash_deductions' AND record_id = $1 AND action = 'DELETE'`,
        [partial.id],
      )).rowCount).toBe(0)

      await batches.apply(shiftId, emptyBatch({
        cashDeductionDeletes: [{ expected: partial }],
      }), driverUserId)
      expect((await deductions.listByShift(shiftId)).map((row) => row.id)).toEqual([richer.id])
      expect((await pool.query<{ actor_id: string | null }>(
        `SELECT actor_id::text
           FROM audit_log
          WHERE table_name = 'cash_deductions' AND record_id = $1 AND action = 'DELETE'`,
        [partial.id],
      )).rows).toEqual([{ actor_id: driverUserId }])

      const racing = record(randomUUID(), 'recent-orders:bbbbbbbbbbbbbbbb', null)
      await deductions.create(racing, driverUserId)
      await withTransaction(pool, { actorId: managerId }, async (client) => {
        await client.query(
          `UPDATE cash_deductions
              SET decision_reason = 'manager confirmed a separate operation',
                  decided_by = $2,
                  decided_at = clock_timestamp()
            WHERE id = $1`,
          [racing.id, managerId],
        )
      })
      await expect(batches.apply(shiftId, emptyBatch({
        cashDeductionDeletes: [{ expected: racing }],
      }), driverUserId)).rejects.toMatchObject({ code: 'STALE_OPERATION_BATCH' })
      expect((await deductions.listByShift(shiftId)).find((row) => row.id === racing.id)).toMatchObject({
        decidedBy: managerId,
        decisionReason: 'manager confirmed a separate operation',
      })
    })
  })
}
