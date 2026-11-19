-- Custody purchases and debt payments use exact company-funded legs; never owner equity.
ALTER TABLE company_debt_events DROP CONSTRAINT company_debt_events_source_check;
ALTER TABLE company_debt_events ADD CONSTRAINT company_debt_events_source_check CHECK(source IN('pocket','reserve','owner_outside','owner_custody'));
ALTER TABLE fixed_assets DROP CONSTRAINT fixed_assets_paid_from_check;
ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_paid_from_check CHECK(paid_from IN('pocket','reserve','owner_outside','owner_custody','opening'));
ALTER TABLE asset_installment_plans DROP CONSTRAINT asset_installment_plans_paid_from_check;
ALTER TABLE asset_installment_plans ADD CONSTRAINT asset_installment_plans_paid_from_check CHECK(paid_from IN('pocket','reserve','owner_outside','owner_custody'));

CREATE OR REPLACE FUNCTION ash_company_fund_event_allowed(p_type text,p_event text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT CASE
  WHEN p_event='company_historical_restoration_reclass' THEN p_type IN('historical_branch_transit','branch_clearing')
  WHEN p_event='company_custody_transfer' THEN p_type IN('company_cash','company_custody')
  ELSE CASE p_type
    WHEN 'company_custody' THEN p_event IN('company_expense','company_correction','company_debt_payment','asset_purchase')
    WHEN 'company_cash' THEN p_event IN('company_deposit','company_withdrawal','company_expense','company_income',
      'company_fx_exchange','company_opening_transfer','company_restoration_mirror','company_historical_transfer',
      'company_debt_open','company_debt_payment','asset_purchase','depreciation_transfer','depreciation_release','company_correction')
    WHEN 'depreciation_reserve' THEN p_event IN('depreciation_transfer','depreciation_release','company_expense','company_debt_payment','asset_purchase','company_correction')
    WHEN 'company_fx_position' THEN p_event IN('company_fx_exchange','company_correction')
    WHEN 'branch_clearing' THEN p_event IN('company_opening_transfer','company_restoration_mirror')
    WHEN 'historical_branch_transit' THEN p_event='company_historical_transfer'
    WHEN 'company_payable' THEN p_event IN('company_debt_open','company_debt_payment','company_debt_writeoff','asset_purchase','company_correction')
    WHEN 'company_receivable' THEN p_event IN('company_debt_open','company_debt_payment','company_debt_writeoff','asset_purchase','company_correction')
    WHEN 'fixed_asset' THEN p_event IN('asset_purchase','company_correction')
    WHEN 'company_expense' THEN p_event IN('company_expense','company_debt_open','company_debt_writeoff','company_correction')
    WHEN 'company_income' THEN p_event IN('company_income','company_debt_open','company_debt_writeoff','company_correction')
    WHEN 'company_equity' THEN p_event IN('company_deposit','company_withdrawal','company_expense','company_debt_open','company_debt_payment','asset_purchase','company_correction')
    ELSE false END END $$;

CREATE OR REPLACE FUNCTION guard_company_debt_event_insert() RETURNS trigger
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
      WHEN 'owner_custody' THEN 'company_custody'
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

CREATE OR REPLACE FUNCTION guard_fixed_asset_insert() RETURNS trigger
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
      WHEN 'owner_custody' THEN 'company_custody'
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

