#!/usr/bin/env node
/**
 * Static checks over the SQL migrations.
 *
 * The migrations cannot be executed on this dev machine (no Docker, no psql), and the design
 * review found that unverifiable DDL grows exactly these bugs — including a CHECK constraint
 * containing a subquery, which PostgreSQL rejects outright. This catches the known class of
 * mistake without a database, and is NOT a substitute for actually running them.
 *
 * Every rule here exists because getting it wrong would be expensive and silent.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MIGRATIONS = join(ROOT, 'packages', 'db', 'migrations')

const failures = []
const fail = (file, msg) => failures.push(`${file}: ${msg}`)

/** Tables whose every mutation must be audited (A-5 / س79). */
const MUST_AUDIT = [
  'users', 'role_permissions', 'settings', 'approval_ceilings',
  'drivers', 'vehicles', 'documents',
  'funds', 'fx_days', 'week_locks', 'journal_entries', 'journal_lines',
  'cash_counts', 'expenses', 'incomes', 'receivable_events', 'checkins',
  'shifts', 'shift_orders', 'cash_deductions', 'shift_media', 'float_tranches', 'tier_rules',
  // Decision-complete cash/wallet close snapshots. Append-only, but creation is a money decision.
  'shift_settlements',
  // Advance authority plus the exact cash/wallet values a driver may receive automatically.
  'preapproved_shift_rules',
  // Renumbering a type restates the printed code of every vehicle of that type; a pack moving
  // between bikes is an asset transfer; a corrected reading changes evidence already approved.
  'vehicle_types', 'batteries', 'shift_battery_readings',
  // Where a manual order went — part of the evidence a manager approves a shift against.
  'shift_order_points',
  // What the wallet actually did. An unmatched movement is a term in BR1, and whether a row is
  // included or which order it answers to changes the money a manager approves.
  'shift_wallet_movements',
  // «رأس مال المكتب» decides how much «كييش» is swept out of the branch every single day, and
  // «الترميم» is the record of it having happened. Editing a target silently restates the profit.
  'office_capital_targets', 'restorations',
  // «السلفة» — office money paid out that must come back. It is counted as capital while it is
  // outstanding, so who created one, for how much, and who later declared it spent are all money
  // decisions of exactly the kind this list exists for.
  'advances', 'advance_events',
  // Company debts are isolated per debt UUID; both their opening facts and every settlement are
  // immutable money decisions guarded against overpayment in PostgreSQL.
  'company_debts', 'company_debt_events',
  // A manager declaring that a row is not a delivery at all removes a fee from the shift's money.
  // The register is append-only and can only be added to, but «who removed what, and when did the
  // general manager get told» is precisely a money decision — and the audit row is the second,
  // independent copy that does not depend on the register's own insert having happened.
  'operation_removals',
]

/**
 * Tables deliberately NOT audited, each with a reason. A new table must be added to one list or
 * the other — it cannot silently escape the decision.
 */
