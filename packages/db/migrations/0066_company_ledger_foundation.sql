-- 0066 — «صندوق الشركة» becomes its own ledger, in USD and SYP (finance redesign, phase C1)
--
-- The owner (2026-09-17): «صندوق الشركة» is a whole financial system, separate from the branch box,
-- in dollars and lira. This migration lays the FOUNDATION only. No new money moves exist yet — C2
-- adds the commands — but after this file the database can hold a balanced USD entry in a dedicated
-- company ledger, and can refuse every way such an entry could leak into a branch or a branch entry
-- into it.
--
-- ── WHY A BRANCH ROW, NOT A NULLABLE branch_id ─────────────────────────────────────────────────
-- 0023 records it for `company_box` and it still holds: `funds.branch_id` is NOT NULL and both fund
-- unique constraints key on it (0004), week locks key on it, the sealed-week guard (0018) and the
-- seal advisory lock (0029) key on it. A NULL branch would make each of those silently stop
-- preventing duplicates. So the company gets ONE row of its own in `branches`, told apart by
-- `kind = 'company'`, and every existing mechanism — fund identity, week locks, sealing, the
-- financial advisory lock — works for it unchanged.
--
-- ── WHAT EXISTING BRANCHES SEE ─────────────────────────────────────────────────────────────────
-- Nothing. Every branch fund is SYP_NEW, every branch entry is single-currency, and the rewritten
-- balance trigger computes exactly the old sum for a single-currency entry. The proof below
-- re-checks every stored entry under the new rule before the transaction may commit.
--
-- Constraint names that PostgreSQL generated (0004's funds currency CHECK, 0007's branch_no CHECK)
-- are found in pg_constraint, never assumed: this file must apply to a database whose history it
-- did not write.


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 1. branches.kind and the company (HQ) row
-- ═════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE branches
  ADD COLUMN kind text NOT NULL DEFAULT 'branch'
    CONSTRAINT branches_kind_ck CHECK (kind IN ('branch', 'company'));

-- One company. A second one would split صندوق الشركة in two with nothing to say which is real.
CREATE UNIQUE INDEX branches_single_company_uq ON branches (kind) WHERE kind = 'company';

-- 0007 added `branch_no smallint CHECK (branch_no BETWEEN 1 AND 99)` inline, so PostgreSQL named
-- it. Drop exactly that one, whatever it is called, and refuse to guess if the schema is not the
-- one this file was written against.
DO $$
DECLARE
  v_name  text;
  v_count integer := 0;
BEGIN
  FOR v_name IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.branches'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ~ '\mbranch_no\M'
  LOOP
    EXECUTE format('ALTER TABLE public.branches DROP CONSTRAINT %I', v_name);
    v_count := v_count + 1;
  END LOOP;
  IF v_count <> 1 THEN
    RAISE EXCEPTION '0066 expected exactly one branch_no CHECK on branches, found %', v_count;
  END IF;
END
$$;

-- The company row is number 0, so it can never take a real branch's place in «رقم الآلية».
ALTER TABLE branches
  ADD CONSTRAINT branches_kind_number_ck CHECK (
    (kind = 'branch' AND branch_no BETWEEN 1 AND 99)
    OR (kind = 'company' AND branch_no = 0)
  );

-- A branch cannot become the company or the other way round: every fund, entry and week lock
-- already filed under the row was judged by the rules of its kind.
CREATE FUNCTION assert_branch_kind_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'branch % cannot change kind from % to %', OLD.id, OLD.kind, NEW.kind
      USING ERRCODE = '23514', CONSTRAINT = 'branches_kind_immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER branches_kind_immutable
  BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind_immutable();

-- The HQ row. A FIXED id so the API, the seed and every environment name the same row. Its
-- governorate is the one Damascus (`DAM`) uses; on a database with no DAM yet (a fresh install,
-- where the seed creates DAM in governorate no. 1 right after the migrations) it is that same
-- governorate. `seedReferenceData` mirrors this insert.
INSERT INTO branches (id, code, name_ar, name_en, governorate_id, branch_no, kind)
SELECT '10000000-0000-4000-8000-000000000100'::uuid, 'HQ', 'صندوق الشركة', 'Company',
       g.governorate_id, 0, 'company'
  FROM (
    SELECT COALESCE(
      (SELECT b.governorate_id FROM branches b WHERE b.code = 'DAM'),
      (SELECT gv.id FROM governorates gv WHERE gv.no = 1)
    ) AS governorate_id
  ) g
 WHERE g.governorate_id IS NOT NULL
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM branches
     WHERE id = '10000000-0000-4000-8000-000000000100'::uuid
       AND code = 'HQ' AND kind = 'company' AND branch_no = 0
  ) THEN
    RAISE EXCEPTION '0066 could not establish the company (HQ) branch row';
  END IF;
