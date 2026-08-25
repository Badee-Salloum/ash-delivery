import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/migrate.ts'
import { createPool, type PoolClient } from '../src/pool.ts'
import {
  assertDisposableDatabaseConnection,
  assertDisposableDatabaseUrl,
} from './disposable-database.ts'

const DATABASE_URL = process.env.DATABASE_URL
const migrationsDir = new URL('../migrations/', import.meta.url)

const migration41 = readFileSync(
  new URL('0041_deferred_collection_funds_next_shift.sql', migrationsDir),
  'utf8',
)

interface Fixture {
  branchId: string
  managerId: string
  driverId: string
  vehicleId: string
  shiftId: string
  batteryId: string
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`

const applyMigrationsThrough0040 = async (client: PoolClient): Promise<void> => {
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && file <= '0040_preapproved_shift_rules.sql')
    .sort()

  expect(files.at(-1)).toBe('0040_preapproved_shift_rules.sql')
  expect(files).toHaveLength(40)
  for (const file of files) {
    await client.query(readFileSync(new URL(file, migrationsDir), 'utf8'))
  }
}

const insertFixture = async (
  client: PoolClient,
  state: 'draft' | 'open' | 'pending_review' = 'draft',
): Promise<Fixture> => {
  const branchId = randomUUID()
  const managerId = randomUUID()
  const driverId = randomUUID()
  const vehicleId = randomUUID()
  const shiftId = randomUUID()
  const batteryId = randomUUID()
  const suffix = branchId.replaceAll('-', '').slice(0, 12)

  await client.query(
    `INSERT INTO roles (key, name_ar, name_en)
     VALUES ('branch_manager', 'مدير فرع', 'Branch manager')
     ON CONFLICT (key) DO NOTHING`,
  )
  await client.query(
    `INSERT INTO branches
       (id, code, name_ar, name_en, timezone, governorate_id, branch_no)
     SELECT $1, $2, 'فرع اختبار المهاجرة', 'Migration behavior test',
            'Asia/Damascus', g.id, n.branch_no
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
    [branchId, `MIGRATION-BEHAVIOR-${suffix}`],
  )
  await client.query(
    `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
     VALUES ($1, $2, 'branch_manager', $3, 'مدير اختبار المهاجرة', 'x')`,
    [managerId, branchId, `migration-manager-${suffix}`],
  )
  await client.query(
    `INSERT INTO drivers (id, branch_id, code, full_name_ar)
     VALUES ($1, $2, $3, 'سائق اختبار المهاجرة')`,
    [driverId, branchId, `MIGRATION-DRV-${suffix}`],
  )
  await client.query(
    `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no)
     SELECT $1, $2, t.id, $3, 1
       FROM vehicle_types t
      WHERE t.code = 'e_motorbike'`,
    [vehicleId, branchId, `MIGRATION-VEH-${suffix}`],
  )
  await client.query(
    `INSERT INTO batteries
       (id, branch_id, serial_no, capacity_ah, vehicle_id, slot_no)
     VALUES ($1, $2, $3, 50, $4, 1)`,
    [batteryId, branchId, `MIGRATION-BAT-${suffix}`, vehicleId],
  )
  await client.query(
    `INSERT INTO shifts
       (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date,
        state, submitted_at)
     VALUES ($1, $2, $3, $4, 1, DATE '2026-08-26', DATE '2026-08-23',
             $5::shift_state,
             CASE WHEN $5 = 'pending_review'
                  THEN TIMESTAMPTZ '2026-08-26 12:00:00+00' ELSE NULL END)`,
    [shiftId, branchId, driverId, vehicleId, state],
  )
  await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', managerId])
  await client.query('SELECT set_config($1, $2, true)', [
    'app.request_id',
    `migration-behavior-${suffix}`,
  ])

  return { branchId, managerId, driverId, vehicleId, shiftId, batteryId }
}

