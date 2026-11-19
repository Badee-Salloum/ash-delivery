export const BACKUP_COLUMNS_SQL = `
  SELECT table_name,column_name,udt_name,is_nullable,ordinal_position
    FROM information_schema.columns
   WHERE table_schema='public'
   ORDER BY table_name,ordinal_position
`

export function parseBackupOptions(args, defaultOut) {
  const options = { outRoot: defaultOut, concurrency: 1, quiescent: false }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!['--out', '--concurrency', '--quiescent'].includes(key) || seen.has(key)) throw new Error('unknown or repeated backup argument')
    seen.add(key)
    if (key === '--quiescent') { options.quiescent = true; continue }
    const value = args[++i]
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error('backup argument value is required')
    if (key === '--out') options.outRoot = value
    else {
      if (!/^[1-4]$/.test(value)) throw new Error('--concurrency must be an integer from 1 to 4')
      options.concurrency = Number(value)
    }
  }
  return options
}

export function backupColumnsByTable(tables, rows) {
  return Object.fromEntries(tables.map(table => {
    const columns = rows.filter(row => row.table_name === table)
      .sort((a, b) => Number(a.ordinal_position) - Number(b.ordinal_position))
      .map(row => ({ name: row.column_name, type: row.udt_name, nullable: row.is_nullable === 'YES' }))
    if (!columns.length || new Set(columns.map(column => column.name)).size !== columns.length) {
      throw new Error(`missing or duplicate backup column metadata: ${table}`)
    }
    return [table, columns]
  }))
}

export const backupIdent = value => `"${String(value).replaceAll('"', '""')}"`
const literal = value => `'${String(value).replaceAll("'", "''")}'`
export function backupCountQuery(tables) {
  return tables.length ? tables.map(table => `SELECT ${literal(table)} AS table_name,count(*)::text AS row_count FROM public.${backupIdent(table)}`).join('\nUNION ALL\n')
    : "SELECT NULL::text AS table_name,'0'::text AS row_count WHERE false"
}

export function exactBackupCounts(tables, rows) {
  const expected = new Set(tables), found = new Map()
  for (const row of rows) {
    if (!expected.has(row.table_name) || found.has(row.table_name) || typeof row.row_count !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.row_count)) {
      throw new Error('invalid exact backup count metadata')
    }
    const value = BigInt(row.row_count)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('backup row count exceeds exact manifest integer range')
    found.set(row.table_name, Number(value))
  }
  if (found.size !== expected.size) throw new Error('missing exact backup count metadata')
  return Object.fromEntries(tables.map(table => [table, found.get(table)]))
}

export function assertQuiescentCounts(tables, start, written, end) {
  for (const table of tables) {
    if (![start[table], written[table], end[table]].every(value => Number.isSafeInteger(value) && value >= 0)
      || start[table] !== written[table] || start[table] !== end[table]) {
      throw new Error(`quiescent backup count drift: ${table}`)
    }
  }
}

/** Stop assigning jobs after failure, but await every already-started pipeline before rejecting. */
export async function runBackupBounded(items, concurrency, work) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('invalid backup concurrency')
  let next = 0, failed = false, failure
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++
      try { await work(items[index], index) } catch (error) { if (!failed) { failed = true; failure = error } }
    }
  }))
  if (failed) throw failure
}
