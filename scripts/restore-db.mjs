#!/usr/bin/env node
/**
 * Load a backup taken by `backup-db.mjs` into a target database.
 *
 *   DATABASE_URL=postgres://<TARGET> node scripts/restore-db.mjs backups/<stamp> [--yes]
 *
 * A backup nobody has restored from is a belief, not a backup. This is the half that makes the
 * other half true, and it is meant to be REHEARSED — see RUNBOOK.
 *
 * THE SCHEMA IS NOT IN THE BACKUP, deliberately. It lives in `packages/db/migrations`, under
 * checksum, in version control. Restoring is therefore: create an empty database, `pnpm migrate`,
 * then run this. The manifest records which migrations the data was written under, and this
 * refuses to load if the target does not match — data from a schema you no longer have is not a
 * restore, it is a puzzle.
 *
 * Parents are loaded before children, ordered from the foreign-key graph captured at backup time,
 * because Neon's owner role cannot reliably `SET session_replication_role = replica` to defer the
 * checks. A cycle (none today) falls back to the recorded order and reports it.
 *
 * SAFETY. It refuses to touch a database that already holds business rows unless `--yes` is given,
 * and it refuses outright if the target host looks like the production host in the manifest.
 */
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGunzip } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(join(root, 'packages/db/package.json'))
const mod = await import(pathToFileURL(req.resolve('@neondatabase/serverless')).href)
const neon = mod.neon ?? mod.default?.neon

const dir = process.argv[2]
const force = process.argv.includes('--yes')
const url = process.env.DATABASE_URL
if (!dir || !url) {
  console.error('usage: DATABASE_URL=<target> node scripts/restore-db.mjs <backup-dir> [--yes]')
  process.exit(1)
}
const sql = neon(url)

/** Parents first. Kahn's algorithm over the captured FK edges; self-references are ignored. */
function loadOrder(tables, fks) {
  const deps = new Map(tables.map((t) => [t, new Set()]))
  for (const { child, parent } of fks) {
    if (child === parent || !deps.has(child) || !deps.has(parent)) continue
    deps.get(child).add(parent)
  }
  const out = []
  const left = new Set(tables)
  while (left.size > 0) {
    const ready = [...left].filter((t) => [...deps.get(t)].every((p) => !left.has(p)))
    if (ready.length === 0) {
      // A cycle. Report it rather than silently producing an order that will fail on FK checks.
      console.warn(`!! FK cycle among: ${[...left].join(', ')} — loading in recorded order`)
      out.push(...left)
      break
    }
    for (const t of ready.sort()) {
      out.push(t)
      left.delete(t)
    }
  }
  return out
}

