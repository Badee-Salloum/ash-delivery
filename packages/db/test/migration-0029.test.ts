import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../migrations/0029_serialize_week_seal_with_postings.sql', import.meta.url),
  'utf8',
)

function functionSql(signature: string): string {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = migration.match(new RegExp(`CREATE OR REPLACE FUNCTION ${escaped}[\\s\\S]*?\\n\\$\\$;`))
  expect(match, `missing SQL function ${signature}`).not.toBeNull()
  return match?.[0].replace(/\s+/g, ' ') ?? ''
}

describe('migration 0029 sealed-week race protocol', () => {
  it('uses one canonical branch lock key on both sides', () => {
    const key = functionSql('fin_week_seal_guard_key(p_branch_id uuid)')
    expect(key).toContain("hashtextextended('ash:week-seal:' || p_branch_id::text, 0)")

    const postingGuard = functionSql('assert_posting_week_open()')
    expect(postingGuard).toContain(
      'pg_advisory_xact_lock_shared(public.fin_week_seal_guard_key(NEW.branch_id))',
    )

    const sealer = functionSql('fin_seal_week(p_week_lock_id bigint, p_closed_by uuid)')
    expect(sealer).toContain('pg_advisory_xact_lock(public.fin_week_seal_guard_key(v_branch))')
  })

  it('locks before either side checks or mutates the week', () => {
    const postingGuard = functionSql('assert_posting_week_open()')
    expect(postingGuard.indexOf('pg_advisory_xact_lock_shared')).toBeLessThan(
      postingGuard.indexOf('SELECT closed_at INTO v_closed_at'),
    )

    const sealer = functionSql('fin_seal_week(p_week_lock_id bigint, p_closed_by uuid)')
    expect(sealer.indexOf('pg_advisory_xact_lock(')).toBeLessThan(
      sealer.indexOf('UPDATE public.journal_entries'),
    )
    expect(sealer.indexOf('UPDATE public.journal_entries')).toBeLessThan(
      sealer.indexOf('UPDATE public.week_locks'),
    )
  })

  it('cannot resolve week state through a caller temporary schema', () => {
    const postingGuard = functionSql('assert_posting_week_open()')
    expect(postingGuard).toContain('SET search_path = pg_catalog, public, pg_temp')
    expect(postingGuard).toContain('public.fin_week_seal_guard_key(NEW.branch_id)')
    expect(postingGuard.match(/FROM public\.week_locks/g)).toHaveLength(2)

    const sealer = functionSql('fin_seal_week(p_week_lock_id bigint, p_closed_by uuid)')
    expect(sealer).toContain('SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp')
    expect(sealer).toContain('FROM public.week_locks')
    expect(sealer).toContain('UPDATE public.journal_entries')
    expect(sealer).toContain('UPDATE public.week_locks')
    expect(sealer).toContain('public.fin_week_seal_guard_key(v_branch)')
  })
})
