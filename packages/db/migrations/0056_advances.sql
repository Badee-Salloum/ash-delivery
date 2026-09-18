-- 0056 - «السلفة»: an expense that was paid but must come back in full (owner decision 17)
--
-- The owner's words: «اضف شي خليط بين الصرفية و الذمة — هوي صرفية دفعت لكنها يجب ان ترد كاملة».
-- Money leaves the box the way a صرفية does — a named person, a category, a receipt — but unlike a
-- صرفية it is NOT consumed. It stays company property until it is handed back, so it stays counted
-- as office capital (0057 teaches الترميم that) and only an audited conversion ever spends it.
--
-- MODELLED ON receivable_events (0037), NOT ON expenses (0004), for the reason 0047 records:
-- `expenses.journal_entry_id` is nullable, which forces a runtime `assertCompleteExpense` guard
-- against a row that should never have been storable. Here both journal columns are NOT NULL and
-- UNIQUE, so a سلفة without its journal cannot exist.
--
-- WHY THE FUND IS PER ADVANCE, NOT PER PARTY. The party is free text — a driver, a workshop, a
-- landlord — so it has no uuid, and «أبو محمد» / «ابو محمد» would otherwise be two funds. Keying
-- the fund to the advance also buys back 0037's proven over-collection guard: it refuses to drive a
-- NAMED asset below zero, and a single pooled fund would hide over-repaying one advance behind
-- another still outstanding, because the pool would never go negative.
--
-- je_reason_ck IS DELIBERATELY NOT WIDENED. Adding three event types to it would rescan the whole
-- of `journal_entries` under ACCESS EXCLUSIVE on a live financial table, and buy nothing: the
-- guards below require the journal's reason to equal a NOT NULL column on the command row, so a
-- NULL reason already cannot commit.

CREATE TABLE advances (
  -- The client-owned UUID is the identity, the idempotency key, AND the journal occurrence key —
  -- one durable retry key, exactly as for expenses and incomes.
  id                uuid PRIMARY KEY,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  -- Free text by the owner's own choice: whoever the manager wrote on the line. `party_key` is a
  -- normalisation used ONLY for search and grouping in the UI. NO MONEY DEPENDS ON IT — every
  -- balance is per advance, so two spellings of one name can never merge or split a figure.
  party_name        text NOT NULL
                      CHECK (ash_has_visible_text(party_name) AND char_length(party_name) <= 120),
  party_key         text NOT NULL CHECK (char_length(party_key) <= 120),
  -- A سلفة carries the same classification a صرفية does, because it becomes one if it is never
  -- repaid, and the conversion must be able to file it without asking anyone again.
  category_id       uuid NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  cost_center_kind  text NOT NULL CHECK (cost_center_kind IN ('vehicle', 'branch', 'general')),
  vehicle_id        uuid REFERENCES vehicles(id) ON DELETE RESTRICT,
  -- The operator states only WHICH BOX paid — a physical fact he knows. He never names a ledger
  -- fund, so `fundRefFromCode`'s cost-centre default cannot mint a look-alike account.
  channel           text NOT NULL CHECK (channel IN ('office_cash', 'office_wallet')),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  business_date     date NOT NULL,
  description       text NOT NULL
                      CHECK (ash_has_visible_text(description) AND char_length(description) <= 500),
  receipt_media_id  uuid REFERENCES media(id),
  journal_entry_id  bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT advances_vehicle_ck CHECK ((cost_center_kind = 'vehicle') = (vehicle_id IS NOT NULL))
);
CREATE INDEX advances_branch_date_idx ON advances (branch_id, business_date, created_at);
CREATE INDEX advances_party_idx       ON advances (branch_id, party_key);

