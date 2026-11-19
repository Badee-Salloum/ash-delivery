-- A pre-platform transfer changes HQ cash on its real financial day. It does not replay or
-- mutate a branch restoration. The separate transit account keeps pre-cutover evidence out of
-- branch_clearing, whose balance is reserved for the live post-cutover invariant.

CREATE OR REPLACE FUNCTION ash_is_company_fund_type(p_type text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_type IN (
    'company_cash', 'depreciation_reserve', 'company_fx_position', 'branch_clearing',
    'historical_branch_transit', 'company_payable', 'company_receivable', 'fixed_asset',
    'company_expense', 'company_income', 'company_equity'
  )
$$;

CREATE OR REPLACE FUNCTION ash_is_company_event(p_event text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_event IN (
    'company_opening_transfer', 'company_restoration_mirror', 'company_historical_transfer',
    'company_deposit', 'company_withdrawal', 'company_expense', 'company_income',
    'company_fx_exchange', 'company_debt_open', 'company_debt_payment',
    'company_debt_writeoff', 'asset_purchase', 'depreciation_transfer',
    'depreciation_release', 'company_correction'
  )
$$;

CREATE OR REPLACE FUNCTION ash_company_fund_event_allowed(p_type text, p_event text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_type
    WHEN 'company_cash' THEN p_event IN (
      'company_deposit', 'company_withdrawal', 'company_expense', 'company_income',
      'company_fx_exchange', 'company_opening_transfer', 'company_restoration_mirror',
      'company_historical_transfer', 'company_debt_open', 'company_debt_payment',
      'asset_purchase', 'depreciation_transfer', 'depreciation_release', 'company_correction')
    WHEN 'depreciation_reserve' THEN p_event IN (
      'depreciation_transfer', 'depreciation_release', 'company_expense',
      'company_debt_payment', 'asset_purchase', 'company_correction')
    WHEN 'company_fx_position' THEN p_event IN ('company_fx_exchange', 'company_correction')
    WHEN 'branch_clearing' THEN p_event IN ('company_opening_transfer', 'company_restoration_mirror')
    WHEN 'historical_branch_transit' THEN p_event = 'company_historical_transfer'
    WHEN 'company_payable' THEN p_event IN (
      'company_debt_open', 'company_debt_payment', 'company_debt_writeoff',
      'asset_purchase', 'company_correction')
    WHEN 'company_receivable' THEN p_event IN (
      'company_debt_open', 'company_debt_payment', 'company_debt_writeoff',
      'asset_purchase', 'company_correction')
    WHEN 'fixed_asset' THEN p_event IN ('asset_purchase', 'company_correction')
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

CREATE TABLE company_historical_transfers (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  source_branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('to_company', 'from_company')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  occurred_on date NOT NULL CHECK (occurred_on >= DATE '2000-01-01'),
  business_date date NOT NULL CHECK (business_date = occurred_on),
  source_reference text NOT NULL UNIQUE CHECK (ash_has_visible_text(source_reference) AND length(source_reference) <= 200),
  reason text NOT NULL CHECK (ash_has_visible_text(reason) AND length(reason) <= 500),
  restoration_id bigint REFERENCES restorations(id) ON DELETE RESTRICT,
  journal_entry_id bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (branch_id <> source_branch_id)
);
CREATE INDEX company_historical_transfers_day_idx ON company_historical_transfers(branch_id, business_date, id);

CREATE FUNCTION guard_company_historical_transfer_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_actor uuid := public.ash_current_actor(); v_cash_side text; v_transit_side text;
BEGIN
  IF NEW.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor, 'company_fund.manage')
     OR NOT EXISTS (SELECT 1 FROM public.users WHERE id=v_actor AND active
       AND role_key IN ('general_manager','system_admin')) THEN
    RAISE EXCEPTION 'historical transfer requires an attributed owner-level manager'
      USING ERRCODE='23514', CONSTRAINT='company_historical_transfer_actor_guard';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id=NEW.branch_id AND kind='company')
     OR NOT EXISTS (SELECT 1 FROM public.branches WHERE id=NEW.source_branch_id AND kind='branch') THEN
    RAISE EXCEPTION 'historical transfer must connect HQ to an operating branch'
      USING ERRCODE='23514', CONSTRAINT='company_historical_transfer_branch_guard';
  END IF;
  IF NEW.restoration_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.restorations WHERE id=NEW.restoration_id AND branch_id=NEW.source_branch_id) THEN
    RAISE EXCEPTION 'restoration belongs to another branch'
      USING ERRCODE='23514', CONSTRAINT='company_historical_transfer_restoration_guard';
  END IF;
  IF NOT public.ash_company_entry_is(NEW.journal_entry_id, NEW.branch_id,
      'company_historical_transfer', NEW.id::text, NEW.business_date, NEW.reason, NEW.created_by, NULL)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE id=NEW.journal_entry_id
       AND external_reference=NEW.source_reference) THEN
    RAISE EXCEPTION 'historical transfer identity differs from its HQ journal'
      USING ERRCODE='23514', CONSTRAINT='company_historical_transfer_journal_guard';
  END IF;
  v_cash_side := CASE NEW.direction WHEN 'to_company' THEN 'D' ELSE 'C' END;
  v_transit_side := CASE NEW.direction WHEN 'to_company' THEN 'C' ELSE 'D' END;
  IF NOT public.ash_company_lines_match(NEW.journal_entry_id, NEW.branch_id,
    jsonb_build_array(
      public.ash_company_line('company_cash:SYP_NEW','company_cash','SYP_NEW',
        v_cash_side,NEW.amount_minor,'historical_branch_transfer'),
      public.ash_company_line('historical_branch_transit:'||NEW.source_branch_id::text,
        'historical_branch_transit','SYP_NEW',v_transit_side,NEW.amount_minor,
        'historical_branch_transfer'))) THEN
    RAISE EXCEPTION 'historical transfer lines differ from source direction or amount'
      USING ERRCODE='23514', CONSTRAINT='company_historical_transfer_lines_guard';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER company_historical_transfers_insert_guard BEFORE INSERT ON company_historical_transfers
  FOR EACH ROW EXECUTE FUNCTION guard_company_historical_transfer_insert();
