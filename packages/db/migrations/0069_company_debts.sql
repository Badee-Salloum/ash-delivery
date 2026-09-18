-- 0069 — company debts in both directions (finance redesign C3)
--
-- A debt is one named ledger fund, never a pooled party balance. The party remains free text for
-- the owner's workflow; `party_key` is search-only. Opening, every payment and every write-off is
-- an immutable command tied one-to-one to an exact journal. Overpayment is refused under a row
-- lock on that debt fund, closing the two-connection write-skew that a route-only balance check
-- would leave open.

CREATE TABLE company_debts (
  id                    uuid PRIMARY KEY,
  branch_id             uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  direction             text NOT NULL CHECK (direction IN ('payable', 'receivable')),
  party_name            text NOT NULL
                            CHECK (ash_has_visible_text(party_name) AND char_length(party_name) <= 120),
  party_key             text NOT NULL CHECK (char_length(party_key) <= 120),
  currency              text NOT NULL CHECK (currency IN ('SYP_NEW', 'USD')),
  principal_minor       bigint NOT NULL CHECK (principal_minor > 0),
  syp_minor_per_usd     bigint CHECK (syp_minor_per_usd > 0),
  opened_on             date NOT NULL,
  business_date         date NOT NULL,
  due_on                date,
  note                  text CHECK (note IS NULL OR (ash_has_visible_text(note) AND char_length(note) <= 500)),
  origin                text NOT NULL CHECK (origin IN ('cash', 'expense', 'income', 'opening', 'asset_purchase')),
  expense_category_id   uuid REFERENCES expense_categories(id) ON DELETE RESTRICT,
  income_category_id    uuid REFERENCES income_categories(id) ON DELETE RESTRICT,
  cost_center_kind      text CHECK (cost_center_kind IN ('general', 'vehicle')),
  vehicle_id            uuid REFERENCES vehicles(id) ON DELETE RESTRICT,
  -- C4 adds the deferrable FK after `fixed_assets` exists and permits asset_purchase openings.
  asset_id              uuid UNIQUE,
  journal_entry_id      bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_debts_dates_ck CHECK (
    opened_on >= DATE '2000-01-01' AND opened_on <= business_date AND (due_on IS NULL OR due_on >= opened_on)
  ),
  CONSTRAINT company_debts_rate_ck CHECK ((currency = 'USD') = (syp_minor_per_usd IS NOT NULL)),
  CONSTRAINT company_debts_origin_direction_ck CHECK (
    (direction = 'payable' AND origin IN ('cash', 'expense', 'opening', 'asset_purchase'))
    OR (direction = 'receivable' AND origin IN ('cash', 'income', 'opening'))
  ),
  CONSTRAINT company_debts_categories_ck CHECK (
    (origin = 'expense') = (expense_category_id IS NOT NULL)
    AND (origin = 'income') = (income_category_id IS NOT NULL)
  ),
  CONSTRAINT company_debts_cost_centre_ck CHECK (
    (origin = 'expense') = (cost_center_kind IS NOT NULL)
    AND (cost_center_kind = 'vehicle') = (vehicle_id IS NOT NULL)
  ),
  CONSTRAINT company_debts_asset_ck CHECK ((origin = 'asset_purchase') = (asset_id IS NOT NULL))
);
CREATE INDEX company_debts_branch_date_idx ON company_debts (branch_id, business_date, created_at);
CREATE INDEX company_debts_party_idx ON company_debts (branch_id, party_key);
CREATE INDEX company_debts_due_idx ON company_debts (branch_id, due_on) WHERE due_on IS NOT NULL;
CREATE INDEX company_debts_vehicle_idx ON company_debts (vehicle_id) WHERE vehicle_id IS NOT NULL;

CREATE TABLE company_debt_events (
  id                    uuid PRIMARY KEY,
  debt_id               uuid NOT NULL REFERENCES company_debts(id) ON DELETE RESTRICT,
  branch_id             uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  kind                  text NOT NULL CHECK (kind IN ('payment', 'writeoff')),
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  -- Only paying a payable names a source. A receivable collection always enters company_cash;
  -- a write-off moves no cash at all.
  source                text CHECK (source IN ('pocket', 'reserve', 'owner_outside')),
  syp_minor_per_usd     bigint CHECK (syp_minor_per_usd > 0),
  occurred_on           date NOT NULL,
  business_date         date NOT NULL,
  reason                text NOT NULL CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500),
  journal_entry_id      bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_debt_events_dates_ck CHECK (
    occurred_on >= DATE '2000-01-01' AND occurred_on <= business_date
  ),
  CONSTRAINT company_debt_events_rate_ck CHECK ((syp_minor_per_usd IS NULL) OR syp_minor_per_usd > 0)
);
CREATE INDEX company_debt_events_debt_idx ON company_debt_events (debt_id, created_at);
CREATE INDEX company_debt_events_branch_date_idx ON company_debt_events (branch_id, business_date, created_at);

