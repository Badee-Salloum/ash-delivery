-- 0067 — «صندوق الشركة» commands, the restoration mirror, and the cutover (finance redesign, C2)
--
-- 0066 built the company (HQ) ledger and refused every way money could leak across it. This file
-- gives it its MONEY MOVES, each as an immutable command row that is one accounting fact with its
-- journal entry — the 0056 pattern:
--
--   company_moves              «إيداع المالك» / «سحب المالك» (and the manual USD opening balance)
--   company_expenses           «صرفية الشركة», filed under a cost centre, paid from a pocket, the
--                              depreciation reserve, or by the owner outside the system
--   company_incomes            «مدخول الشركة»
--   company_fx_exchanges       «تصريف عملة»: BOTH actual amounts, the implied rate frozen
--   company_reversals          «عكس»: the exact line-for-line inverse of one of the above
--   company_ledger_cutovers    the day a branch's `company_box` moves as-is into the company pocket
--   company_restoration_mirrors the HQ half of every branch entry that moves `company_box` after it
--
-- Every row: the client's UUID is the row id, the idempotency key AND the journal occurrence key;
-- the journal columns are NOT NULL UNIQUE; a BEFORE INSERT guard checks the attributed actor against
-- the LIVE `role_permissions`, the journal's identity, and the EXACT line set (fund, type, currency,
-- side, amount, role); a deferred trigger refuses a company journal entry that has no command row.
--
-- ── THE MIRROR ─────────────────────────────────────────────────────────────────────────────────
-- DAM's `company_box` stays exactly as it is and becomes «حساب الشركة لدى الفرع». From the cutover
-- on, every branch entry that moves it gets, in the SAME transaction, an HQ entry that moves the
-- company SYP pocket and `branch_clearing:<branch>` the same way, so at every COMMIT:
--
--     balance(branch company_box) + balance(HQ branch_clearing:<branch>) = 0
--
-- The restoration guards (0038, 0053, 0061) are NOT touched: the branch half of الترميم is exactly
-- what it was, and the mirror is a separate entry in a separate ledger.
--
-- ── ONE CHANGE TO AN EXISTING RULE ─────────────────────────────────────────────────────────────
-- 0066 let only `company_fx_exchange` span two currencies. The reversal of an exchange is a
-- four-line, two-currency `company_correction`, so `assert_entry_balanced` now accepts that event
-- too. Each currency must still balance on its own; and this file requires every
-- `company_correction` to be the exact inverse of a reversible command, so a two-currency
-- correction can only ever be an exchange taken back.


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 0. Double entry per currency — the reversal of an exchange may span two currencies
-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- Re-emitted from 0066 with exactly one change: the event list on the two-currency branch.
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
    IF v_event IS NULL
       OR v_event NOT IN ('company_fx_exchange', 'company_correction')
       OR v_currencies <> 2
    THEN
      RAISE EXCEPTION 'journal entry % (%) spans % currencies; only company_fx_exchange (or its company_correction reversal) may span exactly two',
        v_entry_id, v_event, v_currencies
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NULL;
END
$$;


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Shared helpers for the guards
-- ═════════════════════════════════════════════════════════════════════════════════════════════

-- The attributed actor of this transaction, or NULL. A malformed GUC is no actor at all.
CREATE FUNCTION ash_current_actor() RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN NULLIF(current_setting('app.actor_id', true), '')::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

-- Whether an ACTIVE user holds a permission at scope `all` in the live, editable matrix. There is
-- deliberately no compiled-default fallback: an empty matrix fails closed, as 0037/0056 do.
CREATE FUNCTION ash_actor_holds_all(p_actor uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_actor IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.users u
      JOIN public.role_permissions rp
        ON rp.role_key = u.role_key
       AND rp.permission_key = p_permission
       AND rp.scope = 'all'
     WHERE u.id = p_actor
       AND u.active
  )
$$;

-- A shift-less command entry with exactly this identity: branch, event, key, one business date
-- that is also its posting date, its Sunday week, reason, author and frozen rate.
CREATE FUNCTION ash_company_entry_is(
  p_entry_id bigint,
  p_branch_id uuid,
  p_event text,
  p_key text,
  p_business_date date,
  p_reason text,
  p_created_by uuid,
  p_rate bigint
) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.journal_entries je
     WHERE je.id = p_entry_id
       AND je.branch_id = p_branch_id
       AND je.event_type::text = p_event
       AND je.shift_id IS NULL
       AND je.occurrence_key = p_key
       AND je.business_date = p_business_date
       AND je.posting_date = p_business_date
       AND je.week_start_date = (p_business_date - extract(dow FROM p_business_date)::integer)
       AND je.reason IS NOT DISTINCT FROM p_reason
       AND je.created_by = p_created_by
       AND je.syp_minor_per_usd IS NOT DISTINCT FROM p_rate
  )
$$;

-- One expected journal line, in the shape `ash_company_lines_match` compares.
CREATE FUNCTION ash_company_line(
  p_code text,
  p_type text,
  p_currency text,
  p_side text,
  p_amount bigint,
  p_role text
) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT jsonb_build_object(
    'code', p_code, 'type', p_type, 'currency', p_currency,
    'side', p_side, 'amount', p_amount, 'role', p_role
  )
$$;

-- The entry's lines are EXACTLY the expected multiset: same count, and each line one-to-one on
-- fund code, fund type, fund currency, side, amount and role — every fund in `p_branch_id`, owned
-- by nobody (company accounts carry their identity in the code, as an advance does).
CREATE FUNCTION ash_company_lines_match(p_entry_id bigint, p_branch_id uuid, p_expected jsonb) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH actual AS (
    SELECT f.code, f.type::text AS type, f.currency, jl.side::text AS side,
           jl.amount_minor AS amount, jl.line_role AS role,
           (f.branch_id = p_branch_id AND f.owner_kind = 'none' AND f.owner_id IS NULL) AS owned_right
      FROM public.journal_lines jl
      JOIN public.funds f ON f.id = jl.fund_id
     WHERE jl.entry_id = p_entry_id
  ),
  expected AS (
    SELECT e->>'code' AS code, e->>'type' AS type, e->>'currency' AS currency, e->>'side' AS side,
           (e->>'amount')::bigint AS amount, e->>'role' AS role
      FROM jsonb_array_elements(p_expected) e
  )
  SELECT jsonb_typeof(p_expected) = 'array'
     AND (SELECT count(*) FROM actual) = jsonb_array_length(p_expected)
     AND NOT EXISTS (SELECT 1 FROM actual WHERE NOT owned_right)
     AND NOT EXISTS (
       (SELECT code, type, currency, side, amount, role FROM actual)
       EXCEPT ALL
       (SELECT code, type, currency, side, amount, role FROM expected)
     )
     AND NOT EXISTS (
       (SELECT code, type, currency, side, amount, role FROM expected)
       EXCEPT ALL
       (SELECT code, type, currency, side, amount, role FROM actual)
     )
