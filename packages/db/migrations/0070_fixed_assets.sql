-- 0070 — fixed assets, financed purchases and the 36-month schedule (finance redesign C4)
--
-- One purchase is one journal. The asset is debited for its whole price; cash/reserve/equity is
-- credited for what was paid now and one linked company payable is credited for the remainder.
-- Period 1 is the purchase month. The first 35 periods receive floor(price / 36); period 36 gets
-- the remainder, and a deferred proof refuses a schedule that does not sum exactly to the price.

CREATE TABLE fixed_assets (
  id                    uuid PRIMARY KEY,
  branch_id             uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  kind                  text NOT NULL CHECK (kind IN ('vehicle', 'equipment', 'property', 'other')),
  vehicle_id            uuid UNIQUE REFERENCES vehicles(id) ON DELETE RESTRICT,
  name                  text NOT NULL CHECK (ash_has_visible_text(name) AND char_length(name) <= 160),
  currency              text NOT NULL CHECK (currency IN ('SYP_NEW', 'USD')),
  price_minor           bigint NOT NULL CHECK (price_minor > 0),
  syp_minor_per_usd     bigint CHECK (syp_minor_per_usd > 0),
  purchased_on          date NOT NULL,
  business_date         date NOT NULL,
  useful_months         integer NOT NULL DEFAULT 36 CHECK (useful_months = 36),
  paid_now_minor        bigint NOT NULL CHECK (paid_now_minor >= 0 AND paid_now_minor <= price_minor),
  paid_from             text NOT NULL CHECK (paid_from IN ('pocket', 'reserve', 'owner_outside', 'opening')),
  debt_id               uuid UNIQUE,
  description           text NOT NULL CHECK (ash_has_visible_text(description) AND char_length(description) <= 500),
  journal_entry_id      bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fixed_assets_vehicle_ck CHECK ((kind = 'vehicle') = (vehicle_id IS NOT NULL)),
  CONSTRAINT fixed_assets_dates_ck CHECK (purchased_on >= DATE '2000-01-01' AND purchased_on <= business_date),
  CONSTRAINT fixed_assets_rate_ck CHECK ((currency = 'USD') = (syp_minor_per_usd IS NOT NULL)),
  CONSTRAINT fixed_assets_debt_ck CHECK ((paid_now_minor < price_minor) = (debt_id IS NOT NULL))
);
CREATE INDEX fixed_assets_branch_date_idx ON fixed_assets (branch_id, business_date, created_at);

CREATE TABLE asset_depreciation_schedule (
  asset_id       uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
  period         integer NOT NULL CHECK (period BETWEEN 1 AND 36),
  period_month   date NOT NULL CHECK (extract(day FROM period_month) = 1),
  amount_minor   bigint NOT NULL CHECK (amount_minor >= 0),
  PRIMARY KEY (asset_id, period),
  UNIQUE (asset_id, period_month)
);
CREATE INDEX asset_depreciation_schedule_month_idx ON asset_depreciation_schedule (period_month, asset_id);