const AUDIT_EXEMPT = {
  branches: 'near-static reference data; changes are rare and visible',
  governorates: 'near-static reference data; the fourteen are fixed, only their numbers are editable',
  roles: 'reference data; the grants in role_permissions are what carry authority',
  permissions: 'reference data, defined in code',
  expense_categories: 'reference data',
  income_categories: 'reference data',
  checkin_windows: 'a rota of expected times, not money; every change is a settings-shaped edit and the checkins it judges are audited',
  sessions: 'high churn; login/logout is covered by login_attempts',
  login_attempts: 'already an append-only audit record in its own right',
  notifications: 'derived from audited events; auditing them would double the write volume',
  media: 'immutable and content-addressed; the shift_media link is what matters',
  shift_media_attachment_history:
    'trigger-owned append-only provenance; direct INSERT/UPDATE/DELETE/TRUNCATE are revoked',
  shift_close_draft_observations:
    'append-only machine observations tied by composite FK to immutable OCR-read metadata; updates and deletes are revoked',
  shift_close_drafts:
    'high-frequency recoverable working state; revision/hash carry concurrency while final canonical rows and explicit restore actions are audited without duplicating routes/figures into audit_log',
  shift_close_draft_reads:
    'append-only OCR metadata; row pixels/transcription live only in protected observations and must not be copied into generic audit snapshots',
  shift_media_restore_decisions:
    'append-only reasoned restore decisions; this table is the minimal audit record itself',
  operation_window_reclassification_context:
    'transaction-scoped internal capability; app_user has no privileges and the SECURITY DEFINER classifier always removes it',
  close_draft_materialization_context:
    'transaction-scoped exact-draft capability; guarded writes are matched to the locked revision and the marker is removed before commit',
  attendance_days: 'derived from session activity',
  vehicle_events: 'append-only life log; is itself the audit trail (B-2)',
  assignments: 'covered by the audited shift it produces',
  shift_decisions: 'append-only decision log; is itself the audit trail (C-7)',
  cash_count_lines: 'sealed with a sha256 proof on the parent cash_count',
  driver_day_shares: 'a derived projection of audited journal entries',
  fx_rate_versions: 'append-only supersession history',
  ocr_fee_samples:
    'research material, not money: insert-once pixels beside what OCR made of them, deletable on a retention policy; the approved fee it is compared against lives on the audited shift_orders row',
  ocr_samples:
    'same as ocr_fee_samples, generalised to every reader: insert-once pixels, no money, no ground truth (joined from the audited owning row at export), deletable on a retention policy',
  ocr_reads:
    'an internal cost/cache receipt, not a decision: repository-owned reservation and completion updates hold no money; the suggested value lands on the audited shift/order row, where every correction is visible',
  gps_pings: 'high-volume append-only telemetry (SRS K); auditing every ping would dwarf the audit log',
  battery_swaps: 'append-only event log; its substance — the pack fitment change on batteries and the swap_out/swap_in readings — is already audited, and the route appends an explicit audit row',
  audit_log: 'the audit log itself',
}

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
if (files.length === 0) fail('migrations', 'no .sql files found')

let allSql = ''
const createdTables = new Set()
const auditedTables = new Set()

