-- Historical missing HQ side and explicit unrecorded transfers; no approved shift mutations.

CREATE TABLE company_historical_branch_links(
  id uuid PRIMARY KEY,company_branch_id uuid NOT NULL REFERENCES branches(id),source_branch_id uuid NOT NULL REFERENCES branches(id),
  source_entry_id bigint NOT NULL UNIQUE REFERENCES journal_entries(id),company_entry_id bigint NOT NULL UNIQUE REFERENCES journal_entries(id),
  created_entry boolean NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),
  direction text NOT NULL CHECK(direction IN('to_company','from_company')),occurred_on date NOT NULL CHECK(occurred_on>=DATE '2000-01-01'),
  reason text NOT NULL CHECK(ash_has_visible_text(reason) AND length(reason)<=500),request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL, CHECK(company_branch_id<>source_branch_id));
CREATE FUNCTION guard_company_historical_branch_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_source public.journal_entries%ROWTYPE; v_target public.journal_entries%ROWTYPE; v_cutover public.company_ledger_cutovers%ROWTYPE;
  v_box public.journal_lines%ROWTYPE; v_cash_side text; v_transit_side text;
BEGIN
  SELECT * INTO v_source FROM public.journal_entries WHERE id=NEW.source_entry_id;
  SELECT * INTO v_target FROM public.journal_entries WHERE id=NEW.company_entry_id;
  SELECT * INTO v_cutover FROM public.company_ledger_cutovers WHERE branch_id=NEW.source_branch_id;
  SELECT l.* INTO v_box FROM public.journal_lines l JOIN public.funds f ON f.id=l.fund_id WHERE l.entry_id=NEW.source_entry_id AND f.code='company_box' AND f.branch_id=NEW.source_branch_id;
  IF NEW.created_by IS DISTINCT FROM public.ash_current_actor() OR NOT public.ash_actor_holds_all(NEW.created_by,'company_fund.manage')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=NEW.created_by AND active AND role_key IN('general_manager','system_admin'))
    OR v_cutover.mode IS DISTINCT FROM 'link_only' OR v_cutover.company_branch_id IS DISTINCT FROM NEW.company_branch_id
    OR v_source.id IS NULL OR v_source.id>v_cutover.watermark_entry_id OR v_source.branch_id IS DISTINCT FROM NEW.source_branch_id
    OR v_source.event_type::text<>'manual' OR v_source.shift_id IS NOT NULL OR v_source.business_date IS DISTINCT FROM NEW.occurred_on
    OR v_box.amount_minor IS DISTINCT FROM NEW.amount_minor OR (SELECT count(*) FROM public.journal_lines WHERE entry_id=NEW.source_entry_id)<>2
    OR NEW.direction IS DISTINCT FROM (CASE v_box.side WHEN 'D' THEN 'to_company' ELSE 'from_company' END)
    OR NOT EXISTS(SELECT 1 FROM public.journal_lines l JOIN public.funds f ON f.id=l.fund_id WHERE l.entry_id=NEW.source_entry_id
      AND f.branch_id=NEW.source_branch_id AND f.code IN('office_cash','office_wallet') AND l.amount_minor=NEW.amount_minor AND l.side<>v_box.side)
    OR EXISTS(SELECT 1 FROM public.company_restoration_mirrors WHERE source_entry_id=NEW.source_entry_id)
    OR EXISTS(SELECT 1 FROM public.company_restoration_proposal_legs WHERE source_entry_id=NEW.source_entry_id)
    OR EXISTS(SELECT 1 FROM public.journal_entries WHERE branch_id=NEW.source_branch_id AND event_type::text='correction' AND occurrence_key='reversal-of-'||NEW.source_entry_id::text)
    OR v_target.id IS NULL OR v_target.branch_id IS DISTINCT FROM NEW.company_branch_id OR v_target.shift_id IS NOT NULL
    OR v_target.event_type::text<>'company_historical_transfer' OR v_target.business_date IS DISTINCT FROM NEW.occurred_on
    OR EXISTS(SELECT 1 FROM public.company_reversals WHERE target_entry_id=NEW.company_entry_id)
  THEN RAISE EXCEPTION 'historical link requires unique exact immutable branch and HQ evidence' USING ERRCODE='23514'; END IF;
  IF NEW.created_entry AND (v_target.occurrence_key IS DISTINCT FROM NEW.id::text OR v_target.reason IS DISTINCT FROM NEW.reason
    OR v_target.created_by IS DISTINCT FROM NEW.created_by OR v_target.external_reference IS DISTINCT FROM 'HQ-LINK-'||NEW.id::text
    OR v_target.prior_period_reason IS DISTINCT FROM NEW.reason OR NOT EXISTS(SELECT 1 FROM public.journal_entries WHERE id=NEW.company_entry_id AND xmin::text=(txid_current()%4294967296)::text))
  THEN RAISE EXCEPTION 'missing HQ receipt must be created once in the linking transaction' USING ERRCODE='23514'; END IF;
  v_cash_side:=CASE NEW.direction WHEN 'to_company' THEN 'D' ELSE 'C' END;
  v_transit_side:=CASE v_cash_side WHEN 'D' THEN 'C' ELSE 'D' END;
  IF NOT public.ash_company_lines_match(NEW.company_entry_id,NEW.company_branch_id,jsonb_build_array(
    public.ash_company_line('company_cash:SYP_NEW','company_cash','SYP_NEW',v_cash_side,NEW.amount_minor,'historical_branch_transfer'),
    public.ash_company_line('historical_branch_transit:'||NEW.source_branch_id::text,'historical_branch_transit','SYP_NEW',v_transit_side,NEW.amount_minor,'historical_branch_transfer')))
  THEN RAISE EXCEPTION 'historical link cannot invent equity, expenses, clearing or branch cash' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_historical_branch_links_guard BEFORE INSERT ON company_historical_branch_links FOR EACH ROW EXECUTE FUNCTION guard_company_historical_branch_link();
