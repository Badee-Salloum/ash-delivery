import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationDir = new URL('../migrations/', import.meta.url)
const migration44 = readFileSync(
  new URL('0044_close_read_failure_and_funding_comments.sql', migrationDir),
  'utf8',
)
const compact44 = migration44.replace(/\s+/g, ' ')

describe('migration 0044 terminal read vocabulary and funding documentation', () => {
  it('runs after the matcher change without rewriting migration history', () => {
    const files = readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort()
    const first = files.indexOf('0041_deferred_collection_funds_next_shift.sql')
    const last = files.indexOf('0044_close_read_failure_and_funding_comments.sql')
    expect(files.slice(first, last + 1)).toEqual([
      '0041_deferred_collection_funds_next_shift.sql',
      '0042_battery_evidence_invariant.sql',
      '0043_visible_decision_reason.sql',
      '0044_close_read_failure_and_funding_comments.sql',
    ])
  })

  it('makes read_budget_exhausted a durable terminal OCR failure', () => {
    expect(compact44).toContain(
      'DROP CONSTRAINT shift_close_draft_reads_failure_check',
    )
    expect(compact44).toContain(
      'ADD CONSTRAINT shift_close_draft_reads_failure_check CHECK',
    )
    expect(compact44).toContain("'read_budget_exhausted'")
    for (const prior of ['unavailable', 'timeout', 'no_fields', 'refused', 'wrong_screen']) {
      expect(compact44).toContain(`'${prior}'`)
    }
  })

  it('documents both legacy names as automatically consumed next-shift funding', () => {
    const cashStart = compact44.indexOf(
      'COMMENT ON COLUMN shift_settlements.cash_receivable_deferred_minor IS',
    )
    const walletStart = compact44.indexOf(
      'COMMENT ON COLUMN shift_settlements.wallet_receivable_deferred_minor IS',
    )
    expect(cashStart).toBeGreaterThan(-1)
    expect(walletStart).toBeGreaterThan(cashStart)

    const cashComment = compact44.slice(cashStart, walletStart)
    const walletComment = compact44.slice(walletStart)
    for (const comment of [cashComment, walletComment]) {
      expect(comment).toContain('Legacy column name')
      expect(comment).toContain('consumed automatically')
      expect(comment).toContain('not an ordinary receivable')
    }
    expect(cashComment).toContain('driver_shift_funding_cash')
    expect(walletComment).toContain('driver_shift_funding_wallet')
  })
})