$$;

-- Σ D − Σ C of one fund, by code, in one ledger row.
CREATE FUNCTION ash_fund_balance(p_branch_id uuid, p_code text) RETURNS numeric
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END)::numeric, 0)
    FROM public.journal_lines jl
    JOIN public.funds f ON f.id = jl.fund_id
   WHERE f.branch_id = p_branch_id
     AND f.code = p_code
$$;

-- Company command rows are posted facts. Correct one with a visible reversal, never by editing it.
CREATE FUNCTION refuse_company_command_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable: post a reversal instead', TG_TABLE_NAME
    USING ERRCODE = '23514', CONSTRAINT = 'company_command_immutable';
END
$$;


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 2. The command tables
-- ═════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE company_moves (
  id                uuid PRIMARY KEY,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  kind              text NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  equity_account    text NOT NULL CHECK (equity_account IN ('owner_funding', 'owner_drawings', 'opening')),
  currency          text NOT NULL CHECK (currency IN ('SYP_NEW', 'USD')),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  syp_minor_per_usd bigint CHECK (syp_minor_per_usd > 0),
  -- The day it really happened. The entry is posted TODAY (business_date); a historical deposit
  -- keeps its real date here and counts in the books on the day it was recorded.
  occurred_on       date NOT NULL,
  business_date     date NOT NULL,
  reason            text NOT NULL CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500),
  journal_entry_id  bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_moves_occurred_ck CHECK (occurred_on <= business_date AND occurred_on >= DATE '2000-01-01'),
  CONSTRAINT company_moves_account_ck CHECK (
    (kind = 'deposit' AND equity_account IN ('owner_funding', 'opening'))
    OR (kind = 'withdrawal' AND equity_account = 'owner_drawings')
  ),
  CONSTRAINT company_moves_rate_ck CHECK ((currency = 'USD') = (syp_minor_per_usd IS NOT NULL))
);
CREATE INDEX company_moves_branch_date_idx ON company_moves (branch_id, business_date, created_at);

CREATE TABLE company_expenses (
  id                uuid PRIMARY KEY,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  currency          text NOT NULL CHECK (currency IN ('SYP_NEW', 'USD')),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  syp_minor_per_usd bigint CHECK (syp_minor_per_usd > 0),
  category_id       uuid NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  cost_center_kind  text NOT NULL CHECK (cost_center_kind IN ('general', 'vehicle', 'asset')),
  -- Any branch's vehicle: the company buys and repairs the fleet for every branch.
  vehicle_id        uuid REFERENCES vehicles(id) ON DELETE RESTRICT,
  -- The fixed-asset register lands in C4, which adds the foreign key. Until then the guard refuses
  -- the `asset` centre outright, so C4's FK can never meet an id it cannot resolve.
  asset_id          uuid,
  paid_from         text NOT NULL CHECK (paid_from IN ('pocket', 'reserve', 'owner_outside')),
  receipt_media_id  uuid REFERENCES media(id) ON DELETE RESTRICT,
  description       text NOT NULL CHECK (ash_has_visible_text(description) AND char_length(description) <= 500),
  occurred_on       date NOT NULL,
  business_date     date NOT NULL,
  journal_entry_id  bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_expenses_occurred_ck CHECK (occurred_on <= business_date AND occurred_on >= DATE '2000-01-01'),
  CONSTRAINT company_expenses_vehicle_ck CHECK ((cost_center_kind = 'vehicle') = (vehicle_id IS NOT NULL)),
  CONSTRAINT company_expenses_asset_ck CHECK ((cost_center_kind = 'asset') = (asset_id IS NOT NULL)),
  CONSTRAINT company_expenses_rate_ck CHECK ((currency = 'USD') = (syp_minor_per_usd IS NOT NULL))
);
CREATE INDEX company_expenses_branch_date_idx ON company_expenses (branch_id, business_date, created_at);
CREATE INDEX company_expenses_vehicle_idx ON company_expenses (vehicle_id) WHERE vehicle_id IS NOT NULL;

CREATE TABLE company_incomes (
  id                uuid PRIMARY KEY,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  currency          text NOT NULL CHECK (currency IN ('SYP_NEW', 'USD')),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  syp_minor_per_usd bigint CHECK (syp_minor_per_usd > 0),
  category_id       uuid NOT NULL REFERENCES income_categories(id) ON DELETE RESTRICT,
  description       text NOT NULL CHECK (ash_has_visible_text(description) AND char_length(description) <= 500),
  occurred_on       date NOT NULL,
  business_date     date NOT NULL,
  journal_entry_id  bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_incomes_occurred_ck CHECK (occurred_on <= business_date AND occurred_on >= DATE '2000-01-01'),
  CONSTRAINT company_incomes_rate_ck CHECK ((currency = 'USD') = (syp_minor_per_usd IS NOT NULL))
);
CREATE INDEX company_incomes_branch_date_idx ON company_incomes (branch_id, business_date, created_at);

CREATE TABLE company_fx_exchanges (
  id                 uuid PRIMARY KEY,
  branch_id          uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  from_currency      text NOT NULL CHECK (from_currency IN ('SYP_NEW', 'USD')),
  from_amount_minor  bigint NOT NULL CHECK (from_amount_minor > 0),
  to_currency        text NOT NULL CHECK (to_currency IN ('SYP_NEW', 'USD')),
  to_amount_minor    bigint NOT NULL CHECK (to_amount_minor > 0),
  syp_minor_per_usd  bigint NOT NULL CHECK (syp_minor_per_usd > 0),
  reason             text NOT NULL CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500),
  occurred_on        date NOT NULL,
  business_date      date NOT NULL,
  journal_entry_id   bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_fx_exchanges_occurred_ck CHECK (occurred_on <= business_date AND occurred_on >= DATE '2000-01-01'),
  CONSTRAINT company_fx_exchanges_currencies_ck CHECK (from_currency <> to_currency),
  -- The rate is the one the two actual amounts imply, never a number typed in:
  --   rate = round_half_up(lira_minor × 100 / dollar_cents), computed in numeric.
  -- (`fxRateFromAmounts` in the domain is the same formula.) A pair no integer rate reproduces to
  -- the last lira minor unit is still recorded as it happened: the amounts are the facts, the rate
  -- is the nearest integer to their ratio.
  CONSTRAINT company_fx_exchanges_rate_ck CHECK (
    syp_minor_per_usd::numeric = div(
      200 * (CASE WHEN from_currency = 'SYP_NEW' THEN from_amount_minor ELSE to_amount_minor END)::numeric
        + (CASE WHEN from_currency = 'USD' THEN from_amount_minor ELSE to_amount_minor END)::numeric,
      2 * (CASE WHEN from_currency = 'USD' THEN from_amount_minor ELSE to_amount_minor END)::numeric
    )
  )
);
CREATE INDEX company_fx_exchanges_branch_date_idx ON company_fx_exchanges (branch_id, business_date, created_at);

