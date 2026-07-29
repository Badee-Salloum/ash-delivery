import { afterAll, describe, it } from 'vitest'
import type { Deps } from '@ash/contracts'
import { runConformanceSuite } from '@ash/testkit/conformance'
import { assertBigIntParser, createPool } from '../src/pool.ts'
import { migrate } from '../src/migrate.ts'
import { PgAuditRepo, PgFxRepo, PgLedgerRepo, PgOrderRepo, PgSessionRepo, PgUserRepo } from '../src/repos.ts'
import {
  PgCashCountRepo,
  PgNotificationRepo,
  PgDirectoryRepo,
  PgExpenseRepo,
  PgMediaRepo,
  PgSettingsRepo,
  PgTierRepo,
  PgAssignmentRepo,
  PgAttendanceRepo,
  PgBatteryReadingRepo,
  PgBatterySwapRepo,
  PgShiftDecisionRepo,
  PgGpsPingRepo,
  PgShiftRepo,
  PgVehicleEventRepo,
  PgWeekLockRepo,
} from '../src/repos-shift.ts'

/**
 * The PostgreSQL adapters run the SAME conformance suite as the in-memory ones.
 *
 * Skipped when DATABASE_URL is absent, so a laptop without Docker still gets a green suite —
 * but CI always sets it, so the adapters are never merged unproven. A behaviour that differs
 * between the two implementations is a bug in one of them, and this is where it surfaces.
 */
const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  describe('PostgreSQL conformance', () => {
    it.skip('skipped: set DATABASE_URL to run against real Postgres (CI always does)', () => {})
  })
} else {
  const pool = createPool(DATABASE_URL)
  let schemaReady: Promise<void> | null = null

  const ensureSchema = async (): Promise<void> => {
    schemaReady ??= (async () => {
      await assertBigIntParser(pool)
      await migrate(pool)
    })()
    return schemaReady
  }

  const BRANCH = '11111111-1111-1111-1111-111111111111'
  const USER = '22222222-2222-2222-2222-222222222222'
  const SHIFT = '55555555-5555-5555-5555-555555555555'

  runConformanceSuite({
    label: 'postgres',
    async makeDeps(): Promise<Deps> {
      await ensureSchema()

      // Truncate rather than re-migrate: orders of magnitude faster, and it exercises the real
      // constraints on every run instead of a freshly-empty database.
      await pool.query(`
        TRUNCATE journal_lines, journal_entries, shift_orders, shift_media, media, float_tranches, expenses, expense_categories, settings, cash_counts, cash_count_lines, tier_rules, notifications,
                 shift_battery_readings, gps_pings, batteries,
                 shifts, funds, fx_days, week_locks, audit_log, sessions, drivers, vehicles,
                 vehicle_types, users, branches, governorates
        RESTART IDENTITY CASCADE
      `)

      await pool.query(
        `INSERT INTO governorates (id, no, name_ar, name_en)
         VALUES ('99999999-9999-9999-9999-999999999999', 1, 'دمشق', 'Damascus')`,
      )
      await pool.query(
        `INSERT INTO branches (id, code, name_ar, name_en, governorate_id, branch_no)
         VALUES ($1, 'DAM', 'دمشق', 'Damascus', '99999999-9999-9999-9999-999999999999', 1)`,
        [BRANCH],
      )
      await pool.query(
        `INSERT INTO roles (key, name_ar, name_en) VALUES ('system_admin','مدير النظام','System Admin')
         ON CONFLICT (key) DO NOTHING`,
      )
      await pool.query(
        `INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
         VALUES ($1, $2, 'system_admin', 'conformance', 'اختبار', 'x')`,
        [USER, BRANCH],
      )
      await pool.query(
        `INSERT INTO vehicle_types (id, code, name_ar, name_en, type_no)
         VALUES ('66666666-6666-6666-6666-666666666666','e_motorbike','دراجة','E-Motorbike', 1)`,
      )
      await pool.query(
        `INSERT INTO drivers (id, branch_id, code, full_name_ar)
         VALUES ('77777777-7777-7777-7777-777777777777', $1, 'DRV-C', 'سائق')`,
        [BRANCH],
      )
      await pool.query(
        `INSERT INTO vehicles (id, branch_id, vehicle_type_id, code, machine_no)
         VALUES ('88888888-8888-8888-8888-888888888888', $1, '66666666-6666-6666-6666-666666666666','1-1-1-1', 1)`,
        [BRANCH],
      )
      await pool.query(
        `INSERT INTO shifts (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date)
         VALUES ($1, $2, '77777777-7777-7777-7777-777777777777','88888888-8888-8888-8888-888888888888',
                 1, DATE '2026-07-21', DATE '2026-07-19')`,
        [SHIFT, BRANCH],
      )
      await pool.query(
        `INSERT INTO fx_days (id, business_date, syp_minor_per_usd) VALUES (1, DATE '2026-07-21', 13000)
         ON CONFLICT (business_date) DO NOTHING`,
      )

      /**
       * Ports the suite does not exercise yet. A Proxy that throws on USE rather than a value
       * that throws on construction — so the failure names the exact method, and adding a test
       * for one of these produces a clear message instead of a mystery.
       */
      const notYetImplemented = <T extends object>(name: string): T =>
        new Proxy({} as T, {
          get: (_target, prop) => () => {
            throw new Error(`${name}.${String(prop)}() has no PostgreSQL adapter yet`)
          },
        })

      return {
        clock: { nowMs: () => Date.UTC(2026, 6, 21, 5, 0, 0), offsetMinutes: () => 180 },
        ids: { uuid: () => crypto.randomUUID(), token: () => 'token' },
        hasher: { hash: async (p: string) => p, verify: async (p: string, h: string) => p === h },
        // The suite never encrypts (it writes/reads document bytes directly), so a stub suffices.
        cipher: notYetImplemented('Cipher'),
        users: new PgUserRepo(pool),
        sessions: new PgSessionRepo(pool),
        shifts: new PgShiftRepo(pool),
        batteryReadings: new PgBatteryReadingRepo(pool),
        batterySwaps: new PgBatterySwapRepo(pool),
        assignments: new PgAssignmentRepo(pool),
        orders: new PgOrderRepo(pool),
        ledger: new PgLedgerRepo(pool),
        expenses: new PgExpenseRepo(pool),
        cashCounts: new PgCashCountRepo(pool),
        tiers: new PgTierRepo(pool),
        notifications: new PgNotificationRepo(pool),
        settings: new PgSettingsRepo(pool),
        media: new PgMediaRepo(pool),
        // Blob storage is not a database concern; the suite exercises MediaRepo, not bytes.
        blobs: notYetImplemented('BlobStore'),
        fx: new PgFxRepo(pool),
        weekLocks: new PgWeekLockRepo(pool),
        audit: new PgAuditRepo(pool),
        directory: new PgDirectoryRepo(pool),
        vehicleEvents: new PgVehicleEventRepo(pool),
        attendance: new PgAttendanceRepo(pool),
        decisions: new PgShiftDecisionRepo(pool),
        gps: new PgGpsPingRepo(pool),
      }
    },
  })

  afterAll(async () => {
    await pool.end()
  })
}