END
$$;

COMMENT ON COLUMN branches.kind IS
  '''branch'' for an operating branch; ''company'' for the single HQ row that holds the company '
  'ledger («صندوق الشركة», USD and SYP). Immutable.';


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Branch-only tables refuse the company row
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- A driver, a shift or a cash count filed under HQ would put branch operations into the company
-- ledger's partition. The API refuses to address HQ for branch permissions; this is the copy that
-- survives a psql session. `media` stays unguarded on purpose: company receipts will live there.

CREATE FUNCTION assert_branch_kind() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_kind text;
BEGIN
  -- users.branch_id is NULL for organisation-wide roles; that is not a branch at all.
  IF NEW.branch_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT b.kind INTO v_kind FROM public.branches b WHERE b.id = NEW.branch_id;
  -- A missing branch is the foreign key's error to report, not this guard's.
  IF v_kind IS NOT NULL AND v_kind IS DISTINCT FROM TG_ARGV[0] THEN
    RAISE EXCEPTION '% rows belong to a % row, and branch % is a %',
      TG_TABLE_NAME, TG_ARGV[0], NEW.branch_id, v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'branch_kind_guard';
  END IF;
  RETURN NEW;
END
$$;

-- `_00_` sorts before every other BEFORE trigger on these tables, so the cheap refusal comes first.
CREATE TRIGGER users_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON users
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER drivers_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON drivers
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER vehicles_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON vehicles
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER shifts_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON shifts
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER cash_counts_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON cash_counts
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER office_capital_targets_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON office_capital_targets
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER restorations_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON restorations
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER expenses_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON expenses
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER incomes_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON incomes
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER advances_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON advances
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER advance_events_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON advance_events
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER receivable_events_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON receivable_events
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER checkin_windows_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON checkin_windows
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');
CREATE TRIGGER preapproved_shift_rules_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON preapproved_shift_rules
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 3. The company vocabulary, stated once
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- IMMUTABLE and compared as TEXT, so no statement here depends on enum ordering. They name no
-- relation, so they carry no `SET search_path` — which also keeps them inlinable in the per-line
-- triggers below (pg_catalog is searched first regardless). The domain holds
-- the same lists (`COMPANY_FUND_KINDS`, `COMPANY_LEDGER_EVENTS`, `COMPANY_FUND_ALLOWED_EVENTS`)
-- and a PostgreSQL test compares every (type, event) pair between the two.

CREATE FUNCTION ash_is_company_fund_type(p_type text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT p_type IN (
    'company_cash', 'depreciation_reserve', 'company_fx_position', 'branch_clearing',
    'company_payable', 'company_receivable', 'fixed_asset',
    'company_expense', 'company_income', 'company_equity'
  )
$$;

CREATE FUNCTION ash_is_company_event(p_event text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT p_event IN (
    'company_opening_transfer', 'company_restoration_mirror',
    'company_deposit', 'company_withdrawal', 'company_expense', 'company_income',
    'company_fx_exchange',
    'company_debt_open', 'company_debt_payment', 'company_debt_writeoff',
    'asset_purchase', 'depreciation_transfer', 'depreciation_release',
    'company_correction'
  )
$$;

-- Which company events may touch which company account. Anything not listed is refused, so a
-- generic correction cannot reach the branch clearing account and an exchange cannot touch equity.
CREATE FUNCTION ash_company_fund_event_allowed(p_type text, p_event text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE p_type
    WHEN 'company_cash' THEN p_event IN (
      'company_deposit', 'company_withdrawal', 'company_expense', 'company_income',
      'company_fx_exchange', 'company_opening_transfer', 'company_restoration_mirror',
      'company_debt_open', 'company_debt_payment', 'asset_purchase',
      'depreciation_transfer', 'depreciation_release', 'company_correction')
    WHEN 'depreciation_reserve' THEN p_event IN (
      'depreciation_transfer', 'depreciation_release', 'company_expense',
      'company_debt_payment', 'asset_purchase', 'company_correction')
    WHEN 'company_fx_position' THEN p_event IN (
      'company_fx_exchange', 'company_correction')
    WHEN 'branch_clearing' THEN p_event IN (
      'company_opening_transfer', 'company_restoration_mirror')
    WHEN 'company_payable' THEN p_event IN (
      'company_debt_open', 'company_debt_payment', 'company_debt_writeoff',
      'asset_purchase', 'company_correction')
    WHEN 'company_receivable' THEN p_event IN (
      'company_debt_open', 'company_debt_payment', 'company_debt_writeoff',
      'asset_purchase', 'company_correction')
    WHEN 'fixed_asset' THEN p_event IN (
      'asset_purchase', 'company_correction')
    WHEN 'company_expense' THEN p_event IN (
      'company_expense', 'company_debt_open', 'company_debt_writeoff', 'company_correction')
    WHEN 'company_income' THEN p_event IN (
      'company_income', 'company_debt_open', 'company_debt_writeoff', 'company_correction')
    WHEN 'company_equity' THEN p_event IN (
      'company_deposit', 'company_withdrawal', 'company_expense',
      'company_debt_open', 'company_debt_payment', 'asset_purchase', 'company_correction')
    ELSE false
  END
$$;


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Currency lives on the FUND
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- A journal line inherits its currency from its fund, so a line can never disagree with the
-- account it moves. 0004 declared `currency ... CHECK (currency IN ('SYP_NEW'))` inline; drop that
-- auto-named check by what it says, not by what it is probably called.
DO $$
DECLARE
  v_name  text;
  v_count integer := 0;
BEGIN
  FOR v_name IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.funds'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ~ '\mcurrency\M'
  LOOP
    EXECUTE format('ALTER TABLE public.funds DROP CONSTRAINT %I', v_name);
    v_count := v_count + 1;
  END LOOP;
  IF v_count <> 1 THEN
    RAISE EXCEPTION '0066 expected exactly one currency CHECK on funds, found %', v_count;
  END IF;
END
$$;

ALTER TABLE funds
  ADD CONSTRAINT funds_currency_ck CHECK (currency IN ('SYP_NEW', 'USD'));

-- USD exists only in the company ledger. `branch_clearing` mirrors a branch's SYP `company_box`,
-- so it is SYP-only too. Compared as text: the enum values are 0065's.
ALTER TABLE funds
  ADD CONSTRAINT funds_currency_scope_ck CHECK (
    currency = 'SYP_NEW'
    OR type::text IN (
      'company_cash', 'depreciation_reserve', 'company_fx_position',
      'company_payable', 'company_receivable', 'fixed_asset',
      'company_expense', 'company_income', 'company_equity'
    )
  );

-- A fund's identity is what every stored line was posted against. Re-pointing it would restate
-- history — a SYP fund turned USD would reprice every line on it — so it is fixed at creation.
-- `ensureFund`'s `ON CONFLICT ... DO UPDATE SET code = EXCLUDED.code` writes the same value and
-- passes.
CREATE FUNCTION assert_fund_identity_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.currency IS DISTINCT FROM OLD.currency
  THEN
    RAISE EXCEPTION 'fund % identity (branch, type, code, currency) is immutable', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'funds_identity_immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER funds_identity_immutable
  BEFORE UPDATE ON funds
  FOR EACH ROW EXECUTE FUNCTION assert_fund_identity_immutable();

-- Company accounts are opened only in the company row, and branch accounts never are. Checked on
-- the fund itself so the refusal is immediate; the line partition below re-checks at COMMIT.
CREATE FUNCTION assert_fund_ledger_partition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_kind text;
BEGIN
  SELECT b.kind INTO v_kind FROM public.branches b WHERE b.id = NEW.branch_id;
  IF v_kind IS NULL THEN
    RETURN NEW;
  END IF;
  IF (v_kind = 'company') IS DISTINCT FROM public.ash_is_company_fund_type(NEW.type::text) THEN
    RAISE EXCEPTION 'fund type % cannot live in a % ledger (branch %)', NEW.type, v_kind, NEW.branch_id
      USING ERRCODE = '23514', CONSTRAINT = 'funds_ledger_partition_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER funds_00_ledger_partition
  BEFORE INSERT ON funds
  FOR EACH ROW EXECUTE FUNCTION assert_fund_ledger_partition();


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 5. The frozen USD rate
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- `fx_days` is overwritten in place when the admin corrects a day's rate, so it cannot be the
-- record of what a USD entry was worth. The rate a USD entry was posted at is frozen on the entry.
-- NULL on every branch entry and every SYP-only company entry.
ALTER TABLE journal_entries
  ADD COLUMN syp_minor_per_usd bigint
    CONSTRAINT je_syp_minor_per_usd_ck CHECK (syp_minor_per_usd > 0);

COMMENT ON COLUMN journal_entries.syp_minor_per_usd IS
  'The SYP-minor-per-USD rate frozen on an entry that has a USD line (and only then). Never read '
  'from fx_days afterwards: that row is corrected in place.';


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 6. Double entry, per currency
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- 0006's rule was Σ debits = Σ credits per entry. With two currencies that sum is meaningless —
-- $100 against 100 lira "balances" — so the rule becomes: per entry, per currency, debits equal
-- credits. And an entry may span two currencies only as an exchange, where each side balances
-- through the FX position account on its own. The constraint trigger `journal_lines_balanced`
-- keeps firing exactly as before; only the function it calls changes.
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_entry_id   bigint;
  v_lines      integer;
  v_currencies integer;
  v_problem    text;
  v_event      text;
BEGIN
  v_entry_id := COALESCE(NEW.entry_id, OLD.entry_id);

  SELECT COALESCE(SUM(per.line_count), 0),
         COUNT(*),
         string_agg(
           format('%s debits %s <> credits %s', per.currency, per.debits, per.credits),
           '; ' ORDER BY per.currency
         ) FILTER (WHERE per.debits <> per.credits)
    INTO v_lines, v_currencies, v_problem
    FROM (
      SELECT f.currency,
             COUNT(*) AS line_count,
             COALESCE(SUM(jl.amount_minor) FILTER (WHERE jl.side = 'D'), 0) AS debits,
             COALESCE(SUM(jl.amount_minor) FILTER (WHERE jl.side = 'C'), 0) AS credits
        FROM public.journal_lines jl
        JOIN public.funds f ON f.id = jl.fund_id
       WHERE jl.entry_id = v_entry_id
       GROUP BY f.currency
    ) per;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'journal entry % has no lines', v_entry_id
      USING ERRCODE = '23514';
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: %', v_entry_id, v_problem
      USING ERRCODE = '23514';
  END IF;

  IF v_currencies > 1 THEN
    SELECT je.event_type::text INTO v_event FROM public.journal_entries je WHERE je.id = v_entry_id;
    IF v_event IS DISTINCT FROM 'company_fx_exchange' OR v_currencies <> 2 THEN
      RAISE EXCEPTION 'journal entry % (%) spans % currencies; only company_fx_exchange may span exactly two',
        v_entry_id, v_event, v_currencies
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NULL;
END
$$;


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 7. The ledger partition, and the USD rate rule
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- At COMMIT, for every line and every entry:
--   • a line's fund belongs to the entry's own branch row;
--   • in the company row: only company events, only company accounts, and each account only under
--     the events listed in `ash_company_fund_event_allowed` — so `/journal/manual` (event `manual`)
--     and the generic reverse (event `correction`) cannot reach the company ledger at all;
--   • in a branch row: no company event, no company account, no currency but SYP_NEW;
--   • a USD line requires the entry's frozen rate, and a frozen rate requires a USD line.
-- One function for both tables, so a line costs one lookup of its entry, fund and branch.
CREATE FUNCTION assert_ledger_partition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_entry_id     bigint;
  v_entry_branch uuid;
  v_event        text;
  v_rate         bigint;
  v_kind         text;
  v_fund_branch  uuid;
  v_fund_type    text;
  v_currency     text;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    v_entry_id := NEW.id;
    v_entry_branch := NEW.branch_id;
    v_event := NEW.event_type::text;
    v_rate := NEW.syp_minor_per_usd;
  ELSE
    v_entry_id := NEW.entry_id;
    SELECT je.branch_id, je.event_type::text, je.syp_minor_per_usd
      INTO v_entry_branch, v_event, v_rate
      FROM public.journal_entries je
     WHERE je.id = v_entry_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    SELECT f.branch_id, f.type::text, f.currency
      INTO v_fund_branch, v_fund_type, v_currency
      FROM public.funds f
     WHERE f.id = NEW.fund_id;
    IF v_fund_branch IS DISTINCT FROM v_entry_branch THEN
      RAISE EXCEPTION 'journal line % of entry % names fund % of another branch',
        NEW.id, v_entry_id, NEW.fund_id
        USING ERRCODE = '23514', CONSTRAINT = 'journal_ledger_partition_guard';
    END IF;
  END IF;

  SELECT b.kind INTO v_kind FROM public.branches b WHERE b.id = v_entry_branch;

  IF v_kind = 'company' THEN
    IF NOT public.ash_is_company_event(v_event) THEN
      RAISE EXCEPTION 'the company ledger accepts only company events; entry % is %', v_entry_id, v_event
        USING ERRCODE = '23514', CONSTRAINT = 'journal_ledger_partition_guard';
    END IF;
    IF TG_TABLE_NAME = 'journal_lines' THEN
      IF NOT public.ash_is_company_fund_type(v_fund_type) THEN
        RAISE EXCEPTION 'the company ledger accepts only company accounts; entry % names %',
          v_entry_id, v_fund_type
          USING ERRCODE = '23514', CONSTRAINT = 'journal_ledger_partition_guard';
      END IF;
      IF NOT public.ash_company_fund_event_allowed(v_fund_type, v_event) THEN
        RAISE EXCEPTION 'company account % cannot move under event % (entry %)',
          v_fund_type, v_event, v_entry_id
          USING ERRCODE = '23514', CONSTRAINT = 'journal_company_event_guard';
      END IF;
    END IF;
  ELSE
    IF public.ash_is_company_event(v_event) THEN
      RAISE EXCEPTION 'company event % cannot post in branch % (entry %)', v_event, v_entry_branch, v_entry_id
        USING ERRCODE = '23514', CONSTRAINT = 'journal_ledger_partition_guard';
    END IF;
    IF TG_TABLE_NAME = 'journal_lines'
       AND (public.ash_is_company_fund_type(v_fund_type) OR v_currency IS DISTINCT FROM 'SYP_NEW') THEN
      RAISE EXCEPTION 'branch entry % cannot move company account % in %', v_entry_id, v_fund_type, v_currency
        USING ERRCODE = '23514', CONSTRAINT = 'journal_ledger_partition_guard';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'journal_lines' THEN
    IF v_currency = 'USD' AND v_rate IS NULL THEN
      RAISE EXCEPTION 'journal entry % has a USD line but no frozen syp_minor_per_usd', v_entry_id
        USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_usd_rate_guard';
    END IF;
  ELSIF v_rate IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.journal_lines jl
      JOIN public.funds f ON f.id = jl.fund_id
     WHERE jl.entry_id = v_entry_id
       AND f.currency = 'USD'
  ) THEN
    RAISE EXCEPTION 'journal entry % freezes a USD rate but has no USD line', v_entry_id
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_usd_rate_guard';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journal_lines_ledger_partition
  AFTER INSERT OR UPDATE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_partition();

-- `week_lock_id` is the one column the seal writes; it is not part of the partition.
CREATE CONSTRAINT TRIGGER journal_entries_ledger_partition
  AFTER INSERT OR UPDATE OF branch_id, event_type, syp_minor_per_usd ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_partition();


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 8. The company pockets never go negative — except through the restoration mirror
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- `company_cash` and `depreciation_reserve` are money the owner can count. A withdrawal, an
-- expense or a transfer larger than what is there is refused at COMMIT. The one exception is the
-- owner's own (2026-09-17): a restoration top-up «شحن» may drive the company SYP pocket negative,
-- with a visible warning, rather than leave a branch short — so `company_restoration_mirror`
-- entries are not judged here. Only a CREDIT can lower a pocket; a deposit into a pocket already
-- below zero is always welcome.
--
-- The fund row is locked before the balance is read, as 0037/0056 do for named assets: two
-- concurrent withdrawals must not each see enough money and jointly overdraw.
CREATE FUNCTION assert_company_pocket_not_negative() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_type  text;
  v_event text;
BEGIN
  SELECT f.type::text INTO v_type FROM public.funds f WHERE f.id = NEW.fund_id;
  IF v_type IS NULL OR v_type NOT IN ('company_cash', 'depreciation_reserve') THEN
    RETURN NULL;
  END IF;

  SELECT je.event_type::text INTO v_event FROM public.journal_entries je WHERE je.id = NEW.entry_id;
  IF v_event IS NULL OR v_event = 'company_restoration_mirror' THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM public.funds f WHERE f.id = NEW.fund_id FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM public.journal_lines jl
     WHERE jl.fund_id = NEW.fund_id
    HAVING COALESCE(
      SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END),
      0
    ) < 0
  ) THEN
    RAISE EXCEPTION 'company pocket % would go below zero (entry %, event %)', NEW.fund_id, NEW.entry_id, v_event
      USING ERRCODE = '23514', CONSTRAINT = 'company_pocket_negative_guard';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journal_lines_company_pocket
  AFTER INSERT OR UPDATE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.side = 'C')
  EXECUTE FUNCTION assert_company_pocket_not_negative();


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 9. The proof: every stored entry already satisfies the new rules
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- The triggers above judge NEW rows only. History was judged by 0006's single-sum rule, so before
-- this transaction may commit, re-judge all of it: balanced per currency, single-currency, and
-- inside its own branch's partition. Any failure aborts the whole migration with the offending
-- entry ids, and nothing above takes effect.
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(format('entry %s %s: %s', bad.entry_id, bad.currency, bad.diff), '; ')
    INTO v_bad
    FROM (
      SELECT jl.entry_id, f.currency,
             SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END) AS diff
        FROM journal_lines jl
        JOIN funds f ON f.id = jl.fund_id
       GROUP BY jl.entry_id, f.currency
      HAVING SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END) <> 0
       ORDER BY jl.entry_id
       LIMIT 20
    ) bad;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0066 proof failed — entries unbalanced per currency: %', v_bad;
  END IF;

  SELECT string_agg(format('entry %s (%s currencies)', multi.entry_id, multi.currencies), '; ')
    INTO v_bad
    FROM (
      SELECT jl.entry_id, COUNT(DISTINCT f.currency) AS currencies
        FROM journal_lines jl
        JOIN funds f ON f.id = jl.fund_id
        JOIN journal_entries je ON je.id = jl.entry_id
       GROUP BY jl.entry_id, je.event_type
      HAVING COUNT(DISTINCT f.currency) > 1
         AND (je.event_type::text <> 'company_fx_exchange' OR COUNT(DISTINCT f.currency) <> 2)
       ORDER BY jl.entry_id
       LIMIT 20
    ) multi;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0066 proof failed — entries span currencies: %', v_bad;
  END IF;

  SELECT string_agg(format('line %s of entry %s', stray.line_id, stray.entry_id), '; ')
    INTO v_bad
    FROM (
      SELECT jl.id AS line_id, jl.entry_id
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN funds f ON f.id = jl.fund_id
        JOIN branches b ON b.id = je.branch_id
       WHERE f.branch_id <> je.branch_id
          OR (b.kind = 'branch' AND (
                ash_is_company_event(je.event_type::text)
                OR ash_is_company_fund_type(f.type::text)
                OR f.currency <> 'SYP_NEW'))
          OR (b.kind = 'company' AND (
                NOT ash_is_company_event(je.event_type::text)
                OR NOT ash_company_fund_event_allowed(f.type::text, je.event_type::text)))
       ORDER BY jl.id
       LIMIT 20
    ) stray;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0066 proof failed — lines outside their ledger partition: %', v_bad;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM funds f
      JOIN branches b ON b.id = f.branch_id
     WHERE (b.kind = 'company') IS DISTINCT FROM ash_is_company_fund_type(f.type::text)
  ) THEN
    RAISE EXCEPTION '0066 proof failed — a fund lives in the wrong ledger';
  END IF;
END
$$;
