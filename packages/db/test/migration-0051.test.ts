import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationDir = new URL('../migrations/', import.meta.url)
const migration50 = readFileSync(new URL('0050_receivable_correction.sql', migrationDir), 'utf8')
const migration51 = readFileSync(new URL('0051_receivable_writeoff.sql', migrationDir), 'utf8')
const compact50 = migration50.replace(/\s+/g, ' ')
const compact51 = migration51.replace(/\s+/g, ' ')

describe('migration 0051 ordinary-receivable write-off', () => {
  it('lands between correction history and shift-shortage settlement changes', () => {
    const files = readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort()
    const first = files.indexOf('0050_receivable_correction.sql')
    const last = files.indexOf('0052_shift_shortage_ordinary_receivable.sql')
    expect(files.slice(first, last + 1)).toEqual([
      '0050_receivable_correction.sql',
      '0051_receivable_writeoff.sql',
      '0052_shift_shortage_ordinary_receivable.sql',
    ])
  })

  it('makes write-off an immutable history intent with before/after balance arithmetic', () => {
    expect(compact51).toContain("CHECK (intent IN ('command', 'correction', 'writeoff'))")
    expect(compact51).toContain(
      "intent <> 'writeoff' OR (receivable_kind = 'ordinary' AND direction = 'collect')",
    )
    // 0050's non-command branch already requires both balances and binds their delta to amount.
    expect(compact50).toContain('ELSE prior_balance_minor IS NOT NULL')
    expect(compact50).toContain(
      "WHEN 'create' THEN target_balance_minor = prior_balance_minor + amount_minor ELSE target_balance_minor = prior_balance_minor - amount_minor",
    )
  })

  it('uses only the dedicated loss counterpart for write-offs, never an office fund', () => {
    expect(compact51).toContain(
      "WHEN p_intent = 'writeoff' THEN 'cost_center:receivable_writeoff_loss' ELSE 'office_' || p_channel",
    )
    expect(compact51).toContain(
      "WHEN p_intent = 'writeoff' THEN 'cost_center' ELSE 'office_' || p_channel",
    )
    expect(compact51).toContain("WHEN p_intent = 'writeoff' THEN 'D'")
    expect(compact51).toContain(
      "WHEN p_intent = 'writeoff' THEN 'receivable_writeoff_loss'",
    )
    expect(compact51).toContain(
      "WHEN p_intent = 'writeoff' THEN 'receivable_written_off'",
    )
    expect(compact51).toContain('SELECT COUNT(*) = 2')
  })

  it('keeps live permission, exact-journal, and nonnegative-balance guards in force', () => {
    expect(compact51).toContain("rp.permission_key = 'journal.manual.write'")
    expect(compact51).toContain("NEW.intent = 'writeoff'")
    expect(compact51).toContain("NEW.receivable_kind <> 'ordinary' OR NEW.direction <> 'collect'")
    expect(compact51).toContain("je.event_type = 'receivable_adjustment'")
    expect(compact51).toContain('public.receivable_event_lines_match(')
    expect(compact51).toContain('FOR UPDATE;')
    expect(compact51).toContain("CONSTRAINT = 'receivable_events_overcollection_guard'")
  })

  it('reuses the same exact matcher when late journal lines are appended', () => {
    expect(compact51).toContain(
      'CREATE OR REPLACE FUNCTION check_receivable_journal_lines() RETURNS trigger',
    )
    expect(compact51.match(/public\.receivable_event_lines_match\(/g)).toHaveLength(2)
    expect(compact51).toContain("CONSTRAINT = 'receivable_events_lines_guard'")
  })
})
