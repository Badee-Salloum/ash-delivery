import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/migrate.ts'
import { createPool } from '../src/pool.ts'
import { PgShiftRepo } from '../src/repos-shift.ts'
import { assertDisposableDatabaseUrl } from './disposable-database.ts'

const DATABASE_URL = process.env.DATABASE_URL
if (DATABASE_URL) assertDisposableDatabaseUrl(DATABASE_URL)

if (!DATABASE_URL) {
  describe('PostgreSQL shift open-approval precision', () => {
    it.skip('skipped: set DATABASE_URL to run against real PostgreSQL', () => {})
  })
} else {
  const pool = createPool(DATABASE_URL)
  const shifts = new PgShiftRepo(pool)

  const branchId = randomUUID()
  const managerId = randomUUID()
  const initialDriverId = randomUUID()
  const precisionDriverId = randomUUID()
  const initialVehicleId = randomUUID()
  const precisionVehicleId = randomUUID()
  const initialShiftId = randomUUID()
  const precisionShiftId = randomUUID()
  const suffix = branchId.replaceAll('-', '').slice(0, 12)

  beforeAll(async () => {
    await migrate(pool)

    await pool.query(
      `INSERT INTO branches (id, code, name_ar, name_en, timezone, governorate_id, branch_no)
       SELECT $1, $2, 'فرع اختبار دقة الاعتماد', 'Approval precision', 'Asia/Damascus', g.id, n.branch_no
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
      [branchId, `PREC-${suffix}`],
    )
    await pool.query(
      `INSERT INTO roles (key, name_ar, name_en)
       VALUES ('branch_manager', 'مدير فرع', 'Branch manager')
       ON CONFLICT (key) DO NOTHING`,
    )
    await pool.query(
      `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
       VALUES ($1, $2, 'branch_manager', $3, 'مدير اختبار دقة الاعتماد', 'x')`,
      [managerId, branchId, `approval-precision-manager-${suffix}`],
    )
    await pool.query(
      `INSERT INTO drivers (id, branch_id, code, full_name_ar)
       VALUES
         ($1, $3, $4, 'سائق اختبار الكتابة الأولى'),
         ($2, $3, $5, 'سائق اختبار دقة الميكروثانية')`,
      [initialDriverId, precisionDriverId, branchId, `PREC-DRV-A-${suffix}`, `PREC-DRV-B-${suffix}`],
    )
    await pool.query(
      `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no)
       SELECT $1::uuid, $3::uuid, t.id, $4, 1 FROM vehicle_types t WHERE t.code = 'e_motorbike'
       UNION ALL
       SELECT $2::uuid, $3::uuid, t.id, $5, 2 FROM vehicle_types t WHERE t.code = 'e_motorbike'`,
      [initialVehicleId, precisionVehicleId, branchId, `PREC-VEH-A-${suffix}`, `PREC-VEH-B-${suffix}`],
    )
    await pool.query(
      `INSERT INTO shifts
         (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date, state,
          open_approved_at, open_approved_by)
       VALUES
         ($1, $3, $4, $5, 1, DATE '2026-08-13', DATE '2026-08-09', 'awaiting_open_approval', NULL, NULL),
         ($2, $3, $6, $7, 1, DATE '2026-08-13', DATE '2026-08-09', 'open',
          TIMESTAMPTZ '2026-08-13 16:48:06.268377+00', $8)`,
      [
        initialShiftId,
        precisionShiftId,
        branchId,
        initialDriverId,
        initialVehicleId,
        precisionDriverId,
        precisionVehicleId,
        managerId,
      ],
    )
  })

  afterAll(async () => {
    await pool.end()
  })

  it('allows the initial open-approval timestamp and manager to be written', async () => {
    const shift = await shifts.findById(initialShiftId)
    expect(shift).not.toBeNull()

    await shifts.update(
      {
        ...shift!,
        state: 'open',
        openApprovedAt: '2026-08-13T16:48:06.268Z',
        openApprovedBy: managerId,
      },
      managerId,
    )

    await expect(shifts.findById(initialShiftId)).resolves.toMatchObject({
      state: 'open',
      openApprovedAt: '2026-08-13T16:48:06.268Z',
      openApprovedBy: managerId,
    })
  })

  it('preserves PostgreSQL microseconds when a later state update uses the rounded JS value', async () => {
    const shift = await shifts.findById(precisionShiftId)
    expect(shift).toMatchObject({
      state: 'open',
      // JS Date has millisecond precision; PostgreSQL still holds .268377 below.
      openApprovedAt: '2026-08-13T16:48:06.268Z',
      openApprovedBy: managerId,
    })

    await expect(shifts.update({ ...shift!, state: 'cancelled' }, managerId)).resolves.toBeUndefined()

    const { rows } = await pool.query<{ state: string; approved_at: string; approved_by: string }>(
      `SELECT state,
              to_char(open_approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS approved_at,
              open_approved_by::text AS approved_by
         FROM shifts
        WHERE id = $1`,
      [precisionShiftId],
    )
    expect(rows[0]).toEqual({
      state: 'cancelled',
      approved_at: '2026-08-13T16:48:06.268377Z',
      approved_by: managerId,
    })
  })
}