CREATE TABLE company_reversals (
  id                uuid PRIMARY KEY,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  target_kind       text NOT NULL CHECK (target_kind IN ('move', 'expense', 'income', 'exchange')),
  target_id         uuid NOT NULL,
  -- Once. A second reversal of the same entry would move the money back twice.
  target_entry_id   bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  -- The reversal inherits the target's frozen rate: it undoes the same dollars at the same price.
  syp_minor_per_usd bigint CHECK (syp_minor_per_usd > 0),
  reason            text NOT NULL CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500),
  occurred_on       date NOT NULL,
  business_date     date NOT NULL,
  journal_entry_id  bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_reversals_occurred_ck CHECK (occurred_on <= business_date AND occurred_on >= DATE '2000-01-01'),
  CONSTRAINT company_reversals_not_itself_ck CHECK (target_entry_id <> journal_entry_id)
);
CREATE INDEX company_reversals_branch_date_idx ON company_reversals (branch_id, business_date, created_at);

-- One cutover per branch, ever: `branch_id` is the key.
CREATE TABLE company_ledger_cutovers (
  branch_id            uuid PRIMARY KEY REFERENCES branches(id) ON DELETE RESTRICT,
  company_branch_id    uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  -- The branch's company_box balance at the moment of cutover, moved as-is. Zero moves nothing.
  opening_amount_minor bigint NOT NULL CHECK (opening_amount_minor >= 0),
  opening_entry_id     bigint UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  -- max(journal_entries.id) read under the branch and company locks. Every company_box line of the
  -- branch after it has a mirror; every one at or before it is inside the opening amount.
  watermark_entry_id   bigint NOT NULL CHECK (watermark_entry_id >= 0),
  business_date        date NOT NULL,
  reason               text NOT NULL CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500),
  performed_by         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  performed_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_ledger_cutovers_opening_ck CHECK ((opening_amount_minor = 0) = (opening_entry_id IS NULL)),
  CONSTRAINT company_ledger_cutovers_distinct_ck CHECK (branch_id <> company_branch_id)
);

CREATE TABLE company_restoration_mirrors (
  id                uuid PRIMARY KEY,
  source_branch_id  uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  source_entry_id   bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  mirror_entry_id   bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  direction         text NOT NULL CHECK (direction IN ('to_company', 'from_company')),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  -- The ترميم run the source entry belongs to; NULL for a hand «كييش», a legacy company-fund move
  -- or a reversal of one.
  restoration_id    bigint REFERENCES restorations(id) ON DELETE RESTRICT,
  created_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_restoration_mirrors_distinct_ck CHECK (source_entry_id <> mirror_entry_id)
);
CREATE INDEX company_restoration_mirrors_branch_idx ON company_restoration_mirrors (source_branch_id, source_entry_id);
CREATE INDEX company_restoration_mirrors_restoration_idx ON company_restoration_mirrors (restoration_id)
  WHERE restoration_id IS NOT NULL;

-- Every command row belongs to the company row; the cutover and the mirror name a BRANCH first.
CREATE TRIGGER company_moves_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON company_moves
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER company_expenses_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON company_expenses
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER company_incomes_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON company_incomes
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER company_fx_exchanges_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON company_fx_exchanges
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER company_reversals_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON company_reversals
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER company_ledger_cutovers_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON company_ledger_cutovers
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('branch');

-- Posted accounting facts: the application may read and add, never change or remove.
REVOKE UPDATE, DELETE, TRUNCATE ON company_moves FROM app_user;
GRANT  SELECT, INSERT ON company_moves TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON company_expenses FROM app_user;
GRANT  SELECT, INSERT ON company_expenses TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON company_incomes FROM app_user;
GRANT  SELECT, INSERT ON company_incomes TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON company_fx_exchanges FROM app_user;
GRANT  SELECT, INSERT ON company_fx_exchanges TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON company_reversals FROM app_user;
GRANT  SELECT, INSERT ON company_reversals TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON company_ledger_cutovers FROM app_user;
GRANT  SELECT, INSERT ON company_ledger_cutovers TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON company_restoration_mirrors FROM app_user;
GRANT  SELECT, INSERT ON company_restoration_mirrors TO app_user;

-- …and not even a superuser's stray UPDATE: the ledger they describe is append-only too.
CREATE TRIGGER company_moves_immutable BEFORE UPDATE OR DELETE ON company_moves
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_expenses_immutable BEFORE UPDATE OR DELETE ON company_expenses
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_incomes_immutable BEFORE UPDATE OR DELETE ON company_incomes
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_fx_exchanges_immutable BEFORE UPDATE OR DELETE ON company_fx_exchanges
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_reversals_immutable BEFORE UPDATE OR DELETE ON company_reversals
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_ledger_cutovers_immutable BEFORE UPDATE OR DELETE ON company_ledger_cutovers
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_restoration_mirrors_immutable BEFORE UPDATE OR DELETE ON company_restoration_mirrors
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();

