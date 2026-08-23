import { describe, expect, it } from 'vitest'
import {
  OWNED_SEQUENCE_COLUMNS_SQL,
  buildSequenceResetQuery,
  quoteIdent,
  resetOwnedSequences,
} from '../../../scripts/restore-db-sequences.mjs'

describe('restore sequence reset plan', () => {
  it('discovers serial and identity sequences in one catalog query', () => {
    expect(OWNED_SEQUENCE_COLUMNS_SQL).toContain('pg_get_serial_sequence')
    expect(OWNED_SEQUENCE_COLUMNS_SQL).toContain("attribute.attidentity IN ('a', 'd')")
    expect(OWNED_SEQUENCE_COLUMNS_SQL).toContain('attribute.atthasdef')
    expect(OWNED_SEQUENCE_COLUMNS_SQL).toContain("namespace.nspname = 'public'")
  })

  it('builds one parameterized, safely quoted reset statement for restored tables only', () => {
    const query = buildSequenceResetQuery([
      {
        table_schema: 'public',
        table_name: 'journal_entries',
        column_name: 'id',
        sequence_name: 'public.journal_entries_id_seq',
      },
      {
        table_schema: 'public',
        table_name: 'odd"table',
        column_name: 'odd"id',
        sequence_name: 'public.odd_table_id_seq',
      },
      {
        table_schema: 'public',
        table_name: 'not_restored',
        column_name: 'id',
        sequence_name: 'public.not_restored_id_seq',
      },
    ], ['journal_entries', 'odd"table'])

    expect(query.params).toEqual([
      'public.journal_entries_id_seq',
      'public.odd_table_id_seq',
    ])
    expect(query.count).toBe(2)
    expect(query.text).toContain('$1::regclass')
    expect(query.text).toContain('$2::regclass')
    expect(query.text).toContain('UNION ALL')
    expect(query.text).toContain('FROM "public"."journal_entries"')
    expect(query.text).toContain('MAX("odd""id")')
    expect(query.text).toContain('FROM "public"."odd""table"')
    expect(query.text).not.toContain('journal_entries_id_seq')
    expect(buildSequenceResetQuery([], [])).toBeNull()
    expect(quoteIdent('a"b')).toBe('"a""b"')
  })

  it('uses exactly two queries regardless of the number of sequences', async () => {
    const calls = []
    const sql = {
      async query(text, params) {
        calls.push({ text, params })
        if (calls.length === 1) {
          return [
            {
              table_schema: 'public',
              table_name: 'a',
              column_name: 'id',
              sequence_name: 'public.a_id_seq',
            },
            {
              table_schema: 'public',
              table_name: 'b',
              column_name: 'id',
              sequence_name: 'public.b_id_seq',
            },
          ]
        }
        return []
      },
    }

    expect(await resetOwnedSequences(sql, ['a', 'b'])).toBe(2)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ text: OWNED_SEQUENCE_COLUMNS_SQL, params: undefined })
    expect(calls[1].params).toEqual(['public.a_id_seq', 'public.b_id_seq'])
  })

  it('does not issue a reset query when no restored table owns a sequence', async () => {
    const calls = []
    const sql = {
      async query(text, params) {
        calls.push({ text, params })
        return [{
          table_schema: 'public',
          table_name: 'other',
          column_name: 'id',
          sequence_name: 'public.other_id_seq',
        }]
      },
    }

    expect(await resetOwnedSequences(sql, ['restored'])).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('rejects duplicate catalog mappings instead of issuing ambiguous resets', () => {
    const row = {
      table_schema: 'public',
      table_name: 'items',
      column_name: 'id',
      sequence_name: 'public.items_id_seq',
    }
    expect(() => buildSequenceResetQuery([row, row], ['items'])).toThrow('duplicate sequence mapping')
  })
})
