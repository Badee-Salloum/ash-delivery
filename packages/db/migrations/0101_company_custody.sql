CREATE OR REPLACE FUNCTION ash_is_company_fund_type(p_type text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT p_type IN (
  'company_cash','company_custody','depreciation_reserve','company_fx_position','branch_clearing',
  'historical_branch_transit','company_payable','company_receivable','fixed_asset','company_expense','company_income','company_equity') $$;
CREATE OR REPLACE FUNCTION ash_is_company_event(p_event text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT p_event IN (
  'company_opening_transfer','company_restoration_mirror','company_historical_transfer','company_historical_restoration_reclass',
  'company_deposit','company_withdrawal','company_expense','company_income','company_fx_exchange',
  'company_debt_open','company_debt_payment','company_debt_writeoff','asset_purchase',
  'depreciation_transfer','depreciation_release','company_correction','company_custody_transfer') $$;
CREATE OR REPLACE FUNCTION ash_company_fund_event_allowed(p_type text,p_event text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT CASE
  WHEN p_event='company_historical_restoration_reclass' THEN p_type IN('historical_branch_transit','branch_clearing')
  WHEN p_event='company_custody_transfer' THEN p_type IN('company_cash','company_custody')
  ELSE CASE p_type
    WHEN 'company_custody' THEN p_event IN('company_expense','company_correction')
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
ALTER TABLE funds DROP CONSTRAINT funds_currency_scope_ck;
ALTER TABLE funds ADD CONSTRAINT funds_currency_scope_ck CHECK(currency='SYP_NEW' OR type::text IN(
  'company_cash','company_custody','depreciation_reserve','company_fx_position','company_payable','company_receivable',
  'fixed_asset','company_expense','company_income','company_equity'));

-- The journal itself is this narrow transfer's immutable receipt (UUID, actor, date, reason).
-- Deferred exact-line guard rules out all owner-equity, P&L, branch, cross-currency or orphan legs.
DROP TRIGGER journal_entries_company_fact ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_company_fact AFTER INSERT OR UPDATE OF event_type,branch_id,shift_id ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN(ash_is_company_event(NEW.event_type::text) AND NEW.occurrence_key !~ '^review(-reverse)?:'
    AND NEW.event_type::text<>'company_custody_transfer') EXECUTE FUNCTION assert_company_journal_fact();
CREATE FUNCTION assert_company_custody_transfer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_currency text; v_amount bigint; v_custody_side text;
BEGIN
  IF NEW.shift_id IS NOT NULL OR NEW.created_by IS DISTINCT FROM public.ash_current_actor()
    OR NOT public.ash_actor_holds_all(NEW.created_by,'company_fund.manage')
    OR NEW.occurrence_key !~ '^custody:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NOT public.ash_has_visible_text(NEW.reason) OR NEW.business_date IS DISTINCT FROM NEW.posting_date
  THEN RAISE EXCEPTION 'custody transfer requires its company manager and immutable receipt' USING ERRCODE='23514'; END IF;
  SELECT f.currency,l.amount_minor,l.side::text INTO v_currency,v_amount,v_custody_side
    FROM public.journal_lines l JOIN public.funds f ON f.id=l.fund_id
    WHERE l.entry_id=NEW.id AND f.branch_id=NEW.branch_id AND f.type::text='company_custody';
  IF v_amount IS NULL OR v_amount<=0 OR NOT public.ash_company_lines_match(NEW.id,NEW.branch_id,jsonb_build_array(
    public.ash_company_line('company_custody:'||v_currency,'company_custody',v_currency,v_custody_side,v_amount,'custody_transfer'),
    public.ash_company_line('company_cash:'||v_currency,'company_cash',v_currency,CASE v_custody_side WHEN 'D' THEN 'C' ELSE 'D' END,v_amount,'custody_transfer')))
  THEN RAISE EXCEPTION 'custody requires exactly opposite cash legs in one currency' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entries_custody_fact AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.event_type::text='company_custody_transfer')
  EXECUTE FUNCTION assert_company_custody_transfer();
CREATE FUNCTION assert_company_custody_not_negative() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_branch uuid; v_code text;
BEGIN
  SELECT branch_id,code INTO v_branch,v_code FROM public.funds WHERE id=NEW.fund_id AND type::text='company_custody';
  IF v_code IS NOT NULL AND public.ash_fund_balance(v_branch,v_code)<0 THEN
    RAISE EXCEPTION 'cannot spend or return more than actual company custody' USING ERRCODE='23514',CONSTRAINT='company_custody_negative_guard'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_lines_custody_balance AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_company_custody_not_negative();

ALTER TABLE company_expenses DROP CONSTRAINT company_expenses_paid_from_check;
ALTER TABLE company_expenses ADD CONSTRAINT company_expenses_paid_from_check CHECK(paid_from IN('pocket','reserve','owner_outside','owner_custody'));
CREATE OR REPLACE FUNCTION guard_company_expense_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_actor uuid:=public.ash_current_actor(); v_centre text; v_source_code text; v_source_type text;
BEGIN
  IF v_actor IS NULL OR NEW.created_by IS DISTINCT FROM v_actor OR NOT public.ash_actor_holds_all(v_actor,'company_fund.manage')
  THEN RAISE EXCEPTION 'company expense requires attributed company manager' USING ERRCODE='23514',CONSTRAINT='company_expenses_actor_guard'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.expense_categories WHERE id=NEW.category_id AND active)
  THEN RAISE EXCEPTION 'unknown expense category' USING ERRCODE='23514',CONSTRAINT='company_expenses_category_guard'; END IF;
  IF NEW.vehicle_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.vehicles WHERE id=NEW.vehicle_id)
  THEN RAISE EXCEPTION 'unknown expense vehicle' USING ERRCODE='23514',CONSTRAINT='company_expenses_vehicle_guard'; END IF;
  IF NEW.asset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.fixed_assets WHERE id=NEW.asset_id)
  THEN RAISE EXCEPTION 'unknown expense asset' USING ERRCODE='23514',CONSTRAINT='company_expenses_asset_guard'; END IF;
  IF NOT public.ash_company_entry_is(NEW.journal_entry_id,NEW.branch_id,'company_expense',NEW.id::text,
    NEW.business_date,NEW.description,NEW.created_by,NEW.syp_minor_per_usd)
  THEN RAISE EXCEPTION 'expense identity differs from journal' USING ERRCODE='23514',CONSTRAINT='company_expenses_journal_guard'; END IF;
  v_centre:='company_expense:'||NEW.currency||':'||CASE NEW.cost_center_kind WHEN 'vehicle' THEN 'vehicle:'||NEW.vehicle_id::text WHEN 'asset' THEN 'asset:'||NEW.asset_id::text ELSE 'general' END;
  v_source_type:=CASE NEW.paid_from WHEN 'pocket' THEN 'company_cash' WHEN 'reserve' THEN 'depreciation_reserve' WHEN 'owner_custody' THEN 'company_custody' ELSE 'company_equity' END;
  v_source_code:=v_source_type||':'||NEW.currency||CASE NEW.paid_from WHEN 'owner_outside' THEN ':owner_funding' ELSE '' END;
  IF NOT public.ash_company_lines_match(NEW.journal_entry_id,NEW.branch_id,jsonb_build_array(
    public.ash_company_line(v_centre,'company_expense',NEW.currency,'D',NEW.amount_minor,'expense_cost'),
    public.ash_company_line(v_source_code,v_source_type,NEW.currency,'C',NEW.amount_minor,'expense_paid')))
  THEN RAISE EXCEPTION 'expense source/amount/centre differs from exact journal' USING ERRCODE='23514',CONSTRAINT='company_expenses_lines_guard'; END IF;
  RETURN NEW;
END $$;
