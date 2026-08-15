import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../migrations/0033_unknown_operation_exclusion.sql', import.meta.url),
  'utf8',
)
const compact = migration.replace(/\s+/g, ' ')

describe('migration 0033 unknown operation exclusion', () => {
  it('automatically includes only verified window statuses', () => {
    expect(compact).toContain(
      "SELECT p_status IN ('in_window', 'open_minute_boundary', 'close_minute_boundary')",
    )
    expect(compact).not.toMatch(/p_status IN \([^)]*'unknown'/)
  })

  it('uses the same rule for orders, deductions, and trigger verification', () => {
    expect(compact.match(/operation_window_included_automatically\(/g)?.length).toBeGreaterThanOrEqual(7)
    expect(compact).toContain('UPDATE public.shift_orders')
    expect(compact).toContain('UPDATE public.cash_deductions')
    expect(compact).toContain('CREATE OR REPLACE FUNCTION guard_shift_order_window_decision_reason()')
    expect(compact).toContain('CREATE OR REPLACE FUNCTION guard_cash_deduction_window_decision_reason()')
  })

  it('preserves only an attributed, timed, reasoned manager decision', () => {
    expect(compact).toContain('o.decided_by IS NOT NULL AND o.decided_at IS NOT NULL')
    expect(compact).toContain("NULLIF(btrim(o.decision_reason), '') IS NOT NULL")
    expect(compact).toContain('d.decided_by IS NOT NULL AND d.decided_at IS NOT NULL')
    expect(compact).toContain("NULLIF(btrim(d.decision_reason), '') IS NOT NULL")
  })
})
