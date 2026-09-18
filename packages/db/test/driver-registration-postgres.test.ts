import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { DriverAccountProvisionInput } from '@ash/contracts'
import { migrate } from '../src/migrate.ts'
import { createPool } from '../src/pool.ts'
import { PgDriverAccountProvisioningRepo } from '../src/repos-driver-account.ts'
import { assertDisposableDatabaseConnection, assertDisposableDatabaseUrl } from './disposable-database.ts'

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  describe('PostgreSQL driver registration', () => {
    it.skip('skipped: set DATABASE_URL to a positively identified disposable database', () => {})
  })
} else {
  const disposable = assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = createPool(DATABASE_URL)
  const repo = new PgDriverAccountProvisioningRepo(pool)
  const secondRepo = new PgDriverAccountProvisioningRepo(pool)
  const BRANCH = '11111111-1111-4111-8111-111111111111'

  const input = (suffix = '1'): DriverAccountProvisionInput => ({
    user: {
      id: `20000000-0000-4000-8000-00000000000${suffix}`,
      branchId: BRANCH,
      roleKey: 'driver',
      username: `driver-${suffix}`,
      fullNameAr: 'سائق اختبار',
      passwordHash: '$2b$12$credential-material-must-not-enter-audit',
      driverId: null,
      mfaSecret: null,
      mfaEnrolledAtMs: null,
      failedAttempts: 0,
      lockedUntilMs: null,
      active: true,
    },
    driver: {
      id: `30000000-0000-4000-8000-00000000000${suffix}`,
      branchId: BRANCH,
      userId: `20000000-0000-4000-8000-00000000000${suffix}`,
      code: `driver-${suffix}`,
      fullNameAr: 'سائق اختبار',
      active: true,
    },
    session: {
      id: `40000000-0000-4000-8000-00000000000${suffix}`,
      userId: `20000000-0000-4000-8000-00000000000${suffix}`,
      tokenHash: `token-hash-${suffix}`,
      mfaSatisfied: true,
      createdAtMs: Date.UTC(2026, 8, 18, 10),
      lastSeenAtMs: Date.UTC(2026, 8, 18, 10),
      expiresAtMs: Date.UTC(2026, 8, 18, 18),
      revokedAtMs: null,
    },
    audit: {
      actorId: null,
      actorKind: 'anonymous',
      requestId: `registration-${suffix}`,
      occurredAtMs: Date.UTC(2026, 8, 18, 10),
    },
  })

  beforeEach(async () => {
    await assertDisposableDatabaseConnection(pool, disposable)
    await migrate(pool)
    await pool.query(`
      TRUNCATE driver_registration_attempts, sessions, drivers, audit_log, users, branches, governorates
      RESTART IDENTITY CASCADE
    `)
    await pool.query(
      `INSERT INTO governorates (id, no, name_ar, name_en)
       VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'دمشق', 'Damascus')`,
    )
    await pool.query(
      `INSERT INTO roles (key, name_ar, name_en) VALUES
         ('driver', 'سائق', 'Driver'),
         ('general_manager', 'المدير العام', 'General manager')
       ON CONFLICT (key) DO NOTHING`,
    )
    await pool.query(
      `INSERT INTO branches (id, code, name_ar, name_en, governorate_id, branch_no)
       VALUES ($1, 'DAM', 'دمشق', 'Damascus', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1)`,
      [BRANCH],
    )
    await pool.query('TRUNCATE audit_log RESTART IDENTITY')
  })

  afterAll(async () => {
    await pool.end()
  })

  describe('PostgreSQL driver registration', () => {
    it('commits user, driver, session, and password-free anonymous audit facts together', async () => {
      await repo.provision(input())
      expect((await pool.query('SELECT id FROM users WHERE username = $1', ['driver-1'])).rowCount).toBe(1)
      expect((await pool.query('SELECT id FROM drivers WHERE code = $1', ['driver-1'])).rowCount).toBe(1)
      expect((await pool.query('SELECT id FROM sessions WHERE token_hash = $1', ['token-hash-1'])).rowCount).toBe(1)

      const audit = await pool.query<{ actor_kind: string; facts: string }>(
        `SELECT actor_kind, coalesce(before::text, '') || coalesce(after::text, '') AS facts
           FROM audit_log
          WHERE request_id = 'registration-1'`,
      )
      expect(audit.rowCount).toBeGreaterThanOrEqual(3)
      expect(audit.rows.every((row) => row.actor_kind === 'anonymous')).toBe(true)
      expect(audit.rows.map((row) => row.facts).join(' ')).not.toContain('password_hash')
      expect(audit.rows.map((row) => row.facts).join(' ')).not.toContain('credential-material')
    })

    it('rolls user, driver, their trigger audits, and the session back after a late failure', async () => {
      await pool.query(
        `INSERT INTO users (id, role_key, username, full_name_ar, password_hash)
         VALUES ('50000000-0000-4000-8000-000000000001', 'general_manager', 'existing', 'موجود', 'x')`,
      )
      await pool.query(
        `INSERT INTO sessions (id, user_id, token_hash, mfa_satisfied, expires_at)
         VALUES ('40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', 'existing-token', true, now() + interval '8 hours')`,
      )
      await pool.query('TRUNCATE audit_log RESTART IDENTITY')
      const lateFailure = input('2')
      await expect(repo.provision(lateFailure)).rejects.toMatchObject({ code: '23505' })

      expect((await pool.query('SELECT id FROM users WHERE id = $1', [lateFailure.user.id])).rowCount).toBe(0)
      expect((await pool.query('SELECT id FROM drivers WHERE id = $1', [lateFailure.driver.id])).rowCount).toBe(0)
      expect((await pool.query('SELECT id FROM audit_log WHERE request_id = $1', [lateFailure.audit.requestId])).rowCount).toBe(0)
    })

    it('allows one winner for concurrent duplicate provisioning', async () => {
      const duplicate = input('3')
      const results = await Promise.allSettled([
        repo.provision(duplicate),
        secondRepo.provision(duplicate),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      expect((await pool.query('SELECT id FROM users WHERE username = $1', [duplicate.user.username])).rowCount).toBe(1)
      expect((await pool.query('SELECT id FROM drivers WHERE code = $1', [duplicate.driver.code])).rowCount).toBe(1)
      expect((await pool.query('SELECT id FROM sessions WHERE token_hash = $1', [duplicate.session!.tokenHash])).rowCount).toBe(1)
    })

    it('allows exactly three rolling-hour claims and does not extend a denied window', async () => {
      const now = Date.UTC(2026, 8, 18, 10)
      await pool.query(
        `INSERT INTO driver_registration_attempts (address_sha256, attempted_at)
         VALUES ($1, to_timestamp($2::double precision / 1000))`,
        ['d'.repeat(64), now - 24 * 60 * 60 * 1000 - 1],
      )
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(repo.claimRegistrationAttempt({ addressHash: 'a'.repeat(64), attemptedAtMs: now, limit: 3, windowMs: 3_600_000 }))
          .resolves.toEqual({ allowed: true })
      }
      await expect(repo.claimRegistrationAttempt({ addressHash: 'a'.repeat(64), attemptedAtMs: now, limit: 3, windowMs: 3_600_000 }))
        .resolves.toEqual({ allowed: false, retryAfterSeconds: 3600 })
      await expect(repo.claimRegistrationAttempt({ addressHash: 'a'.repeat(64), attemptedAtMs: now + 1_000, limit: 3, windowMs: 3_600_000 }))
        .resolves.toEqual({ allowed: false, retryAfterSeconds: 3599 })
      expect((await pool.query("SELECT count(*)::int AS count FROM driver_registration_attempts WHERE address_sha256 = $1", ['a'.repeat(64)])).rows[0].count).toBe(3)
      expect((await pool.query("SELECT count(*)::int AS count FROM driver_registration_attempts WHERE address_sha256 = $1", ['d'.repeat(64)])).rows[0].count).toBe(0)
      await expect(repo.claimRegistrationAttempt({ addressHash: 'a'.repeat(64), attemptedAtMs: now + 3_600_001, limit: 3, windowMs: 3_600_000 }))
        .resolves.toEqual({ allowed: true })
    })

    it('serializes concurrent claims across repository instances while keeping addresses separate', async () => {
      const now = Date.UTC(2026, 8, 18, 10)
      const claims = await Promise.all(
        Array.from({ length: 4 }, (_, index) => (index % 2 === 0 ? repo : secondRepo).claimRegistrationAttempt({
          addressHash: 'b'.repeat(64), attemptedAtMs: now, limit: 3, windowMs: 3_600_000,
        })),
      )
      expect(claims.filter((claim) => claim.allowed)).toHaveLength(3)
      expect(claims.filter((claim) => !claim.allowed)).toHaveLength(1)
      await expect(secondRepo.claimRegistrationAttempt({
        addressHash: 'c'.repeat(64), attemptedAtMs: now, limit: 3, windowMs: 3_600_000,
      })).resolves.toEqual({ allowed: true })
    })
  })
}
