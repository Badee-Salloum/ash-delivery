import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrations = new URL('../migrations/', import.meta.url)
const file = '0086_existing_motor_assets.sql'
const sql = readFileSync(new URL(file, migrations), 'utf8')
const flat = sql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ')

describe('0086 existing motor cards safe additive migration', () => {
  it('follows 0085 without rewriting old purchases or depreciation', () => {
    const files = readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()
    expect(files.indexOf(file)).toBe(files.indexOf('0085_dashboard_charge_vehicle_types.sql') + 1)
    expect(flat).not.toMatch(/UPDATE (fixed_assets|journal_entries|journal_lines|asset_depreciation_schedule)/)
    expect(flat).not.toContain('INSERT INTO journal_entries')
  })
  it('separates neutral cards and allocation-free evidence from immutable audited revisions', () => {
    expect(flat).toContain("price_minor bigint CHECK (price_minor > 0)")
    expect(flat).toContain("funding_source IN ('company','owner_outside','unknown')")
    expect(flat).toContain('UNIQUE (asset_id,version)')
    expect(flat).not.toContain('allocated_amount')
    expect(flat).toContain('existing_asset_neutral_registration_guard')
    for (const table of ['company_existing_assets', 'company_existing_asset_events', 'company_existing_asset_evidence']) {
      expect(flat).toContain(`CREATE TRIGGER audit_${table}`)
    }
  })
  it('guards concurrent vehicle registration across old and new paths and refuses event mutation', () => {
    expect(flat).toContain("ON company_existing_assets (vehicle_id) WHERE status <> 'sold'")
    expect(flat).toContain("pg_advisory_xact_lock(hashtextextended('ash:asset_vehicle:'")
    expect(flat).toContain('CREATE TRIGGER fixed_assets_01_existing_card_guard BEFORE INSERT ON fixed_assets')
    expect(flat).toContain('existing_asset_projection_guard')
    expect(flat).toContain('DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_existing_asset_event_projected()')
    expect(flat).toContain('REVOKE UPDATE,DELETE,TRUNCATE ON company_existing_asset_events,company_existing_asset_evidence FROM app_user')
  })
})
