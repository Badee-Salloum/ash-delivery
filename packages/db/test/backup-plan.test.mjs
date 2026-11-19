import { describe, expect, it } from 'vitest'
import { BACKUP_COLUMNS_SQL, assertQuiescentCounts, backupColumnsByTable, backupCountQuery,
  exactBackupCounts, parseBackupOptions, runBackupBounded } from '../../../scripts/backup-db-plan.mjs'

describe('conservative logical backup planner', () => {
  it('defaults to one full-stream worker and accepts only explicit bounded options', () => {
    expect(parseBackupOptions([], 'backups')).toEqual({ outRoot: 'backups', concurrency: 1, quiescent: false })
    expect(parseBackupOptions(['--out', 'other', '--quiescent', '--concurrency', '4'], 'backups'))
      .toEqual({ outRoot: 'other', concurrency: 4, quiescent: true })
    for (const args of [['--concurrency', '0'], ['--concurrency', '5'], ['--concurrency', '1.5'],
      ['--concurrency', '01'], ['--out'], ['--out', '--quiescent'], ['--quiescent', '--quiescent'], ['--unknown']]) {
      expect(() => parseBackupOptions(args, 'backups')).toThrow()
    }
  })

  it('groups one public metadata query without changing column order or type/null fidelity', () => {
    expect(BACKUP_COLUMNS_SQL).toContain("table_schema='public'")
    const columns = backupColumnsByTable(['entries', 'users'], [
      { table_name: 'entries', column_name: 'amount_minor', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 2 },
      { table_name: 'view_not_captured', column_name: 'ignored', udt_name: 'text', is_nullable: 'YES', ordinal_position: 1 },
      { table_name: 'entries', column_name: 'id', udt_name: 'uuid', is_nullable: 'NO', ordinal_position: 1 },
      { table_name: 'users', column_name: 'note', udt_name: 'text', is_nullable: 'YES', ordinal_position: 1 },
    ])
    expect(columns).toEqual({ entries: [{ name: 'id', type: 'uuid', nullable: false },
      { name: 'amount_minor', type: 'int8', nullable: false }], users: [{ name: 'note', type: 'text', nullable: true }] })
    expect(() => backupColumnsByTable(['missing'], [])).toThrow('column metadata')
  })

  it('counts all tables in one statement with safely quoted identifiers and text counts', () => {
    const query = backupCountQuery(['ordinary', 'odd"table', "odd'table"])
    expect(query).toContain('count(*)::text')
    expect(query).toContain('UNION ALL')
    expect(query).toContain('FROM public."odd""table"')
    expect(query).toContain("SELECT 'odd''table' AS table_name")
    expect(backupCountQuery([])).toContain('WHERE false')
  })

  it('requires exact complete counts and refuses duplicates, drift and unsafe numeric manifests', () => {
    const counts = exactBackupCounts(['a', 'b'], [{ table_name: 'b', row_count: '0' }, { table_name: 'a', row_count: '249612' }])
    expect(counts).toEqual({ a: 249612, b: 0 })
    expect(() => assertQuiescentCounts(['a', 'b'], counts, counts, counts)).not.toThrow()
    expect(() => assertQuiescentCounts(['a', 'b'], counts, { a: 249612, b: 1 }, counts)).toThrow('count drift')
    expect(() => assertQuiescentCounts(['a', 'b'], counts, counts, { a: 249611, b: 0 })).toThrow('count drift')
    expect(() => exactBackupCounts(['a'], [])).toThrow('missing')
    expect(() => exactBackupCounts(['a'], [{ table_name: 'a', row_count: '1' }, { table_name: 'a', row_count: '1' }])).toThrow('invalid')
    expect(() => exactBackupCounts(['a'], [{ table_name: 'a', row_count: '9007199254740993' }])).toThrow('exact manifest')
    expect(() => exactBackupCounts(['a'], [{ table_name: 'a', row_count: 1 }])).toThrow('invalid')
  })

  it('never exceeds the explicit table concurrency and processes each table once', async () => {
    let active = 0, maximum = 0
    const completed = []
    await runBackupBounded([0, 1, 2, 3, 4, 5, 6], 4, async value => {
      active++; maximum = Math.max(maximum, active)
      await Promise.resolve(); completed.push(value); active--
    })
    expect(maximum).toBe(4)
    expect(completed.sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(active).toBe(0)
  })

  it('waits for in-flight jobs and does not assign a later table after a failure', async () => {
    let finishSecond
    const deferred = new Promise(resolve => { finishSecond = resolve })
    const visited = []
    const result = runBackupBounded(['first', 'second', 'never'], 2, async value => {
      visited.push(value)
      if (value === 'first') throw new Error('page failed')
      await deferred
    })
    let finished = false
    const completion = result.catch(error => { finished = true; return error.message })
    await Promise.resolve()
    expect(finished).toBe(false)
    finishSecond()
    expect(await completion).toBe('page failed')
    expect(visited).toEqual(['first', 'second'])
  })
})