ALTER TABLE fixed_assets
  ADD CONSTRAINT fixed_assets_debt_fk FOREIGN KEY (debt_id) REFERENCES company_debts(id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE company_debts
  ADD CONSTRAINT company_debts_asset_fk FOREIGN KEY (asset_id) REFERENCES fixed_assets(id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE company_expenses
  ADD CONSTRAINT company_expenses_asset_fk FOREIGN KEY (asset_id) REFERENCES fixed_assets(id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER fixed_assets_00_branch_kind_guard
  BEFORE INSERT OR UPDATE OF branch_id ON fixed_assets
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');

REVOKE UPDATE, DELETE, TRUNCATE ON fixed_assets FROM app_user;
GRANT SELECT, INSERT ON fixed_assets TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON asset_depreciation_schedule FROM app_user;
GRANT SELECT, INSERT ON asset_depreciation_schedule TO app_user;
CREATE TRIGGER fixed_assets_immutable BEFORE UPDATE OR DELETE ON fixed_assets
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER asset_depreciation_schedule_immutable BEFORE UPDATE OR DELETE ON asset_depreciation_schedule
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER audit_fixed_assets AFTER INSERT OR UPDATE OR DELETE ON fixed_assets
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE UNIQUE INDEX je_asset_purchase_command_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'asset_purchase';

CREATE FUNCTION ash_depreciation_amount(
  p_price_minor bigint,
  p_months integer,
  p_period integer
) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE STRICT
AS $$
DECLARE
  v_base bigint;
BEGIN
  IF p_price_minor <= 0 OR p_months <= 0 OR p_period < 1 OR p_period > p_months THEN
    RAISE EXCEPTION 'invalid depreciation inputs price %, months %, period %',
      p_price_minor, p_months, p_period USING ERRCODE = '22023';
  END IF;
  v_base := p_price_minor / p_months;
  RETURN CASE WHEN p_period = p_months
    THEN p_price_minor - v_base * (p_months - 1)
    ELSE v_base
  END;
END
$$;

CREATE FUNCTION guard_asset_schedule_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_asset public.fixed_assets%ROWTYPE;
  v_month date;
BEGIN
  SELECT * INTO v_asset FROM public.fixed_assets a WHERE a.id = NEW.asset_id;
  IF v_asset.id IS NULL THEN RETURN NEW; END IF; -- the FK reports the missing parent
  v_month := (
    date_trunc('month', v_asset.purchased_on::timestamp)
    + make_interval(months => NEW.period - 1)
  )::date;
  IF NEW.period > v_asset.useful_months
     OR NEW.period_month IS DISTINCT FROM v_month
     OR NEW.amount_minor IS DISTINCT FROM public.ash_depreciation_amount(
       v_asset.price_minor, v_asset.useful_months, NEW.period)
  THEN
    RAISE EXCEPTION 'asset depreciation row does not match its deterministic schedule'
      USING ERRCODE = '23514', CONSTRAINT = 'asset_depreciation_schedule_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER asset_depreciation_schedule_insert_guard
  BEFORE INSERT ON asset_depreciation_schedule
  FOR EACH ROW EXECUTE FUNCTION guard_asset_schedule_insert();

CREATE FUNCTION assert_asset_schedule_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_asset_id uuid := CASE WHEN TG_TABLE_NAME = 'fixed_assets' THEN NEW.id ELSE NEW.asset_id END;
  v_asset public.fixed_assets%ROWTYPE;
  v_count bigint;
  v_total bigint;
BEGIN
  SELECT * INTO v_asset FROM public.fixed_assets a WHERE a.id = v_asset_id;
  IF v_asset.id IS NULL THEN RETURN NULL; END IF;
  SELECT count(*), COALESCE(sum(s.amount_minor), 0)
    INTO v_count, v_total
    FROM public.asset_depreciation_schedule s
   WHERE s.asset_id = v_asset_id;
  IF v_count <> v_asset.useful_months OR v_total <> v_asset.price_minor THEN
    RAISE EXCEPTION 'asset % needs % depreciation rows totalling %, found % rows totalling %',
      v_asset_id, v_asset.useful_months, v_asset.price_minor, v_count, v_total
      USING ERRCODE = '23514', CONSTRAINT = 'asset_depreciation_schedule_complete';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER fixed_assets_schedule_complete
  AFTER INSERT ON fixed_assets DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_asset_schedule_complete();
CREATE CONSTRAINT TRIGGER asset_schedule_complete
  AFTER INSERT ON asset_depreciation_schedule DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_asset_schedule_complete();

CREATE FUNCTION guard_fixed_asset_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor       uuid := public.ash_current_actor();
  v_source_type text;
  v_source_code text;
  v_expected    jsonb;
  v_financed    bigint := NEW.price_minor - NEW.paid_now_minor;
BEGIN
  IF v_actor IS NULL OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN
    RAISE EXCEPTION 'fixed asset requires its attributed company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'fixed_assets_actor_guard';
  END IF;
  IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.vehicles v WHERE v.id = NEW.vehicle_id) THEN
    RAISE EXCEPTION 'fixed asset names an unknown vehicle'
      USING ERRCODE = '23514', CONSTRAINT = 'fixed_assets_vehicle_guard';
  END IF;
  IF NOT public.ash_company_entry_is(
       NEW.journal_entry_id, NEW.branch_id, 'asset_purchase', NEW.id::text, NEW.business_date,
       NEW.description, NEW.created_by, NEW.syp_minor_per_usd)
  THEN
    RAISE EXCEPTION 'fixed asset identity differs from its journal'
      USING ERRCODE = '23514', CONSTRAINT = 'fixed_assets_journal_guard';
  END IF;

  v_expected := jsonb_build_array(public.ash_company_line(
    'fixed_asset:' || NEW.currency || ':' || NEW.id::text, 'fixed_asset', NEW.currency,
    'D', NEW.price_minor, 'asset_acquired'));
  IF NEW.paid_now_minor > 0 THEN
    v_source_type := CASE NEW.paid_from
      WHEN 'pocket' THEN 'company_cash'
      WHEN 'reserve' THEN 'depreciation_reserve'
      ELSE 'company_equity'
    END;
    v_source_code := v_source_type || ':' || NEW.currency
      || CASE WHEN NEW.paid_from IN ('owner_outside', 'opening')
              THEN ':' || CASE NEW.paid_from WHEN 'opening' THEN 'opening' ELSE 'owner_funding' END
              ELSE '' END;
    v_expected := v_expected || jsonb_build_array(public.ash_company_line(
      v_source_code, v_source_type, NEW.currency, 'C', NEW.paid_now_minor, 'asset_paid'));
  END IF;
  IF v_financed > 0 THEN
    v_expected := v_expected || jsonb_build_array(public.ash_company_line(
      'company_payable:' || NEW.currency || ':' || NEW.debt_id::text, 'company_payable', NEW.currency,
      'C', v_financed, 'asset_financed'));
  END IF;

  IF NOT public.ash_company_lines_match(NEW.journal_entry_id, NEW.branch_id, v_expected) THEN
    RAISE EXCEPTION 'fixed asset price/source/financing differs from its journal lines'
      USING ERRCODE = '23514', CONSTRAINT = 'fixed_assets_lines_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER fixed_assets_insert_guard
  BEFORE INSERT ON fixed_assets
  FOR EACH ROW EXECUTE FUNCTION guard_fixed_asset_insert();

CREATE FUNCTION assert_asset_debt_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_asset_id uuid := CASE WHEN TG_TABLE_NAME = 'fixed_assets' THEN NEW.id ELSE NEW.asset_id END;
  v_asset public.fixed_assets%ROWTYPE;
  v_debt public.company_debts%ROWTYPE;
  v_financed bigint;
BEGIN
  SELECT * INTO v_asset FROM public.fixed_assets a WHERE a.id = v_asset_id;
  IF v_asset.id IS NULL THEN RETURN NULL; END IF;
  v_financed := v_asset.price_minor - v_asset.paid_now_minor;
  IF v_financed = 0 THEN
    IF v_asset.debt_id IS NOT NULL THEN
      RAISE EXCEPTION 'fully paid asset % unexpectedly names a debt', v_asset.id
        USING ERRCODE = '23514', CONSTRAINT = 'fixed_assets_debt_link_guard';
    END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO v_debt FROM public.company_debts d WHERE d.id = v_asset.debt_id;
  IF v_debt.id IS NULL
     OR v_debt.asset_id IS DISTINCT FROM v_asset.id
     OR v_debt.direction <> 'payable'
     OR v_debt.origin <> 'asset_purchase'
     OR v_debt.branch_id IS DISTINCT FROM v_asset.branch_id
     OR v_debt.currency IS DISTINCT FROM v_asset.currency
     OR v_debt.principal_minor IS DISTINCT FROM v_financed
     OR v_debt.business_date IS DISTINCT FROM v_asset.business_date
     OR v_debt.journal_entry_id IS DISTINCT FROM v_asset.journal_entry_id
     OR v_debt.created_by IS DISTINCT FROM v_asset.created_by
  THEN
    RAISE EXCEPTION 'financed asset % and its payable are not one accounting fact', v_asset.id
      USING ERRCODE = '23514', CONSTRAINT = 'fixed_assets_debt_link_guard';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER fixed_assets_debt_link
  AFTER INSERT ON fixed_assets DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_asset_debt_link();
CREATE CONSTRAINT TRIGGER company_debts_asset_link
  AFTER INSERT ON company_debts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.origin = 'asset_purchase') EXECUTE FUNCTION assert_asset_debt_link();

-- 0069 deliberately refused this origin until the asset table and its deferred two-way link
-- existed. Keep all of its normal opening checks and add the asset-purchase special case.
CREATE OR REPLACE FUNCTION guard_company_debt_insert() RETURNS trigger
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
  v_asset_line_ok     boolean;
BEGIN
  IF v_actor IS NULL OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN
    RAISE EXCEPTION 'company debt requires its attributed company-fund manager'
      USING ERRCODE = '23514', CONSTRAINT = 'company_debts_actor_guard';
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

  IF NEW.origin = 'asset_purchase' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.journal_entries je
       WHERE je.id = NEW.journal_entry_id AND je.branch_id = NEW.branch_id
         AND je.event_type::text = 'asset_purchase' AND je.shift_id IS NULL
         AND je.occurrence_key = NEW.asset_id::text AND je.business_date = NEW.business_date
         AND je.posting_date = NEW.business_date
         AND je.week_start_date = (NEW.business_date - extract(dow FROM NEW.business_date)::integer)
         AND je.created_by = NEW.created_by
         AND je.syp_minor_per_usd IS NOT DISTINCT FROM NEW.syp_minor_per_usd
    ) THEN
      RAISE EXCEPTION 'asset payable identity differs from its purchase journal'
        USING ERRCODE = '23514', CONSTRAINT = 'company_debts_journal_guard';
    END IF;
    SELECT COUNT(*) = 1 INTO v_asset_line_ok
      FROM public.journal_lines jl JOIN public.funds f ON f.id = jl.fund_id
     WHERE jl.entry_id = NEW.journal_entry_id
       AND f.branch_id = NEW.branch_id
       AND f.code = 'company_payable:' || NEW.currency || ':' || NEW.id::text
       AND f.type::text = 'company_payable' AND f.currency = NEW.currency
       AND jl.side = 'C' AND jl.amount_minor = NEW.principal_minor AND jl.line_role = 'asset_financed';
    IF NOT COALESCE(v_asset_line_ok, false) THEN
      RAISE EXCEPTION 'asset payable differs from its purchase journal line'
        USING ERRCODE = '23514', CONSTRAINT = 'company_debts_lines_guard';
    END IF;
    RETURN NEW;
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
    WHEN 'cash' THEN v_counter_type := 'company_cash'; v_counter_code := 'company_cash:' || NEW.currency;
    WHEN 'expense' THEN
      v_counter_type := 'company_expense';
      v_centre := CASE NEW.cost_center_kind WHEN 'vehicle' THEN 'vehicle:' || NEW.vehicle_id::text ELSE 'general' END;
      v_counter_code := 'company_expense:' || NEW.currency || ':' || v_centre;
    WHEN 'income' THEN v_counter_type := 'company_income'; v_counter_code := 'company_income:' || NEW.currency || ':general';
    WHEN 'opening' THEN v_counter_type := 'company_equity'; v_counter_code := 'company_equity:' || NEW.currency || ':opening';
    ELSE RAISE EXCEPTION 'unsupported company debt origin %', NEW.origin
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

