import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(new URL('../migrations/0097_company_historical_restoration_reclass.sql', import.meta.url), 'utf8')
describe('0097 historical restoration reclassification safeguards', () => {
  it('does not rewrite existing facts or manufacture cash, profit or a balancing baseline', () => {
    expect(sql).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:public\.)?(?:journal_entries|journal_lines|restorations|company_ledger_cutovers)\b/i)
    expect(sql).toContain("p_type IN('historical_branch_transit','branch_clearing')")
    expect(sql).toContain('CREATE OR REPLACE FUNCTION ash_company_fund_event_allowed')
    expect(sql).toContain('ash_historical_restoration_settlement_offset(v_branch)')
    expect(sql).toContain('v_cutover.baseline_difference_minor::numeric')
  })
  it('preserves attribution, versioning, exact full-group evidence and immutable uniqueness', () => {
    for (const guard of ['actor','cutover','version','payload','complete','group','whole_group','net','branch_source','hq_source']) {
      expect(sql).toContain(`company_historical_settlement_${guard}_guard`)
    }
    expect(sql).toContain("r.plan->>'schemaVersion' IN('3','4')")
    expect(sql).toContain('company_historical_settlement_same_transaction_guard')
    expect(sql).toContain('company_historical_settled_source_reversal_guard')
    expect(sql).toContain("'historical-reclass:'||v_batch.id::text||':'||v_leg.historical_journal_entry_id::text")
    expect(sql).toContain('historical_journal_entry_id bigint NOT NULL UNIQUE')
    expect(sql).toContain('restoration_id bigint NOT NULL UNIQUE')
    expect(sql).toContain('source_entry_id bigint NOT NULL UNIQUE')
    expect(sql).toContain('REVOKE UPDATE,DELETE,TRUNCATE')
    expect(sql.match(/EXECUTE FUNCTION refuse_company_command_change\(\)/g)).toHaveLength(4)
    expect(sql.match(/EXECUTE FUNCTION audit_row_change\(\)/g)).toHaveLength(4)
    expect(sql).not.toContain('assert_company_pocket_not_negative')
  })
})
