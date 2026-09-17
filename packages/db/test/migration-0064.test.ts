import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, DEFAULT_GRANTS } from '@ash/domain'
import { createPool, type PoolClient } from '../src/pool.ts'
import {
  assertDisposableDatabaseConnection,
  assertDisposableDatabaseUrl,
} from './disposable-database.ts'

const DATABASE_URL = process.env.DATABASE_URL
const migrationsDir = new URL('../migrations/', import.meta.url)
const FILE = '0064_company_fund_permission.sql'
const migration = readFileSync(new URL(FILE, migrationsDir), 'utf8')
/** Statements only: the header prose names the branch manager on purpose. */
const flat = migration
  .replace(/^\s*--.*$/gm, '')
  .replace(/\s+/g, ' ')
  .trim()

/**
 * «إدارة صندوق الشركة» (2026-09-17) — the company fund gets its own permission.
 *
 * The one property that matters most is the one easiest to get wrong: a migration must never make
 * an EMPTY `role_permissions` non-empty. `grantsFromRows` reads an empty table as «not seeded yet»
 * and authorises from DEFAULT_GRANTS; two rows would replace that whole fallback with themselves.
 */
describe('migration 0064 company-fund permission', () => {
  it('follows 0063', () => {
    // Asserts the ORDER, never the tip, so a later migration does not fail a test about this one.
    const files = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()
    expect(files.indexOf(FILE)).toBe(files.indexOf('0063_gps_batch_ingest.sql') + 1)
  })

  it('names the key the domain enforces, with the grants the domain seeds', () => {
    expect(ALL_PERMISSIONS).toContain('company_fund.manage')
    expect(DEFAULT_GRANTS['company_fund.manage']).toEqual({ system_admin: 'all', general_manager: 'all' })
    expect(flat).toContain(
      "INSERT INTO permissions (key, name_ar, name_en, srs_ref) VALUES ('company_fund.manage', 'إدارة صندوق الشركة', 'Manage company fund',",
    )
    expect(flat).toContain('ON CONFLICT (key) DO NOTHING;')
  })

  it('grants only when the matrix is already data, and only to the two org-wide roles', () => {
    expect(flat).toContain(
      "INSERT INTO role_permissions (role_key, permission_key, scope) SELECT r.key, 'company_fund.manage', 'all' FROM roles r WHERE r.key IN ('general_manager', 'system_admin') AND EXISTS (SELECT 1 FROM role_permissions) ON CONFLICT (role_key, permission_key) DO NOTHING;",
    )
    expect(flat).not.toContain('branch_manager')
    // A hand-set grant is the system admin's decision (SRS A-2); the migration must not overwrite it.
    expect(flat).not.toMatch(/DO UPDATE/i)
  })

  it('touches nothing but the two reference tables', () => {
    const statements = flat.split(';').map((s) => s.trim()).filter((s) => s !== '')
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^INSERT INTO permissions /)
    expect(statements[1]).toMatch(/^INSERT INTO role_permissions /)
  })
})

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`

const applyMigrationsThrough0063 = async (client: PoolClient): Promise<void> => {
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && file <= '0063_gps_batch_ingest.sql')
    .sort()
  expect(files.at(-1)).toBe('0063_gps_batch_ingest.sql')
  expect(files).toHaveLength(63)
  for (const file of files) {
    await client.query(readFileSync(new URL(file, migrationsDir), 'utf8'))
  }
}

if (!DATABASE_URL) {
  describe('migration 0064 PostgreSQL behavior', () => {
    it.skip('skipped: set DATABASE_URL to a positively identified disposable PostgreSQL database', () => {})
  })
} else {
  const disposable = assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = createPool(DATABASE_URL)

  afterAll(async () => {
    await pool.end()
  })

  describe('migration 0064 PostgreSQL behavior', () => {
    it(
      'leaves an empty matrix empty, and grants GM + sysadmin on a seeded one',
      async () => {
        await assertDisposableDatabaseConnection(pool, disposable)
        const databaseName = `ash_guardcheck_m0064_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 10)}`
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
          const client = await isolatedPool.connect()
          try {
            await applyMigrationsThrough0063(client)
            const grants = async () =>
              (
                await client.query<{ role_key: string; permission_key: string; scope: string }>(
                  'SELECT role_key, permission_key, scope FROM role_permissions ORDER BY role_key, permission_key',
                )
              ).rows

            // ── An unseeded database: the fallback to DEFAULT_GRANTS must survive. ──────────────
            await client.query('BEGIN')
            expect(await grants()).toEqual([])
            await client.query(migration)
            expect(await grants()).toEqual([])
            const permission = await client.query<{ name_ar: string; name_en: string }>(
              `SELECT name_ar, name_en FROM permissions WHERE key = 'company_fund.manage'`,
            )
            expect(permission.rows).toEqual([{ name_ar: 'إدارة صندوق الشركة', name_en: 'Manage company fund' }])
            await client.query('ROLLBACK')

            // ── A seeded database: exactly the two org-wide grants, never the branch manager. ──
            await client.query('BEGIN')
            for (const key of ['general_manager', 'system_admin', 'branch_manager']) {
              await client.query('INSERT INTO roles (key, name_ar, name_en) VALUES ($1, $1, $1)', [key])
            }
            await client.query(
              `INSERT INTO permissions (key, name_ar, name_en) VALUES ('journal.manual.write', 'x', 'x')`,
            )
            await client.query(
              `INSERT INTO role_permissions (role_key, permission_key, scope)
               VALUES ('branch_manager', 'journal.manual.write', 'branch')`,
            )
            await client.query(migration)
            expect(await grants()).toEqual([
              { role_key: 'branch_manager', permission_key: 'journal.manual.write', scope: 'branch' },
              { role_key: 'general_manager', permission_key: 'company_fund.manage', scope: 'all' },
              { role_key: 'system_admin', permission_key: 'company_fund.manage', scope: 'all' },
            ])
            // Idempotent: a second application changes nothing.
            await client.query(migration)
            expect(await grants()).toHaveLength(3)
            await client.query('ROLLBACK')
          } finally {
            await client.query('ROLLBACK').catch(() => undefined)
            client.release()
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
  })
}
