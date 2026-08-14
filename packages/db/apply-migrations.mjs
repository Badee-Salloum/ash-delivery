// Apply pending migrations over the Neon HTTPS driver.
//
// Why this exists alongside packages/db/src/migrate.ts: plain `pg` cannot reach Neon from here
// (port 5432 is geo-blocked from Damascus; the TCP driver gets ECONNRESET), so production
// migrations run over the HTTP driver. That driver sends each call as a PREPARED statement, and
// PostgreSQL refuses multiple commands in one — so the file has to be split into statements first.
//
// Splitting on ';' is wrong the moment a migration defines a function: a plpgsql body is
// dollar-quoted and full of semicolons. This splitter tracks dollar-quote tags, single-quoted
// literals and comments, which is the minimum needed to be correct rather than lucky.
//
// The checksum is FNV-1a over the file text — byte-identical to `simpleChecksum` in migrate.ts, so
// this runner and the app's own runner agree about what has been applied. Anything else reads as
// history drift and refuses, which is the behaviour we want.
import { readFileSync, readdirSync } from 'node:fs'
import { neon } from '@neondatabase/serverless'
import {
  bootstrapTransactionQueries,
  classifyRecordedMigration,
  migrationTransactionQueries,
} from './migration-http-plan.mjs'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL not set')
const sql = neon(url)
const dir = new URL('./migrations/', import.meta.url)

// Serialize even first-install ledger creation. CREATE TABLE IF NOT EXISTS alone does not make two
// concurrent catalog writes a useful migration-runner lock.
await sql.transaction((tx) => bootstrapTransactionQueries(tx))

const simpleChecksum = (text) => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Split SQL into statements, respecting dollar-quoting, single quotes and comments. */
export function splitStatements(sql) {
  const out = []
  let buf = ''
  let i = 0
  while (i < sql.length) {
    const rest = sql.slice(i)

    // Line comment
    if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? sql.length : nl + 1
      buf += sql.slice(i, end)
      i = end
      continue
    }
    // Block comment
    if (rest.startsWith('/*')) {
      const close = sql.indexOf('*/', i + 2)
      const end = close === -1 ? sql.length : close + 2
      buf += sql.slice(i, end)
      i = end
      continue
    }
    // Single-quoted literal ('' is an escaped quote)
    if (sql[i] === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") { j++; break }
        j++
      }
      buf += sql.slice(i, j)
      i = j
      continue
    }
    // Dollar-quoted string: $tag$ … $tag$
    const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)
    if (tag) {
      const marker = tag[0]
      const close = sql.indexOf(marker, i + marker.length)
      const end = close === -1 ? sql.length : close + marker.length
      buf += sql.slice(i, end)
      i = end
      continue
    }
    if (sql[i] === ';') {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      i++
      continue
    }
    buf += sql[i]
    i++
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
const done = new Map(
  (await sql`SELECT filename, checksum FROM schema_migrations`).map((r) => [r.filename, r.checksum]),
)

let applied = 0
let present = 0
for (const file of files) {
  const body = readFileSync(new URL(file, dir), 'utf8')
  const checksum = simpleChecksum(body)

  if (done.has(file)) {
    if (done.get(file) !== checksum) {
      console.error(`!! ${file} has changed since it was applied (db ${done.get(file)} → file ${checksum}).`)
      console.error('   Applied migrations are immutable. Add a new migration instead.')
      process.exit(1)
    }
    present++
    continue
  }

  const statements = splitStatements(body)
  console.log(`applying ${file} (${statements.length} statements) …`)
  try {
    // The transaction plan locks, re-checks, atomically claims the filename, then applies DDL. The
    // callback remains synchronous as required by Neon's non-interactive HTTP transaction API.
    await sql.transaction((tx) =>
      migrationTransactionQueries(tx, { file, checksum, statements }),
    )
  } catch (e) {
    // A stale concurrent runner intentionally loses the primary-key claim and aborts before DDL.
    // Re-read after rollback to distinguish that safe race (or a lost commit acknowledgement) from
    // a real migration failure. The checksum still enforces immutable migration history.
    let recorded
    try {
      recorded = classifyRecordedMigration(
        await sql.query('SELECT checksum FROM schema_migrations WHERE filename = $1', [file]),
        checksum,
      )
    } catch (verificationError) {
      console.error(`!! ${file} failed atomically: ${e.message}`)
      console.error(`!! unable to verify its migration record: ${verificationError.message}`)
      process.exit(1)
    }

    if (recorded.kind === 'present') {
      console.log(`skipped  ${file} (applied concurrently)`)
      done.set(file, checksum)
      present++
      continue
    }
    if (recorded.kind === 'drift') {
      console.error(
        `!! ${file} has changed since it was applied (db ${recorded.actualChecksum} -> file ${checksum}).`,
      )
      console.error('   Applied migrations are immutable. Add a new migration instead.')
      process.exit(1)
    }

    console.error(`!! ${file} failed atomically: ${e.message}`)
    process.exit(1)
  }
  console.log(`applied  ${file}`)
  applied++
}

console.log(`migrations: ${applied} applied, ${present} already present`)
