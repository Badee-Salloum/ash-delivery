import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationDir = new URL('../migrations/', import.meta.url)
const file = '0088_company_movement_review.sql'
const sql = readFileSync(new URL(file, migrationDir), 'utf8')
const flat = sql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim()

describe('0088 — historical intake and versioned HQ corrections', () => {
  it('is additive after the separate restoration-review migration', () => {
    const files = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()
    expect(files.indexOf(file)).toBe(files.indexOf('0087_company_restoration_reviews.sql') + 1)
    expect(flat).not.toMatch(/(?:UPDATE|DELETE FROM) journal_(?:entries|lines)/)
  })
  it('audits all three tables, preserves correction versions and rejects old-evidence mutation', () => {
    for (const table of ['company_movement_metadata', 'company_historical_intake_sessions', 'company_movement_correction_versions']) {
      expect(flat).toContain(`CREATE TABLE ${table}`)
      expect(flat).toContain(`CREATE TRIGGER audit_${table} AFTER INSERT OR UPDATE OR DELETE ON ${table}`)
    }
    expect(flat).toContain('PRIMARY KEY(id,version)')
    expect(flat).toContain('action_id uuid NOT NULL UNIQUE')
    expect(flat).toContain('company_correction_append_only BEFORE UPDATE OR DELETE')
    expect(flat).toContain("previous.status='confirmed'")
  })
  it('keeps HQ and branch isolated, guards source-command links and confirmed effective versions', () => {
    expect(flat).toContain("EXECUTE FUNCTION assert_branch_kind('company')")
    expect(flat).toContain('metadata must describe an existing HQ command')
    expect(flat).toContain('NEW.target_version<>confirmed_count+1')
    expect(flat).toContain('correction must not modify branch journal')
    expect(flat).toContain('company_correction_canonical_target_guard')
    expect(flat).toContain('WHERE status=\'confirmed\'')
    expect(flat).toContain("payload->>'reviewedSourceUnits'='true'")
    expect(flat).toContain("payload->>'reviewedExistingEntries'='true'")
  })
})