async function main() {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  const targetHost = new URL(url).host
  const targetDb = new URL(url).pathname.slice(1)

  console.log(`backup:  ${manifest.takenAt}  ${manifest.totalRows} rows  from ${manifest.host}/${manifest.database}`)
  console.log(`target:  ${targetHost}/${targetDb}`)
  // Host AND database: a scratch database on the same Neon project is the normal rehearsal
  // target, and refusing it would mean the rehearsal never happens. Refusing to load a backup
  // back over the exact database it came from is the check that matters.
  if (targetHost === manifest.host && targetDb === manifest.database && !force) {
    console.error('\nREFUSING: that is the database this backup came from. Pass --yes only if you mean it.')
    process.exit(1)
  }

  // The data was written under a specific schema. Loading it into a different one is not a restore.
  const there = await sql`SELECT filename, checksum FROM schema_migrations ORDER BY filename`
  const want = manifest.migrations.map((m) => `${m.filename}=${m.checksum}`).join(',')
  const have = there.map((m) => `${m.filename}=${m.checksum}`).join(',')
  if (want !== have) {
    console.error('\nREFUSING: the target schema does not match the backup.')
    console.error(`  backup has ${manifest.migrations.length} migrations, target has ${there.length}`)
    console.error('  Run `pnpm migrate` against the target first, at the matching commit.')
    process.exit(1)
  }

  const order = loadOrder(manifest.tables, manifest.fks)

  // Never load on top of live data by accident.
  const busy = []
  for (const t of order) {
    const [{ n }] = await sql.query(`SELECT count(*)::int AS n FROM "${t}"`)
    if (n > 0) busy.push(`${t} (${n})`)
  }
  if (busy.length > 0 && !force) {
    console.error(`\nREFUSING: the target already holds rows: ${busy.slice(0, 6).join(', ')}${busy.length > 6 ? ' …' : ''}`)
    console.error('Pass --yes to truncate and load anyway.')
    process.exit(1)
  }

  /*
   * TRIGGERS OFF FOR THE LOAD. Not an optimisation — the restore is wrong without it, twice over.
   *
   * The audit triggers fire on the restore's own INSERTs and write NEW rows into `audit_log`,
   * whose ids then collide with the audit rows being restored (`Key (id)=(41) already exists`).
   *
   * And `journal_lines_balanced` is DEFERRABLE INITIALLY DEFERRED — it checks at COMMIT. The Neon
   * HTTP driver has no persistent session, so every INSERT is its own implicit transaction and the
   * deferred check fires after EACH LINE: the first line of a two-line entry fails on its own,
   * every time. The ledger is unrestorable with triggers on.
   *
   * `ALTER TABLE … DISABLE TRIGGER USER` is DDL, so it persists across the driver's separate
   * connections where `SET session_replication_role` would not. Re-enabled in `finally`, because
   * a database left with its audit and balance triggers off is a worse outcome than a failed
   * restore.
   */
  console.log('\ndisabling triggers for the load…')
  for (const t of order) await sql.query(`ALTER TABLE "${t}" DISABLE TRIGGER USER`)

  let loaded = 0
  try {
    loaded = await load()
  } finally {
    console.log('\nre-enabling triggers…')
    for (const t of order) await sql.query(`ALTER TABLE "${t}" ENABLE TRIGGER USER`)
  }

  async function load() {
  // Children first when emptying, parents first when filling.
  console.log('emptying…')
  for (const t of [...order].reverse()) await sql.query(`DELETE FROM "${t}"`)

  console.log('loading…')
  let loaded = 0
  for (const t of order) {
    const cols = manifest.columns[t]
    if (!cols || cols.length === 0) continue
    const file = join(dir, `${t}.jsonl.gz`)
    const names = cols.map((c) => `"${c.name}"`).join(', ')
    // Every value arrives as text (see backup-db.mjs) and is cast back to its recorded type, so a
    // bigint amount is reconstructed exactly rather than through a JSON double.
    const casts = cols.map((c, i) => `$${i + 1}::${c.type}`).join(', ')
    /*
     * OVERRIDING SYSTEM VALUE.
     *
     * `journal_entries.id` and friends are GENERATED ALWAYS AS IDENTITY, which REJECTS an explicit
     * id — `cannot insert a non-DEFAULT value into column "id"`. A restore must reproduce the
     * original ids exactly or every foreign key pointing at them breaks, so the identity generator
     * has to be overridden rather than obeyed. Found by the first rehearsal, on the ledger table,
     * which is precisely where it would have been found otherwise: at 2am, with the data gone.
     */

    /*
     * MANY ROWS PER STATEMENT. The first rehearsal sent one INSERT per row and moved about three
     * rows a second — every row paying a full HTTPS round-trip to Neon. 1,196 rows took seven
     * minutes, which sounds tolerable until you extrapolate: a hundred bikes at twenty orders a
     * day reaches a million rows inside a year, and at that rate the restore takes four DAYS
     * against SRS §7's four-HOUR RTO. A restore that cannot finish is not a restore.
     *
     * Postgres caps a statement at 65,535 parameters, so the batch is sized from the column count
     * rather than fixed.
     */
    const perStatement = Math.max(1, Math.min(500, Math.floor(60_000 / cols.length)))
    let n = 0
    let batch = []
    const flush = async () => {
      if (batch.length === 0) return
      const tuples = batch
        .map((_, r) => `(${cols.map((c, i) => `$${r * cols.length + i + 1}::${c.type}`).join(', ')})`)
        .join(', ')
      await sql.query(`INSERT INTO "${t}" (${names}) OVERRIDING SYSTEM VALUE VALUES ${tuples}`, batch.flat())
      batch = []
    }
    try {
      const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity })
      for await (const line of rl) {
        if (line.trim() === '') continue
        const row = JSON.parse(line)
        batch.push(cols.map((c) => row[c.name] ?? null))
        n++
        if (batch.length >= perStatement) await flush()
      }
      await flush()
    } catch (err) {
      if (err.code !== 'ENOENT') throw err // a table with no file had no rows
    }
    if (n !== (manifest.counts[t] ?? 0)) {
      console.error(`!! ${t}: loaded ${n}, manifest says ${manifest.counts[t]}`)
      process.exitCode = 1
    }
    loaded += n
    if (n > 0) console.log(`  ${t.padEnd(28)} ${String(n).padStart(8)} rows`)
  }
  return loaded
  }

  /*
   * SEQUENCES. Inserting explicit ids does not move them, so without this the restore looks
   * flawless — every row present, the ledger balancing — and then the FIRST WRITE collides on the
   * primary key, in a way nobody would connect back to the restore.
   *
   * `pg_get_serial_sequence`, not a `pg_depend` join on `deptype='a'`: that finds `serial`
   * columns only. Every id here is GENERATED ALWAYS AS IDENTITY, whose sequence is an INTERNAL
   * dependency (`deptype='i'`) — so the join found nothing, silently, and the first rehearsal
   * came back with `journal_entries` about to reissue id 1 over a table whose max was 12.
   */
  console.log('\nresetting sequences…')
  let reset = 0
  for (const t of order) {
    for (const c of manifest.columns[t] ?? []) {
      const [{ seq }] = await sql.query(`SELECT pg_get_serial_sequence($1, $2) AS seq`, [t, c.name])
      if (!seq) continue
      // `false` so the NEXT value is max+1: `setval(seq, 0, true)` on an empty table is illegal.
      await sql.query(
        `SELECT setval('${seq}', COALESCE((SELECT MAX("${c.name}") FROM "${t}"), 0) + 1, false)`,
      )
      reset++
    }
  }
  console.log(`  ${reset} sequences`)

  console.log(`\nrestored ${loaded} of ${manifest.totalRows} rows into ${targetHost}`)
  if (process.exitCode === 1) console.error('MISMATCH — see the lines above. This restore is NOT trustworthy.')
  else console.log('Row counts match the manifest exactly.')
}

await main()