-- Every later fact about one advance: money coming back, or the company giving up on it.
CREATE TABLE advance_events (
  id                uuid PRIMARY KEY,
  advance_id        uuid NOT NULL REFERENCES advances(id) ON DELETE RESTRICT,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  kind              text NOT NULL CHECK (kind IN ('repayment', 'conversion')),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  business_date     date NOT NULL,
  reason            text NOT NULL
                      CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500),
  -- A conversion IS an ordinary صرفية from that moment on, and it writes a real `expenses` row so
  -- every existing expense report picks it up. SRS G — «كل ليرة تخرج: مصنَّفة وموثَّقة ومنسوبة
  -- لمركز كلفتها» — is honoured at the moment the lira is finally recognised as spent.
  expense_id        uuid REFERENCES expenses(id) ON DELETE RESTRICT,
  journal_entry_id  bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT advance_events_expense_ck CHECK ((kind = 'conversion') = (expense_id IS NOT NULL))
);
CREATE INDEX advance_events_advance_idx ON advance_events (advance_id, created_at);
CREATE INDEX advance_events_branch_date_idx ON advance_events (branch_id, business_date, created_at);

-- A conversion expense is an expense with NO same-day cash outflow — the money left weeks ago.
-- Naming its origin keeps the row self-describing for anyone reconciling "Σ expenses today against
-- today's office_cash credits", and makes a SECOND conversion of one advance impossible in the
-- schema rather than only in a route check.
ALTER TABLE expenses ADD COLUMN advance_id uuid REFERENCES advances(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX expenses_advance_uq ON expenses (advance_id) WHERE advance_id IS NOT NULL;

-- Defence in depth for non-shift journal commands, mirroring je_receivable_command_uq (0037) and
-- je_income_command_uq (0047). REQUIRED, not decorative: je_idempotency_uq is partial on
-- `shift_id IS NOT NULL`, so a command journal has no uniqueness of its own.
CREATE UNIQUE INDEX je_advance_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'advance';
CREATE UNIQUE INDEX je_advance_repayment_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'advance_repayment';
CREATE UNIQUE INDEX je_advance_conversion_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'advance_conversion';

-- Posted accounting facts. Correct one with a visible dated reversal (E-6), never by editing it.
REVOKE UPDATE, DELETE, TRUNCATE ON advances FROM app_user;
GRANT  SELECT, INSERT ON advances TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON advance_events FROM app_user;
GRANT  SELECT, INSERT ON advance_events TO app_user;

CREATE TRIGGER audit_advances
  AFTER INSERT OR UPDATE OR DELETE ON advances
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_advance_events
  AFTER INSERT OR UPDATE OR DELETE ON advance_events
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();


-- The command row and its journal are one accounting fact. Verify their identity, the attributed
-- manager against the LIVE editable RBAC matrix, and the exact two-line recipe.
CREATE FUNCTION guard_advance_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor          uuid;
  v_advance_code   text;
  v_advance_type   text;
  v_office_code    text;
  v_lines_match    boolean;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  -- Match the API's live, editable RBAC matrix. There is deliberately no compiled-role fallback:
  -- an empty/missing grant fails closed, and revoking a formerly privileged role takes effect on
  -- direct SQL immediately. Paying an advance is `expense.write`, the same key that records the
  -- صرفية it is a variant of.
  IF v_actor IS NULL
     OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT EXISTS (
       SELECT 1
         FROM public.users u
         JOIN public.role_permissions rp
           ON rp.role_key = u.role_key
          AND rp.permission_key = 'expense.write'
        WHERE u.id = v_actor
          AND u.active
          AND (
            rp.scope = 'all'
            OR (rp.scope = 'branch' AND u.branch_id = NEW.branch_id)
          )
     )
  THEN
    RAISE EXCEPTION 'advance requires its attributed active manager'
      USING ERRCODE = '23514', CONSTRAINT = 'advances_actor_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.expense_categories ec WHERE ec.id = NEW.category_id AND ec.active
  ) THEN
    RAISE EXCEPTION 'advance names an unknown or inactive category'
      USING ERRCODE = '23514', CONSTRAINT = 'advances_category_guard';
  END IF;

  -- A vehicle cost centre must name a vehicle of THIS branch, or the cost lands on another
  -- branch's profitability and the conversion would later file it there for good.
  IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.vehicles v WHERE v.id = NEW.vehicle_id AND v.branch_id = NEW.branch_id
  ) THEN
    RAISE EXCEPTION 'advance names a vehicle from another branch'
      USING ERRCODE = '23514', CONSTRAINT = 'advances_vehicle_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.journal_entries je
     WHERE je.id = NEW.journal_entry_id
       AND je.branch_id = NEW.branch_id
       AND je.event_type = 'advance'
       AND je.shift_id IS NULL
       AND je.occurrence_key = NEW.id::text
       AND je.business_date = NEW.business_date
       AND je.posting_date = NEW.business_date
       AND je.week_start_date =
         (NEW.business_date - extract(dow FROM NEW.business_date)::integer)
       AND je.reason IS NOT DISTINCT FROM NEW.description
       AND je.created_by = NEW.created_by
  ) THEN
    RAISE EXCEPTION 'advance identity differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'advances_journal_guard';
  END IF;

  v_advance_type := 'advance_receivable_' || CASE NEW.channel
    WHEN 'office_cash' THEN 'cash' ELSE 'wallet' END;
  v_advance_code := v_advance_type || ':' || NEW.id::text;
  v_office_code  := NEW.channel;

  SELECT COUNT(*) = 2
     AND COUNT(*) FILTER (
       WHERE f.branch_id = NEW.branch_id
         AND f.code = v_advance_code
         AND f.type::text = v_advance_type
         -- The advance asset is branch-owned with its identity in the code — the shape
         -- `cost_center:cash_count_variance:<branch>:<fund>` already uses. `funds_owner_ck`
         -- requires exactly this pairing.
         AND f.owner_kind = 'none'
         AND f.owner_id IS NULL
         AND jl.side = 'D'
         AND jl.amount_minor = NEW.amount_minor
         AND jl.line_role = 'advance_created'
     ) = 1
     AND COUNT(*) FILTER (
       WHERE f.branch_id = NEW.branch_id
         AND f.code = v_office_code
         AND f.type::text = v_office_code
         AND f.owner_kind = 'none'
         AND f.owner_id IS NULL
         AND jl.side = 'C'
         AND jl.amount_minor = NEW.amount_minor
         AND jl.line_role = 'office_value_advanced'
     ) = 1
    INTO v_lines_match
    FROM public.journal_lines jl
    JOIN public.funds f ON f.id = jl.fund_id
   WHERE jl.entry_id = NEW.journal_entry_id;

  IF NOT COALESCE(v_lines_match, false) THEN
    RAISE EXCEPTION 'advance amount/channel differs from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'advances_lines_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER advances_insert_guard
  BEFORE INSERT ON advances
  FOR EACH ROW EXECUTE FUNCTION guard_advance_insert();


