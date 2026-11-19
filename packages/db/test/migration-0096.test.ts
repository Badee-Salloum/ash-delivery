import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(new URL('../migrations/0096_existing_asset_documentary_sale.sql', import.meta.url), 'utf8').replace(/\s+/g, ' ')

describe('documentary motor sale database guards', () => {
  it('is additive and never manufactures money or book recognition', () => {
    expect(sql).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) (?:journal_entries|journal_lines|fixed_assets)/i)
    expect(sql).toContain('existing_asset_documentary_sale_guard')
    expect(sql).toContain("v_sale->'disposalEntryId' IS DISTINCT FROM 'null'::jsonb")
    expect(sql).toContain("v_sale->'bookValue' IS DISTINCT FROM 'null'::jsonb")
    expect(sql).toContain("v_sale->'debtId' IS DISTINCT FROM 'null'::jsonb")
  })
  it('retains financial recognition/disposal and immutable command-scope guards', () => {
    expect(sql).toContain('existing_asset_sale_guard')
    expect(sql).toContain('existing_asset_recognition_guard')
    expect(sql).toContain('existing_asset_command_scope_guard')
    expect(sql).toContain("NEW.kind NOT IN ('edit','sale_confirm','sale_documentary')")
    expect(sql).toContain("v_prior.accounting_status IS DISTINCT FROM 'pending_review'")
    expect(sql).toContain('public.company_reversals')
    expect(sql).toContain("f.code='company_cash:'||(v_sale->>'currency')")
    expect(sql).toContain("CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Damascus'")
    expect(sql).toContain('BEFORE INSERT ON company_reversals')
    expect(sql).toContain('existing_asset_sale_receipt_correction_guard')
  })
})