CREATE TRIGGER company_debts_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON company_debts
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER company_debt_events_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON company_debt_events
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');

REVOKE UPDATE, DELETE, TRUNCATE ON company_debts FROM app_user;
GRANT SELECT, INSERT ON company_debts TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON company_debt_events FROM app_user;
GRANT SELECT, INSERT ON company_debt_events TO app_user;

CREATE TRIGGER company_debts_immutable BEFORE UPDATE OR DELETE ON company_debts
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_debt_events_immutable BEFORE UPDATE OR DELETE ON company_debt_events
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER audit_company_debts AFTER INSERT OR UPDATE OR DELETE ON company_debts
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_debt_events AFTER INSERT OR UPDATE OR DELETE ON company_debt_events
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE UNIQUE INDEX je_company_debt_open_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'company_debt_open';
CREATE UNIQUE INDEX je_company_debt_payment_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'company_debt_payment';
CREATE UNIQUE INDEX je_company_debt_writeoff_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'company_debt_writeoff';

CREATE FUNCTION guard_company_debt_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor             uuid := public.ash_current_actor();
  v_counter_code      text;
  v_counter_type      text;
  v_counter_side      text;
  v_debt_code         text;
  v_debt_type         text;
  v_debt_side         text;
  v_centre            text;
BEGIN
  IF v_actor IS NULL
     OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN
    RAISE EXCEPTION 'company debt requires its attributed company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debts_actor_guard';
  END IF;

  IF NEW.origin = 'asset_purchase' THEN
    RAISE EXCEPTION 'asset-purchase debt requires the fixed-asset register from migration 0070'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debts_asset_guard';
  END IF;
  IF NEW.expense_category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.expense_categories c WHERE c.id = NEW.expense_category_id AND c.active
  ) THEN
    RAISE EXCEPTION 'company debt names an unknown or inactive expense category'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debts_category_guard';
  END IF;
  IF NEW.income_category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.income_categories c WHERE c.id = NEW.income_category_id AND c.active
  ) THEN
    RAISE EXCEPTION 'company debt names an unknown or inactive income category'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debts_category_guard';
  END IF;
  IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.vehicles v WHERE v.id = NEW.vehicle_id) THEN
    RAISE EXCEPTION 'company debt names an unknown vehicle'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debts_vehicle_guard';
  END IF;

  IF NOT public.ash_company_entry_is(
       NEW.journal_entry_id, NEW.branch_id, 'company_debt_open', NEW.id::text, NEW.business_date,
       COALESCE(NEW.note, NEW.party_name), NEW.created_by, NEW.syp_minor_per_usd)
  THEN
    RAISE EXCEPTION 'company debt identity differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debts_journal_guard';
  END IF;

  v_debt_type := CASE NEW.direction WHEN 'payable' THEN 'company_payable' ELSE 'company_receivable' END;
  v_debt_code := v_debt_type || ':' || NEW.currency || ':' || NEW.id::text;
  v_debt_side := CASE NEW.direction WHEN 'payable' THEN 'C' ELSE 'D' END;
  v_counter_side := CASE NEW.direction WHEN 'payable' THEN 'D' ELSE 'C' END;

  CASE NEW.origin
    WHEN 'cash' THEN
      v_counter_type := 'company_cash';
      v_counter_code := 'company_cash:' || NEW.currency;
    WHEN 'expense' THEN
      v_counter_type := 'company_expense';
      v_centre := CASE NEW.cost_center_kind WHEN 'vehicle' THEN 'vehicle:' || NEW.vehicle_id::text ELSE 'general' END;
      v_counter_code := 'company_expense:' || NEW.currency || ':' || v_centre;
    WHEN 'income' THEN
      v_counter_type := 'company_income';
      v_counter_code := 'company_income:' || NEW.currency || ':general';
    WHEN 'opening' THEN
      v_counter_type := 'company_equity';
      v_counter_code := 'company_equity:' || NEW.currency || ':opening';
    ELSE
      RAISE EXCEPTION 'unsupported company debt origin %', NEW.origin
        USING ERRCODE = '23514', CONSTRAINT = 'company_debts_origin_guard';
  END CASE;

  IF NOT public.ash_company_lines_match(
       NEW.journal_entry_id, NEW.branch_id,
       jsonb_build_array(
         public.ash_company_line(v_counter_code, v_counter_type, NEW.currency, v_counter_side,
           NEW.principal_minor, 'debt_open_counterpart'),
         public.ash_company_line(v_debt_code, v_debt_type, NEW.currency, v_debt_side,
           NEW.principal_minor, 'debt_open_balance')))
  THEN
    RAISE EXCEPTION 'company debt principal/direction/origin differs from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debts_lines_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER company_debts_insert_guard
  BEFORE INSERT ON company_debts
  FOR EACH ROW EXECUTE FUNCTION guard_company_debt_insert();