CREATE TRIGGER company_historical_branch_links_immutable BEFORE UPDATE OR DELETE ON company_historical_branch_links FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER audit_company_historical_branch_links AFTER INSERT OR UPDATE OR DELETE ON company_historical_branch_links FOR EACH ROW EXECUTE FUNCTION audit_row_change();
GRANT SELECT,INSERT ON company_historical_branch_links TO app_user;
REVOKE UPDATE,DELETE,TRUNCATE ON company_historical_branch_links FROM app_user;

-- Narrow audited branch addition: standalone manual transfer only, not any approved shift fact.
CREATE FUNCTION guard_audited_branch_transfer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_office text; v_amount bigint; v_side text;
BEGIN
  IF NEW.prior_period_reason IS NULL OR NOT EXISTS(SELECT 1 FROM public.branches WHERE id=NEW.branch_id AND kind='branch') THEN RETURN NULL; END IF;
  SELECT f.code,l.amount_minor,l.side::text INTO v_office,v_amount,v_side FROM public.journal_lines l JOIN public.funds f ON f.id=l.fund_id
    WHERE l.entry_id=NEW.id AND f.code IN('office_cash','office_wallet') AND f.branch_id=NEW.branch_id;
  IF NEW.event_type::text<>'manual' OR NEW.shift_id IS NOT NULL OR v_amount IS NULL
    OR NOT public.ash_actor_holds_all(NEW.created_by,'journal.manual.write')
    OR NOT public.ash_company_lines_match(NEW.id,NEW.branch_id,jsonb_build_array(
      public.ash_company_line(v_office,CASE v_office WHEN 'office_cash' THEN 'office_cash' ELSE 'office_wallet' END,'SYP_NEW',v_side,v_amount,
        CASE WHEN v_side='D' AND EXISTS(SELECT 1 FROM public.journal_lines l JOIN public.funds f ON f.id=l.fund_id WHERE l.entry_id=NEW.id AND f.code='company_box') THEN 'shahn' ELSE NULL END),
      public.ash_company_line(CASE WHEN EXISTS(SELECT 1 FROM public.journal_lines l JOIN public.funds f ON f.id=l.fund_id WHERE l.entry_id=NEW.id AND f.code='company_box') THEN 'company_box' ELSE 'owner_funding' END,
        CASE WHEN EXISTS(SELECT 1 FROM public.journal_lines l JOIN public.funds f ON f.id=l.fund_id WHERE l.entry_id=NEW.id AND f.code='company_box') THEN 'company_box' ELSE 'owner_funding' END,
        'SYP_NEW',CASE v_side WHEN 'D' THEN 'C' ELSE 'D' END,v_amount,CASE WHEN v_side='C' THEN 'kaish' ELSE NULL END)))
  THEN RAISE EXCEPTION 'audited branch addition must be an exact standalone transfer' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entries_audited_branch_transfer AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_audited_branch_transfer();

