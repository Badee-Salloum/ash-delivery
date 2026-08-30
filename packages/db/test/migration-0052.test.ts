import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationDir = new URL('../migrations/', import.meta.url)
const migration = readFileSync(
  new URL('0052_shift_shortage_ordinary_receivable.sql', migrationDir),
  'utf8',
)
const compact = migration.replace(/\s+/g, ' ')

describe('migration 0052 close-time ordinary shortage receivable', () => {
  it('follows the write-off migration without rewriting history', () => {
    const files = readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort()
    const index = files.indexOf('0052_shift_shortage_ordinary_receivable.sql')
    expect(files.slice(index - 1, index + 1)).toEqual([
      '0051_receivable_writeoff.sql',
      '0052_shift_shortage_ordinary_receivable.sql',
    ])
  })

  it('stores the reviewed maximum and selected ordinary shortage separately from funding', () => {
    expect(compact).toContain(
      'ADD COLUMN maximum_cash_shortage_receivable_minor bigint NOT NULL DEFAULT 0',
    )
    expect(compact).toContain(
      'ADD COLUMN cash_shortage_receivable_minor bigint NOT NULL DEFAULT 0',
    )
    expect(compact).toContain(
      'maximum_cash_shortage_receivable_minor::numeric = GREATEST(-final_employee_cash_minor::numeric, 0::numeric)',
    )
    expect(compact).toContain(
      'cash_shortage_receivable_minor::numeric <= maximum_cash_shortage_receivable_minor::numeric',
    )
    expect(compact).toContain(
      '- cash_receivable_deferred_minor::numeric - cash_shortage_receivable_minor::numeric',
    )
  })

  it('binds the ordinary debt line to the immutable shift-close journal', () => {
    expect(compact).toContain("'cash_shortage_receivable', 'driver_receivable_cash'")
    expect(compact).toContain('st.cash_shortage_receivable_minor::numeric')
    expect(compact).toContain('CREATE OR REPLACE FUNCTION shift_close_journals_match')
    expect(compact).not.toContain('INSERT INTO receivable_events')
  })
})