CREATE FUNCTION guard_company_debt_event_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor         uuid := public.ash_current_actor();
  v_debt          public.company_debts%ROWTYPE;
  v_event         text;
  v_debt_type     text;
  v_debt_code     text;
  v_source_type   text;
  v_source_code   text;
  v_expected      jsonb;
  v_fund_id       uuid;
  -- `SUM(bigint)` is numeric in PostgreSQL, preserving overflow safety; every stored amount stays bigint.
  v_position      numeric;
BEGIN
  SELECT * INTO v_debt FROM public.company_debts d WHERE d.id = NEW.debt_id;
  IF v_debt.id IS NULL OR v_debt.branch_id IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'company debt event names a debt outside its company ledger'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debt_events_debt_guard';
  END IF;
  IF (v_debt.currency = 'USD') IS DISTINCT FROM (NEW.syp_minor_per_usd IS NOT NULL) THEN
    RAISE EXCEPTION 'company debt event frozen rate does not match its currency'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debt_events_rate_guard';
  END IF;
  IF v_actor IS NULL
     OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN
    RAISE EXCEPTION 'company debt event requires its attributed company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debt_events_actor_guard';
  END IF;

  v_event := CASE NEW.kind WHEN 'payment' THEN 'company_debt_payment' ELSE 'company_debt_writeoff' END;
  IF NOT public.ash_company_entry_is(
       NEW.journal_entry_id, NEW.branch_id, v_event, NEW.id::text, NEW.business_date,
       NEW.reason, NEW.created_by, NEW.syp_minor_per_usd)
  THEN
    RAISE EXCEPTION 'company debt event identity differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debt_events_journal_guard';
  END IF;

  v_debt_type := CASE v_debt.direction WHEN 'payable' THEN 'company_payable' ELSE 'company_receivable' END;
  v_debt_code := v_debt_type || ':' || v_debt.currency || ':' || v_debt.id::text;

  IF NEW.kind = 'payment' AND v_debt.direction = 'payable' THEN
    IF NEW.source IS NULL THEN
      RAISE EXCEPTION 'paying a payable requires its source'
        USING ERRCODE = '23514', CONSTRAINT = 'company_debt_events_source_guard';
    END IF;
    v_source_type := CASE NEW.source
      WHEN 'pocket' THEN 'company_cash'
      WHEN 'reserve' THEN 'depreciation_reserve'
      ELSE 'company_equity'
    END;
    v_source_code := v_source_type || ':' || v_debt.currency
      || CASE NEW.source WHEN 'owner_outside' THEN ':owner_funding' ELSE '' END;
    v_expected := jsonb_build_array(
      public.ash_company_line(v_debt_code, v_debt_type, v_debt.currency, 'D', NEW.amount_minor, 'debt_payment_balance'),
      public.ash_company_line(v_source_code, v_source_type, v_debt.currency, 'C', NEW.amount_minor, 'debt_payment_source'));
  ELSIF NEW.kind = 'payment' THEN
    IF NEW.source IS NOT NULL THEN
      RAISE EXCEPTION 'collecting a receivable always enters the company pocket and has no source selector'
        USING ERRCODE = '23514', CONSTRAINT = 'company_debt_events_source_guard';
    END IF;
    v_expected := jsonb_build_array(
      public.ash_company_line('company_cash:' || v_debt.currency, 'company_cash', v_debt.currency,
        'D', NEW.amount_minor, 'debt_collection_received'),
      public.ash_company_line(v_debt_code, v_debt_type, v_debt.currency,
        'C', NEW.amount_minor, 'debt_collection_balance'));
  ELSIF v_debt.direction = 'payable' THEN
    IF NEW.source IS NOT NULL THEN
      RAISE EXCEPTION 'writing off a debt moves no cash source'
        USING ERRCODE = '23514', CONSTRAINT = 'company_debt_events_source_guard';
    END IF;
    v_expected := jsonb_build_array(
      public.ash_company_line(v_debt_code, v_debt_type, v_debt.currency,
        'D', NEW.amount_minor, 'debt_writeoff_balance'),
      public.ash_company_line('company_income:' || v_debt.currency || ':payable_forgiven', 'company_income',
        v_debt.currency, 'C', NEW.amount_minor, 'debt_writeoff_counterpart'));
  ELSE
    IF NEW.source IS NOT NULL THEN
      RAISE EXCEPTION 'writing off a debt moves no cash source'
        USING ERRCODE = '23514', CONSTRAINT = 'company_debt_events_source_guard';
    END IF;
    v_expected := jsonb_build_array(
      public.ash_company_line('company_expense:' || v_debt.currency || ':receivable_writeoff', 'company_expense',
        v_debt.currency, 'D', NEW.amount_minor, 'debt_writeoff_counterpart'),
      public.ash_company_line(v_debt_code, v_debt_type, v_debt.currency,
        'C', NEW.amount_minor, 'debt_writeoff_balance'));
  END IF;

  IF NOT public.ash_company_lines_match(NEW.journal_entry_id, NEW.branch_id, v_expected) THEN
    RAISE EXCEPTION 'company debt event amount/kind/source differs from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debt_events_lines_guard';
  END IF;

  SELECT f.id INTO v_fund_id
    FROM public.funds f
   WHERE f.branch_id = NEW.branch_id AND f.code = v_debt_code AND f.type::text = v_debt_type
   FOR UPDATE;
  IF v_fund_id IS NULL THEN
    RAISE EXCEPTION 'company debt event names no matching debt fund'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debt_events_balance_guard';
  END IF;
  v_position := public.ash_fund_balance(NEW.branch_id, v_debt_code);
  IF (v_debt.direction = 'payable' AND v_position > 0)
     OR (v_debt.direction = 'receivable' AND v_position < 0)
  THEN
    RAISE EXCEPTION 'company debt payment or write-off exceeds the outstanding balance'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debt_events_overpayment_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER company_debt_events_insert_guard
  BEFORE INSERT ON company_debt_events
  FOR EACH ROW EXECUTE FUNCTION guard_company_debt_event_insert();

