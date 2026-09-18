import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationDir = new URL('../migrations/', import.meta.url)
const migration = readFileSync(
  new URL('0053_ledger_backed_restoration.sql', migrationDir),
  'utf8',
)
const compact = migration.replace(/\s+/g, ' ')

describe('migration 0053 ledger-backed restoration', () => {
  it('is the forward migration after 0052', () => {
    // Asserts the ORDER, not that 0053 is the newest file. Pinning it to the tip made every later
    // migration fail a test about 0053, which says nothing about 0053 and trains people to edit a
    // passing assertion out of the way.
    const files = readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort()
    const after = files.indexOf('0053_ledger_backed_restoration.sql')
    expect(after).toBeGreaterThan(0)
    expect(files[after - 1]).toBe('0052_shift_shortage_ordinary_receivable.sql')
  })

  it('keeps schema v2 on its original count-backed guard and makes only v3 count-less', () => {
    expect(compact).toContain('ALTER COLUMN cash_count_id DROP NOT NULL')
    expect(compact).toContain("COALESCE(NEW.plan->>'schemaVersion', '') NOT IN ('2', '3')")
    expect(compact).toContain("NEW.plan->>'schemaVersion' = '2' AND NEW.cash_count_id IS NULL")
    expect(compact).toContain("NEW.plan->>'schemaVersion' = '3' AND NEW.cash_count_id IS NOT NULL")
    expect(compact).toContain("WHEN ((NEW.plan->>'schemaVersion') = '2') EXECUTE FUNCTION guard_restoration_insert()")
    expect(compact).toContain("WHEN ((NEW.plan->>'schemaVersion') = '3') EXECUTE FUNCTION guard_ledger_restoration_insert()")
  })

  it('pins the v3 snapshot, exact arithmetic, journals, and final target invariant', () => {
    expect(compact).toContain("NEW.plan->>'source' IS DISTINCT FROM 'live_ledger'")
    expect(compact).toContain("jsonb_typeof(NEW.plan->'openingBalances') IS DISTINCT FROM 'array'")
    expect(compact).toContain("item - ARRAY['fundCode', 'balance'] <> '{}'::jsonb")
    expect(compact).toContain("leg - ARRAY[ 'fundCode', 'officeBalance', 'receivables', 'position', 'capitalTarget', 'delta', 'direction', 'amount', 'feasible', 'refusals' ] <> '{}'::jsonb")
    expect(compact).not.toContain("'counted'")
    expect(compact).toContain("(opening->>'balance')::numeric = (leg->>'officeBalance')::numeric")
    expect(compact).toContain("(leg->>'position')::numeric <> (leg->>'officeBalance')::numeric + (leg->>'receivables')::numeric")
    expect(compact).toContain("je.occurrence_key = NEW.business_date::text || ':' || (leg->>'fundCode')")
    expect(compact).toContain('restoration opening snapshot does not match the pre-posting live ledger')
    expect(compact).toContain('restoration journals do not leave office balance plus receivables at target')
    expect(compact).toContain('restoration net differs from its exact journal-backed legs')
  })

  it('retains the existing append-only fact and journal linkage guards', () => {
    expect(compact).not.toContain('DROP TRIGGER restorations_immutable')
    expect(compact).not.toContain('DROP TRIGGER restoration_journal_fact_from_entry')
    expect(compact).not.toContain('DROP TRIGGER restoration_journal_line_fact_from_line')
    expect(compact).toContain('COMMENT ON TRIGGER restorations_immutable ON restorations')
  })
})
