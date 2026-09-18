/**
 * Read-only release proof for migration 0053.
 *
 * Run with the direct owner URL after applying migrations. It never inserts, updates, deletes, or
 * exercises the restoration endpoint; it only proves that the migration ledger, trigger dispatch,
 * historical evidence split, and double-entry invariant match the checked-out release artifact.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(join(root, 'packages', 'db', 'package.json'))
const neonModule = await import(pathToFileURL(req.resolve('@neondatabase/serverless')).href)
const neon = neonModule.neon ?? neonModule.default?.neon

const EXPECTED_MIGRATIONS = Object.freeze({
  '0051_receivable_writeoff.sql': '9bfb4ed6',
  '0052_shift_shortage_ordinary_receivable.sql': 'b482cc62',
  '0053_ledger_backed_restoration.sql': 'baaa695d',
})
const EXPECTED_MIGRATION = '0053_ledger_backed_restoration.sql'
const EXPECTED_CHECKSUM = EXPECTED_MIGRATIONS[EXPECTED_MIGRATION]

const fail = (message, detail) => {
  throw new Error(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`)
}
const assert = (condition, message, detail) => {
  if (!condition) fail(message, detail)
}
const simpleChecksum = (source) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

for (const [filename, expectedChecksum] of Object.entries(EXPECTED_MIGRATIONS)) {
  const migrationSource = await readFile(join(root, 'packages', 'db', 'migrations', filename), 'utf8')
  const localChecksum = simpleChecksum(migrationSource)
  assert(localChecksum === expectedChecksum, `the checked-out ${filename} artifact changed`, {
    expected: expectedChecksum,
    actual: localChecksum,
  })
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) fail('DATABASE_URL is required')
const expectedDatabaseHost = process.env.EXPECTED_DATABASE_HOST
if (!expectedDatabaseHost) fail('EXPECTED_DATABASE_HOST is required')
const parsedDatabaseUrl = new URL(databaseUrl)
assert(!parsedDatabaseUrl.hostname.includes('-pooler'), 'postflight requires the direct database endpoint')
assert(parsedDatabaseUrl.hostname === expectedDatabaseHost, 'postflight database endpoint differs from the pinned production host')
const sql = neon(databaseUrl)

const [databaseIdentity] = await sql`
  SELECT current_database() AS database, current_user AS "currentUser"
`
assert(databaseIdentity?.database === 'neondb', 'postflight is not connected to the expected database name', databaseIdentity)
assert(databaseIdentity?.currentUser === 'neondb_owner', 'postflight requires the owner role', databaseIdentity)
assert(
  decodeURIComponent(parsedDatabaseUrl.username) === databaseIdentity.currentUser,
  'DATABASE_URL user differs from the connected role',
  databaseIdentity,
)

const migrationRows = await sql`
  SELECT filename, checksum
    FROM schema_migrations
   WHERE filename IN (
     '0051_receivable_writeoff.sql',
     '0052_shift_shortage_ordinary_receivable.sql',
     '0053_ledger_backed_restoration.sql'
   )
   ORDER BY filename
`
assert(migrationRows.length === 3, 'release migration rows are missing or duplicated', migrationRows)
for (const row of migrationRows) {
  assert(EXPECTED_MIGRATIONS[row.filename] === row.checksum, 'release migration checksum mismatch', row)
}

const [migration] = await sql`
  SELECT count(*)::text AS total,
         max(filename) AS latest,
         (SELECT checksum FROM schema_migrations WHERE filename = ${EXPECTED_MIGRATION}) AS checksum
    FROM schema_migrations
`
assert(migration.total === '53', 'migration ledger is not exactly at 0053', migration)
assert(migration.latest === EXPECTED_MIGRATION, '0053 is not the latest migration', migration)
assert(migration.checksum === EXPECTED_CHECKSUM, 'database 0053 checksum differs from the release artifact', migration)

const settlementColumns = await sql`
  SELECT column_name AS name, is_nullable AS "isNullable"
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'shift_settlements'
     AND column_name IN (
       'maximum_cash_shortage_receivable_minor',
       'cash_shortage_receivable_minor'
     )
   ORDER BY column_name
`
assert(
  settlementColumns.length === 2 && settlementColumns.every((column) => column.isNullable === 'NO'),
  '0052 settlement shortage columns are absent or nullable',
  settlementColumns,
)

const [settlementFacts] = await sql`
  SELECT count(*) FILTER (
           WHERE maximum_cash_shortage_receivable_minor
                   <> GREATEST(-final_employee_cash_minor::numeric, 0::numeric)
         )::text AS "wrongMaximum",
         count(*) FILTER (
           WHERE cash_shortage_receivable_minor < 0
              OR cash_shortage_receivable_minor > maximum_cash_shortage_receivable_minor
         )::text AS "outOfBounds"
    FROM shift_settlements
`
assert(settlementFacts.wrongMaximum === '0' && settlementFacts.outOfBounds === '0', '0052 settlement facts are inconsistent', settlementFacts)

const [column] = await sql`
  SELECT is_nullable AS "isNullable"
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'restorations'
     AND column_name = 'cash_count_id'
`
assert(column?.isNullable === 'YES', 'restorations.cash_count_id is not nullable for schema v3', column)

const triggers = await sql`
  SELECT trigger.tgname AS name,
         trigger.tgenabled AS enabled,
         function.proname AS function,
         pg_get_triggerdef(trigger.oid, true) AS definition
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_proc function ON function.oid = trigger.tgfoid
   WHERE namespace.nspname = 'public'
     AND relation.relname = 'restorations'
     AND NOT trigger.tgisinternal
     AND trigger.tgname IN (
       'restorations_00_schema_guard',
       'restorations_10_v2_guard',
       'restorations_10_v3_guard',
       'restorations_immutable',
       'restorations_insert_guard'
     )
   ORDER BY trigger.tgname
`
const triggersByName = new Map(triggers.map((trigger) => [trigger.name, trigger]))
for (const [name, expectedFunction] of [
  ['restorations_00_schema_guard', 'guard_restoration_schema_insert'],
  ['restorations_10_v2_guard', 'guard_restoration_insert'],
  ['restorations_10_v3_guard', 'guard_ledger_restoration_insert'],
  ['restorations_immutable', 'prevent_restoration_mutation'],
]) {
  const trigger = triggersByName.get(name)
  assert(trigger?.enabled === 'O' && trigger?.function === expectedFunction, `${name} is absent, disabled, or miswired`, trigger)
}
assert(!triggersByName.has('restorations_insert_guard'), 'the unconditional v2 trigger still exists', triggers)
for (const name of ['restorations_00_schema_guard', 'restorations_10_v2_guard', 'restorations_10_v3_guard']) {
  const definition = triggersByName.get(name)?.definition ?? ''
  assert(
    /\bBEFORE INSERT\b/i.test(definition) && /\bFOR EACH ROW\b/i.test(definition),
    `${name} is not a row-level BEFORE INSERT trigger`,
    definition,
  )
}
for (const [name, schemaVersion] of [
  ['restorations_10_v2_guard', '2'],
  ['restorations_10_v3_guard', '3'],
]) {
  const definition = triggersByName.get(name)?.definition ?? ''
  const otherSchemaVersion = schemaVersion === '2' ? '3' : '2'
  assert(
    /\bWHEN\b/i.test(definition)
      && definition.includes('schemaVersion')
      && definition.includes(`'${schemaVersion}'`)
      && !definition.includes(`'${otherSchemaVersion}'`),
    `${name} lost its schema-version predicate`,
    definition,
  )
}
const immutableDefinition = triggersByName.get('restorations_immutable')?.definition ?? ''
assert(
  /\bBEFORE\b/i.test(immutableDefinition)
    && /\bUPDATE\b/i.test(immutableDefinition)
    && /\bDELETE\b/i.test(immutableDefinition)
    && /\bFOR EACH ROW\b/i.test(immutableDefinition),
  'restorations_immutable no longer guards row updates and deletes',
  immutableDefinition,
)

const functions = await sql`
  SELECT function.proname AS name,
         function.prosecdef AS secure,
         COALESCE(array_to_string(function.proconfig, ','), '') AS settings,
         pg_get_function_identity_arguments(function.oid) AS arguments,
         pg_get_function_result(function.oid) AS result,
         language.lanname AS language,
         pg_get_functiondef(function.oid) AS definition
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN pg_language language ON language.oid = function.prolang
   WHERE namespace.nspname = 'public'
     AND function.proname IN ('guard_restoration_schema_insert', 'guard_ledger_restoration_insert')
   ORDER BY function.proname
`
const functionsByName = new Map(functions.map((fn) => [fn.name, fn]))
const schemaGuard = functionsByName.get('guard_restoration_schema_insert')
const ledgerGuard = functionsByName.get('guard_ledger_restoration_insert')
assert(functions.length === 2, 'restoration guard functions are missing or overloaded', functions)
for (const guard of [schemaGuard, ledgerGuard]) {
  assert(
    guard?.arguments === '' && guard?.result === 'trigger' && guard?.language === 'plpgsql',
    'restoration guard signature or language drifted',
    guard,
  )
  assert(guard?.settings === 'search_path=pg_catalog, public, pg_temp', 'restoration guard search_path drifted', guard)
}
assert(
  /COALESCE\s*\(\s*NEW\.plan\s*->>\s*'schemaVersion'(?:::text)?\s*,\s*''(?:::text)?\s*\)/i.test(
    schemaGuard?.definition ?? '',
  ),
  'schema guard is not fail-closed for a missing/null schemaVersion',
  schemaGuard?.definition,
)
assert(ledgerGuard?.secure === true, 'v3 ledger guard is not SECURITY DEFINER', ledgerGuard)

const [facts] = await sql`
  SELECT count(*) FILTER (
           WHERE plan->>'schemaVersion' = '2' AND cash_count_id IS NULL
         )::text AS "v2WithoutCount",
         count(*) FILTER (
           WHERE plan->>'schemaVersion' = '3' AND cash_count_id IS NOT NULL
         )::text AS "v3WithCount",
         count(*) FILTER (
           WHERE jsonb_typeof(plan) IS DISTINCT FROM 'object'
              OR COALESCE(plan->>'schemaVersion', '') NOT IN ('2', '3')
         )::text AS "unsupportedSchema",
         count(*) FILTER (WHERE plan->>'schemaVersion' = '3')::text AS "v3Facts"
    FROM restorations
`
assert(facts.v2WithoutCount === '0', 'historical schema-v2 restoration lost its count evidence', facts)
assert(facts.v3WithCount === '0', 'schema-v3 restoration incorrectly references a cash count', facts)
assert(facts.unsupportedSchema === '0', 'unsupported restoration facts exist', facts)

const [ledger] = await sql`
  SELECT count(*) FILTER (
           WHERE line_count < 2
              OR line_count <> debit_lines + credit_lines
              OR debit_lines = 0
              OR credit_lines = 0
              OR non_positive_lines > 0
              OR debit_minor <> credit_minor
         )::text AS "invalidEntries",
         COALESCE(sum(debit_minor - credit_minor), 0)::text AS "trialBalance"
    FROM (
      SELECT entry.id,
             count(line.id) AS line_count,
             count(line.id) FILTER (WHERE line.side = 'D') AS debit_lines,
             count(line.id) FILTER (WHERE line.side = 'C') AS credit_lines,
             count(line.id) FILTER (WHERE line.amount_minor <= 0) AS non_positive_lines,
             COALESCE(sum(line.amount_minor) FILTER (WHERE line.side = 'D'), 0) AS debit_minor,
             COALESCE(sum(line.amount_minor) FILTER (WHERE line.side = 'C'), 0) AS credit_minor
        FROM journal_entries entry
        LEFT JOIN journal_lines line ON line.entry_id = entry.id
       GROUP BY entry.id
    ) entry_balance
`
assert(ledger.invalidEntries === '0' && ledger.trialBalance === '0', 'one or more journal entries are not balanced', ledger)

console.log(JSON.stringify({
  ok: true,
  databaseIdentity,
  migration,
  releaseMigrations: migrationRows,
  settlementFacts,
  cashCountIdNullable: true,
  triggers: [...triggersByName.keys()].sort(),
  restorationFacts: facts,
  trialBalance: ledger.trialBalance,
}, null, 2))
