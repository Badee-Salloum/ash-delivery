import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../migrations/0032_ocr_call_reservations.sql', import.meta.url),
  'utf8',
)
const compact = migration.replace(/\s+/g, ' ')

describe('migration 0032 paid OCR read reservations', () => {
  it('versions cache identity and ignores every legacy prompt result', () => {
    expect(compact).toContain("ADD COLUMN cache_signature text NOT NULL DEFAULT 'legacy-v1'")
    expect(compact).toContain('DROP INDEX ocr_reads_sha_uq;')
    expect(compact).toContain('ON ocr_reads (branch_id, sha256, field, cache_signature)')
  })

  it('stores one bounded running lease and a separate retry owner', () => {
    expect(compact).toContain("ADD COLUMN read_state text NOT NULL DEFAULT 'complete'")
    expect(compact).toContain('ADD COLUMN reservation_id uuid')
    expect(compact).toContain('ADD COLUMN reserved_at timestamptz')
    expect(compact).toContain('ADD COLUMN reserved_attempt smallint CHECK (reserved_attempt IN (1, 2))')
    expect(compact).toContain('ADD COLUMN retry_shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL')
    expect(compact).toContain('ADD COLUMN retry_created_at timestamptz')
    expect(compact).toContain('ADD COLUMN retry_created_by uuid REFERENCES users(id) ON DELETE SET NULL')
    expect(compact).toContain("read_state = 'running'")
    expect(compact).toContain('DROP CONSTRAINT ocr_reads_shift_id_fkey')
    expect(compact).toContain('FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL')
    expect(compact).not.toContain('ocr_reads_retry_owner_ck')
  })
})