CREATE TRIGGER audit_company_moves
  AFTER INSERT OR UPDATE OR DELETE ON company_moves
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_expenses
  AFTER INSERT OR UPDATE OR DELETE ON company_expenses
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_incomes
  AFTER INSERT OR UPDATE OR DELETE ON company_incomes
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_fx_exchanges
  AFTER INSERT OR UPDATE OR DELETE ON company_fx_exchanges
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_reversals
  AFTER INSERT OR UPDATE OR DELETE ON company_reversals
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_ledger_cutovers
  AFTER INSERT OR UPDATE OR DELETE ON company_ledger_cutovers
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_restoration_mirrors
  AFTER INSERT OR UPDATE OR DELETE ON company_restoration_mirrors
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- Defence in depth beside je_idempotency_uq (0017), as 0037/0047/0056 do for their commands.
CREATE UNIQUE INDEX je_company_deposit_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'company_deposit';
CREATE UNIQUE INDEX je_company_withdrawal_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'company_withdrawal';
CREATE UNIQUE INDEX je_company_expense_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'company_expense';
CREATE UNIQUE INDEX je_company_income_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'company_income';
CREATE UNIQUE INDEX je_company_fx_exchange_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'company_fx_exchange';
CREATE UNIQUE INDEX je_company_correction_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'company_correction';
CREATE UNIQUE INDEX je_company_opening_transfer_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'company_opening_transfer';
CREATE UNIQUE INDEX je_company_restoration_mirror_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'company_restoration_mirror';


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 3. BEFORE INSERT guards — one accounting fact per row
-- ═════════════════════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION guard_company_move_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor uuid := public.ash_current_actor();
  v_event text;
  v_cash  text := 'company_cash:' || NEW.currency;
  v_equity text := 'company_equity:' || NEW.currency || ':' || NEW.equity_account;
BEGIN
  IF v_actor IS NULL
     OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN
    RAISE EXCEPTION 'company move requires its attributed company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'company_moves_actor_guard';
  END IF;

  v_event := CASE NEW.kind WHEN 'deposit' THEN 'company_deposit' ELSE 'company_withdrawal' END;

  IF NOT public.ash_company_entry_is(
       NEW.journal_entry_id, NEW.branch_id, v_event, NEW.id::text, NEW.business_date,
       NEW.reason, NEW.created_by, NEW.syp_minor_per_usd)
  THEN
    RAISE EXCEPTION 'company move identity differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'company_moves_journal_guard';
  END IF;

  IF NOT public.ash_company_lines_match(
       NEW.journal_entry_id, NEW.branch_id,
       CASE NEW.kind
         WHEN 'deposit' THEN jsonb_build_array(
           public.ash_company_line(v_cash, 'company_cash', NEW.currency, 'D', NEW.amount_minor, 'deposit_received'),
           public.ash_company_line(v_equity, 'company_equity', NEW.currency, 'C', NEW.amount_minor, 'deposit_source'))
         ELSE jsonb_build_array(
           public.ash_company_line(v_equity, 'company_equity', NEW.currency, 'D', NEW.amount_minor, 'withdrawal_destination'),
           public.ash_company_line(v_cash, 'company_cash', NEW.currency, 'C', NEW.amount_minor, 'withdrawal_paid'))
       END)
  THEN
    RAISE EXCEPTION 'company move amount/currency/account differs from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'company_moves_lines_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER company_moves_insert_guard
  BEFORE INSERT ON company_moves
  FOR EACH ROW EXECUTE FUNCTION guard_company_move_insert();


CREATE FUNCTION guard_company_expense_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor       uuid := public.ash_current_actor();
  v_centre      text;
  v_source_code text;
  v_source_type text;
BEGIN
  IF v_actor IS NULL
     OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN
    RAISE EXCEPTION 'company expense requires its attributed company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'company_expenses_actor_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.expense_categories ec WHERE ec.id = NEW.category_id AND ec.active
  ) THEN
    RAISE EXCEPTION 'company expense names an unknown or inactive category'
      USING ERRCODE = '23514', CONSTRAINT = 'company_expenses_category_guard';
  END IF;

  IF NEW.cost_center_kind = 'asset' THEN
    RAISE EXCEPTION 'the fixed-asset register is not available yet; file the expense under general or a vehicle'
      USING ERRCODE = '23514', CONSTRAINT = 'company_expenses_asset_guard';
  END IF;

  -- A vehicle of ANY operating branch: the company pays for the whole fleet. Never the company row
  -- itself, which owns no vehicles (0066 refuses one there).
  IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.vehicles v WHERE v.id = NEW.vehicle_id
  ) THEN
    RAISE EXCEPTION 'company expense names an unknown vehicle'
      USING ERRCODE = '23514', CONSTRAINT = 'company_expenses_vehicle_guard';
  END IF;

  IF NOT public.ash_company_entry_is(
       NEW.journal_entry_id, NEW.branch_id, 'company_expense', NEW.id::text, NEW.business_date,
       NEW.description, NEW.created_by, NEW.syp_minor_per_usd)
  THEN
    RAISE EXCEPTION 'company expense identity differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'company_expenses_journal_guard';
  END IF;

  v_centre := 'company_expense:' || NEW.currency || ':' || CASE NEW.cost_center_kind
    WHEN 'vehicle' THEN 'vehicle:' || NEW.vehicle_id::text
    WHEN 'asset' THEN 'asset:' || NEW.asset_id::text
    ELSE 'general'
  END;
  v_source_type := CASE NEW.paid_from
    WHEN 'pocket' THEN 'company_cash'
    WHEN 'reserve' THEN 'depreciation_reserve'
    ELSE 'company_equity'
  END;
  v_source_code := v_source_type || ':' || NEW.currency
    || CASE NEW.paid_from WHEN 'owner_outside' THEN ':owner_funding' ELSE '' END;

  IF NOT public.ash_company_lines_match(
       NEW.journal_entry_id, NEW.branch_id,
       jsonb_build_array(
         public.ash_company_line(v_centre, 'company_expense', NEW.currency, 'D', NEW.amount_minor, 'expense_cost'),
         public.ash_company_line(v_source_code, v_source_type, NEW.currency, 'C', NEW.amount_minor, 'expense_paid')))
  THEN
    RAISE EXCEPTION 'company expense amount/currency/centre/source differs from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'company_expenses_lines_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER company_expenses_insert_guard
  BEFORE INSERT ON company_expenses
  FOR EACH ROW EXECUTE FUNCTION guard_company_expense_insert();


CREATE FUNCTION guard_company_income_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor uuid := public.ash_current_actor();
BEGIN
  IF v_actor IS NULL
     OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN
    RAISE EXCEPTION 'company income requires its attributed company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'company_incomes_actor_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.income_categories ic WHERE ic.id = NEW.category_id AND ic.active
  ) THEN
    RAISE EXCEPTION 'company income names an unknown or inactive category'
      USING ERRCODE = '23514', CONSTRAINT = 'company_incomes_category_guard';
  END IF;

  IF NOT public.ash_company_entry_is(
       NEW.journal_entry_id, NEW.branch_id, 'company_income', NEW.id::text, NEW.business_date,
       NEW.description, NEW.created_by, NEW.syp_minor_per_usd)
  THEN
    RAISE EXCEPTION 'company income identity differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'company_incomes_journal_guard';
  END IF;

  IF NOT public.ash_company_lines_match(
       NEW.journal_entry_id, NEW.branch_id,
       jsonb_build_array(
         public.ash_company_line('company_cash:' || NEW.currency, 'company_cash', NEW.currency, 'D', NEW.amount_minor, 'income_received'),
         public.ash_company_line('company_income:' || NEW.currency || ':general', 'company_income', NEW.currency, 'C', NEW.amount_minor, 'income_earned')))
  THEN
    RAISE EXCEPTION 'company income amount/currency differs from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'company_incomes_lines_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER company_incomes_insert_guard
  BEFORE INSERT ON company_incomes
  FOR EACH ROW EXECUTE FUNCTION guard_company_income_insert();


