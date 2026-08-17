import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  new URL('../migrations/0034_durable_shift_close_drafts.sql', import.meta.url),
  'utf8',
)
const compact = sql.replace(/\s+/g, ' ')

describe('migration 0034 close-draft evidence guards', () => {
  it('uses database time for every real attachment generation', () => {
    expect(compact).toContain('CREATE FUNCTION stamp_shift_media_attachment_time() RETURNS trigger')
    expect(compact).toContain("IF TG_OP = 'INSERT' OR NEW.media_id IS DISTINCT FROM OLD.media_id THEN NEW.created_at := clock_timestamp();")
    expect(compact).toContain('BEFORE INSERT OR UPDATE OF media_id ON shift_media')
  })

  it('accepts positional order evidence only from the exact completed dashboard read', () => {
    expect(compact).toContain('JOIN public.shift_close_draft_reads r ON r.id = o.read_id')
    expect(compact).toContain("AND r.package = 'end' AND r.field = 'orders' AND r.status = 'complete'")
    expect(compact).toContain("AND r.slot ~ '^dashboard(_([2-9]|[1-9][0-9]+))?$'")
  })

  it('keeps submitted reads and provenance changes behind independent database guards', () => {
    expect(compact).toContain('JOIN public.shift_close_drafts d ON d.shift_id = s.id')
    expect(compact).toContain('WHERE s.id = NEW.shift_id AND d.submitted_at IS NULL')
    expect(compact).toContain('operation provenance changes require a fresh attributed manager reason')
  })

  it('keeps PL/pgSQL CASE expressions unambiguous around json operators', () => {
    expect(compact).toContain("IF (p_new ->> 'pay_mode') IS DISTINCT FROM (CASE")
    expect(compact).toContain("OR (p_new ->> 'source') IS DISTINCT FROM (CASE")
  })

  it('requires driver ownership only when inserting a new canonical operation', () => {
    expect(compact).toContain("IF p_operation = 'INSERT' AND NOT EXISTS (")
    expect(compact).toContain("p_new -> 'id', p_new -> 'shift_id', p_new -> 'created_by'")
    expect(compact).toContain("p_old -> 'id', p_old -> 'shift_id', p_old -> 'created_by'")
  })
})
