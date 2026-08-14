import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../migrations/0028_shift_operation_windowing.sql', import.meta.url),
  'utf8',
)

const executableSql = migration.replace(/^\s*--.*$/gm, '')

function functionSql(name: string): string {
  const match = migration.match(new RegExp(`CREATE FUNCTION ${name}\\(\\)[\\s\\S]*?\\n\\$\\$;`))
  expect(match, `missing SQL function ${name}`).not.toBeNull()
  return match?.[0].replace(/\s+/g, ' ') ?? ''
}

describe('migration 0028 invariants', () => {
  it('adds the ledger enum without using the new value in the same transaction', () => {
    expect(executableSql).toContain(
      "ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'driver_cash_deduction';",
    )
    expect(executableSql.match(/driver_cash_deduction/g)).toHaveLength(1)
  })

  it('keeps canonical window instants compatible with old state-only writers', () => {
    const body = functionSql('maintain_shift_window_on_transition')
    expect(body).toContain(
      "OLD.state = 'awaiting_open_approval' AND NEW.state = 'open' AND NEW.open_approved_at IS NULL",
    )
    expect(body).toContain(
      "OLD.state IN ('open', 'suspended') AND NEW.state IN ('pending_review', 'approved') AND NEW.submitted_at IS NULL",
    )
    expect(body).toContain(
      "OLD.state = 'pending_review' AND NEW.state IN ('open', 'suspended')",
    )
    expect(body).toContain('NEW.submitted_at := NULL;')
    expect(executableSql).toMatch(
      /CREATE TRIGGER shifts_window_transition_compat\s+BEFORE UPDATE OF state, open_approved_at, submitted_at ON shifts\s+FOR EACH ROW EXECUTE FUNCTION maintain_shift_window_on_transition\(\);/,
    )
  })

  it('requires an audited reason for cash-deduction inclusion or printed-time decisions', () => {
    const body = functionSql('guard_cash_deduction_window_decision_reason')
    expect(body).toContain('NEW.decided_by IS NOT NULL')
    expect(body).toContain('NEW.included IS DISTINCT FROM OLD.included')
    expect(body).toContain('NEW.occurred_date IS DISTINCT FROM OLD.occurred_date')
    expect(body).toContain('NEW.occurred_minute IS DISTINCT FROM OLD.occurred_minute')
    expect(body).toContain("NEW.decision_reason IS NULL OR btrim(NEW.decision_reason) = ''")
    expect(body).toContain("ERRCODE = '23514', CONSTRAINT = 'cash_deductions_window_decision_reason_guard'")
    expect(executableSql).toMatch(
      /CREATE TRIGGER cash_deductions_window_decision_reason_guard\s+BEFORE UPDATE OF included, occurred_date, occurred_minute, decision_reason, decided_by ON cash_deductions\s+FOR EACH ROW EXECUTE FUNCTION guard_cash_deduction_window_decision_reason\(\);/,
    )
  })

  it('keeps an old-PWA BMS retake safely staged until the replacement attachment arrives', () => {
    const guard = functionSql('guard_shift_battery_reading_write')
    const linker = functionSql('link_pending_bms_reading_to_evidence')
    expect(guard).toContain('IF NEW.media_id IS NULL THEN RETURN NEW; END IF;')
    expect(linker).toContain('SET media_id = NEW.media_id')
    expect(linker).toContain('AND r.media_id IS NULL')
    expect(executableSql).toMatch(
      /CREATE TRIGGER shift_media_link_pending_bms_reading\s+AFTER INSERT OR UPDATE OF media_id ON shift_media/,
    )
  })

  it('pins the attachment-history definer away from caller temporary relations', () => {
    const historyAppender = functionSql('append_shift_media_attachment_history')
    expect(historyAppender).toContain('SECURITY DEFINER')
    expect(historyAppender).toContain('SET search_path = pg_catalog, public, pg_temp')
    expect(historyAppender.match(/INSERT INTO public\.shift_media_attachment_history/g)).toHaveLength(2)
  })
})