-- Money coming back, or the company giving up on it. Same shape as the guard above, plus the
-- over-repayment check transplanted from 0037's over-collection guard.
CREATE FUNCTION guard_advance_event_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor           uuid;
  v_permission      text;
  v_event_type      text;
  v_advance         public.advances%ROWTYPE;
  v_advance_code    text;
  v_advance_type    text;
  v_office_code     text;
  v_counter_code    text;
  v_counter_role    text;
  v_advance_role    text;
  v_advance_fund_id uuid;
  v_lines_match     boolean;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  SELECT * INTO v_advance FROM public.advances a WHERE a.id = NEW.advance_id;
  IF v_advance.id IS NULL OR v_advance.branch_id IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'advance event names an advance from another branch'
      USING ERRCODE = '23514', CONSTRAINT = 'advance_events_advance_guard';
  END IF;

  -- Taking money back is bookkeeping and rides on `expense.write`. Declaring that it will never
  -- come back permanently reduces office capital, so it takes the manual-journal key — the same
  -- one a receivable write-off takes.
  v_permission := CASE NEW.kind WHEN 'conversion' THEN 'journal.manual.write' ELSE 'expense.write' END;
  v_event_type := CASE NEW.kind WHEN 'conversion' THEN 'advance_conversion' ELSE 'advance_repayment' END;

  IF v_actor IS NULL
     OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT EXISTS (
       SELECT 1
         FROM public.users u
         JOIN public.role_permissions rp
           ON rp.role_key = u.role_key
          AND rp.permission_key = v_permission
        WHERE u.id = v_actor
          AND u.active
          AND (
            rp.scope = 'all'
            OR (rp.scope = 'branch' AND u.branch_id = NEW.branch_id)
          )
     )
  THEN
    RAISE EXCEPTION 'advance event requires its attributed active manager'
      USING ERRCODE = '23514', CONSTRAINT = 'advance_events_actor_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.journal_entries je
     WHERE je.id = NEW.journal_entry_id
       AND je.branch_id = NEW.branch_id
       AND je.event_type::text = v_event_type
       AND je.shift_id IS NULL
       AND je.occurrence_key = NEW.id::text
       AND je.business_date = NEW.business_date
       AND je.posting_date = NEW.business_date
       AND je.week_start_date =
         (NEW.business_date - extract(dow FROM NEW.business_date)::integer)
       AND je.reason IS NOT DISTINCT FROM NEW.reason
       AND je.created_by = NEW.created_by
  ) THEN
    RAISE EXCEPTION 'advance event identity differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'advance_events_journal_guard';
  END IF;

  v_advance_type := 'advance_receivable_' || CASE v_advance.channel
    WHEN 'office_cash' THEN 'cash' ELSE 'wallet' END;
  v_advance_code := v_advance_type || ':' || v_advance.id::text;
  v_office_code  := v_advance.channel;

  IF NEW.kind = 'repayment' THEN
    -- IT RETURNS TO THE BOX IT LEFT. الترميم plans each box against its own target, so an advance
    -- repaid into the other box would raise one leg and lower the other at different moments,
    -- letting this advance's own balance go negative in between.
    v_counter_code := v_office_code;
    v_counter_role := 'advance_repaid';
    v_advance_role := 'advance_cleared';
  ELSE
    -- The cost centre is derived exactly as an ordinary expense derives it, never from the
    -- category: the category is a column on `expenses` and has never been an account.
    v_counter_code := 'cost_center:' ||
      COALESCE(v_advance.vehicle_id::text, v_advance.cost_center_kind || ':' || v_advance.branch_id::text);
    v_counter_role := 'advance_converted_cost';
    v_advance_role := 'advance_converted';

    IF NOT EXISTS (
      SELECT 1
        FROM public.expenses e
       WHERE e.id = NEW.expense_id
         AND e.advance_id = NEW.advance_id
         AND e.branch_id = NEW.branch_id
         AND e.amount_minor = NEW.amount_minor
         AND e.journal_entry_id = NEW.journal_entry_id
    ) THEN
      RAISE EXCEPTION 'advance conversion must write the matching ordinary expense row'
        USING ERRCODE = '23514', CONSTRAINT = 'advance_events_expense_guard';
    END IF;
  END IF;

  SELECT COUNT(*) = 2
     AND COUNT(*) FILTER (
       WHERE f.branch_id = NEW.branch_id
         AND f.code = v_advance_code
         AND f.type::text = v_advance_type
         AND f.owner_kind = 'none'
         AND f.owner_id IS NULL
         AND jl.side = 'C'
         AND jl.amount_minor = NEW.amount_minor
         AND jl.line_role = v_advance_role
     ) = 1
     AND COUNT(*) FILTER (
       WHERE f.branch_id = NEW.branch_id
         AND f.code = v_counter_code
         AND jl.side = 'D'
         AND jl.amount_minor = NEW.amount_minor
         AND jl.line_role = v_counter_role
     ) = 1
    INTO v_lines_match
    FROM public.journal_lines jl
    JOIN public.funds f ON f.id = jl.fund_id
   WHERE jl.entry_id = NEW.journal_entry_id;

  IF NOT COALESCE(v_lines_match, false) THEN
    RAISE EXCEPTION 'advance event amount/kind differs from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'advance_events_lines_guard';
  END IF;

  -- Serialize the fresh balance read on the named asset itself. Application advisory locks make
  -- normal requests orderly, but this row lock also closes the two-connection write-skew where
  -- concurrent repayments could each observe enough outstanding balance and jointly go below zero.
  -- The second transaction re-reads after the first commits. Transplanted from 0037.
  SELECT f.id
    INTO v_advance_fund_id
    FROM public.funds f
   WHERE f.branch_id = NEW.branch_id
     AND f.code = v_advance_code
     AND f.type::text = v_advance_type
     AND f.owner_kind = 'none'
     AND f.owner_id IS NULL
   FOR UPDATE;

  IF v_advance_fund_id IS NULL THEN
    RAISE EXCEPTION 'advance event names no matching advance asset'
      USING ERRCODE = '23514', CONSTRAINT = 'advance_events_lines_guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.journal_lines jl
     WHERE jl.fund_id = v_advance_fund_id
    HAVING COALESCE(
      SUM(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END),
      0
    ) >= 0
  ) THEN
    RAISE EXCEPTION 'advance repayment or conversion exceeds the outstanding balance'
      USING ERRCODE = '23514', CONSTRAINT = 'advance_events_overrepayment_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER advance_events_insert_guard
  BEFORE INSERT ON advance_events
  FOR EACH ROW EXECUTE FUNCTION guard_advance_event_insert();


