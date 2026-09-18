import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CREATE_MIGRATION_LEDGER_SQL,
  MIGRATION_CLAIM_SQL,
  MIGRATION_LOCK_ID,
  MIGRATION_LOCK_SQL,
  MIGRATION_RECHECK_SQL,
  bootstrapTransactionQueries,
  classifyRecordedMigration,
  migrationChecksum,
  migrationChecksumMatches,
  migrationChecksums,
  migrationTransactionQueries,
} from '../migration-http-plan.mjs'

function recordingTransaction() {
  const calls = []
  return {
    calls,
    tx: {
      query(sql, params) {
        const query = { sql, params }
        calls.push(query)
        return query
      },
    },
  }
}

describe('Neon HTTP migration single-runner protocol', () => {
  it('guards first-install ledger creation with the shared transaction lock', () => {
    const { tx, calls } = recordingTransaction()

    expect(bootstrapTransactionQueries(tx)).toEqual(calls)
    expect(calls).toEqual([
      { sql: MIGRATION_LOCK_SQL, params: [MIGRATION_LOCK_ID] },
      { sql: CREATE_MIGRATION_LEDGER_SQL, params: undefined },
    ])
    expect(MIGRATION_LOCK_ID).toBe('8472113355')
    expect(readFileSync(new URL('../src/migrate.ts', import.meta.url), 'utf8')).toContain(
      'const MIGRATION_LOCK_ID = 8_472_113_355n',
    )
  })

  it('locks, re-checks, and claims before submitting any migration DDL', () => {
    const { tx, calls } = recordingTransaction()
    const statements = [
      'CREATE TABLE example (id integer)',
      'CREATE INDEX example_id_idx ON example(id)',
    ]

    expect(
      migrationTransactionQueries(tx, {
        file: '0029_example.sql',
        checksum: 'deadbeef',
        statements,
      }),
    ).toEqual(calls)

    expect(calls).toEqual([
      { sql: MIGRATION_LOCK_SQL, params: [MIGRATION_LOCK_ID] },
      { sql: MIGRATION_RECHECK_SQL, params: ['0029_example.sql'] },
      { sql: MIGRATION_CLAIM_SQL, params: ['0029_example.sql', 'deadbeef'] },
      { sql: statements[0], params: undefined },
      { sql: statements[1], params: undefined },
    ])
    // No ON CONFLICT is deliberate: a stale runner must abort before executing the DDL queries.
    expect(MIGRATION_CLAIM_SQL).not.toMatch(/ON\s+CONFLICT/i)
  })

  it('distinguishes a concurrent/lost-ack commit, checksum drift, and a real failure', () => {
    expect(classifyRecordedMigration([{ checksum: 'deadbeef' }], 'deadbeef')).toEqual({
      kind: 'present',
    })
    expect(classifyRecordedMigration([{ checksum: 'cafebabe' }], 'deadbeef')).toEqual({
      kind: 'drift',
      actualChecksum: 'cafebabe',
    })
    expect(classifyRecordedMigration([], 'deadbeef')).toEqual({ kind: 'missing' })
  })

  it('canonicalizes new checksums to LF while accepting legacy CRLF records', () => {
    const lf = 'CREATE TABLE example (id integer);\n-- immutable\n'
    const crlf = lf.replaceAll('\n', '\r\n')
    const accepted = migrationChecksums(lf)

    expect(migrationChecksum(lf)).toBe(migrationChecksum(crlf))
    expect(accepted).toHaveLength(2)
    expect(migrationChecksums(crlf)).toEqual(accepted)
    expect(migrationChecksumMatches(lf, accepted[0])).toBe(true)
    expect(migrationChecksumMatches(lf, accepted[1])).toBe(true)
    expect(migrationChecksumMatches(lf, 'deadbeef')).toBe(false)
    expect(classifyRecordedMigration([{ checksum: accepted[1] }], accepted)).toEqual({
      kind: 'present',
    })
  })
})
