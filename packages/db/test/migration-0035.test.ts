import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/migrate.ts'
import { createPool } from '../src/pool.ts'
import { assertDisposableDatabaseUrl } from './disposable-database.ts'

const migration = readFileSync(
  new URL('../migrations/0035_shift_money_integrity.sql', import.meta.url),
  'utf8',
)
const compact = migration.replace(/\s+/g, ' ')

describe('migration 0035 shift-money integrity', () => {
  it('turns the variance reason guard into an explicit visible-text boolean for SQL NULL and Unicode controls', () => {
    expect(compact).toContain('CREATE FUNCTION ash_has_visible_text(value text) RETURNS boolean')
    expect(compact).toContain('regexp_replace(')
    expect(compact).toContain('\\200B-\\200F')
    expect(compact).toContain(
      "char_length(COALESCE(variance_reason, '')) <= 500",
    )
    expect(compact).toContain(
      'variance_minor = 0 OR ash_has_visible_text(variance_reason)',
    )
    expect(compact).not.toContain("NULLIF(btrim(variance_reason), '') IS NOT NULL")
  })

  it('adds an index-only branch path restricted to exactly open shifts', () => {
    expect(compact).toContain(
      'CREATE INDEX shifts_branch_open_idx ON shifts (branch_id) INCLUDE (driver_id, vehicle_id)',
    )
    expect(compact).toContain("WHERE state = 'open'")
    expect(compact).not.toMatch(/WHERE state IN \([^)]*suspended/i)
  })

  it('allows the transactional force-cancel decision in the append-only decision log', () => {
    expect(compact).toContain("'force_close_prepared', 'force_cancelled'")
    expect(compact).toContain('ALTER TABLE shift_decisions')
    expect(compact).toContain("decision <> 'force_cancelled' OR (gate = 'close' AND ash_has_visible_text(notes))")
  })
})

const DATABASE_URL = process.env.DATABASE_URL
if (DATABASE_URL) assertDisposableDatabaseUrl(DATABASE_URL)

