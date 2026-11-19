#!/usr/bin/env node
/**
 * A logical backup of the whole database, over the one connection method that works from here.
 *
 *   DATABASE_URL=postgres://… node scripts/backup-db.mjs [--out backups] [--concurrency 1..4] [--quiescent]
 *
 * --quiescent is for an EXTERNALLY WRITE-PAUSED release only. It verifies exact starting/written/
 * ending row counts and skips data SELECTs for initially empty tables. Equal counts cannot prove
 * that no in-place update occurred; this is not an MVCC snapshot or a replacement for the pause.
 *
 * WHY THIS EXISTS. There was no backup at all — not of the ledger, not of the evidence photos.
 * The restic sidecar in `infra/` belongs to a docker-compose stack that is not deployed;
 * production is Vercel + Neon, and the "scheduled pg_dump" the deploy doc promises was never
 * written. A `DROP TABLE`, a bad migration or a billing lapse would have taken a live financial
 * ledger with no tested way back.
 *
 * WHY NOT `pg_dump`. It is not installed here, and on the Damascus network port 5432 is reset by
 * the geo-block after about twenty seconds — the `@neondatabase/serverless` driver over HTTPS is
 * the only path that completes. That is also why the migration procedure uses it.
 *
 * WHAT IT WRITES. One gzipped directory per run:
 *   manifest.json   — timestamp, migration ledger, per-table row counts, column types, FK graph
 *   <table>.jsonl.gz — one JSON object per row, EVERY VALUE A STRING (or null)
 *
 * Every value is cast to text in SQL and kept as a JSON string on the way out. That is not
 * fussiness: `bigint` is the money type here, and JSON numbers are IEEE doubles — a single
 * `to_jsonb()` would silently round any amount above 2^53 minor units. A backup that quietly
 * corrupts the largest amounts is worse than none, because it is trusted.
 *
 * The FK graph is captured so a restore can load parents before children without needing the
 * superuser rights to switch triggers off (Neon's owner role does not reliably have them).
 */
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGzip } from 'node:zlib'
import {
  BACKUP_COLUMNS_SQL, assertQuiescentCounts, backupColumnsByTable, backupCountQuery, backupIdent,
  exactBackupCounts, parseBackupOptions, runBackupBounded,
} from './backup-db-plan.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(join(root, 'packages/db/package.json'))
const mod = await import(pathToFileURL(req.resolve('@neondatabase/serverless')).href)
const neon = mod.neon ?? mod.default?.neon

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required. Use the DIRECT endpoint (drop "-pooler" from the host).')
  process.exit(1)
}
const { outRoot, concurrency, quiescent } = parseBackupOptions(process.argv.slice(2), join(root, 'backups'))

const sql = neon(url)

/** Rows are streamed in pages: one `SELECT *` on a year of GPS pings would exhaust the heap. */
const PAGE = 2_000

async function main() {
  const startedMs = Date.now()
  const stamp = new Date(startedMs).toISOString().replace(/[:.]/g, '-')
  const dir = join(outRoot, stamp)
  await mkdir(outRoot, { recursive: true })
  await mkdir(dir) // Never overwrite a backup if two launches share the same timestamp.

  // Only ordinary tables in `public`, and never a view or a partition parent.
  const tables = (
    await sql`
      SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY c.relname`
  ).map((r) => r.name)

  const columns = backupColumnsByTable(tables, await sql.query(BACKUP_COLUMNS_SQL))

  // Parent → child edges, so a restore can topologically sort instead of disabling triggers.
  const fks = (
    await sql`
      SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'f' AND n.nspname = 'public'`
  ).map((r) => ({ child: r.child.replace(/^public\./, ''), parent: r.parent.replace(/^public\./, '') }))

  // The schema itself lives in git as the migration files; what the ledger proves is WHICH of them
  // this data was written under. A restore that runs a different set is a different database.
  let migrations = []
  try {
    migrations = await sql`SELECT filename, checksum, applied_at::text AS applied_at FROM schema_migrations ORDER BY filename`
  } catch {
    console.warn('!! schema_migrations is unreadable — recording none')
  }

  const readCounts = async () => exactBackupCounts(tables, await sql.query(backupCountQuery(tables)))
  const startingCounts = quiescent ? await readCounts() : null
  const completedCounts = new Map()
  await runBackupBounded(tables, concurrency, async t => {
    const cols = columns[t]
    // Every column cast to text, assembled server-side. See the header: this is what keeps a
    // bigint amount exact through JSON.
    const pairs = cols.map((c) => `'${c.name.replaceAll("'", "''")}', ${backupIdent(c.name)}::text`).join(', ')
    const file = join(dir, `${t}.jsonl.gz`)

    let offset = 0
    let n = 0
    const gzip = createGzip()
    const written = pipeline(gzip, createWriteStream(file))
    // Register rejection immediately while independent HTTPS page reads are in flight.
    let streamFailure = null
    void written.catch(error => { streamFailure = error })
    try {
      for (; !quiescent || startingCounts[t] !== 0;) {
        // A stable order is what makes two consecutive pages disjoint; ctid is always present.
        // `sql.query` rather than the tagged template: the column list and the table name are
        // identifiers, which no placeholder can carry. Both come from pg_catalog, never from input.
        const page = await sql.query(
          `SELECT json_build_object(${pairs}) AS row FROM public.${backupIdent(t)} ORDER BY ctid LIMIT ${PAGE} OFFSET ${offset}`,
        )
        if (page.length === 0) break
        for (const r of page) {
          if (streamFailure || gzip.destroyed) throw streamFailure ?? new Error('backup output stream closed before table completion')
          if (!gzip.write(`${JSON.stringify(r.row)}\n`)) await once(gzip, 'drain')
        }
        n += page.length
        if (!Number.isSafeInteger(n)) throw new Error(`backup row count exceeds exact manifest integer range: ${t}`)
        offset += PAGE
        if (page.length < PAGE) break
      }
      gzip.end()
      await written
    } catch (error) {
      gzip.destroy(error)
      await written.catch(() => {})
      throw error
    }
    completedCounts.set(t, n)
    console.log(`  ${t.padEnd(28)} ${String(n).padStart(8)} rows`)
  })
  // Preserve deterministic manifest ordering despite independent table completion order.
  const counts = Object.fromEntries(tables.map(table => [table, completedCounts.get(table)]))
  const endingCounts = quiescent ? await readCounts() : null
  if (quiescent) assertQuiescentCounts(tables, startingCounts, counts, endingCounts)
  const totalRows = Object.values(counts).reduce((sum, count) => sum + count, 0)
  if (!Number.isSafeInteger(totalRows)) throw new Error('backup total rows exceeds exact manifest integer range')

  const manifest = {
    takenAt: new Date(startedMs).toISOString(),
    tookMs: Date.now() - startedMs,
    // Enough to tell two databases apart without recording the credential itself.
    host: new URL(url).host,
    database: new URL(url).pathname.slice(1),
    migrations,
    tables,
    columns,
    fks,
    counts,
    totalRows,
    tableConcurrency: concurrency,
    ...(quiescent ? { consistency: { mode: 'externally_quiescent_count_checked', startingCounts, endingCounts } } : {}),
  }
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`\n${tables.length} tables, ${totalRows} rows, ${migrations.length} migrations`)
  console.log(`written: ${dir}`)
  // A backup nobody has restored from is a belief, not a backup.
  console.log('\nRestore with:  DATABASE_URL=<target> node scripts/restore-db.mjs ' + dir)
}

await main()
