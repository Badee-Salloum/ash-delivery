import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationDir = new URL('../migrations/', import.meta.url)
const file = '0084_company_historical_external_reference.sql'
const sql = readFileSync(new URL(file, migrationDir), 'utf8')
const flat = sql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim()

describe('0084 — historical company-fund audit references', () => {
  it('follows the current migration tip', () => {
    const files = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()
    expect(files.indexOf(file)).toBe(files.indexOf('0083_gps_offline_delivery.sql') + 1)
  })

  it('keeps old journal rows nullable while requiring visible text when a reference is supplied', () => {
    expect(flat).toContain('ALTER TABLE journal_entries ADD COLUMN external_reference text;')
    expect(flat).toContain(
      'ADD CONSTRAINT je_external_reference_visible_ck CHECK ( external_reference IS NULL OR ash_has_visible_text(external_reference) );',
    )
  })

  it('makes a non-null reference unique within its ledger and HQ-only', () => {
    expect(flat).toContain(
      'CREATE UNIQUE INDEX je_external_reference_hq_uq ON journal_entries (branch_id, external_reference) WHERE external_reference IS NOT NULL;',
    )
    expect(flat).toContain(
      "CREATE TRIGGER journal_entries_00_external_reference_hq_guard BEFORE INSERT OR UPDATE OF branch_id, external_reference ON journal_entries FOR EACH ROW WHEN (NEW.external_reference IS NOT NULL) EXECUTE FUNCTION assert_branch_kind('company');",
    )
  })
})
