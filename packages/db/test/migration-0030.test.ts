import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../migrations/0030_operation_window_integrity.sql', import.meta.url),
  'utf8',
)
const compact = migration.replace(/\s+/g, ' ')

function functionSql(name: string, args = ''): string {
  const escapedArgs = args.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = migration.match(
    new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name}\\(${escapedArgs}\\)[\\s\\S]*?\\n\\$\\$;`),
  )
  expect(match, `missing SQL function ${name}(${args})`).not.toBeNull()
  return match?.[0].replace(/\s+/g, ' ') ?? ''
}

describe('migration 0030 operation-window integrity', () => {
  it('exposes one deterministic SECURITY DEFINER command, not a caller-selected status bypass', () => {
    const body = functionSql('reclassify_shift_operations', 'p_shift_id uuid')
    expect(body).toContain('LANGUAGE plpgsql SECURITY DEFINER')
    expect(body).toContain('SET search_path = pg_catalog, public, pg_temp')
    expect(body).toContain('FROM public.shifts')
    expect(body).toContain('INTO public.operation_window_reclassification_context')
    expect(body).toContain('UPDATE public.shift_orders')
    expect(body).toContain('UPDATE public.cash_deductions')
    expect(body).toContain('s.open_approved_at')
    expect(body).toContain('s.submitted_at')
    expect(body).toContain('b.timezone')
    expect(body).toContain('classify_operation_window(')
    expect(body).not.toMatch(/p_(?:included|window_status|occurred_date|occurred_minute)/)
    expect(compact).toContain('GRANT EXECUTE ON FUNCTION reclassify_shift_operations(uuid) TO app_user;')
  })

  it('protects and transaction-scopes the capability consumed by both guards', () => {
    expect(compact).toContain('REVOKE ALL ON operation_window_reclassification_context FROM app_user;')
    expect(compact).toContain('backend_pid = pg_backend_pid()')
    expect(compact).toContain('transaction_id = txid_current()')
    expect(compact.match(/FROM public\.operation_window_reclassification_context c/g)).toHaveLength(2)
    expect(compact.match(/DELETE FROM public\.operation_window_reclassification_context/g)).toHaveLength(2)
  })

  it.each([
    ['guard_shift_order_window_decision_reason', 'shift_orders_window_decision_reason_guard'],
    ['guard_cash_deduction_window_decision_reason', 'cash_deductions_window_decision_reason_guard'],
  ])('requires a fresh attributed manager decision in %s', (name, constraint) => {
    const body = functionSql(name)
    expect(body).toContain('SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp')
    expect(body).toContain('FROM public.operation_window_reclassification_context c')
    expect(body).toContain('FROM public.users u JOIN public.shifts s')
    expect(body).toContain('NEW.included IS DISTINCT FROM OLD.included')
    expect(body).toContain('NEW.occurred_date IS DISTINCT FROM OLD.occurred_date')
    expect(body).toContain('NEW.occurred_minute IS DISTINCT FROM OLD.occurred_minute')
    expect(body).toContain('NEW.decision_reason IS DISTINCT FROM OLD.decision_reason')
    expect(body).toContain('NEW.decided_by IS DISTINCT FROM OLD.decided_by')
    expect(body).toContain('NEW.decided_at IS DISTINCT FROM OLD.decided_at')
    expect(body).toContain("NULLIF(current_setting('app.actor_id', true), '')::uuid")
    expect(body).toContain('NEW.decided_by IS DISTINCT FROM v_actor')
    expect(body).toContain('NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at')
    expect(body).toContain('IS NOT DISTINCT FROM ROW(OLD.decision_reason, OLD.decided_by, OLD.decided_at)')
    expect(body).toContain("u.role_key = 'branch_manager' AND u.branch_id = s.branch_id")
    expect(body).toContain(`CONSTRAINT = '${constraint}'`)
  })

  it('keeps value-only order corrections compatible while closing metadata-only resolution', () => {
    const orderGuard = functionSql('guard_shift_order_window_decision_reason')
    expect(orderGuard).toContain('NEW.fee_minor IS DISTINCT FROM OLD.fee_minor')
    expect(orderGuard).toContain('NEW.wallet_amount_minor IS DISTINCT FROM OLD.wallet_amount_minor')
    expect(orderGuard).toContain('(v_window_changed OR NOT v_value_changed)')

    const deductionGuard = functionSql('guard_cash_deduction_window_decision_reason')
    expect(deductionGuard).toContain('IF NOT v_window_changed AND NOT v_metadata_changed THEN')
    expect(deductionGuard).toContain("NEW.decision_reason IS NULL OR btrim(NEW.decision_reason) = ''")
  })

  it('hardens the pre-existing durable audit definer in the effective schema', () => {
    expect(compact).toContain(
      'ALTER FUNCTION public.audit_row_change() SET search_path = pg_catalog, public, pg_temp;',
    )
    expect(compact).not.toContain('SECURITY DEFINER SET search_path = public ')
  })
})