CREATE FUNCTION guard_company_fx_exchange_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor uuid := public.ash_current_actor();
BEGIN
  IF v_actor IS NULL
     OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN
    RAISE EXCEPTION 'company exchange requires its attributed company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'company_fx_exchanges_actor_guard';
  END IF;

  -- The rate on the entry is the rate on the row, which the CHECK above derived from the amounts.
  IF NOT public.ash_company_entry_is(
       NEW.journal_entry_id, NEW.branch_id, 'company_fx_exchange', NEW.id::text, NEW.business_date,
       NEW.reason, NEW.created_by, NEW.syp_minor_per_usd)
  THEN
    RAISE EXCEPTION 'company exchange identity or frozen rate differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'company_fx_exchanges_journal_guard';
  END IF;

  IF NOT public.ash_company_lines_match(
       NEW.journal_entry_id, NEW.branch_id,
       jsonb_build_array(
         public.ash_company_line('company_fx_position:' || NEW.from_currency, 'company_fx_position', NEW.from_currency, 'D', NEW.from_amount_minor, 'fx_sold'),
         public.ash_company_line('company_cash:' || NEW.from_currency, 'company_cash', NEW.from_currency, 'C', NEW.from_amount_minor, 'fx_paid'),
         public.ash_company_line('company_cash:' || NEW.to_currency, 'company_cash', NEW.to_currency, 'D', NEW.to_amount_minor, 'fx_received'),
         public.ash_company_line('company_fx_position:' || NEW.to_currency, 'company_fx_position', NEW.to_currency, 'C', NEW.to_amount_minor, 'fx_bought')))
  THEN
    RAISE EXCEPTION 'company exchange amounts/currencies differ from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'company_fx_exchanges_lines_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER company_fx_exchanges_insert_guard
  BEFORE INSERT ON company_fx_exchanges
  FOR EACH ROW EXECUTE FUNCTION guard_company_fx_exchange_insert();


CREATE FUNCTION guard_company_reversal_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor        uuid := public.ash_current_actor();
  v_found        boolean;
  v_target_event text;
  v_target_rate  bigint;
  v_target_branch uuid;
  v_expected     jsonb;
BEGIN
  IF v_actor IS NULL
     OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN
    RAISE EXCEPTION 'company reversal requires its attributed company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'company_reversals_actor_guard';
  END IF;

  -- The target is a command of the named kind, in this ledger, whose journal is the named entry.
  v_found := CASE NEW.target_kind
    WHEN 'move' THEN EXISTS (
      SELECT 1 FROM public.company_moves t
       WHERE t.id = NEW.target_id AND t.journal_entry_id = NEW.target_entry_id AND t.branch_id = NEW.branch_id)
    WHEN 'expense' THEN EXISTS (
      SELECT 1 FROM public.company_expenses t
       WHERE t.id = NEW.target_id AND t.journal_entry_id = NEW.target_entry_id AND t.branch_id = NEW.branch_id)
    WHEN 'income' THEN EXISTS (
      SELECT 1 FROM public.company_incomes t
       WHERE t.id = NEW.target_id AND t.journal_entry_id = NEW.target_entry_id AND t.branch_id = NEW.branch_id)
    WHEN 'exchange' THEN EXISTS (
      SELECT 1 FROM public.company_fx_exchanges t
       WHERE t.id = NEW.target_id AND t.journal_entry_id = NEW.target_entry_id AND t.branch_id = NEW.branch_id)
    ELSE false
  END;

  SELECT je.event_type::text, je.syp_minor_per_usd, je.branch_id
    INTO v_target_event, v_target_rate, v_target_branch
    FROM public.journal_entries je
   WHERE je.id = NEW.target_entry_id;

  IF NOT COALESCE(v_found, false)
     OR v_target_branch IS DISTINCT FROM NEW.branch_id
     OR v_target_event IS NULL
     OR NOT (CASE NEW.target_kind
       WHEN 'move' THEN v_target_event IN ('company_deposit', 'company_withdrawal')
       WHEN 'expense' THEN v_target_event = 'company_expense'
       WHEN 'income' THEN v_target_event = 'company_income'
       WHEN 'exchange' THEN v_target_event = 'company_fx_exchange'
       ELSE false
     END)
  THEN
    RAISE EXCEPTION 'company reversal must name a reversible command of its own kind and ledger'
      USING ERRCODE = '23514', CONSTRAINT = 'company_reversals_target_guard';
  END IF;

  IF NEW.syp_minor_per_usd IS DISTINCT FROM v_target_rate
     OR NOT public.ash_company_entry_is(
       NEW.journal_entry_id, NEW.branch_id, 'company_correction', NEW.id::text, NEW.business_date,
       NEW.reason, NEW.created_by, v_target_rate)
  THEN
    RAISE EXCEPTION 'company reversal identity or frozen rate differs from its journal and target'
      USING ERRCODE = '23514', CONSTRAINT = 'company_reversals_journal_guard';
  END IF;

  -- Line for line: the target's own lines, every side flipped, fund, amount and role kept.
  SELECT COALESCE(jsonb_agg(public.ash_company_line(
           f.code, f.type::text, f.currency,
           CASE jl.side WHEN 'D' THEN 'C' ELSE 'D' END,
           jl.amount_minor, jl.line_role)), '[]'::jsonb)
    INTO v_expected
    FROM public.journal_lines jl
    JOIN public.funds f ON f.id = jl.fund_id
   WHERE jl.entry_id = NEW.target_entry_id;

  IF jsonb_array_length(v_expected) = 0
     OR NOT public.ash_company_lines_match(NEW.journal_entry_id, NEW.branch_id, v_expected)
  THEN
    RAISE EXCEPTION 'company reversal is not the exact inverse of its target'
      USING ERRCODE = '23514', CONSTRAINT = 'company_reversals_lines_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER company_reversals_insert_guard
  BEFORE INSERT ON company_reversals
  FOR EACH ROW EXECUTE FUNCTION guard_company_reversal_insert();