-- Extend 0067's closed command-row map. The journal is inserted first and the command second, so
-- this stays deferred; an orphan can never commit.
CREATE OR REPLACE FUNCTION assert_company_journal_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NOT public.ash_is_company_event(NEW.event_type::text) THEN RETURN NULL; END IF;
  v_ok := NEW.shift_id IS NULL AND CASE NEW.event_type::text
    WHEN 'company_deposit' THEN EXISTS (SELECT 1 FROM public.company_moves m WHERE m.journal_entry_id = NEW.id AND m.kind = 'deposit')
    WHEN 'company_withdrawal' THEN EXISTS (SELECT 1 FROM public.company_moves m WHERE m.journal_entry_id = NEW.id AND m.kind = 'withdrawal')
    WHEN 'company_expense' THEN EXISTS (SELECT 1 FROM public.company_expenses e WHERE e.journal_entry_id = NEW.id)
    WHEN 'company_income' THEN EXISTS (SELECT 1 FROM public.company_incomes i WHERE i.journal_entry_id = NEW.id)
    WHEN 'company_fx_exchange' THEN EXISTS (SELECT 1 FROM public.company_fx_exchanges x WHERE x.journal_entry_id = NEW.id)
    WHEN 'company_correction' THEN EXISTS (SELECT 1 FROM public.company_reversals r WHERE r.journal_entry_id = NEW.id)
    WHEN 'company_opening_transfer' THEN EXISTS (SELECT 1 FROM public.company_ledger_cutovers c WHERE c.opening_entry_id = NEW.id)
    WHEN 'company_restoration_mirror' THEN EXISTS (SELECT 1 FROM public.company_restoration_mirrors m WHERE m.mirror_entry_id = NEW.id)
    WHEN 'company_debt_open' THEN EXISTS (SELECT 1 FROM public.company_debts d WHERE d.journal_entry_id = NEW.id)
    WHEN 'company_debt_payment' THEN EXISTS (SELECT 1 FROM public.company_debt_events e WHERE e.journal_entry_id = NEW.id AND e.kind = 'payment')
    WHEN 'company_debt_writeoff' THEN EXISTS (SELECT 1 FROM public.company_debt_events e WHERE e.journal_entry_id = NEW.id AND e.kind = 'writeoff')
    ELSE false
  END;
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'company journal entry % (%) requires its immutable command row in the same transaction', NEW.id, NEW.event_type
      USING ERRCODE = '23514', CONSTRAINT = 'company_journal_fact_guard';
  END IF;
  RETURN NULL;
END
$$;

COMMENT ON TABLE company_debts IS
  'Company debts in both directions. Party names are free text for display/search; every balance is isolated by debt uuid.';
COMMENT ON COLUMN company_debts.party_key IS
  'Normalised search/grouping key only. It never identifies a fund and therefore cannot merge two balances.';
