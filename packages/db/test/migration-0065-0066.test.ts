import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COMPANY_LEDGER_EVENTS } from '@ash/domain'

const migrationDir = new URL('../migrations/', import.meta.url)
const read = (file: string): string => readFileSync(new URL(file, migrationDir), 'utf8')

const ENUMS = '0065_company_ledger_enum_values.sql'
const enums = read(ENUMS)

const COMPANY_FUND_TYPES = [
  'company_cash',
  'depreciation_reserve',
  'company_fx_position',
  'branch_clearing',
  'company_payable',
  'company_receivable',
  'fixed_asset',
  'company_expense',
  'company_income',
  'company_equity',
] as const

/**
 * «صندوق الشركة» becomes its own ledger (finance redesign, phase C1).
 *
 * The static half. The behaviour — per-currency balance, the partition, the USD rate rule and the
 * pocket guard — is proven against a real PostgreSQL in `company-ledger-postgres.test.ts`.
 */
describe('0065 — enum values, and nothing else', () => {
  it('follows 0064', () => {
    // Asserts the ORDER, never the tip, so a later migration does not fail a test about this one.
    const files = readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort()
    expect(files.indexOf(ENUMS)).toBe(files.indexOf('0064_company_fund_permission.sql') + 1)
  })

  it('adds the ten company fund types', () => {
    for (const value of COMPANY_FUND_TYPES) {
      expect(enums).toContain(`ALTER TYPE fund_type ADD VALUE IF NOT EXISTS '${value}';`)
    }
  })

  it('adds exactly the company events the domain declares', () => {
    const added = [...enums.matchAll(/ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS '(\w+)';/g)].map((m) => m[1])
    expect(added).toEqual([...COMPANY_LEDGER_EVENTS])
  })

  it('contains no statement other than ALTER TYPE', () => {
    // A Postgres enum value must be committed before a later migration uses it, and the migrator
    // wraps each file in exactly one transaction — the reason 0023, 0036, 0046 and 0055 are alone.
    const statements = enums
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('--'))
    expect(statements.length).toBe(COMPANY_FUND_TYPES.length + COMPANY_LEDGER_EVENTS.length)
    expect(statements.every((line) => line.startsWith('ALTER TYPE '))).toBe(true)
  })

  it('leaves company_box alone', () => {
    expect(enums).not.toMatch(/ADD VALUE IF NOT EXISTS 'company_box'/)
  })
})

const FOUNDATION = '0066_company_ledger_foundation.sql'
const foundation = read(FOUNDATION)
/** Statements only, whitespace-collapsed: the prose names things on purpose. */
const flat = foundation
  .replace(/^\s*--.*$/gm, '')
  .replace(/\s+/g, ' ')
  .trim()

const BRANCH_ONLY_TABLES = [
  'users',
  'drivers',
  'vehicles',
  'shifts',
  'cash_counts',
  'office_capital_targets',
  'restorations',
  'expenses',
  'incomes',
  'advances',
  'advance_events',
  'receivable_events',
  'checkin_windows',
  'preapproved_shift_rules',
] as const

