/**
 * Turn what the drivers corrected into a training set.
 *
 * This is the missing half of the sample tables. `ocr_fee_samples` has existed since 0019 and
 * `ocr_samples` since 0022; between them they hold the pixels every reader worked from. Nothing has
 * ever READ them — no port method, no route, no script — so the samples have been accumulating with
 * no path into the templates, and the only input the classifier has ever had is a bank of glyphs one
 * person transcribed by hand off twenty-five screenshots.
 *
 * THE GROUND TRUTH IS JOINED HERE, NEVER STORED THERE. That is the rule the sample tables were built
 * on: a fee lives on `shift_orders.fee_minor`, an odometer on `shifts.odo_start`/`odo_end`, a wallet
 * balance on `shifts.end_wallet_declared_minor`. Copying any of them into the sample row would create
 * a second copy of a number the money depends on, free to drift. So the label is fetched at export
 * time, from the audited row, and a sample whose owner has not been approved yet is simply skipped —
 * an unapproved figure is not yet ground truth.
 *
 *   node scripts/ocr-export.mjs <out-dir> [--kind fee|odometer|wallet] [--include-unapproved]
 *
 * Writes `<out-dir>/<kind>/<id>.png` and one `<out-dir>/<kind>/labels.json`:
 *   [{ file, kind, source, truth, shiftId, package, approvedAt }]
 *
 * `source` matters as much as `truth`. A `refused` sample is an image the reader declined to read at
 * all, beside the number a human then supplied — the case it is failing, which is the one worth
 * training on. Successes are what it already handles.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Resolved through `packages/db`, exactly as `scripts/backup-db.mjs` does: the driver is that
// package's dependency, not the repo root's, and plain `pg` cannot reach Neon from here anyway.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(join(root, 'packages/db/package.json'))
const mod = await import(pathToFileURL(req.resolve('@neondatabase/serverless')).href)
const neon = mod.neon ?? mod.default?.neon

const outDir = process.argv[2]
if (!outDir) {
  console.error('usage: node scripts/ocr-export.mjs <out-dir> [--kind fee|odometer|wallet] [--include-unapproved]')
  process.exit(2)
}
const kindArg = process.argv.includes('--kind') ? process.argv[process.argv.indexOf('--kind') + 1] : null
const includeUnapproved = process.argv.includes('--include-unapproved')
const KINDS = kindArg ? [kindArg] : ['fee', 'odometer', 'wallet']

const sql = neon(process.env.DATABASE_URL)

/** A shift's figures are ground truth once the manager has signed for the money behind them. */
const APPROVED = ['approved', 'week_locked']

async function feeRows() {
  return await sql`
    SELECT s.id::text, s.source, s.strip_png, o.fee_minor::text AS truth,
           o.shift_id::text AS shift_id, NULL AS package, sh.state, sh.approved_at
      FROM ocr_fee_samples s
      JOIN shift_orders o ON o.id = s.shift_order_id
      JOIN shifts sh      ON sh.id = o.shift_id
     ORDER BY s.id`
}

async function shiftRows(kind) {
  // The truth column differs per reader and per package — this is the whole join.
  return await sql`
    SELECT s.id::text, s.source, s.strip_png, s.package,
           s.shift_id::text AS shift_id, sh.state, sh.approved_at,
           CASE
             WHEN s.kind = 'odometer' AND s.package = 'start' THEN sh.odo_start::text
             WHEN s.kind = 'odometer' AND s.package = 'end'   THEN sh.odo_end::text
             WHEN s.kind = 'wallet'                            THEN sh.end_wallet_declared_minor::text
           END AS truth
      FROM ocr_samples s
      JOIN shifts sh ON sh.id = s.shift_id
     WHERE s.kind = ${kind}
     ORDER BY s.id`
}

let total = 0
for (const kind of KINDS) {
  const rows = kind === 'fee' ? await feeRows() : await shiftRows(kind)
  const dir = join(outDir, kind)
  mkdirSync(dir, { recursive: true })

  const labels = []
  let skippedUnapproved = 0
  let skippedNoTruth = 0

  for (const r of rows) {
    if (!includeUnapproved && !APPROVED.includes(r.state)) {
      skippedUnapproved += 1
      continue
    }
    // No label, no example. A sample whose owning figure is null teaches nothing.
    if (r.truth === null || r.truth === undefined) {
      skippedNoTruth += 1
      continue
    }
    const file = `${r.id}.png`
    writeFileSync(join(dir, file), Buffer.from(r.strip_png))
    labels.push({
      file,
      kind,
      source: r.source,
      truth: r.truth,
      shiftId: r.shift_id,
      package: r.package ?? null,
      approvedAt: r.approved_at ?? null,
    })
  }

  writeFileSync(join(dir, 'labels.json'), JSON.stringify(labels, null, 1))
  const refused = labels.filter((l) => l.source === 'refused').length
  console.log(
    `${kind}: ${labels.length} exported (${refused} refusals — the cases it gets wrong), ` +
      `${skippedUnapproved} unapproved, ${skippedNoTruth} without a label`,
  )
  total += labels.length
}

console.log(`\n${total} samples -> ${outDir}`)
if (total === 0) {
  console.log(
    'Nothing yet. Samples accumulate as drivers work: each corrected reading leaves the pixels behind\n' +
      'it, and becomes exportable once the manager approves that shift.',
  )
}