-- The normal FinancialUOW writes the balanced journal first and its immutable command second.
-- Check the inverse at transaction end so that ordering remains valid but an orphan journal can
-- never commit and bypass attribution, over-repayment protection, or idempotent history.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM journal_entries je
      LEFT JOIN advances a        ON a.journal_entry_id  = je.id
      LEFT JOIN advance_events ae ON ae.journal_entry_id = je.id
     WHERE je.event_type::text IN ('advance', 'advance_repayment', 'advance_conversion')
       AND (
         je.shift_id IS NOT NULL
         OR (je.event_type::text = 'advance' AND a.id IS NULL)
         OR (je.event_type::text <> 'advance' AND ae.id IS NULL)
       )
  ) THEN
    RAISE EXCEPTION 'advance journal is missing its immutable command'
      USING ERRCODE = '23514', CONSTRAINT = 'advance_journal_event_guard';
  END IF;
END
$$;

CREATE FUNCTION check_advance_journal_event() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.event_type::text IN ('advance', 'advance_repayment', 'advance_conversion')
     AND (
       NEW.shift_id IS NOT NULL
       OR (
         NEW.event_type::text = 'advance'
         AND NOT EXISTS (SELECT 1 FROM public.advances a WHERE a.journal_entry_id = NEW.id)
       )
       OR (
         NEW.event_type::text <> 'advance'
         AND NOT EXISTS (SELECT 1 FROM public.advance_events ae WHERE ae.journal_entry_id = NEW.id)
       )
     )
  THEN
    RAISE EXCEPTION 'advance journal requires one immutable command in the same transaction'
      USING ERRCODE = '23514', CONSTRAINT = 'advance_journal_event_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER advance_journal_event_from_entry
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_advance_journal_event();

COMMENT ON TABLE advances IS
  '«السلفة» (owner decision 17): money paid out like a صرفية that must come back in full. Counted '
  'as office capital while outstanding, so الترميم does not read the emptier box as a shortfall. '
  'Ends either in repayment or in an audited conversion into an ordinary expense.';
COMMENT ON COLUMN advances.party_key IS
  'Normalised party name for search and grouping in the UI ONLY. No money depends on it: every '
  'balance is per advance, so two spellings can never merge or split a figure.';
