import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(new URL('../migrations/0087_company_restoration_reviews.sql', import.meta.url), 'utf8')
describe('0087 — actual branch restoration with separate immutable HQ review', () => {
  it('leaves historical facts unchanged and creates only additive immutable audited tables', () => {
    for (const table of ['company_restoration_proposals', 'company_restoration_proposal_legs',
      'company_restoration_review_revisions', 'company_restoration_review_legs']) {
      expect(sql).toContain(`CREATE TABLE ${table}`)
      expect(sql).toContain(`BEFORE UPDATE OR DELETE ON ${table}`)
      expect(sql).toContain(`AFTER INSERT OR UPDATE OR DELETE ON ${table}`)
    }
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?(?:restorations|journal_entries|company_restoration_mirrors)\s+SET/i)
    expect(sql).not.toMatch(/DROP TABLE/i)
  })
  it('preserves the established v4 branch arithmetic guard and every source leg even with zero net', () => {
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.guard_ledger_restoration_insert_v4')
    expect(sql).toContain("(v_run.plan->>'schemaVersion')::integer IS DISTINCT FROM 4")
    expect(sql).toContain('proposal must retain every actual branch leg including offsetting legs')
    expect(sql).toContain('source_entry_id bigint PRIMARY KEY REFERENCES journal_entries(id)')
  })
  it('proves a pending counterpart instead of silently weakening the clearing invariant', () => {
    expect(sql).toContain('CREATE FUNCTION ash_restoration_pending_difference(p_branch uuid) RETURNS numeric')
    expect(sql).toContain('<> public.ash_restoration_pending_difference(v_branch)')
    expect(sql).toContain("r.kind IN ('confirm','correct')")
    expect(sql).toContain("company_restoration_review_fact_guard")
    expect(sql).toContain('HQ confirmation differs from its exact guarded line set')
    expect(sql).toContain('HQ correction must reverse only the previous HQ confirmation')
  })
  it('requires active authority, source identity, versions and reviewed journals without rewriting the old fact validator', () => {
    expect(sql).toContain("public.ash_actor_holds_all(NEW.created_by,'company_fund.manage')")
    expect(sql).toContain("company_restoration_proposal_source_guard")
    expect(sql).toContain('NEW.version <> v_current+1')
    expect(sql).toContain('UNIQUE (proposal_id,version)')
    expect(sql).toContain('EXECUTE FUNCTION assert_company_journal_fact()')
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION assert_company_journal_fact()')
  })
})
