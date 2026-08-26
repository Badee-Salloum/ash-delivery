import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationDir = new URL('../migrations/', import.meta.url)
const migration45 = readFileSync(
  new URL('0045_close_draft_read_idempotency.sql', migrationDir),
  'utf8',
)

// Strip `--` prose before asserting on DDL. This migration *explains* why it is deliberately not a
// UNIQUE index and not a trigger, so a naive text search finds those words in the rationale and
// proves nothing at all.
const ddl45 = migration45
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
const compact45 = ddl45.replace(/\s+/g, ' ')

describe('migration 0045 close-draft read idempotency', () => {
  it('runs after 0044 without rewriting migration history', () => {
    const files = readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort()
    const first = files.indexOf('0043_visible_decision_reason.sql')
    const last = files.indexOf('0045_close_draft_read_idempotency.sql')
    expect(files.slice(first, last + 1)).toEqual([
      '0043_visible_decision_reason.sql',
      '0044_close_read_failure_and_funding_comments.sql',
      '0045_close_draft_read_idempotency.sql',
    ])
  })

  it('indexes exactly the identity the repository checks, and only completed reads', () => {
    expect(compact45).toContain(
      'CREATE INDEX shift_close_draft_reads_attachment_field_idx ON shift_close_draft_reads '
      + "(shift_id, media_id, attachment_token, field) WHERE status = 'complete'",
    )
  })

  it('never turns the invariant into a constraint that could abort a deploy or a close', () => {
    // Production already holds the violating pair from 2026-08-25, and OCR evidence is append-only
    // by design (0034 revokes UPDATE/DELETE). A UNIQUE index would abort this migration; a raising
    // trigger would abort a driver's close. Both are worse than a duplicate no-op.
    expect(compact45).not.toMatch(/CREATE\s+UNIQUE\s+INDEX/i)
    expect(compact45).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i)
    expect(compact45).not.toMatch(/\bRAISE\s+EXCEPTION\b/i)
    expect(compact45).not.toMatch(/\bDELETE\s+FROM\b/i)
  })

  it('records where the invariant actually lives, so the next reader does not add a constraint', () => {
    const start = compact45.indexOf('COMMENT ON TABLE shift_close_draft_reads IS')
    expect(start).toBeGreaterThan(-1)
    const comment = compact45.slice(start)
    expect(comment).toContain('At most one row per (shift_id, media_id, attachment_token, field)')
    expect(comment).toContain('PgCloseDraftRepo.saveRead')
    expect(comment).toContain('shift row lock')
    expect(comment).toContain('rotates attachment_token')
  })
})
