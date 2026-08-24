import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationDir = new URL('../migrations/', import.meta.url)
const migration36 = readFileSync(new URL('0036_receivable_ledger_event.sql', migrationDir), 'utf8')
const migration37 = readFileSync(new URL('0037_receivable_settlement_and_events.sql', migrationDir), 'utf8')
const migration38 = readFileSync(new URL('0038_restoration_atomicity_guards.sql', migrationDir), 'utf8')
const migration39 = readFileSync(new URL('0039_editable_office_capital_targets.sql', migrationDir), 'utf8')
const migration40 = readFileSync(new URL('0040_preapproved_shift_rules.sql', migrationDir), 'utf8')
const compact36 = migration36.replace(/\s+/g, ' ')
const compact37 = migration37.replace(/\s+/g, ' ')
const compact38 = migration38.replace(/\s+/g, ' ')
const compact39 = migration39.replace(/\s+/g, ' ')
const compact40 = migration40.replace(/\s+/g, ' ')

const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

describe('migrations 0036/0037 receivable release', () => {
  it('commits enum values before any migration uses them', () => {
    const files = readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort()
    expect(files.slice(-7)).toEqual([
      '0034_durable_shift_close_drafts.sql',
      '0035_shift_money_integrity.sql',
      '0036_receivable_ledger_event.sql',
      '0037_receivable_settlement_and_events.sql',
      '0038_restoration_atomicity_guards.sql',
      '0039_editable_office_capital_targets.sql',
      '0040_preapproved_shift_rules.sql',
    ])
    expect(compact36).toContain("ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'receivable_adjustment'")
    expect(compact36).toContain("ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'driver_shift_funding_cash'")
    expect(compact36).toContain("ALTER TYPE fund_type ADD VALUE IF NOT EXISTS 'driver_shift_funding_wallet'")
    expect(compact36).toContain(
      "f.type::text IN ('driver_receivable_cash', 'driver_receivable_wallet')",
    )
    expect(compact36).toContain('v_nonzero_legacy_balances <> 0')
    expect(compact36).toContain('receivable kind migration blocked')
    expect(compact36).not.toContain('CREATE TABLE receivable_events')
    expect(compact37).toContain("event_type = 'receivable_adjustment'")
  })

  it('makes a completed restoration append-only and requires its sealed count identity', () => {
    expect(compact38).toContain('ALTER COLUMN cash_count_id SET NOT NULL')
    expect(compact38).toContain('CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500)')
    expect(compact38).toContain('CREATE FUNCTION guard_restoration_insert() RETURNS trigger')
    expect(compact38).toContain("rp.permission_key = 'journal.manual.write'")
    expect(compact38).toContain("CONSTRAINT = 'restorations_cash_count_guard'")
    expect(compact38).toContain("CONSTRAINT = 'restorations_cash_count_sealed_guard'")
    expect(compact38).toContain("CONSTRAINT = 'restorations_cash_count_lines_guard'")
    expect(compact38).toContain("f.code = 'office_cash' AND ccl.counted_minor < 0")
    expect(compact38).toContain("CONSTRAINT = 'restorations_journal_guard'")
    expect(compact38).toContain("CONSTRAINT = 'restorations_postcondition_guard'")
    expect(compact38).toContain('CREATE UNIQUE INDEX je_restoration_daily_key_uq')
    expect(compact38).toContain('CREATE CONSTRAINT TRIGGER restoration_journal_fact_from_entry')
    expect(compact38).toContain('CREATE CONSTRAINT TRIGGER restoration_journal_line_fact_from_line')
    expect(compact38).toContain('CREATE TRIGGER referenced_cash_count_lines_immutable')
    expect(compact38).toContain('CREATE FUNCTION prevent_restoration_mutation() RETURNS trigger')
    expect(compact38).toContain('CREATE TRIGGER restorations_immutable BEFORE UPDATE OR DELETE ON restorations')
    expect(compact38).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON restorations FROM app_user')
  })

  it('publishes the current editable targets without restating a completed restoration', () => {
    expect(compact39).toContain('CREATE FUNCTION guard_office_capital_target_history() RETURNS trigger')
    expect(compact39).toContain('BEFORE INSERT OR UPDATE OR DELETE ON office_capital_targets')
    expect(compact39).toContain("rp.permission_key = 'journal.manual.write'")
    expect(compact39).toContain('NOT public.ash_has_visible_text(NEW.note)')
    expect(compact39).toContain("'ash:financial:receivables:' || v_branch_id::text")
    expect(compact39).toContain('REVOKE DELETE, TRUNCATE ON office_capital_targets FROM app_user')
    expect(compact39).toContain("CONSTRAINT = 'office_capital_targets_history_guard'")
    expect(compact39).toContain("business_date >= DATE '2026-08-23'")
    expect(compact39).toContain("('office_cash', 5000000::bigint)")
    expect(compact39).toContain("('office_wallet', 1000000::bigint)")
  })

  it('stores immutable, scoped and single-use custom-date shift authorizations', () => {
    expect(compact40).toContain('CREATE TABLE preapproved_shift_rules (')
    expect(compact40).toContain('cash_float_minor bigint NOT NULL CHECK (cash_float_minor >= 0)')
    expect(compact40).toContain('wallet_topup_minor bigint NOT NULL CHECK (wallet_topup_minor >= 0)')
    expect(compact40).toContain('CHECK (window_start_minute < window_end_minute)')
    expect(compact40).toContain('UNIQUE (consumed_by_shift_id)')
    expect(compact40).toContain("rp.permission_key = 'shift.approve'")
    expect(compact40).toContain("CONSTRAINT = 'preapproved_shift_rule_publication_shape'")
    expect(compact40).toContain("CONSTRAINT = 'preapproved_shift_rule_publication_actor'")
    expect(compact40).toContain('AND d.active')
    expect(compact40).toContain("CONSTRAINT = 'preapproved_shift_rule_consumption_actor'")
    expect(compact40).toContain("CONSTRAINT = 'preapproved_shift_rule_consumption_identity'")
    expect(compact40).toContain("s.state = 'awaiting_open_approval'")
    expect(compact40).toContain('s.driver_confirmed_at IS NOT NULL')
    expect(compact40).toContain('OLD.created_at <= s.driver_confirmed_at')
    expect(compact40).toContain('BETWEEN OLD.window_start_minute AND OLD.window_end_minute')
    expect(compact40).toContain("'ash:preapproved-shift:' || NEW.driver_id::text")
    expect(compact40).toContain('REVOKE DELETE, TRUNCATE ON preapproved_shift_rules FROM app_user')
    expect(compact40).toContain('CREATE TRIGGER audit_preapproved_shift_rules')
  })

  it('pins the reviewed claims, bounded deferrals, and physical actions with overflow-safe checks', () => {
    expect(compact37).toContain(
      "policy_code IN ('fixed_40_cash_close_v1', 'fixed_40_cash_close_v2_receivable')",
    )
    expect(compact37).toContain(
      'cash_claim_to_office_minor::numeric = actual_cash_minor::numeric - final_employee_cash_minor::numeric',
    )
    expect(compact37).toContain('wallet_claim_to_office_minor = actual_wallet_minor')
    expect(compact37).toContain(
      'cash_receivable_deferred_minor::numeric <= GREATEST(cash_claim_to_office_minor::numeric, 0::numeric)',
    )
    expect(compact37).toContain(
      'wallet_receivable_deferred_minor::numeric <= GREATEST(wallet_claim_to_office_minor::numeric, 0::numeric)',
    )
    expect(compact37).toContain(
      'cash_to_office_minor::numeric = cash_claim_to_office_minor::numeric - cash_receivable_deferred_minor::numeric',
    )
    expect(compact37).toContain(
      'wallet_to_office_minor::numeric = wallet_claim_to_office_minor::numeric - wallet_receivable_deferred_minor::numeric',
    )
    expect(compact37).toContain(
      'actual_total_minor::numeric = actual_cash_minor::numeric + actual_wallet_minor::numeric',
    )
    expect(compact37).toContain(
      "policy_code <> 'fixed_40_cash_close_v1' OR ( cash_receivable_deferred_minor = 0 AND wallet_receivable_deferred_minor = 0 )",
    )
  })

  it('backfills historical immutable settlements only inside the migration transaction', () => {
    const disable = compact37.indexOf('DISABLE TRIGGER shift_settlements_immutable')
    const backfill = compact37.indexOf('UPDATE shift_settlements SET cash_claim_to_office_minor')
    const enable = compact37.indexOf('ENABLE TRIGGER shift_settlements_immutable')
    expect(disable).toBeGreaterThan(-1)
    expect(backfill).toBeGreaterThan(disable)
    expect(enable).toBeGreaterThan(backfill)
    expect(compact37).toContain(
      "s.state NOT IN ('approved', 'week_locked') OR s.kept_as_receivable_minor IS DISTINCT FROM ss.cash_receivable_deferred_minor",
    )
    expect(compact37).toContain("CONSTRAINT = 'shift_receivable_projection_guard'")
  })

  it('makes direct receivable commands immutable, attributable, journal-aligned, and idempotent', () => {
    expect(compact37).toContain('CREATE TABLE receivable_events (')
    expect(compact37).toContain('UNIQUE (branch_id, idempotency_key)')
    expect(compact37).toContain('CREATE UNIQUE INDEX je_receivable_command_uq')
    expect(compact37).toContain('CREATE FUNCTION guard_receivable_event_insert() RETURNS trigger')
    expect(compact37).toContain("CONSTRAINT = 'receivable_events_actor_guard'")
    expect(compact37).toContain('JOIN public.role_permissions rp ON rp.role_key = u.role_key')
    expect(compact37).toContain("rp.permission_key = 'journal.manual.write'")
    expect(compact37).toContain("rp.scope = 'all'")
    expect(compact37).toContain("rp.scope = 'branch' AND u.branch_id = NEW.branch_id")
    expect(compact37).not.toContain("u.role_key IN ('general_manager', 'system_admin')")
    expect(compact37).toContain("CONSTRAINT = 'receivable_events_driver_guard'")
    expect(compact37).toContain("NEW.direction = 'collect' OR d.active")
    expect(compact37).toContain("CONSTRAINT = 'receivable_events_journal_guard'")
    expect(compact37).toContain('je.posting_date = NEW.business_date')
    expect(compact37).toContain(
      'je.week_start_date = (NEW.business_date - extract(dow FROM NEW.business_date)::integer)',
    )
    expect(compact37).toContain("CONSTRAINT = 'receivable_events_lines_guard'")
    expect(compact37).toContain("CONSTRAINT = 'receivable_events_overcollection_guard'")
    expect(compact37).toContain(
      "f.branch_id = NEW.branch_id AND f.code = v_receivable_code AND f.type::text = v_receivable_type AND f.owner_kind = 'driver' AND f.owner_id = NEW.driver_id",
    )
    expect(compact37).toContain(
      "f.branch_id = NEW.branch_id AND f.code = v_office_code AND f.type::text = v_office_type AND f.owner_kind = 'none' AND f.owner_id IS NULL",
    )
    expect(compact37).toContain('INTO v_receivable_fund_id FROM public.funds f')
    expect(compact37).toContain('FOR UPDATE;')
    expect(compact37).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON receivable_events FROM app_user')
    expect(compact37).toContain('CREATE TRIGGER receivable_events_immutable BEFORE UPDATE OR DELETE')
    expect(compact37).toContain('CREATE TRIGGER audit_receivable_events AFTER INSERT OR UPDATE OR DELETE')
    expect(compact37).toContain('CREATE FUNCTION check_receivable_journal_event() RETURNS trigger')
    expect(compact37).toContain('CREATE CONSTRAINT TRIGGER receivable_journal_event_from_entry')
    expect(compact37).toContain("CONSTRAINT = 'receivable_journal_event_guard'")
    expect(compact37).toContain('CREATE FUNCTION check_receivable_journal_lines() RETURNS trigger')
    expect(compact37).toContain('CREATE CONSTRAINT TRIGGER receivable_journal_lines_from_line')
  })

  it('couples every new terminal shift to one matching immutable settlement at commit', () => {
    expect(compact37).toContain('LEFT JOIN public.shift_settlements ss ON ss.shift_id = s.id')
    expect(compact37).toContain("v_require_settlement := TG_OP = 'INSERT'")
    expect(compact37).toContain("OLD.state NOT IN ('approved', 'week_locked')")
    expect(compact37).toContain("v_has_settlement AND v_state NOT IN ('approved', 'week_locked')")
    expect(compact37).toContain('(v_require_settlement AND NOT v_has_settlement)')
  })

  it('requires the exact conditional close-entry and line multiset at terminal commit', () => {
    expect(compact37).toContain('CREATE FUNCTION shift_close_journals_match(p_shift_id uuid) RETURNS boolean')
    expect(compact37).toContain("je.event_type IN ('wallet_return', 'float_return')")
    expect(compact37).toContain("CASE WHEN st.policy_code = 'fixed_40_cash_close_v1' THEN 'wallet_full_return' ELSE 'wallet_settlement' END")
    expect(compact37).toContain("'driver_receivable_wallet:' || st.driver_id::text")
    expect(compact37).toContain("'driver_receivable_cash:' || st.driver_id::text")
    expect(compact37).toContain('EXCEPT ALL')
    expect(compact37).toContain('WHERE st.wallet_diff_minor IS NOT NULL')
    expect(compact37).toContain("CONSTRAINT = 'shift_close_journal_guard'")
    expect(compact37).toContain('CREATE CONSTRAINT TRIGGER shift_close_journals_from_shift')
    expect(compact37).toContain('CREATE CONSTRAINT TRIGGER shift_close_journals_from_settlement')
    expect(compact37).toContain('CREATE CONSTRAINT TRIGGER shift_close_journals_from_entry')
    expect(compact37).toContain('CREATE CONSTRAINT TRIGGER shift_close_journals_from_line')
  })

  it('serializes return journals with terminal transitions and validates exact forced voids', () => {
    expect(compact37).toContain('CREATE FUNCTION shift_void_journals_match(p_shift_id uuid) RETURNS boolean')
    expect(compact37).toContain("sd.decision = 'force_cancelled'")
    expect(compact37).toContain('c.notes AS reason')
    expect(compact37).toContain('c.decided_by::text AS created_by')
    expect(compact37).toContain("'void-carry-' || c.shift_id::text")
    expect(compact37).toContain("'void-wallet-carry-' || c.shift_id::text")
    expect(compact37).toContain("'driver_shift_funding_cash:' || c.driver_id::text")
    expect(compact37).toContain("'driver_shift_funding_wallet:' || c.driver_id::text")
    expect(compact37).toContain('FOR NO KEY UPDATE;')
    expect(compact37).toContain("s.state NOT IN ('approved', 'week_locked', 'cancelled')")
    expect(compact37).toContain('nonterminal shift already contains a return/void journal')
    expect(compact37).toContain("CONSTRAINT = 'shift_return_state_guard'")
    expect(compact37).toContain("CONSTRAINT = 'shift_void_journal_guard'")
    expect(compact37).toContain('CREATE CONSTRAINT TRIGGER shift_void_journals_from_decision')
    expect(compact37).toContain('CREATE CONSTRAINT TRIGGER shift_void_journals_from_tranche')
  })

  it('keeps the migration ledger checksums explicit for the coordinated release', () => {
    expect(fnv1a(migration36)).toBe('adbfc150')
    expect(fnv1a(migration37)).toBe('5fdf1556')
    expect(fnv1a(migration38)).toBe('b2dd47f0')
    expect(fnv1a(migration39)).toBe('ec71e10c')
    expect(fnv1a(migration40)).toBe('e1d2b547')
  })
})