-- The cutover. Under the branch lock and then the company lock — the one order every two-ledger
-- transaction takes them in — the opening amount must be the branch's company_box balance, every
-- company_box line must sit at or below the watermark, and a positive opening must be exactly the
-- one transfer entry.
CREATE FUNCTION guard_company_cutover_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor    uuid := public.ash_current_actor();
  v_box      numeric;
  v_clearing numeric;
  v_clearing_code text := 'branch_clearing:' || NEW.branch_id::text;
BEGIN
  IF v_actor IS NULL
     OR NEW.performed_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
     OR NOT public.ash_actor_holds_all(v_actor, 'settings.write')
  THEN
    RAISE EXCEPTION 'cutover requires its attributed company-fund manager holding settings.write'
      USING ERRCODE = '23514', CONSTRAINT = 'company_cutovers_actor_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.branches b WHERE b.id = NEW.company_branch_id AND b.kind = 'company'
  ) THEN
    RAISE EXCEPTION 'cutover must move money into the company row'
      USING ERRCODE = '23514', CONSTRAINT = 'company_cutovers_company_guard';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ash:financial:receivables:' || NEW.branch_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ash:financial:receivables:' || NEW.company_branch_id::text, 0));

  v_box := public.ash_fund_balance(NEW.branch_id, 'company_box');
  IF NEW.opening_amount_minor::numeric <> v_box THEN
    RAISE EXCEPTION 'cutover opening % differs from the branch company_box balance %', NEW.opening_amount_minor, v_box
      USING ERRCODE = '23514', CONSTRAINT = 'company_cutovers_opening_guard';
  END IF;

  IF NEW.watermark_entry_id > (SELECT COALESCE(max(je.id), 0) FROM public.journal_entries je)
     OR EXISTS (
       SELECT 1
         FROM public.journal_lines jl
         JOIN public.funds f ON f.id = jl.fund_id
        WHERE f.branch_id = NEW.branch_id
          AND f.type::text = 'company_box'
          AND jl.entry_id > NEW.watermark_entry_id
     )
  THEN
    RAISE EXCEPTION 'cutover watermark % does not cover the branch company_box history', NEW.watermark_entry_id
      USING ERRCODE = '23514', CONSTRAINT = 'company_cutovers_watermark_guard';
  END IF;

  IF NEW.opening_amount_minor > 0 AND (
       NEW.opening_entry_id <= NEW.watermark_entry_id
       OR NOT public.ash_company_entry_is(
         NEW.opening_entry_id, NEW.company_branch_id, 'company_opening_transfer',
         'opening:' || NEW.branch_id::text, NEW.business_date, NEW.reason, NEW.performed_by, NULL)
       OR NOT public.ash_company_lines_match(
         NEW.opening_entry_id, NEW.company_branch_id,
         jsonb_build_array(
           public.ash_company_line('company_cash:SYP_NEW', 'company_cash', 'SYP_NEW', 'D', NEW.opening_amount_minor, 'opening_transfer'),
           public.ash_company_line(v_clearing_code, 'branch_clearing', 'SYP_NEW', 'C', NEW.opening_amount_minor, 'opening_transfer')))
     )
  THEN
    RAISE EXCEPTION 'cutover opening transfer differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'company_cutovers_journal_guard';
  END IF;

  -- Nothing may have moved the clearing account before this, apart from the transfer itself.
  v_clearing := public.ash_fund_balance(NEW.company_branch_id, v_clearing_code);
  IF v_clearing <> -NEW.opening_amount_minor::numeric THEN
    RAISE EXCEPTION 'cutover finds branch clearing % where it expects %', v_clearing, -NEW.opening_amount_minor
      USING ERRCODE = '23514', CONSTRAINT = 'company_cutovers_clearing_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER company_ledger_cutovers_insert_guard
  BEFORE INSERT ON company_ledger_cutovers
  FOR EACH ROW EXECUTE FUNCTION guard_company_cutover_insert();


-- The mirror. Its authority is INHERITED from the audited branch posting it mirrors: the actor must
-- be that entry's author, and unless he manages the company fund, the entry must be a ترميم run he
-- was allowed to perform — a branch manager's restoration writes its mirror through this recipe and
-- no other.
CREATE FUNCTION guard_company_mirror_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor       uuid := public.ash_current_actor();
  v_source      public.journal_entries%ROWTYPE;
  v_cutover     public.company_ledger_cutovers%ROWTYPE;
  v_box_lines   integer;
  v_box_side    text;
  v_box_amount  bigint;
  v_manager     boolean;
  v_clearing    text := 'branch_clearing:' || NEW.source_branch_id::text;
  v_role        text;