CREATE OR REPLACE FUNCTION assert_company_journal_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_ok boolean;
BEGIN
  IF NOT public.ash_is_company_event(NEW.event_type::text) THEN RETURN NULL; END IF;
  v_ok:=NEW.shift_id IS NULL AND CASE NEW.event_type::text
    WHEN 'company_deposit' THEN EXISTS(SELECT 1 FROM public.company_moves WHERE journal_entry_id=NEW.id AND kind='deposit')
    WHEN 'company_withdrawal' THEN EXISTS(SELECT 1 FROM public.company_moves WHERE journal_entry_id=NEW.id AND kind='withdrawal')
    WHEN 'company_expense' THEN EXISTS(SELECT 1 FROM public.company_expenses WHERE journal_entry_id=NEW.id)
    WHEN 'company_income' THEN EXISTS(SELECT 1 FROM public.company_incomes WHERE journal_entry_id=NEW.id)
    WHEN 'company_fx_exchange' THEN EXISTS(SELECT 1 FROM public.company_fx_exchanges WHERE journal_entry_id=NEW.id)
    WHEN 'company_correction' THEN EXISTS(SELECT 1 FROM public.company_reversals WHERE journal_entry_id=NEW.id)
    WHEN 'company_opening_transfer' THEN EXISTS(SELECT 1 FROM public.company_ledger_cutovers WHERE opening_entry_id=NEW.id)
    WHEN 'company_restoration_mirror' THEN EXISTS(SELECT 1 FROM public.company_restoration_mirrors WHERE mirror_entry_id=NEW.id)
    WHEN 'company_historical_transfer' THEN EXISTS(SELECT 1 FROM public.company_historical_transfers WHERE journal_entry_id=NEW.id) OR EXISTS(SELECT 1 FROM public.company_historical_branch_links WHERE company_entry_id=NEW.id AND created_entry)
    WHEN 'company_historical_restoration_reclass' THEN EXISTS(SELECT 1 FROM public.company_historical_restoration_settlement_legs WHERE journal_entry_id=NEW.id)
    WHEN 'company_debt_open' THEN EXISTS(SELECT 1 FROM public.company_debts WHERE journal_entry_id=NEW.id)
    WHEN 'company_debt_payment' THEN EXISTS(SELECT 1 FROM public.company_debt_events WHERE journal_entry_id=NEW.id AND kind='payment')
    WHEN 'company_debt_writeoff' THEN EXISTS(SELECT 1 FROM public.company_debt_events WHERE journal_entry_id=NEW.id AND kind='writeoff')
    WHEN 'asset_purchase' THEN EXISTS(SELECT 1 FROM public.fixed_assets WHERE journal_entry_id=NEW.id)
    WHEN 'depreciation_transfer' THEN EXISTS(SELECT 1 FROM public.depreciation_transfers WHERE journal_entry_id=NEW.id)
    WHEN 'depreciation_release' THEN EXISTS(SELECT 1 FROM public.depreciation_releases WHERE journal_entry_id=NEW.id)
    ELSE false END;
  IF NOT COALESCE(v_ok,false) THEN RAISE EXCEPTION 'company journal requires its immutable command in the same transaction'
    USING ERRCODE='23514',CONSTRAINT='company_journal_fact_guard'; END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION assert_posting_week_open() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_lock public.week_locks%ROWTYPE; v_book_closed boolean;
BEGIN
  IF TG_OP='UPDATE' AND NEW.week_lock_id IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock_shared(public.fin_week_seal_guard_key(NEW.branch_id));
  SELECT * INTO v_lock FROM public.week_locks WHERE branch_id=NEW.branch_id
    AND NEW.business_date BETWEEN week_start_date AND week_end_date AND closed_at IS NOT NULL;
  SELECT EXISTS(SELECT 1 FROM public.week_locks WHERE branch_id=NEW.branch_id
    AND week_start_date=NEW.week_start_date AND closed_at IS NOT NULL) INTO v_book_closed;
  IF NEW.prior_period_reason IS NOT NULL THEN
    IF NEW.created_by IS DISTINCT FROM public.ash_current_actor()
      OR NOT public.ash_actor_holds_all(NEW.created_by,'company_fund.manage')
      OR NOT EXISTS(SELECT 1 FROM public.branches WHERE id=NEW.branch_id AND (kind='company' OR
        (kind='branch' AND NEW.event_type::text='manual' AND EXISTS(SELECT 1 FROM public.users WHERE id=NEW.created_by AND role_key IN('general_manager','system_admin')))))
      OR NEW.shift_id IS NOT NULL OR NEW.posting_date IS DISTINCT FROM NEW.business_date
      OR NEW.week_start_date IS DISTINCT FROM NEW.business_date-EXTRACT(DOW FROM NEW.business_date)::integer
      OR NEW.event_type::text NOT IN ('company_deposit','company_withdrawal','company_expense','company_income','company_fx_exchange','company_correction','company_custody_transfer','company_restoration_mirror','company_historical_transfer','manual')
      OR NEW.reason IS DISTINCT FROM NEW.prior_period_reason
    THEN RAISE EXCEPTION 'invalid audited prior company period addition'
      USING ERRCODE='23514',CONSTRAINT='company_prior_period_actor_guard'; END IF;
    IF v_lock.id IS NOT NULL THEN NEW.week_lock_id:=v_lock.id; END IF;
    RETURN NEW;
  END IF;
  IF v_lock.id IS NOT NULL OR v_book_closed OR NEW.week_lock_id IS NOT NULL THEN
    RAISE EXCEPTION 'sealed week requires an attributed company prior-period addition; branch periods remain closed'
      USING ERRCODE='25006';
  END IF;
  RETURN NEW;
END $$;
