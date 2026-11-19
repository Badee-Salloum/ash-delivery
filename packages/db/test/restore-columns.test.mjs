import { describe, expect, it } from 'vitest'
import { RESTORE_TARGET_COLUMNS_SQL, restoreInsertColumns } from '../../../scripts/restore-db-columns.mjs'

const columns = [{ name: 'request_id', type: 'uuid' }, { name: 'id', type: 'uuid' }, { name: 'payload', type: 'jsonb' }]
const catalog = [
  { table_name: 'revisions', column_name: 'request_id', generated: '' },
  { table_name: 'revisions', column_name: 'id', generated: 's' },
  { table_name: 'revisions', column_name: 'payload', generated: '' },
]

describe('restore generated column filtering', () => {
  it('uses real target generation metadata and keeps all backup fields intact', () => {
    expect(RESTORE_TARGET_COLUMNS_SQL).toContain('attribute.attgenerated')
    expect(RESTORE_TARGET_COLUMNS_SQL).toContain("namespace.nspname='public'")
    expect(restoreInsertColumns('revisions', columns, catalog)).toEqual([columns[0], columns[2]])
    expect(columns).toHaveLength(3)
    expect(columns[1]).toEqual({ name: 'id', type: 'uuid' })
  })

  it('preserves ordinary serial and identity source columns and manifest order', () => {
    const ordinary = catalog.map(row => ({ ...row, generated: '' }))
    expect(restoreInsertColumns('revisions', [...columns].reverse(), ordinary)).toEqual([...columns].reverse())
    const virtual = catalog.map(row => ({ ...row, generated: row.generated === 's' ? 'v' : '' }))
    expect(restoreInsertColumns('revisions', columns, virtual)).toEqual([columns[0], columns[2]])
  })

  it('fails before destructive loading on missing, extra, duplicate or unknown target metadata', () => {
    expect(() => restoreInsertColumns('missing', columns, catalog)).toThrow('column set differs')
    expect(() => restoreInsertColumns('revisions', columns.slice(1), catalog)).toThrow('column set differs')
    expect(() => restoreInsertColumns('revisions', [columns[0], columns[0], columns[2]], catalog)).toThrow('column set differs')
    expect(() => restoreInsertColumns('revisions', columns, [...catalog, catalog[0]])).toThrow('column set differs')
    expect(() => restoreInsertColumns('revisions', columns, catalog.map(row => ({ ...row, generated: 'unknown' })))).toThrow('generation metadata')
  })

  it('refuses a generated-only table rather than silently ignoring captured rows', () => {
    expect(() => restoreInsertColumns('derived', [{ name: 'id', type: 'uuid' }], [
      { table_name: 'derived', column_name: 'id', generated: 's' },
    ])).toThrow('no insertable source columns')
  })
})
