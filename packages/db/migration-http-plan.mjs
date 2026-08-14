// Pure query planning for apply-migrations.mjs. Keeping this module free of environment and
// network access lets the single-runner protocol be exercised without touching a database.

// Keep this identical to packages/db/src/migrate.ts. Session- and transaction-level advisory
// locks with the same bigint key conflict with each other, so the TCP and Neon HTTP runners also
// serialize against one another.
export const MIGRATION_LOCK_ID = '8472113355'

export const MIGRATION_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1::bigint)'

export const CREATE_MIGRATION_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    checksum    text NOT NULL
  )
`

export const MIGRATION_RECHECK_SQL =
  'SELECT checksum FROM schema_migrations WHERE filename = $1'

export const MIGRATION_CLAIM_SQL =
  'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)'

/**
 * Neon HTTP transactions are non-interactive: the callback must synchronously return all query
 * promises. The migration ledger's primary key is therefore also the atomic claim. A stale runner
 * waits at the transaction-level advisory lock, re-reads the ledger, and then its INSERT fails
 * before any migration statement can execute. PostgreSQL aborts the whole transaction on that
 * unique violation. If a later DDL statement fails, the claim rolls back with it.
 */
export function migrationTransactionQueries(tx, { file, checksum, statements }) {
  return [
    tx.query(MIGRATION_LOCK_SQL, [MIGRATION_LOCK_ID]),
    tx.query(MIGRATION_RECHECK_SQL, [file]),
    tx.query(MIGRATION_CLAIM_SQL, [file, checksum]),
    ...statements.map((statement) => tx.query(statement)),
  ]
}

/** Guard first-install ledger creation against two fresh runners racing in PostgreSQL's catalogs. */
export function bootstrapTransactionQueries(tx) {
  return [
    tx.query(MIGRATION_LOCK_SQL, [MIGRATION_LOCK_ID]),
    tx.query(CREATE_MIGRATION_LEDGER_SQL),
  ]
}

/**
 * Interpret the authoritative row after a failed or ambiguously acknowledged transaction.
 * `missing` means the migration transaction really failed. `present` covers both an ordinary race
 * and a commit whose HTTP response was lost. A different checksum is immutable-history drift.
 */
export function classifyRecordedMigration(rows, expectedChecksum) {
  const row = rows[0]
  if (!row) return { kind: 'missing' }
  if (row.checksum !== expectedChecksum) {
    return { kind: 'drift', actualChecksum: row.checksum }
  }
  return { kind: 'present' }
}