describe('0066 — the company ledger foundation', () => {
  it('follows 0065', () => {
    const files = readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort()
    expect(files.indexOf(FOUNDATION)).toBe(files.indexOf(ENUMS) + 1)
  })

  it('adds an immutable branches.kind with a single company row, never a nullable branch_id', () => {
    expect(flat).toContain(
      "ALTER TABLE branches ADD COLUMN kind text NOT NULL DEFAULT 'branch' CONSTRAINT branches_kind_ck CHECK (kind IN ('branch', 'company'));",
    )
    expect(flat).toContain("CREATE UNIQUE INDEX branches_single_company_uq ON branches (kind) WHERE kind = 'company';")
    expect(flat).toContain('CREATE TRIGGER branches_kind_immutable BEFORE UPDATE ON branches')
    expect(flat).not.toMatch(/branch_id DROP NOT NULL/i)
  })

  it('finds the auto-named branch_no and currency CHECKs in pg_constraint instead of assuming their names', () => {
    // 0007 and 0004 declared both inline, so PostgreSQL named them. A migration that DROPs a guessed
    // name fails on a database whose history named it differently — find it by what it says.
    expect(flat).not.toContain('DROP CONSTRAINT branches_branch_no_check')
    expect(flat).not.toContain('DROP CONSTRAINT funds_currency_check')
    expect(flat).toContain(
      "WHERE c.conrelid = 'public.branches'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ '\\mbranch_no\\M'",
    )
    expect(flat).toContain(
      "WHERE c.conrelid = 'public.funds'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ '\\mcurrency\\M'",
    )
    expect(flat).toContain("EXECUTE format('ALTER TABLE public.branches DROP CONSTRAINT %I', v_name);")
    expect(flat).toContain("EXECUTE format('ALTER TABLE public.funds DROP CONSTRAINT %I', v_name);")
    expect(flat).toContain(
      "ADD CONSTRAINT branches_kind_number_ck CHECK ( (kind = 'branch' AND branch_no BETWEEN 1 AND 99) OR (kind = 'company' AND branch_no = 0) );",
    )
  })

  it('inserts the HQ row with its fixed id in the governorate DAM uses, looked up in SQL', () => {
    expect(flat).toContain(
      "SELECT '10000000-0000-4000-8000-000000000100'::uuid, 'HQ', 'صندوق الشركة', 'Company', g.governorate_id, 0, 'company'",
    )
    expect(flat).toContain("(SELECT b.governorate_id FROM branches b WHERE b.code = 'DAM')")
    expect(flat).toContain('ON CONFLICT DO NOTHING;')
    // No second hard-coded uuid: the governorate is never named by id.
    const uuids = new Set(foundation.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g))
    expect([...uuids]).toEqual(['10000000-0000-4000-8000-000000000100'])
  })

  it('guards exactly the branch-only tables, and leaves media alone', () => {
    const guarded = [
      ...flat.matchAll(
        /CREATE TRIGGER (\w+)_00_branch_kind_guard BEFORE INSERT OR UPDATE OF branch_id ON (\w+) FOR EACH ROW EXECUTE FUNCTION assert_branch_kind\('branch'\);/g,
      ),
    ]
    expect(guarded.map((m) => m[2])).toEqual([...BRANCH_ONLY_TABLES])
    for (const m of guarded) expect(m[1]).toBe(m[2])
    expect(flat).not.toMatch(/ON media /)
  })

  it('puts currency on the fund: SYP_NEW or USD, USD only for company accounts, identity immutable', () => {
    expect(flat).toContain("ADD CONSTRAINT funds_currency_ck CHECK (currency IN ('SYP_NEW', 'USD'));")
    expect(flat).toContain("ADD CONSTRAINT funds_currency_scope_ck CHECK ( currency = 'SYP_NEW' OR type::text IN (")
    // The clearing account mirrors a branch SYP box: never USD.
    const scope = /funds_currency_scope_ck CHECK \(([^;]*)\);/.exec(flat)![1]!
    expect(scope).not.toContain('branch_clearing')
    expect(flat).toContain(
      'IF NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.type IS DISTINCT FROM OLD.type OR NEW.code IS DISTINCT FROM OLD.code OR NEW.currency IS DISTINCT FROM OLD.currency',
    )
    expect(flat).toContain('CREATE TRIGGER funds_identity_immutable BEFORE UPDATE ON funds')
  })

  it('freezes the rate on the entry as a positive bigint', () => {
    expect(flat).toContain(
      'ALTER TABLE journal_entries ADD COLUMN syp_minor_per_usd bigint CONSTRAINT je_syp_minor_per_usd_ck CHECK (syp_minor_per_usd > 0);',
    )
  })

  it('rewrites the balance function in place, hardened, and keeps its deferred trigger', () => {
    expect(foundation).toContain(
      'CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger\nLANGUAGE plpgsql\nSET search_path = pg_catalog, public, pg_temp',
    )
    // The constraint trigger from 0006 is neither recreated nor dropped — only its function changes.
    expect(flat).not.toMatch(/journal_lines_balanced/)
    expect(flat).toContain('GROUP BY f.currency')
    expect(flat).toContain("IF v_event IS DISTINCT FROM 'company_fx_exchange' OR v_currencies <> 2 THEN")
  })

  it('adds the partition, USD-rate and pocket guards as DEFERRED constraint triggers', () => {
    for (const trigger of [
      'CREATE CONSTRAINT TRIGGER journal_lines_ledger_partition AFTER INSERT OR UPDATE ON journal_lines DEFERRABLE INITIALLY DEFERRED',
      'CREATE CONSTRAINT TRIGGER journal_entries_ledger_partition AFTER INSERT OR UPDATE OF branch_id, event_type, syp_minor_per_usd ON journal_entries DEFERRABLE INITIALLY DEFERRED',
      "CREATE CONSTRAINT TRIGGER journal_lines_company_pocket AFTER INSERT OR UPDATE ON journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.side = 'C')",
    ]) {
      expect(flat).toContain(trigger)
    }
    for (const constraint of [
      'journal_ledger_partition_guard',
      'journal_company_event_guard',
      'journal_entry_usd_rate_guard',
      'company_pocket_negative_guard',
    ]) {
      expect(flat).toContain(`CONSTRAINT = '${constraint}'`)
    }
  })

  it('exempts only the restoration mirror from the pocket guard, and locks the fund before reading it', () => {
    expect(flat).toContain("IF v_type IS NULL OR v_type NOT IN ('company_cash', 'depreciation_reserve') THEN")
    expect(flat).toContain("IF v_event IS NULL OR v_event = 'company_restoration_mirror' THEN")
    const lock = flat.indexOf('PERFORM 1 FROM public.funds f WHERE f.id = NEW.fund_id FOR UPDATE;')
    const balance = flat.indexOf(
      "SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END), 0 ) < 0",
    )
    expect(lock).toBeGreaterThan(-1)
    expect(balance).toBeGreaterThan(lock)
    expect(foundation).toContain(
      'CREATE FUNCTION assert_company_pocket_not_negative() RETURNS trigger\nLANGUAGE plpgsql SECURITY DEFINER\nSET search_path = pg_catalog, public, pg_temp',
    )
  })

  it('proves every stored entry against the new rules before it may commit', () => {
    expect(flat).toContain("RAISE EXCEPTION '0066 proof failed — entries unbalanced per currency: %', v_bad;")
    expect(flat).toContain("RAISE EXCEPTION '0066 proof failed — entries span currencies: %', v_bad;")
    expect(flat).toContain("RAISE EXCEPTION '0066 proof failed — lines outside their ledger partition: %', v_bad;")
    expect(flat).toContain("RAISE EXCEPTION '0066 proof failed — a fund lives in the wrong ledger';")
  })

  it('creates no table, so the audit list needs no new entry', () => {
    expect(flat).not.toMatch(/CREATE TABLE/i)
  })
})
