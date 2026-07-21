import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from './pool.ts'

/**
 * Migration runner.
 *
 * Forward-only, applied in filename order, each inside its own transaction, and recorded so it
 * never runs twice. Guarded by a session-level advisory lock so two app replicas starting at the
 * same moment cannot both migrate — one waits, then finds nothing to do.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

/** Arbitrary but fixed. Any process holding this lock is the one allowed to migrate. */
const MIGRATION_LOCK_ID = 8_472_113_355n

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const client = await pool.connect()
  const applied: string[] = []
  const skipped: string[] = []

  try {
    // Wait rather than fail: a deploy where two containers race should be slow, not broken.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID.toString()])

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        checksum    text NOT NULL
      )
    `)

    const done = new Map<string, string>()
    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    )
    for (const r of rows) done.set(r.filename, r.checksum)

    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8')
      const checksum = simpleChecksum(sql)
      const previous = done.get(file)

      if (previous !== undefined) {
        if (previous !== checksum) {
          // An applied migration that has since been edited means the database and the repo
          // disagree about history. Refusing is the only safe answer — silently re-running it
          // or ignoring it both end with a schema nobody can reason about.
          throw new Error(
            `migration ${file} has changed since it was applied (checksum ${previous} → ${checksum}). ` +
              'Applied migrations are immutable: add a new migration instead.',
          )
        }
        skipped.push(file)
        continue
      }

      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum])
        await client.query('COMMIT')
        applied.push(file)
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err })
      }
    }
    return { applied, skipped }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID.toString()]).catch(() => undefined)
    client.release()
  }
}

/** FNV-1a. Not cryptographic — this detects accidental edits, not tampering. */
function simpleChecksum(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