-- C2 initially refused asset cost centres because no referenced register existed. It exists now.
CREATE OR REPLACE FUNCTION guard_company_expense_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor       uuid := public.ash_current_actor();
  v_centre      text;
  v_source_code text;
  v_source_type text;
BEGIN
  IF v_actor IS NULL OR NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
  THEN RAISE EXCEPTION 'company expense requires its attributed company-fund manager'
    USING ERRCODE = '23514', CONSTRAINT = 'company_expenses_actor_guard'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.expense_categories c WHERE c.id = NEW.category_id AND c.active) THEN
    RAISE EXCEPTION 'company expense names an unknown or inactive category'
      USING ERRCODE = '23514', CONSTRAINT = 'company_expenses_category_guard';
  END IF;
  IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.vehicles v WHERE v.id = NEW.vehicle_id) THEN
    RAISE EXCEPTION 'company expense names an unknown vehicle'
      USING ERRCODE = '23514', CONSTRAINT = 'company_expenses_vehicle_guard';
  END IF;
  IF NEW.asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fixed_assets a WHERE a.id = NEW.asset_id) THEN
    RAISE EXCEPTION 'company expense names an unknown asset'
      USING ERRCODE = '23514', CONSTRAINT = 'company_expenses_asset_guard';
  END IF;
  IF NOT public.ash_company_entry_is(
       NEW.journal_entry_id, NEW.branch_id, 'company_expense', NEW.id::text, NEW.business_date,
       NEW.description, NEW.created_by, NEW.syp_minor_per_usd)
  THEN RAISE EXCEPTION 'company expense identity differs from its journal'
    USING ERRCODE = '23514', CONSTRAINT = 'company_expenses_journal_guard'; END IF;
  v_centre := 'company_expense:' || NEW.currency || ':' || CASE NEW.cost_center_kind
    WHEN 'vehicle' THEN 'vehicle:' || NEW.vehicle_id::text
    WHEN 'asset' THEN 'asset:' || NEW.asset_id::text ELSE 'general' END;
  v_source_type := CASE NEW.paid_from WHEN 'pocket' THEN 'company_cash'
    WHEN 'reserve' THEN 'depreciation_reserve' ELSE 'company_equity' END;
  v_source_code := v_source_type || ':' || NEW.currency
    || CASE NEW.paid_from WHEN 'owner_outside' THEN ':owner_funding' ELSE '' END;
  IF NOT public.ash_company_lines_match(
       NEW.journal_entry_id, NEW.branch_id,
       jsonb_build_array(
         public.ash_company_line(v_centre, 'company_expense', NEW.currency, 'D', NEW.amount_minor, 'expense_cost'),
         public.ash_company_line(v_source_code, v_source_type, NEW.currency, 'C', NEW.amount_minor, 'expense_paid')))
  THEN RAISE EXCEPTION 'company expense amount/currency/centre/source differs from its journal lines'
    USING ERRCODE = '23514', CONSTRAINT = 'company_expenses_lines_guard'; END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION assert_company_journal_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_ok boolean;
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
    WHEN 'asset_purchase' THEN EXISTS (SELECT 1 FROM public.fixed_assets a WHERE a.journal_entry_id = NEW.id)
    ELSE false
  END;
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'company journal entry % (%) requires its immutable command row in the same transaction', NEW.id, NEW.event_type
      USING ERRCODE = '23514', CONSTRAINT = 'company_journal_fact_guard';
  END IF;
  RETURN NULL;
END
$$;

COMMENT ON TABLE fixed_assets IS
  'Company fixed assets in purchase currency. Vehicle assets are one-to-one with fleet vehicles; financed balances live in company_debts.';
COMMENT ON TABLE asset_depreciation_schedule IS
  'Deterministic 36-period straight-line schedule. Period 1 is the purchase month; the final row holds the integer remainder.';