if (!DATABASE_URL) {
  describe('migrations 0041-0044 PostgreSQL behavior', () => {
    it.skip('skipped: set DATABASE_URL to a positively identified disposable PostgreSQL database', () => {})
  })
} else {
  const disposable = assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = createPool(DATABASE_URL)

  afterAll(async () => {
    await pool.end()
  })

  describe('migrations 0041-0044 PostgreSQL behavior', () => {
    it(
      '0041 refuses a schema-0040 database with a non-zero deferral before replacing the matcher',
      async () => {
        await assertDisposableDatabaseConnection(pool, disposable)
        const databaseName = `ash_guardcheck_m0041_${process.pid}_${randomUUID()
          .replaceAll('-', '')
          .slice(0, 10)}`
        const databaseUrl = new URL(DATABASE_URL)
        databaseUrl.pathname = `/${databaseName}`
        const isolatedUrl = databaseUrl.toString()
        const isolatedIdentity = assertDisposableDatabaseUrl(isolatedUrl)
        let databaseCreated = false
        let isolatedPool: ReturnType<typeof createPool> | null = null

        try {
          await pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
          databaseCreated = true
          isolatedPool = createPool(isolatedUrl, 1)
          await assertDisposableDatabaseConnection(isolatedPool, isolatedIdentity)
          const setup = await isolatedPool.connect()
          try {
            await applyMigrationsThrough0040(setup)
            const oldMatcher = await setup.query<{ definition: string }>(
              `SELECT pg_get_functiondef(
                        'shift_close_journals_match(uuid)'::regprocedure
                      ) AS definition`,
            )
            expect(oldMatcher.rows[0]!.definition).toContain(
              "'cash_settlement_deferred', 'driver_receivable_cash'",
            )
            expect(oldMatcher.rows[0]!.definition).toContain(
              "'wallet_settlement_deferred', 'driver_receivable_wallet'",
            )

            await setup.query('BEGIN')
            const fixture = await insertFixture(setup, 'pending_review')
            await setup.query(
              `INSERT INTO shift_settlements (
                 shift_id, branch_id, driver_id, business_date,
                 policy_code, driver_rate_bps, delivery_fee_total_minor,
                 fixed_driver_share_minor, manual_driver_share_minor, gross_driver_share_minor,
                 cash_deduction_total_minor, base_driver_share_minor,
                 expected_total_minor, actual_cash_minor, actual_wallet_minor, actual_total_minor,
                 variance_minor, variance_direction, final_employee_cash_minor,
                 cash_claim_to_office_minor, wallet_claim_to_office_minor,
                 cash_receivable_deferred_minor, wallet_receivable_deferred_minor,
                 wallet_to_office_minor, cash_to_office_minor,
                 wallet_action, wallet_amount_minor, cash_action, cash_amount_minor,
                 reviewed_orders_hash, settlement_hash,
                 wallet_transfer_confirmed, cash_settlement_confirmed,
                 confirmed_by, confirmed_at, variance_reason
               ) VALUES (
                 $1, $2, $3, DATE '2026-08-26',
                 'fixed_40_cash_close_v2_receivable', 4000, 0,
                 0, 0, 0, 0, 0,
                 1000, 1000, 0, 1000,
                 0, 'balanced', 0,
                 1000, 0,
                 100, 0,
                 0, 900,
                 'none', 0, 'collect', 900,
                 'reviewed', repeat('4', 64), true, true,
                 $4, TIMESTAMPTZ '2026-08-26 12:01:00+00', NULL
               )`,
              [fixture.shiftId, fixture.branchId, fixture.driverId, fixture.managerId],
            )

            await expect(setup.query(migration41)).rejects.toMatchObject({
              code: 'P0001',
              message: expect.stringContaining(
                'refusing to replace the close matcher: 0 wallet and 1 cash deferral(s)',
              ),
              hint: expect.stringContaining('Move each balance to driver_shift_funding_*'),
            })
            await setup.query('ROLLBACK')

            const matcherAfterRefusal = await setup.query<{ definition: string }>(
              `SELECT pg_get_functiondef(
                        'shift_close_journals_match(uuid)'::regprocedure
                      ) AS definition`,
            )
            expect(matcherAfterRefusal.rows[0]!.definition).toBe(
              oldMatcher.rows[0]!.definition,
            )
          } finally {
            await setup.query('ROLLBACK').catch(() => undefined)
            setup.release()
          }
        } finally {
          if (isolatedPool) await isolatedPool.end()
          if (databaseCreated) {
            await pool.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`)
          }
        }
      },
      120_000,
    )

    it('0042 rejects an unavailable driver reading with a percent and accepts a manager reading', async () => {
      await assertDisposableDatabaseConnection(pool, disposable)
      await migrate(pool)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const fixture = await insertFixture(client)
        const insertReading = (source: 'manual' | 'ocr' | 'manager') =>
          client.query(
            `INSERT INTO shift_battery_readings
               (shift_id, battery_id, package, percent, source, unavailable)
             VALUES ($1, $2, 'start', 40, $3, true)`,
            [fixture.shiftId, fixture.batteryId, source],
          )

        for (const source of ['manual', 'ocr'] as const) {
          await client.query(`SAVEPOINT rejected_${source}`)
          await expect(insertReading(source)).rejects.toMatchObject({
            code: '23514',
            constraint: 'shift_battery_readings_unavailable_ck',
          })
          await client.query(`ROLLBACK TO SAVEPOINT rejected_${source}`)
        }

        await client.query(
          `UPDATE shifts
              SET state = 'awaiting_open_approval',
                  driver_confirmed_at = TIMESTAMPTZ '2026-08-26 11:59:00+00'
            WHERE id = $1`,
          [fixture.shiftId],
        )
        await expect(insertReading('manager')).resolves.toMatchObject({ rowCount: 1 })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it('0043 rejects invisible decision reasons and accepts visible Arabic wrapped in an RLM', async () => {
      await assertDisposableDatabaseConnection(pool, disposable)
      await migrate(pool)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const fixture = await insertFixture(client)
        let sequence = 0
        const insertOrder = (reason: string) => {
          sequence += 1
          return client.query(
            `INSERT INTO shift_orders
               (shift_id, provider_order_no, pay_mode, fee_minor, source, driver_confirmed,
                decision_reason, decided_by, decided_at, created_by)
             VALUES ($1, $2, 'cash', 100, 'manual', true,
                     $3, $4, TIMESTAMPTZ '2026-08-26 12:10:00+00', $4)`,
            [
              fixture.shiftId,
              `MIGRATION-ORDER-${fixture.shiftId}-${sequence}`,
              reason,
              fixture.managerId,
            ],
          )
        }
        const insertDeduction = (reason: string) => {
          sequence += 1
          return client.query(
            `INSERT INTO cash_deductions
               (shift_id, operation_key, amount_minor, source,
                decision_reason, decided_by, decided_at, created_by)
             VALUES ($1, $2, 100, 'manual',
                     $3, $4, TIMESTAMPTZ '2026-08-26 12:10:00+00', $4)`,
            [
              fixture.shiftId,
              `MIGRATION-DEDUCTION-${sequence}`,
              reason,
              fixture.managerId,
            ],
          )
        }

        const invisibleReasons = [
          ['tab', '\t'],
          ['right_to_left_mark', '\u200F'],
          ['zero_width_space', '\u200B'],
          ['format_controls_only', '\u2060\u2063'],
        ] as const

        for (const [label, reason] of invisibleReasons) {
          await client.query(`SAVEPOINT order_${label}`)
          await expect(insertOrder(reason)).rejects.toMatchObject({
            code: '23514',
            constraint: 'shift_orders_decision_ck',
          })
          await client.query(`ROLLBACK TO SAVEPOINT order_${label}`)

          await client.query(`SAVEPOINT deduction_${label}`)
          await expect(insertDeduction(reason)).rejects.toMatchObject({
            code: '23514',
            constraint: 'cash_deductions_decision_ck',
          })
          await client.query(`ROLLBACK TO SAVEPOINT deduction_${label}`)
        }

        const visibleArabicReason = '\u200Fتمت مراجعة الطلب يدوياً'
        await expect(insertOrder(visibleArabicReason)).resolves.toMatchObject({ rowCount: 1 })
        await expect(insertDeduction(visibleArabicReason)).resolves.toMatchObject({ rowCount: 1 })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it('0044 persists read_budget_exhausted as a terminal close-draft read', async () => {
      await assertDisposableDatabaseConnection(pool, disposable)
      await migrate(pool)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const fixture = await insertFixture(client, 'open')
        const mediaId = randomUUID()
        const readId = randomUUID()
        const attachmentToken = randomUUID()
        await client.query(
          `INSERT INTO media
             (id, branch_id, sha256, byte_size, mime_type, storage_key,
              received_at, uploaded_by)
           VALUES ($1, $2, repeat('a', 64), 1, 'image/jpeg', $3,
                   TIMESTAMPTZ '2026-08-26 12:00:00+00', $4)`,
          [mediaId, fixture.branchId, `migration/read-budget/${mediaId}`, fixture.managerId],
        )
        await client.query(
          `INSERT INTO shift_close_drafts
             (shift_id, revision, draft_hash, payload, updated_at, updated_by)
           VALUES ($1, 0, repeat('b', 64), '{}'::jsonb,
                   TIMESTAMPTZ '2026-08-26 12:01:00+00', $2)`,
          [fixture.shiftId, fixture.managerId],
        )
        await expect(client.query(
          `INSERT INTO shift_close_draft_reads
             (id, shift_id, media_id, attachment_token, package, slot, field,
              status, failure, attempts, result, created_at, updated_at, created_by)
           VALUES ($1, $2, $3, $4, 'end', 'dashboard', 'orders',
                   'failed', 'read_budget_exhausted', 1, '{"rowCount":0}'::jsonb,
                   TIMESTAMPTZ '2026-08-26 12:02:00+00',
                   TIMESTAMPTZ '2026-08-26 12:02:00+00', $5)`,
          [readId, fixture.shiftId, mediaId, attachmentToken, fixture.managerId],
        )).resolves.toMatchObject({ rowCount: 1 })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })
  })
}