for (const file of files) {
  const raw = readFileSync(join(MIGRATIONS, file), 'utf8')
  // Strip line comments so prose about `numeric` or `date_trunc` cannot trip the rules.
  const sql = raw.replace(/^\s*--.*$/gm, '')
  allSql += `\n${sql}`

  for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)) createdTables.add(m[1])
  for (const m of sql.matchAll(/CREATE TRIGGER audit_\w+[\s\S]*?\bON (\w+)\b/gi)) auditedTables.add(m[1])

  // ── Rule 1: money is never a float. ────────────────────────────────────────────────────
  // Any column named *_minor must be bigint; nothing money-shaped may be numeric/real/double.
  for (const m of sql.matchAll(/^\s*(\w*_minor)\s+([a-z ]+?)[\s,(]/gim)) {
    const [, col, type] = m
    if (!/^bigint\b/i.test(type.trim())) {
      fail(file, `column ${col} is "${type.trim()}" — every *_minor column must be BIGINT`)
    }
  }
  for (const m of sql.matchAll(/^\s*(\w+)\s+(numeric|decimal|real|double precision|money)\b/gim)) {
    const [, col, type] = m
    if (/minor|amount|balance|fee|cost|price|share|total|ceiling|salary/i.test(col)) {
      fail(file, `column ${col} is ${type} — money must be BIGINT minor units, never a float`)
    }
  }

  // ── Rule 2: no subquery in a CHECK constraint. PostgreSQL rejects it; the design review
  //    found exactly this bug in DDL that had never been run.
  for (const m of sql.matchAll(/CHECK\s*\(/gi)) {
    // Walk to the matching close paren.
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < sql.length; i++) {
      if (sql[i] === '(') depth++
      else if (sql[i] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    const body = sql.slice(m.index, i + 1)
    if (/\bSELECT\b/i.test(body)) {
      fail(file, `a CHECK constraint contains a SELECT — PostgreSQL rejects subqueries in CHECK: ${body.slice(0, 80)}…`)
    }
  }

  // ── Rule 3: no STABLE expression in a generated column. `AT TIME ZONE` is the classic:
  //    Postgres requires IMMUTABLE and refuses it, which is why business_date is written.
  for (const m of sql.matchAll(/GENERATED ALWAYS AS\s*\(([\s\S]{0,300}?)\)\s*STORED/gi)) {
    if (/AT TIME ZONE|now\(\)|current_date|current_timestamp/i.test(m[1])) {
      fail(file, `a generated column uses a STABLE expression (${m[1].trim().slice(0, 60)}…) — Postgres requires IMMUTABLE`)
    }
  }

  // ── Rule 4: never date_trunc('week') — it is ISO/Monday-based, BR7 closes on Sunday.
  if (/date_trunc\s*\(\s*'week'/i.test(sql)) {
    fail(file, `uses date_trunc('week'), which is MONDAY-based — BR7's week starts SUNDAY; use the stored week_start_date`)
  }
}

// ── Rule 5: the idempotency index must carry occurrence_key (ASSUMPTIONS A-10). ───────────
const idempotency = /CREATE UNIQUE INDEX\s+je_idempotency_uq[\s\S]*?;/i.exec(allSql)
if (!idempotency) {
  fail('migrations', 'the journal idempotency index je_idempotency_uq is missing entirely')
} else if (!/occurrence_key/i.test(idempotency[0])) {
  fail(
    'migrations',
    'je_idempotency_uq omits occurrence_key — a (shift_id, event_type) key makes SRS C-5 ' +
      'multi-tranche float unpostable and silently swallows the second tranche',
  )
}

// ── Rule 6: locked-week immutability must guard journal_LINES too, not just entries. ──────
if (!/CREATE TRIGGER\s+journal_lines_week_locked/i.test(allSql)) {
  fail('migrations', 'journal_lines has no week-lock guard — the AMOUNTS of a locked week would stay mutable')
}
if (!/REVOKE\s+UPDATE,\s*DELETE\s+ON\s+journal_lines\s+FROM\s+app_user/i.test(allSql)) {
  fail('migrations', 'journal_lines is not REVOKEd from app_user')
}
if (!/REVOKE\s+UPDATE,\s*DELETE\s+ON\s+journal_entries\s+FROM\s+app_user/i.test(allSql)) {
  fail('migrations', 'journal_entries is not REVOKEd from app_user')
}

// ── Rule 7: the balance trigger must be DEFERRABLE INITIALLY DEFERRED. ────────────────────
const balanced = /CREATE CONSTRAINT TRIGGER\s+journal_lines_balanced[\s\S]*?;/i.exec(allSql)
if (!balanced) {
  fail('migrations', 'the double-entry balance trigger is missing')
} else if (!/DEFERRABLE INITIALLY DEFERRED/i.test(balanced[0])) {
  fail(
    'migrations',
    'the balance trigger is not DEFERRABLE INITIALLY DEFERRED — it would reject every ' +
      'multi-line entry on its first line',
  )
}

// ── Rule 8: every table is consciously audited or consciously exempt. ─────────────────────
for (const table of MUST_AUDIT) {
  if (!createdTables.has(table)) fail('migrations', `MUST_AUDIT names ${table}, which no migration creates`)
  else if (!auditedTables.has(table)) fail('migrations', `${table} holds money/identity/authority but has no audit trigger`)
}
for (const table of createdTables) {
  if (!MUST_AUDIT.includes(table) && !(table in AUDIT_EXEMPT)) {
    fail(
      'migrations',
      `${table} is neither in MUST_AUDIT nor in AUDIT_EXEMPT — decide, with a reason, in scripts/check-sql.mjs`,
    )
  }
}

if (failures.length > 0) {
  console.error(`SQL check FAILED (${failures.length}):\n` + failures.map((f) => `  ✗ ${f}`).join('\n'))
  process.exit(1)
}
console.log(
  `SQL check passed: ${files.length} migrations, ${createdTables.size} tables, ` +
    `${auditedTables.size} audited, ${Object.keys(AUDIT_EXEMPT).length} consciously exempt.\n` +
    'NOTE: static only. The guards in 0006 are still UNVERIFIED until run against real Postgres.',
)
