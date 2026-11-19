-- Additions are new immutable entries, not reopening or rewriting sealed journals/shift facts.
ALTER TABLE journal_entries ADD COLUMN prior_period_reason text
  CHECK (prior_period_reason IS NULL OR (ash_has_visible_text(prior_period_reason) AND char_length(prior_period_reason)<=500));

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
      OR NOT EXISTS(SELECT 1 FROM public.branches WHERE id=NEW.branch_id AND kind='company')
      OR NEW.shift_id IS NOT NULL OR NEW.posting_date IS DISTINCT FROM NEW.business_date
      OR NEW.week_start_date IS DISTINCT FROM NEW.business_date-EXTRACT(DOW FROM NEW.business_date)::integer
      OR NEW.event_type::text NOT IN ('company_deposit','company_withdrawal','company_expense','company_income','company_fx_exchange','company_correction','company_custody_transfer')
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

-- Permit initial lines only while their explicitly audited header is being created here.
-- After commit its closed-week stamp refuses every subsequent insert/update/delete as before.
CREATE OR REPLACE FUNCTION assert_week_not_locked() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_week_lock_id bigint; v_closed_at timestamptz;
BEGIN
  IF TG_TABLE_NAME='journal_entries' THEN v_week_lock_id:=OLD.week_lock_id;
  ELSE
    SELECT week_lock_id INTO v_week_lock_id FROM public.journal_entries
      WHERE id=COALESCE(NEW.entry_id,OLD.entry_id);
    IF TG_OP='INSERT' AND EXISTS (
      SELECT 1 FROM public.journal_entries j WHERE j.id=NEW.entry_id
        AND j.prior_period_reason IS NOT NULL
        AND j.xmin::text=(txid_current() % 4294967296)::text
        AND j.created_by=public.ash_current_actor()
        AND public.ash_actor_holds_all(j.created_by,'company_fund.manage')
    ) THEN RETURN NEW; END IF;
  END IF;
  IF v_week_lock_id IS NULL THEN RETURN COALESCE(NEW,OLD); END IF;
  SELECT closed_at INTO v_closed_at FROM public.week_locks WHERE id=v_week_lock_id;
  IF v_closed_at IS NOT NULL THEN RAISE EXCEPTION 'closed-period journal is immutable'
    USING ERRCODE='25006'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

-- Only attributed HQ additions may record an observed historical cash shortage.
CREATE OR REPLACE FUNCTION assert_company_pocket_not_negative() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_type text; v_event text;
BEGIN
  SELECT type::text INTO v_type FROM public.funds WHERE id=NEW.fund_id;
  IF v_type IS NULL OR v_type NOT IN('company_cash','depreciation_reserve') THEN RETURN NULL; END IF;
  SELECT event_type::text INTO v_event FROM public.journal_entries WHERE id=NEW.entry_id;
  IF v_event IS NULL OR v_event IN('company_restoration_mirror','company_historical_transfer') THEN RETURN NULL; END IF;
  IF v_type='company_cash' AND (
    EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=NEW.entry_id AND j.prior_period_reason IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.company_movement_metadata m JOIN public.journal_entries j ON j.branch_id=m.branch_id AND j.occurrence_key=m.command_id::text WHERE j.id=NEW.entry_id AND j.external_reference IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.company_movement_correction_versions c WHERE c.status='confirmed' AND (c.reversal_entry_id=NEW.entry_id OR c.replacement_entry_id=NEW.entry_id))
  ) THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.funds WHERE id=NEW.fund_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.journal_lines WHERE fund_id=NEW.fund_id HAVING COALESCE(sum(CASE side WHEN 'D' THEN amount_minor ELSE -amount_minor END),0)<0)
  THEN RAISE EXCEPTION 'company pocket would go below zero' USING ERRCODE='23514',CONSTRAINT='company_pocket_negative_guard'; END IF;
  RETURN NULL;
END $$;
