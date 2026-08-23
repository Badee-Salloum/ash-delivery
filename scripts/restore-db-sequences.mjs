/**
 * Reset serial/identity sequences after a data-only restore using two database round trips:
 * one catalog lookup and one reset statement.
 */

export const OWNED_SEQUENCE_COLUMNS_SQL = `
  SELECT table_schema, table_name, column_name, sequence_name
  FROM (
    SELECT
      namespace.nspname AS table_schema,
      table_class.relname AS table_name,
      attribute.attname AS column_name,
      pg_get_serial_sequence(
        format('%I.%I', namespace.nspname, table_class.relname),
        attribute.attname
      ) AS sequence_name
    FROM pg_class AS table_class
    JOIN pg_namespace AS namespace
      ON namespace.oid = table_class.relnamespace
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = table_class.oid
    WHERE namespace.nspname = 'public'
      AND table_class.relkind IN ('r', 'p')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND (attribute.attidentity IN ('a', 'd') OR attribute.atthasdef)
  ) AS owned
  WHERE sequence_name IS NOT NULL
  ORDER BY table_schema, table_name, column_name
`

export function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

export function buildSequenceResetQuery(rows, restoredTables) {
  const allowedTables = new Set(restoredTables)
  const seen = new Set()
  const owned = rows.filter((row) => {
    if (
      row.table_schema !== 'public'
      || !allowedTables.has(row.table_name)
      || typeof row.sequence_name !== 'string'
      || row.sequence_name.length === 0
    ) return false

    const key = `${row.table_schema}\u0000${row.table_name}\u0000${row.column_name}`
    if (seen.has(key)) throw new Error(`duplicate sequence mapping for ${row.table_name}.${row.column_name}`)
    seen.add(key)
    return true
  })

  if (owned.length === 0) return null

  const branches = owned.map((row, index) => {
    const table = `${quoteIdent(row.table_schema)}.${quoteIdent(row.table_name)}`
    const column = quoteIdent(row.column_name)
    return [
      `SELECT setval($${index + 1}::regclass,`,
      `COALESCE((SELECT MAX(${column})::bigint FROM ${table}), 0::bigint) + 1, false)`,
      'AS next_value',
    ].join(' ')
  })

  return {
    text: branches.join('\nUNION ALL\n'),
    params: owned.map((row) => row.sequence_name),
    count: owned.length,
  }
}

export async function resetOwnedSequences(sql, restoredTables) {
  const rows = await sql.query(OWNED_SEQUENCE_COLUMNS_SQL)
  const query = buildSequenceResetQuery(rows, restoredTables)
  if (!query) return 0
  await sql.query(query.text, query.params)
  return query.count
}
