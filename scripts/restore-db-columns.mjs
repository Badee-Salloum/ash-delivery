/** Never insert stored/virtual generated values; PostgreSQL reconstructs them from source columns. */
export const RESTORE_TARGET_COLUMNS_SQL = `
  SELECT relation.relname AS table_name, attribute.attname AS column_name,
         attribute.attgenerated AS generated
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
   WHERE namespace.nspname='public' AND relation.relkind IN ('r','p')
     AND attribute.attnum>0 AND NOT attribute.attisdropped
   ORDER BY relation.relname,attribute.attnum
`

/** The full manifest stays unchanged; filter INSERT columns only after checking the target catalog. */
export function restoreInsertColumns(table, backupColumns, catalog) {
  const target = catalog.filter(row => row.table_name === table)
  const names = new Set(target.map(row => row.column_name))
  if (!Array.isArray(backupColumns) || backupColumns.length === 0 || target.length !== names.size
    || backupColumns.length !== target.length || new Set(backupColumns.map(column => column.name)).size !== backupColumns.length
    || backupColumns.some(column => !names.has(column.name))) {
    throw new Error(`restore column set differs from target: ${table}`)
  }
  const generated = new Map(target.map(row => [row.column_name, row.generated]))
  if (target.some(row => !['', 's', 'v'].includes(row.generated))) throw new Error(`unknown target generation metadata: ${table}`)
  const insertable = backupColumns.filter(column => generated.get(column.name) === '')
  if (!insertable.length) throw new Error(`no insertable source columns for restored table: ${table}`)
  return insertable
}
