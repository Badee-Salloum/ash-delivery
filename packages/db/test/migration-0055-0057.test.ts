import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationDir = new URL('../migrations/', import.meta.url)
const read = (file: string): string => readFileSync(new URL(file, migrationDir), 'utf8')

const enums = read('0055_advance_enum_values.sql')
const tables = read('0056_advances.sql')
const seam = read('0057_restoration_counts_advances.sql')
const v3 = read('0053_ledger_backed_restoration.sql')
const flat = (s: string): string => s.replace(/\s+/g, ' ')

/**
 * «السلفة» — an expense that must come back (owner decision 17).
 *
 * These assertions are static, and they carry more weight than usual because this machine has no
 * Docker: the guards themselves are proven against real Postgres only at the migration rehearsal.
 * What can be proven here is the part that is easiest to get wrong by hand and hardest to notice
 * afterwards — that 0057's restoration guard is 0053's, changed only where it had to be.
 */
describe('0055 — enum values, and nothing else', () => {
  it('adds two counted fund types and three ledger events', () => {
    for (const value of ['advance_receivable_cash', 'advance_receivable_wallet']) {
      expect(enums).toContain(`ALTER TYPE fund_type ADD VALUE IF NOT EXISTS '${value}';`)
    }
    for (const value of ['advance', 'advance_repayment', 'advance_conversion']) {
      expect(enums).toContain(`ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS '${value}';`)
    }
  })

  it('contains no statement other than ALTER TYPE', () => {
    // A Postgres enum value must be committed before a later migration uses it, and the migrator
    // wraps each file in exactly one transaction — the reason 0023, 0036 and 0046 are each alone.
    const statements = enums
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('--'))
    expect(statements.every((line) => line.startsWith('ALTER TYPE '))).toBe(true)
  })

  it('gives an outstanding advance a REAL fund type, unlike a P&L account', () => {
    // `other_income` deliberately gained no `fund_type` because it is not a box anyone counts.
    // An outstanding سلفة is the opposite: money the company still owns, which الترميم must count
    // toward رأس مال المكتب exactly as it counts a ذمة.
    expect(enums).toContain('ALTER TYPE fund_type ADD VALUE IF NOT EXISTS')
  })
})

describe('0056 — the tables and their guards', () => {
  it('follows 0055, which follows 0054', () => {
    // Asserts the ORDER, never the tip: pinning to the newest file makes every later migration
    // fail a test about this one.
    const files = readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort()
    const at = (name: string): number => files.indexOf(name)
    expect(at('0055_advance_enum_values.sql')).toBe(at('0054_window_opens_at_driver_confirmation.sql') + 1)
    expect(at('0056_advances.sql')).toBe(at('0055_advance_enum_values.sql') + 1)
    expect(at('0057_restoration_counts_advances.sql')).toBe(at('0056_advances.sql') + 1)
  })

  it('makes an advance without its journal impossible, unlike an expense', () => {
    // `expenses.journal_entry_id` is nullable, which is why that route carries a runtime
    // `assertCompleteExpense`. Here the column is NOT NULL and UNIQUE, so the guard has no
    // counterpart to need.
    expect(flat(tables)).toContain('journal_entry_id bigint NOT NULL UNIQUE REFERENCES journal_entries(id)')
  })

  it('gives each advance its own idempotency index, because the shift one does not apply', () => {
    // `je_idempotency_uq` is partial on `shift_id IS NOT NULL`, so a command journal has no
    // uniqueness of its own — the reason 0037 and 0047 each add one.
    for (const event of ['advance', 'advance_repayment', 'advance_conversion']) {
      expect(flat(tables)).toContain(`WHERE shift_id IS NULL AND event_type = '${event}'`)
    }
  })

  it('is append-only to app_user', () => {
    // A posted accounting fact is corrected by a visible dated reversal (E-6), never by an edit.
    for (const table of ['advances', 'advance_events']) {
      expect(flat(tables)).toContain(`REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM app_user`)
    }
  })

  it('reads the LIVE rbac matrix, with no compiled-role fallback', () => {
    // Revoking a role must take effect on direct SQL immediately, and a missing grant must fail
    // closed. Paying is `expense.write`; declaring the money gone is `journal.manual.write`.
    expect(flat(tables)).toContain("rp.permission_key = 'expense.write'")
    expect(flat(tables)).toContain(
      "v_permission := CASE NEW.kind WHEN 'conversion' THEN 'journal.manual.write' ELSE 'expense.write' END",
    )
    expect(flat(tables)).toContain("rp.scope = 'all' OR (rp.scope = 'branch' AND u.branch_id = NEW.branch_id)")
  })

  it('locks the advance fund row before judging the balance', () => {
    // Transplanted from 0037's over-collection guard, and for its stated reason: advisory locks
    // order normal requests, but this row lock closes the two-connection write skew where
    // concurrent repayments each observe enough outstanding balance and jointly go below zero.
    expect(flat(tables)).toContain('FOR UPDATE')
    expect(flat(tables)).toContain('advance_events_overrepayment_guard')
  })

  it('keeps the advance fund branch-owned with its identity in the code', () => {
    // `funds_owner_ck` is `CHECK ((owner_kind='none') = (owner_id IS NULL))`, and the shape
    // `cost_center:cash_count_variance:<branch>:<fund>` already uses it.
    expect(flat(tables)).toContain("af.owner_kind = 'none'".replace('af.', 'f.')) // guard_advance_insert
    expect(flat(tables)).toContain("AND f.owner_kind = 'none' AND f.owner_id IS NULL")
  })

  it('refuses an orphan advance journal at transaction end', () => {
    expect(flat(tables)).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(flat(tables)).toContain('advance_journal_event_guard')
  })

  it('makes a second conversion of one advance a schema impossibility', () => {
    expect(flat(tables)).toContain(
      'CREATE UNIQUE INDEX expenses_advance_uq ON expenses (advance_id) WHERE advance_id IS NOT NULL',
    )
  })
})

