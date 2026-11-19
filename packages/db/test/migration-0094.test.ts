import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(new URL('../migrations/0094_company_branch_matching.sql', import.meta.url), 'utf8')
describe('0094 — truthful link-only branch activation', () => {
  it('keeps old facts and freezes a baseline without a cash balancing entry', () => {
    expect(sql).toContain("ADD COLUMN mode text NOT NULL DEFAULT 'cash_opening'")
    expect(sql).toContain('ADD COLUMN baseline_difference_minor bigint NOT NULL DEFAULT 0')
    expect(sql).toContain("NEW.mode IS DISTINCT FROM 'link_only' OR NEW.opening_entry_id IS NOT NULL")
    expect(sql).toContain('NEW.watermark_entry_id<>(SELECT COALESCE(max(id),0)')
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?(journal_entries|restorations|company_ledger_cutovers)\s+SET/i)
    expect(sql).not.toMatch(/INSERT INTO\s+(?:public\.)?journal_entries/i)
  })
  it('retains exact old cash-opening proof and prevents double adoption or invented sources', () => {
    expect(sql).toContain('company_cutovers_journal_guard')
    expect(sql).toContain('public.ash_company_lines_match')
    expect(sql).toContain("c.mode='link_only' AND NEW.source_entry_id<=c.watermark_entry_id")
    expect(sql).toContain('public.company_historical_import_receipts')
    expect(sql).toContain('public.company_restoration_mirrors m WHERE m.source_entry_id=NEW.source_entry_id')
    expect(sql).toContain('ash_restoration_historical_offset(v_branch)')
  })
})