if (!DATABASE_URL) {
  describe('migration 0035 PostgreSQL variance guard', () => {
    it.skip('skipped: set DATABASE_URL to run against a disposable PostgreSQL database', () => {})
  })
} else {
  const pool = createPool(DATABASE_URL)

  afterAll(async () => {
    await pool.end()
  })

  describe('migration 0035 PostgreSQL variance guard', () => {
    it('rejects NULL/blank non-zero reasons on the real settlement table and accepts an explicit reason', async () => {
      await migrate(pool)
      const client = await pool.connect()
      const branchId = randomUUID()
      const managerId = randomUUID()
      const driverId = randomUUID()
      const vehicleId = randomUUID()
      const shiftId = randomUUID()
      const suffix = branchId.replaceAll('-', '').slice(0, 12)

      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO roles (key, name_ar, name_en)
           VALUES ('branch_manager', 'مدير فرع', 'Branch manager')
           ON CONFLICT (key) DO NOTHING`,
        )
        await client.query(
          `INSERT INTO branches
             (id, code, name_ar, name_en, timezone, governorate_id, branch_no)
           SELECT $1, $2, 'فرع اختبار التسوية', 'Settlement guard test', 'Asia/Damascus', g.id, n.branch_no
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
          [branchId, `SETTLEMENT-GUARD-${suffix}`],
        )
        await client.query(
          `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
           VALUES ($1, $2, 'branch_manager', $3, 'مدير اختبار التسوية', 'x')`,
          [managerId, branchId, `settlement-guard-${suffix}`],
        )
        await client.query(
          `INSERT INTO drivers (id, branch_id, code, full_name_ar)
           VALUES ($1, $2, $3, 'سائق اختبار التسوية')`,
          [driverId, branchId, `SETTLEMENT-DRV-${suffix}`],
        )
        await client.query(
          `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no)
           SELECT $1, $2, t.id, $3, 1
             FROM vehicle_types t
            WHERE t.code = 'e_motorbike'`,
          [vehicleId, branchId, `SETTLEMENT-VEH-${suffix}`],
        )
        await client.query(
          `INSERT INTO shifts
             (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date,
              state, submitted_at)
           VALUES ($1, $2, $3, $4, 1, DATE '2026-08-22', DATE '2026-08-16',
                   'pending_review', TIMESTAMPTZ '2026-08-22 12:00:00+00')`,
          [shiftId, branchId, driverId, vehicleId],
        )
        await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', managerId])

        const insertSettlement = (varianceReason: string | null) => client.query(
          `INSERT INTO shift_settlements (
             shift_id, branch_id, driver_id, business_date,
             policy_code, driver_rate_bps, delivery_fee_total_minor,
             fixed_driver_share_minor, manual_driver_share_minor, gross_driver_share_minor,
             cash_deduction_total_minor, base_driver_share_minor,
             expected_total_minor, actual_cash_minor, actual_wallet_minor, actual_total_minor,
             variance_minor, variance_direction, final_employee_cash_minor,
             wallet_to_office_minor, cash_to_office_minor,
             wallet_action, wallet_amount_minor, cash_action, cash_amount_minor,
             reviewed_orders_hash, settlement_hash,
             wallet_transfer_confirmed, cash_settlement_confirmed,
             confirmed_by, confirmed_at, variance_reason
           ) VALUES (
             $1, $2, $3, DATE '2026-08-22',
             'fixed_40_cash_close_v1', 4000, 0,
             0, 0, 0, 0, 0,
             0, 1, 0, 1,
             1, 'surplus', 1,
             0, 0, 'none', 0, 'none', 0,
             'reviewed', repeat('a', 64), true, true,
             $4, TIMESTAMPTZ '2026-08-22 12:01:00+00', $5
           )`,
          [shiftId, branchId, driverId, managerId, varianceReason],
        )

        await client.query('SAVEPOINT null_reason')
        await expect(insertSettlement(null)).rejects.toMatchObject({
          code: '23514',
          constraint: 'shift_settlements_variance_reason_ck',
        })
        await client.query('ROLLBACK TO SAVEPOINT null_reason')

        await client.query('SAVEPOINT blank_reason')
        await expect(insertSettlement('   ')).rejects.toMatchObject({
          code: '23514',
          constraint: 'shift_settlements_variance_reason_ck',
        })
        await client.query('ROLLBACK TO SAVEPOINT blank_reason')

        await client.query('SAVEPOINT whitespace_reason')
        await expect(insertSettlement('\t\n')).rejects.toMatchObject({
          code: '23514',
          constraint: 'shift_settlements_variance_reason_ck',
        })
        await client.query('ROLLBACK TO SAVEPOINT whitespace_reason')

        await client.query('SAVEPOINT invisible_reason')
        await expect(insertSettlement('\u200B\u2060')).rejects.toMatchObject({
          code: '23514',
          constraint: 'shift_settlements_variance_reason_ck',
        })
        await client.query('ROLLBACK TO SAVEPOINT invisible_reason')

        await client.query('SAVEPOINT explicit_reason')
        await expect(insertSettlement('counted cash surplus')).resolves.toMatchObject({ rowCount: 1 })
        await client.query('ROLLBACK TO SAVEPOINT explicit_reason')

        const insertForceCancel = (gate: 'open' | 'close', notes: string | null) => client.query(
          `INSERT INTO shift_decisions
             (shift_id, gate, decision, notes, decided_by, decided_at)
           VALUES ($1, $2, 'force_cancelled', $3, $4, TIMESTAMPTZ '2026-08-22 12:02:00+00')`,
          [shiftId, gate, notes, managerId],
        )

        for (const [label, gate, notes] of [
          ['wrong_gate', 'open', 'verified cancellation'],
          ['null_cancel_reason', 'close', null],
          ['blank_cancel_reason', 'close', ' \t\n'],
          ['invisible_cancel_reason', 'close', '\u200B\u2060'],
        ] as const) {
          await client.query(`SAVEPOINT ${label}`)
          await expect(insertForceCancel(gate, notes)).rejects.toMatchObject({
            code: '23514',
            constraint: 'shift_decisions_decision_check',
          })
          await client.query(`ROLLBACK TO SAVEPOINT ${label}`)
        }

        await client.query('SAVEPOINT explicit_cancel_reason')
        await expect(insertForceCancel('close', 'manager verified abandonment')).resolves.toMatchObject({ rowCount: 1 })
        await client.query('ROLLBACK TO SAVEPOINT explicit_cancel_reason')
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })
  })
}