BEGIN
  SELECT * INTO v_source FROM public.journal_entries je WHERE je.id = NEW.source_entry_id;
  SELECT * INTO v_cutover FROM public.company_ledger_cutovers c WHERE c.branch_id = NEW.source_branch_id;

  IF v_source.id IS NULL
     OR v_source.branch_id IS DISTINCT FROM NEW.source_branch_id
     OR v_cutover.branch_id IS NULL
     OR NEW.source_entry_id <= v_cutover.watermark_entry_id
     OR NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = NEW.source_branch_id AND b.kind = 'branch')
  THEN
    RAISE EXCEPTION 'a mirror needs a branch entry posted after that branch''s cutover'
      USING ERRCODE = '23514', CONSTRAINT = 'company_mirrors_source_guard';
  END IF;

  IF v_actor IS NULL
     OR NEW.created_by IS DISTINCT FROM v_actor
     OR v_source.created_by IS DISTINCT FROM v_actor
     OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_actor AND u.active)
  THEN
    RAISE EXCEPTION 'a mirror is written by the author of the entry it mirrors'
      USING ERRCODE = '23514', CONSTRAINT = 'company_mirrors_actor_guard';
  END IF;

  v_manager := public.ash_actor_holds_all(v_actor, 'company_fund.manage');
  IF NOT v_manager AND NOT (
    v_source.event_type::text = 'restoration'
    AND NEW.restoration_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.users u
        JOIN public.role_permissions rp
          ON rp.role_key = u.role_key
         AND rp.permission_key = 'journal.manual.write'
       WHERE u.id = v_actor
         AND u.active
         AND (rp.scope = 'all' OR (rp.scope = 'branch' AND u.branch_id = NEW.source_branch_id))
    )
  ) THEN
    RAISE EXCEPTION 'only a company-fund manager, or the manager running this branch''s ترميم, may mirror company_box'
      USING ERRCODE = '23514', CONSTRAINT = 'company_mirrors_actor_guard';
  END IF;

  -- A ترميم journal is mirrored WITH its run, and only a ترميم journal is.
  IF (v_source.event_type::text = 'restoration') IS DISTINCT FROM (NEW.restoration_id IS NOT NULL)
     OR (NEW.restoration_id IS NOT NULL AND NOT EXISTS (
       SELECT 1
         FROM public.restorations r
        WHERE r.id = NEW.restoration_id
          AND r.branch_id = NEW.source_branch_id
          AND r.business_date = v_source.business_date
          AND jsonb_typeof(r.plan->'restorationJournalEntryIds') = 'array'
          AND (r.plan->'restorationJournalEntryIds') @> to_jsonb(NEW.source_entry_id)
     ))
  THEN
    RAISE EXCEPTION 'a restoration journal is mirrored with its own restoration run, and nothing else is'
      USING ERRCODE = '23514', CONSTRAINT = 'company_mirrors_restoration_guard';
  END IF;

  -- Exactly one company_box line gives the direction and the amount.
  SELECT count(*), min(jl.side::text), min(jl.amount_minor)
    INTO v_box_lines, v_box_side, v_box_amount
    FROM public.journal_lines jl
    JOIN public.funds f ON f.id = jl.fund_id
   WHERE jl.entry_id = NEW.source_entry_id
     AND f.branch_id = NEW.source_branch_id
     AND f.code = 'company_box'
     AND f.type::text = 'company_box';

  IF v_box_lines <> 1
     OR EXISTS (
       SELECT 1
         FROM public.journal_lines jl
         JOIN public.funds f ON f.id = jl.fund_id
        WHERE jl.entry_id = NEW.source_entry_id
          AND f.type::text = 'company_box'
          AND (f.branch_id <> NEW.source_branch_id OR f.code <> 'company_box')
     )
     OR NEW.amount_minor IS DISTINCT FROM v_box_amount
     OR NEW.direction IS DISTINCT FROM (CASE v_box_side WHEN 'D' THEN 'to_company' ELSE 'from_company' END)
  THEN
    RAISE EXCEPTION 'a mirror must follow the one company_box line of its source'
      USING ERRCODE = '23514', CONSTRAINT = 'company_mirrors_source_line_guard';
  END IF;

  -- The HQ half: same day, same week, same words, same author, the fixed key.
  IF NOT EXISTS (
    SELECT 1
      FROM public.journal_entries je
     WHERE je.id = NEW.mirror_entry_id
       AND je.branch_id = v_cutover.company_branch_id
       AND je.event_type::text = 'company_restoration_mirror'
       AND je.shift_id IS NULL
       AND je.occurrence_key = 'mirror:' || NEW.source_entry_id::text
       AND je.business_date = v_source.business_date
       AND je.posting_date = v_source.posting_date
       AND je.week_start_date = v_source.week_start_date
       AND je.reason IS NOT DISTINCT FROM v_source.reason
       AND je.created_by = v_source.created_by
       AND je.syp_minor_per_usd IS NULL
  ) THEN
    RAISE EXCEPTION 'a mirror entry must copy its source''s identity into the company ledger'
      USING ERRCODE = '23514', CONSTRAINT = 'company_mirrors_journal_guard';
  END IF;

  v_role := CASE NEW.direction WHEN 'to_company' THEN 'kaish_mirror' ELSE 'shahn_mirror' END;
  IF NOT public.ash_company_lines_match(
       NEW.mirror_entry_id, v_cutover.company_branch_id,
       CASE NEW.direction
         WHEN 'to_company' THEN jsonb_build_array(
           public.ash_company_line('company_cash:SYP_NEW', 'company_cash', 'SYP_NEW', 'D', NEW.amount_minor, v_role),
           public.ash_company_line(v_clearing, 'branch_clearing', 'SYP_NEW', 'C', NEW.amount_minor, v_role))
         ELSE jsonb_build_array(
           public.ash_company_line(v_clearing, 'branch_clearing', 'SYP_NEW', 'D', NEW.amount_minor, v_role),
           public.ash_company_line('company_cash:SYP_NEW', 'company_cash', 'SYP_NEW', 'C', NEW.amount_minor, v_role))
       END)
  THEN
    RAISE EXCEPTION 'a mirror entry must move the company SYP pocket and the branch clearing account, nothing else'
      USING ERRCODE = '23514', CONSTRAINT = 'company_mirrors_lines_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER company_restoration_mirrors_insert_guard
  BEFORE INSERT ON company_restoration_mirrors
  FOR EACH ROW EXECUTE FUNCTION guard_company_mirror_insert();


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Deferred invariants — checked at COMMIT
-- ═════════════════════════════════════════════════════════════════════════════════════════════

-- (1) Every company journal entry has its command row. The FinancialUnitOfWork writes the journal
--     first and the row second; this makes an orphan journal impossible to commit. The debt, asset
--     and depreciation events have no command table yet (C3–C5), so nothing may post them.
CREATE FUNCTION assert_company_journal_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NOT public.ash_is_company_event(NEW.event_type::text) THEN
    RETURN NULL;
  END IF;

  v_ok := NEW.shift_id IS NULL AND CASE NEW.event_type::text
    WHEN 'company_deposit' THEN EXISTS (
      SELECT 1 FROM public.company_moves m WHERE m.journal_entry_id = NEW.id AND m.kind = 'deposit')
    WHEN 'company_withdrawal' THEN EXISTS (
      SELECT 1 FROM public.company_moves m WHERE m.journal_entry_id = NEW.id AND m.kind = 'withdrawal')
    WHEN 'company_expense' THEN EXISTS (
      SELECT 1 FROM public.company_expenses e WHERE e.journal_entry_id = NEW.id)
    WHEN 'company_income' THEN EXISTS (
      SELECT 1 FROM public.company_incomes i WHERE i.journal_entry_id = NEW.id)
    WHEN 'company_fx_exchange' THEN EXISTS (
      SELECT 1 FROM public.company_fx_exchanges x WHERE x.journal_entry_id = NEW.id)
    WHEN 'company_correction' THEN EXISTS (
      SELECT 1 FROM public.company_reversals r WHERE r.journal_entry_id = NEW.id)
    WHEN 'company_opening_transfer' THEN EXISTS (
      SELECT 1 FROM public.company_ledger_cutovers c WHERE c.opening_entry_id = NEW.id)
    WHEN 'company_restoration_mirror' THEN EXISTS (
      SELECT 1 FROM public.company_restoration_mirrors m WHERE m.mirror_entry_id = NEW.id)
    ELSE false
  END;

  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'company journal entry % (%) requires its immutable command row in the same transaction',
      NEW.id, NEW.event_type
      USING ERRCODE = '23514', CONSTRAINT = 'company_journal_fact_guard';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journal_entries_company_fact
  AFTER INSERT OR UPDATE OF event_type, branch_id, shift_id ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (ash_is_company_event(NEW.event_type::text))
  EXECUTE FUNCTION assert_company_journal_fact();