CREATE TRIGGER company_historical_transfers_immutable BEFORE UPDATE OR DELETE ON company_historical_transfers
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER audit_company_historical_transfers AFTER INSERT OR UPDATE OR DELETE ON company_historical_transfers
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
REVOKE UPDATE, DELETE, TRUNCATE ON company_historical_transfers FROM app_user;
GRANT SELECT, INSERT ON company_historical_transfers TO app_user;

CREATE OR REPLACE FUNCTION assert_company_journal_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_ok boolean;
BEGIN
  IF NOT public.ash_is_company_event(NEW.event_type::text) THEN RETURN NULL; END IF;
  v_ok := NEW.shift_id IS NULL AND CASE NEW.event_type::text
    WHEN 'company_deposit' THEN EXISTS (SELECT 1 FROM public.company_moves m WHERE m.journal_entry_id=NEW.id AND m.kind='deposit')
    WHEN 'company_withdrawal' THEN EXISTS (SELECT 1 FROM public.company_moves m WHERE m.journal_entry_id=NEW.id AND m.kind='withdrawal')
    WHEN 'company_expense' THEN EXISTS (SELECT 1 FROM public.company_expenses e WHERE e.journal_entry_id=NEW.id)
    WHEN 'company_income' THEN EXISTS (SELECT 1 FROM public.company_incomes i WHERE i.journal_entry_id=NEW.id)
    WHEN 'company_fx_exchange' THEN EXISTS (SELECT 1 FROM public.company_fx_exchanges x WHERE x.journal_entry_id=NEW.id)
    WHEN 'company_correction' THEN EXISTS (SELECT 1 FROM public.company_reversals r WHERE r.journal_entry_id=NEW.id)
    WHEN 'company_opening_transfer' THEN EXISTS (SELECT 1 FROM public.company_ledger_cutovers c WHERE c.opening_entry_id=NEW.id)
    WHEN 'company_restoration_mirror' THEN EXISTS (SELECT 1 FROM public.company_restoration_mirrors m WHERE m.mirror_entry_id=NEW.id)
    WHEN 'company_historical_transfer' THEN EXISTS (SELECT 1 FROM public.company_historical_transfers t WHERE t.journal_entry_id=NEW.id)
    WHEN 'company_debt_open' THEN EXISTS (SELECT 1 FROM public.company_debts d WHERE d.journal_entry_id=NEW.id)
    WHEN 'company_debt_payment' THEN EXISTS (SELECT 1 FROM public.company_debt_events e WHERE e.journal_entry_id=NEW.id AND e.kind='payment')
    WHEN 'company_debt_writeoff' THEN EXISTS (SELECT 1 FROM public.company_debt_events e WHERE e.journal_entry_id=NEW.id AND e.kind='writeoff')
    WHEN 'asset_purchase' THEN EXISTS (SELECT 1 FROM public.fixed_assets a WHERE a.journal_entry_id=NEW.id)
    WHEN 'depreciation_transfer' THEN EXISTS (SELECT 1 FROM public.depreciation_transfers t WHERE t.journal_entry_id=NEW.id)
    WHEN 'depreciation_release' THEN EXISTS (SELECT 1 FROM public.depreciation_releases r WHERE r.journal_entry_id=NEW.id)
    ELSE false
  END;
  IF NOT COALESCE(v_ok,false) THEN
    RAISE EXCEPTION 'company journal entry % (%) requires its immutable command row in the same transaction', NEW.id, NEW.event_type
      USING ERRCODE='23514', CONSTRAINT='company_journal_fact_guard';
  END IF;
  RETURN NULL;
END $$;

-- Historical cash can be negative; a negative input amount is still forbidden above. The
-- depreciation reserve guard remains unchanged.
CREATE OR REPLACE FUNCTION assert_company_pocket_not_negative() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fund_type text; v_event_type text;
BEGIN
  SELECT type::text INTO fund_type FROM public.funds WHERE id=NEW.fund_id;
  IF fund_type IS NULL OR fund_type NOT IN('company_cash','depreciation_reserve') THEN RETURN NULL; END IF;
  SELECT je.event_type::text INTO v_event_type FROM public.journal_entries je WHERE je.id=NEW.entry_id;
  IF v_event_type IS NULL OR v_event_type IN('company_restoration_mirror','company_historical_transfer') THEN RETURN NULL; END IF;
  IF fund_type='company_cash' AND (
    EXISTS(SELECT 1 FROM public.company_movement_metadata m JOIN public.journal_entries e
      ON e.branch_id=m.branch_id AND e.occurrence_key=m.command_id::text
      WHERE e.id=NEW.entry_id AND e.external_reference IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.company_movement_correction_versions c WHERE c.status='confirmed'
      AND (c.reversal_entry_id=NEW.entry_id OR c.replacement_entry_id=NEW.entry_id))
  ) THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.funds WHERE id=NEW.fund_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.journal_lines WHERE fund_id=NEW.fund_id
    HAVING COALESCE(SUM(CASE side WHEN 'D' THEN amount_minor ELSE -amount_minor END),0)<0) THEN
    RAISE EXCEPTION 'company pocket would go below zero' USING ERRCODE='23514',CONSTRAINT='company_pocket_negative_guard';
  END IF;
  RETURN NULL;
END $$;
