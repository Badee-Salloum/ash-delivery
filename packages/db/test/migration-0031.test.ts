import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../migrations/0031_shift_settlements.sql', import.meta.url),
  'utf8',
)
const compact = migration.replace(/\s+/g, ' ')

function functionSql(name: string): string {
  const match = migration.match(new RegExp(`CREATE FUNCTION ${name}\\(\\)[\\s\\S]*?\\n\\$\\$;`))
  expect(match, `missing SQL function ${name}()`).not.toBeNull()
  return match?.[0].replace(/\s+/g, ' ') ?? ''
}

describe('migration 0031 immutable fixed-policy settlements', () => {
  it('stores one complete minor-unit snapshot per shift', () => {
    expect(compact).toContain('CREATE TABLE shift_settlements (')
    expect(compact).toContain('shift_id uuid NOT NULL UNIQUE REFERENCES shifts(id) ON DELETE RESTRICT')
    for (const column of [
      'delivery_fee_total_minor',
      'fixed_driver_share_minor',
      'manual_driver_share_minor',
      'gross_driver_share_minor',
      'cash_deduction_total_minor',
      'base_driver_share_minor',
      'expected_total_minor',
      'actual_cash_minor',
      'actual_wallet_minor',
      'actual_total_minor',
      'variance_minor',
      'final_employee_cash_minor',
      'wallet_to_office_minor',
      'cash_to_office_minor',
      'wallet_amount_minor',
      'cash_amount_minor',
    ]) {
      expect(compact).toMatch(new RegExp(`${column} bigint NOT NULL`))
    }
  })

  it('pins 40%, signed variance, full wallet return and cash closure in database checks', () => {
    expect(compact).toContain("policy_code = 'fixed_40_cash_close_v1' AND driver_rate_bps = 4000")
    expect(compact).toContain('base_driver_share_minor = gross_driver_share_minor - cash_deduction_total_minor')
    expect(compact).toContain('actual_total_minor = actual_cash_minor + actual_wallet_minor')
    expect(compact).toContain('variance_minor = actual_total_minor - expected_total_minor')
    expect(compact).toContain('final_employee_cash_minor = base_driver_share_minor + variance_minor')
    expect(compact).toContain('wallet_to_office_minor = actual_wallet_minor')
    expect(compact).toContain('cash_to_office_minor = actual_cash_minor - final_employee_cash_minor')
    expect(compact).toContain("wallet_action = 'collect'")
    expect(compact).toContain("wallet_action = 'fund'")
    expect(compact).toContain("cash_action = 'collect'")
    expect(compact).toContain("cash_action = 'pay'")
  })

  it('requires both confirmations and a reason for any non-zero variance', () => {
    expect(compact).toContain('wallet_transfer_confirmed AND cash_settlement_confirmed')
    expect(compact).toContain("variance_minor = 0 OR NULLIF(btrim(variance_reason), '') IS NOT NULL")
    const guard = functionSql('guard_shift_settlement_insert')
    expect(guard).toContain('LANGUAGE plpgsql SECURITY DEFINER')
    expect(guard).toContain('SET search_path = pg_catalog, public, pg_temp')
    expect(guard).toContain("NULLIF(current_setting('app.actor_id', true), '')::uuid")
    expect(guard).toContain('NEW.confirmed_by IS DISTINCT FROM v_actor')
    expect(guard).toContain("u.role_key IN ('general_manager', 'system_admin')")
    expect(guard).toContain("u.role_key = 'branch_manager' AND u.branch_id = NEW.branch_id")
  })

  it('persists the two-phase force-close marker and signs only a submitted pending review', () => {
    expect(compact).toContain('ALTER TABLE shift_decisions DROP CONSTRAINT shift_decisions_decision_check;')
    expect(compact).toContain(
      "CHECK (decision IN ('approved', 'rejected', 'rephoto_requested', 'force_close_prepared'))",
    )
    expect(compact).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON shift_decisions FROM app_user;')
    expect(compact).toContain('GRANT SELECT, INSERT ON shift_decisions TO app_user;')
    expect(compact).toContain('CREATE TRIGGER shift_decisions_append_only BEFORE UPDATE OR DELETE ON shift_decisions')
    const decisionGuard = functionSql('reject_shift_decision_mutation')
    expect(decisionGuard).toContain("USING ERRCODE = '55000'")
    expect(decisionGuard).toContain(
      "TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = OLD.shift_id)",
    )
    expect(decisionGuard).toContain('RETURN OLD;')

    const guard = functionSql('guard_shift_settlement_insert')
    expect(guard).toContain('SELECT s.branch_id, s.driver_id, s.business_date, s.state, s.submitted_at')
    expect(guard).toContain("IF v_state <> 'pending_review' OR v_submitted_at IS NULL THEN")
    expect(guard).toContain("CONSTRAINT = 'shift_settlements_shift_state_guard'")
  })

  it('is append-only to the app, rejects mutation, and audits creation', () => {
    expect(compact).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON shift_settlements FROM app_user;')
    expect(compact).toContain('GRANT SELECT, INSERT ON shift_settlements TO app_user;')
    expect(compact).toContain('CREATE TRIGGER shift_settlements_immutable BEFORE UPDATE OR DELETE ON shift_settlements')
    expect(compact).toContain(
      'CREATE TRIGGER audit_shift_settlements AFTER INSERT OR UPDATE OR DELETE ON shift_settlements',
    )
    expect(functionSql('reject_shift_settlement_mutation')).toContain("USING ERRCODE = '55000'")
  })

  it('documents the only safe pre-data rollback for the forward-only runner', () => {
    expect(compact).toContain('DROP TABLE shift_settlements;')
    expect(compact).toContain('DROP FUNCTION guard_shift_settlement_insert();')
    expect(compact).toContain('DROP FUNCTION reject_shift_settlement_mutation();')
    expect(compact).toContain('forward compensating migration/export')
  })
})