-- (2) The mirror invariant, on every line that moves a branch company_box or a company clearing
--     account:
--       • before a branch's cutover, company_box is the branch's own business and the clearing
--         account for it may not move at all;
--       • after it, every company_box line past the watermark has its mirror row, and
--         balance(company_box) + balance(branch_clearing) = 0.
CREATE FUNCTION assert_company_box_mirrored() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_type        text;
  v_fund_branch uuid;
  v_code        text;
  v_branch      uuid;
  v_cutover     public.company_ledger_cutovers%ROWTYPE;
BEGIN
  SELECT f.type::text, f.branch_id, f.code
    INTO v_type, v_fund_branch, v_code
    FROM public.funds f
   WHERE f.id = NEW.fund_id;

  IF v_type = 'company_box' THEN
    v_branch := v_fund_branch;
  ELSIF v_type = 'branch_clearing' THEN
    IF v_code !~ '^branch_clearing:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'clearing account % does not name a branch', v_code
        USING ERRCODE = '23514', CONSTRAINT = 'company_clearing_invariant_guard';
    END IF;
    v_branch := substr(v_code, 17)::uuid;
  ELSE
    RETURN NULL;
  END IF;

  SELECT * INTO v_cutover FROM public.company_ledger_cutovers c WHERE c.branch_id = v_branch;
  IF v_cutover.branch_id IS NULL THEN
    IF v_type = 'branch_clearing' THEN
      RAISE EXCEPTION 'clearing account % moved for a branch that has no cutover', v_code
        USING ERRCODE = '23514', CONSTRAINT = 'company_clearing_invariant_guard';
    END IF;
    RETURN NULL;
  END IF;

  IF v_type = 'branch_clearing' AND v_fund_branch IS DISTINCT FROM v_cutover.company_branch_id THEN
    RAISE EXCEPTION 'clearing account % lives outside the company row of its cutover', v_code
      USING ERRCODE = '23514', CONSTRAINT = 'company_clearing_invariant_guard';
  END IF;

  IF v_type = 'company_box'
     AND NEW.entry_id > v_cutover.watermark_entry_id
     AND NOT EXISTS (
       SELECT 1 FROM public.company_restoration_mirrors m WHERE m.source_entry_id = NEW.entry_id
     )
  THEN
    RAISE EXCEPTION 'entry % moved company_box of branch % after its cutover without a company mirror',
      NEW.entry_id, v_branch
      USING ERRCODE = '23514', CONSTRAINT = 'company_box_mirror_guard';
  END IF;

  IF public.ash_fund_balance(v_branch, 'company_box')
     + public.ash_fund_balance(v_cutover.company_branch_id, 'branch_clearing:' || v_branch::text) <> 0
  THEN
    RAISE EXCEPTION 'branch % company_box and the company clearing account no longer cancel', v_branch
      USING ERRCODE = '23514', CONSTRAINT = 'company_clearing_invariant_guard';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journal_lines_company_box_mirrored
  AFTER INSERT OR UPDATE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_company_box_mirrored();

-- (3) The same invariant when a cutover row lands with nothing to transfer, and whenever a mirror
--     row lands: its source must still balance at COMMIT.
CREATE FUNCTION assert_company_cutover_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_branch  uuid;
  v_company uuid;
BEGIN
  IF TG_TABLE_NAME = 'company_ledger_cutovers' THEN
    v_branch := NEW.branch_id;
    v_company := NEW.company_branch_id;
  ELSE
    v_branch := NEW.source_branch_id;
    SELECT c.company_branch_id INTO v_company FROM public.company_ledger_cutovers c WHERE c.branch_id = v_branch;
  END IF;

  IF public.ash_fund_balance(v_branch, 'company_box')
     + public.ash_fund_balance(v_company, 'branch_clearing:' || v_branch::text) <> 0
  THEN
    RAISE EXCEPTION 'branch % company_box and the company clearing account do not cancel', v_branch
      USING ERRCODE = '23514', CONSTRAINT = 'company_clearing_invariant_guard';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER company_ledger_cutovers_balanced
  AFTER INSERT ON company_ledger_cutovers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_company_cutover_balanced();

CREATE CONSTRAINT TRIGGER company_restoration_mirrors_balanced
  AFTER INSERT ON company_restoration_mirrors
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_company_cutover_balanced();


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 5. The proof: nothing already stored violates the new rules
-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- No company command existed before this file, so any company entry already stored is an orphan
-- that the deferred fact trigger would have refused. There should be none (0066 is not yet applied
-- in production either); refuse to proceed if there are.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM journal_entries je WHERE ash_is_company_event(je.event_type::text)
  ) THEN
    RAISE EXCEPTION '0067 proof failed — company journal entries exist without command rows';
  END IF;
  IF EXISTS (SELECT 1 FROM funds f WHERE f.type::text = 'branch_clearing') THEN
    RAISE EXCEPTION '0067 proof failed — a branch clearing account exists before any cutover';
  END IF;
END
$$;

COMMENT ON TABLE company_moves IS
  '«صندوق الشركة» owner deposits (owner_funding / opening) and withdrawals (owner_drawings). One row per '
  'company_deposit / company_withdrawal entry; id = client key = occurrence key.';
COMMENT ON TABLE company_fx_exchanges IS
  '«تصريف عملة»: both actual amounts; syp_minor_per_usd is round_half_up(lira_minor × 100 / cents), frozen '
  'here and on the entry.';
COMMENT ON TABLE company_reversals IS
  '«عكس»: a company_correction that is the exact inverse of one move, expense, income or exchange, at the '
  'target''s frozen rate. Once per target.';
COMMENT ON TABLE company_ledger_cutovers IS
  'The day a branch''s company_box moved as-is into the company SYP pocket. After it, every company_box line '
  'past watermark_entry_id has a company_restoration_mirrors row and company_box + branch_clearing = 0.';
COMMENT ON TABLE company_restoration_mirrors IS
  'The HQ half (company_restoration_mirror, key mirror:<source>) of a branch entry that moved company_box '
  'after cutover. Written in the same transaction by the author of the source entry.';