describe('0057 — the restoration guard, changed only where it had to be', () => {
  it('leaves the v3 function and its trigger standing', () => {
    // They are the exact rule already-stored history was judged by — the same reason 0053 left v2
    // in place. Dropping them would silently restate every past night.
    expect(seam).not.toContain('DROP FUNCTION guard_ledger_restoration_insert')
    expect(seam).not.toContain('DROP TRIGGER restorations_10_v3_guard')
    expect(seam).toContain('CREATE FUNCTION guard_ledger_restoration_insert_v4()')
  })

  it('keeps the v4 guard SECURITY DEFINER with the pinned search_path', () => {
    expect(seam).toContain(
      'CREATE FUNCTION guard_ledger_restoration_insert_v4() RETURNS trigger\n' +
        'LANGUAGE plpgsql SECURITY DEFINER\n' +
        'SET search_path = pg_catalog, public, pg_temp',
    )
  })

  it('adds «advances» to BOTH leg key arrays', () => {
    // The require-list AND the exact-list. Missing the second rejects every plan the API emits,
    // which is a loud failure — but missing the first would accept a plan with no advances term.
    const keys =
      "'fundCode', 'officeBalance', 'receivables', 'advances', 'position', 'capitalTarget', 'delta', 'direction', 'amount', 'feasible', 'refusals'"
    expect(flat(seam)).toContain(`leg ?& ARRAY[ ${keys} ]`)
    expect(flat(seam)).toContain(`leg - ARRAY[ ${keys} ] <> '{}'::jsonb`)
  })

  it('makes the position a three-way sum and the postcondition match it', () => {
    expect(flat(seam)).toContain(
      "(leg->>'position')::numeric <> (leg->>'officeBalance')::numeric + (leg->>'receivables')::numeric + (leg->>'advances')::numeric",
    )
    expect(flat(seam)).toContain(
      "(leg->>'capitalTarget')::numeric * 100 <> (leg->>'receivables')::numeric * 100 + (leg->>'advances')::numeric * 100 + COALESCE((",
    )
  })

  it('derives the advance sum from the ledger, with the same EXISTS proof the drivers get', () => {
    // `funds.owner_id` and `funds.code` carry no foreign key, so a hand-inserted fund could
    // otherwise inflate the figure the guard trusts.
    expect(flat(seam)).toContain("FROM public.advances advance_row WHERE advance_row.branch_id = NEW.branch_id")
    expect(flat(seam)).toContain("af.code = af.type::text || ':' || advance_row.id::text")
  })

  /**
   * THE DIFF PROOF, AUTOMATED.
   *
   * The riskiest thing in this release is re-emitting a SECURITY DEFINER function. It was extracted
   * verbatim and changed by named hunks — but a proof that only a human ran once is a proof that
   * drifts. Slice the driver-receivable derivation out of both files with the same anchors and
   * demand they are byte-identical.
   */
  it('carries 0053 driver-receivable derivation BYTE-IDENTICALLY', () => {
    const START = "OR (leg->>'receivables')::numeric * 100 <> COALESCE(("
    const END = "AND rf.type::text IN ('driver_receivable_wallet', 'driver_shift_funding_wallet'))"
    const slice = (sql: string, label: string): string => {
      const from = sql.indexOf(START)
      const to = sql.indexOf(END, from)
      expect(from, `${label}: start anchor`).toBeGreaterThan(-1)
      expect(to, `${label}: end anchor`).toBeGreaterThan(from)
      return sql.slice(from, to + END.length)
    }
    expect(slice(seam, '0057')).toBe(slice(v3, '0053'))
  })

  it('refuses a v3 plan while any advance is outstanding', () => {
    // The whole safety story. An API rolled back past this release is the only thing that can emit
    // a v3 plan now, and a v3 plan has no advances term — it would read the advance as a shortfall
    // and «شحن» real money out of صندوق الشركة. Fail closed and by name instead.
    expect(flat(seam)).toContain("IF NEW.plan->>'schemaVersion' = '3' AND EXISTS (")
    expect(flat(seam)).toContain("f.type::text IN ('advance_receivable_cash', 'advance_receivable_wallet')")
    expect(seam).toContain('schema-v3 restoration cannot ignore an outstanding advance')
  })

  it('accepts v4 in the dispatcher and gives it its own trigger', () => {
    expect(flat(seam)).toContain("COALESCE(NEW.plan->>'schemaVersion', '') NOT IN ('2', '3', '4')")
    expect(flat(seam)).toContain("NEW.plan->>'schemaVersion' IN ('3', '4') AND NEW.cash_count_id IS NOT NULL")
    expect(flat(seam)).toContain(
      "WHEN ((NEW.plan->>'schemaVersion') = '4') EXECUTE FUNCTION guard_ledger_restoration_insert_v4()",
    )
  })

  it('leaves the four blocks it never needed to touch alone', () => {
    // Being able to say precisely what did NOT change is the strongest evidence the change is
    // minimal. Each of these is quoted from 0053 and must survive verbatim into v4.
    for (const untouched of [
      'ledger restoration requires its attributed active manager',
      "PERFORM pg_advisory_xact_lock( hashtextextended('ash:financial:receivables:' || NEW.branch_id::text, 0) )",
      'restoration opening snapshot does not match the pre-posting live ledger',
      "je.occurrence_key = NEW.business_date::text || ':' || (leg->>'fundCode')",
    ]) {
      expect(flat(seam), untouched).toContain(flat(untouched))
      expect(flat(v3), untouched).toContain(flat(untouched))
    }
  })
})
