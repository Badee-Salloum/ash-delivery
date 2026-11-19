-- Link-only branch activation: a frozen historical discrepancy is evidence, not a cash receipt.
-- Existing cash-opening rows and journals stay immutable. New activation creates no journal.
ALTER TABLE company_ledger_cutovers
  ADD COLUMN mode text NOT NULL DEFAULT 'cash_opening' CHECK (mode IN ('cash_opening','link_only')),
  ADD COLUMN baseline_difference_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE company_ledger_cutovers DROP CONSTRAINT company_ledger_cutovers_opening_ck;
ALTER TABLE company_ledger_cutovers DROP CONSTRAINT company_ledger_cutovers_opening_amount_minor_check;
ALTER TABLE company_ledger_cutovers ADD CONSTRAINT company_ledger_cutovers_opening_ck CHECK (
  (mode='link_only' AND opening_entry_id IS NULL) OR
  (mode='cash_opening' AND baseline_difference_minor=0 AND opening_amount_minor>=0
    AND ((opening_amount_minor=0)=(opening_entry_id IS NULL))));

CREATE OR REPLACE FUNCTION guard_company_cutover_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_actor uuid:=public.ash_current_actor(); v_box numeric; v_clearing numeric;
BEGIN
  IF v_actor IS NULL OR NEW.performed_by IS DISTINCT FROM v_actor
    OR NOT public.ash_actor_holds_all(v_actor,'company_fund.manage')
    OR NOT public.ash_actor_holds_all(v_actor,'settings.write')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=v_actor AND active)
    OR NOT EXISTS(SELECT 1 FROM public.branches WHERE id=NEW.branch_id AND kind='branch')
    OR NOT EXISTS(SELECT 1 FROM public.branches WHERE id=NEW.company_branch_id AND kind='company')
  THEN RAISE EXCEPTION 'link-only activation requires its attributed authorized manager and branch/HQ'
    USING ERRCODE='23514',CONSTRAINT='company_cutovers_actor_guard'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ash:financial:receivables:'||NEW.branch_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ash:financial:receivables:'||NEW.company_branch_id::text,0));
  v_box:=public.ash_fund_balance(NEW.branch_id,'company_box');
  v_clearing:=public.ash_fund_balance(NEW.company_branch_id,'branch_clearing:'||NEW.branch_id::text);
  -- Preserve the old audited repository protocol for existing integrations. The public API no
  -- longer creates this mode; its exact journal/actor/watermark guards are not relaxed.
  IF NEW.mode='cash_opening' THEN
    IF NEW.opening_amount_minor::numeric<>v_box THEN
      RAISE EXCEPTION 'cutover opening differs from branch company_box'
        USING ERRCODE='23514',CONSTRAINT='company_cutovers_opening_guard'; END IF;
    IF NEW.watermark_entry_id>(SELECT COALESCE(max(id),0) FROM public.journal_entries)
      OR EXISTS(SELECT 1 FROM public.journal_lines jl JOIN public.funds f ON f.id=jl.fund_id
        WHERE f.branch_id=NEW.branch_id AND f.type::text='company_box' AND jl.entry_id>NEW.watermark_entry_id)
    THEN RAISE EXCEPTION 'cutover watermark does not cover branch history'
      USING ERRCODE='23514',CONSTRAINT='company_cutovers_watermark_guard'; END IF;
    IF NEW.opening_amount_minor>0 AND (
      NEW.opening_entry_id<=NEW.watermark_entry_id
      OR NOT public.ash_company_entry_is(NEW.opening_entry_id,NEW.company_branch_id,'company_opening_transfer',
        'opening:'||NEW.branch_id::text,NEW.business_date,NEW.reason,NEW.performed_by,NULL)
      OR NOT public.ash_company_lines_match(NEW.opening_entry_id,NEW.company_branch_id,jsonb_build_array(
        public.ash_company_line('company_cash:SYP_NEW','company_cash','SYP_NEW','D',NEW.opening_amount_minor,'opening_transfer'),
        public.ash_company_line('branch_clearing:'||NEW.branch_id::text,'branch_clearing','SYP_NEW','C',NEW.opening_amount_minor,'opening_transfer'))))
    THEN RAISE EXCEPTION 'cutover opening differs from exact old journal'
      USING ERRCODE='23514',CONSTRAINT='company_cutovers_journal_guard'; END IF;
    IF v_clearing<>-NEW.opening_amount_minor::numeric OR NEW.baseline_difference_minor<>0 THEN
      RAISE EXCEPTION 'old cash-opening clearing differs'
        USING ERRCODE='23514',CONSTRAINT='company_cutovers_clearing_guard'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.mode IS DISTINCT FROM 'link_only' OR NEW.opening_entry_id IS NOT NULL
    OR NEW.opening_amount_minor::numeric<>v_box
    OR NEW.baseline_difference_minor::numeric<>v_box+v_clearing-public.ash_restoration_pending_difference(NEW.branch_id)
    OR NEW.watermark_entry_id<>(SELECT COALESCE(max(id),0) FROM public.journal_entries)
  THEN RAISE EXCEPTION 'activation must freeze exact locked balances/watermark without a cash opening'
    USING ERRCODE='23514',CONSTRAINT='company_cutovers_link_only_guard'; END IF;
  RETURN NEW;
END $$;

-- The baseline is not subtracted from UI discrepancies. It only establishes the frozen starting
-- invariant so real future branch/HQ changes remain accountable while that discrepancy is reviewed.
CREATE OR REPLACE FUNCTION assert_company_box_mirrored() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_type text; v_fund_branch uuid; v_code text; v_branch uuid;
  v_cutover public.company_ledger_cutovers%ROWTYPE;
BEGIN
  SELECT f.type::text,f.branch_id,f.code INTO v_type,v_fund_branch,v_code FROM public.funds f WHERE f.id=NEW.fund_id;
  IF v_type='company_box' THEN v_branch:=v_fund_branch;
  ELSIF v_type='branch_clearing' THEN
    IF v_code !~ '^branch_clearing:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN RAISE EXCEPTION 'invalid clearing branch' USING ERRCODE='23514'; END IF;
    v_branch:=substr(v_code,17)::uuid;
  ELSE RETURN NULL; END IF;
  SELECT * INTO v_cutover FROM public.company_ledger_cutovers WHERE branch_id=v_branch;
  IF v_cutover.branch_id IS NULL THEN
    IF v_type='branch_clearing' THEN RAISE EXCEPTION 'clearing without cutover' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;
  IF v_type='branch_clearing' AND v_fund_branch IS DISTINCT FROM v_cutover.company_branch_id
  THEN RAISE EXCEPTION 'clearing outside HQ' USING ERRCODE='23514'; END IF;
  IF v_type='company_box' AND NEW.entry_id>v_cutover.watermark_entry_id
    AND NOT EXISTS(SELECT 1 FROM public.company_restoration_mirrors WHERE source_entry_id=NEW.entry_id)
    AND NOT EXISTS(SELECT 1 FROM public.company_restoration_proposal_legs WHERE source_entry_id=NEW.entry_id)
  THEN RAISE EXCEPTION 'company_box entry needs existing mirror or actual-restoration proposal'
    USING ERRCODE='23514',CONSTRAINT='company_box_mirror_guard'; END IF;
  IF public.ash_fund_balance(v_branch,'company_box')+
    public.ash_fund_balance(v_cutover.company_branch_id,'branch_clearing:'||v_branch::text)
    <>v_cutover.baseline_difference_minor::numeric+public.ash_restoration_pending_difference(v_branch)-public.ash_restoration_historical_offset(v_branch)
  THEN RAISE EXCEPTION 'difference changed without frozen baseline or reviewed source evidence'
    USING ERRCODE='23514',CONSTRAINT='company_clearing_invariant_guard'; END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION assert_company_cutover_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_branch uuid; v_company uuid; v_baseline numeric;
BEGIN
  IF TG_TABLE_NAME='company_ledger_cutovers' THEN v_branch:=NEW.branch_id; v_company:=NEW.company_branch_id;
  ELSE v_branch:=NEW.source_branch_id; SELECT company_branch_id INTO v_company FROM public.company_ledger_cutovers WHERE branch_id=v_branch; END IF;
  SELECT baseline_difference_minor::numeric INTO v_baseline FROM public.company_ledger_cutovers WHERE branch_id=v_branch;
  IF public.ash_fund_balance(v_branch,'company_box')+public.ash_fund_balance(v_company,'branch_clearing:'||v_branch::text)
    <>COALESCE(v_baseline,0)+public.ash_restoration_pending_difference(v_branch)-public.ash_restoration_historical_offset(v_branch)
  THEN RAISE EXCEPTION 'difference changed without frozen baseline or reviewed source evidence'
    USING ERRCODE='23514',CONSTRAINT='company_clearing_invariant_guard'; END IF;
  RETURN NULL;
END $$;
COMMENT ON COLUMN company_ledger_cutovers.baseline_difference_minor IS
  'Immutable disclosed unmatched starting difference, not money, income, expense or a balancing journal.';
CREATE OR REPLACE FUNCTION guard_company_restoration_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_current integer; v_confirmed boolean;
BEGIN
  IF NEW.created_by IS DISTINCT FROM public.ash_current_actor()
    OR NOT public.ash_actor_holds_all(NEW.created_by,'company_fund.manage')
    OR NEW.payload->>'id' IS DISTINCT FROM NEW.id::text
    OR NEW.payload->>'proposalId' IS DISTINCT FROM NEW.proposal_id::text
    OR NEW.payload->>'kind' IS DISTINCT FROM NEW.kind
    OR NEW.payload->>'version' IS DISTINCT FROM NEW.version::text
    OR NEW.payload->>'reason' IS DISTINCT FROM NEW.reason
    OR NEW.payload->>'createdBy' IS DISTINCT FROM NEW.created_by::text
    OR NEW.payload->>'occurredOn' IS DISTINCT FROM NEW.occurred_on::text
    OR NEW.payload->>'businessDate' IS DISTINCT FROM NEW.business_date::text
  THEN RAISE EXCEPTION 'HQ review requires its attributed company manager and matching immutable payload'
    USING ERRCODE='23514', CONSTRAINT='company_restoration_review_actor_guard'; END IF;
  SELECT COALESCE(max(version),0),COALESCE(bool_or(kind IN ('confirm','correct')),false)
    INTO v_current,v_confirmed FROM public.company_restoration_review_revisions WHERE proposal_id=NEW.proposal_id;
  IF NEW.version <> v_current+1 OR (NEW.kind IN ('confirm','revise','defer') AND v_confirmed)
    OR (NEW.kind='correct' AND NOT v_confirmed)
  THEN RAISE EXCEPTION 'restoration review version or confirmation state conflict'
    USING ERRCODE='23514', CONSTRAINT='company_restoration_review_version_guard'; END IF;
  RETURN NEW;
END $$;

-- Historical adoption explains part of the frozen baseline; subtract its original source net
-- because it was already present at activation, rather than treating it as a new branch movement.
CREATE FUNCTION ash_restoration_historical_offset(p_branch uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT COALESCE(sum((CASE l.direction WHEN 'to_company' THEN 1 ELSE -1 END)::numeric*l.amount_minor),0)
    FROM public.company_restoration_proposal_legs l JOIN public.company_restoration_proposals p ON p.id=l.proposal_id
    WHERE p.source_branch_id=p_branch AND p.payload->>'origin'='historical'
$$;
CREATE OR REPLACE FUNCTION guard_company_restoration_proposal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_run public.restorations%ROWTYPE; v_actor uuid := public.ash_current_actor();
BEGIN
  SELECT * INTO v_run FROM public.restorations WHERE id=NEW.restoration_id;
  IF v_actor IS NULL OR v_actor IS DISTINCT FROM NEW.created_by
    OR (COALESCE(NEW.payload->>'origin','live')<>'historical' AND v_run.performed_by IS DISTINCT FROM v_actor)
    OR v_run.branch_id IS DISTINCT FROM NEW.source_branch_id
    OR v_run.business_date IS DISTINCT FROM NEW.business_date
    OR (v_run.plan->>'schemaVersion')::integer IS DISTINCT FROM 4
    OR NEW.payload->'snapshot' IS DISTINCT FROM jsonb_build_object('openingBalances',v_run.plan->'openingBalances','legs',v_run.plan->'legs')
    OR NOT EXISTS (SELECT 1 FROM public.company_ledger_cutovers c
      WHERE c.branch_id=NEW.source_branch_id AND c.company_branch_id=NEW.company_branch_id)
    OR NOT EXISTS (SELECT 1 FROM public.users u JOIN public.role_permissions rp ON rp.role_key=u.role_key
      WHERE u.id=v_actor AND u.active AND rp.permission_key='journal.manual.write'
      AND (rp.scope='all' OR (rp.scope='branch' AND u.branch_id=NEW.source_branch_id)))
    OR (NEW.payload->>'origin'='historical' AND (
      NOT public.ash_actor_holds_all(v_actor,'company_fund.manage')
      OR NOT EXISTS(SELECT 1 FROM public.company_ledger_cutovers c WHERE c.branch_id=NEW.source_branch_id AND c.mode='link_only')
      OR EXISTS(SELECT 1 FROM public.company_historical_import_receipts h WHERE h.restoration_id=NEW.restoration_id
        AND h.source_branch_id=NEW.source_branch_id AND h.journal_entry_id IS NOT NULL)))
    OR NEW.payload->>'id' IS DISTINCT FROM NEW.id::text
    OR NEW.payload->>'branchId' IS DISTINCT FROM NEW.source_branch_id::text
    OR NEW.payload->>'companyBranchId' IS DISTINCT FROM NEW.company_branch_id::text
    OR NEW.payload->>'restorationId' IS DISTINCT FROM NEW.restoration_id::text
    OR NEW.payload->>'businessDate' IS DISTINCT FROM NEW.business_date::text
    OR NEW.payload->>'createdBy' IS DISTINCT FROM NEW.created_by::text
  THEN RAISE EXCEPTION 'restoration proposal differs from its executed branch run or actor'
    USING ERRCODE='23514', CONSTRAINT='company_restoration_proposal_source_guard'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_company_restoration_proposal_leg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_proposal public.company_restoration_proposals%ROWTYPE; v_source public.journal_entries%ROWTYPE; v_expected jsonb;
BEGIN
  SELECT * INTO v_proposal FROM public.company_restoration_proposals WHERE id=NEW.proposal_id;
  SELECT * INTO v_source FROM public.journal_entries WHERE id=NEW.source_entry_id;
  IF v_source.branch_id IS DISTINCT FROM v_proposal.source_branch_id OR v_source.event_type::text IS DISTINCT FROM 'restoration'
    OR v_source.business_date IS DISTINCT FROM v_proposal.business_date
    OR NOT EXISTS (SELECT 1 FROM public.company_ledger_cutovers c WHERE c.branch_id=v_proposal.source_branch_id
      AND ((COALESCE(v_proposal.payload->>'origin','live')<>'historical' AND NEW.source_entry_id>c.watermark_entry_id)
        OR (v_proposal.payload->>'origin'='historical' AND c.mode='link_only' AND NEW.source_entry_id<=c.watermark_entry_id)))
    OR EXISTS (SELECT 1 FROM public.company_restoration_mirrors m WHERE m.source_entry_id=NEW.source_entry_id)
    OR NOT EXISTS (SELECT 1 FROM public.restorations r WHERE r.id=v_proposal.restoration_id
      AND r.plan->'restorationJournalEntryIds' @> to_jsonb(NEW.source_entry_id))
    OR (SELECT count(*) FROM public.journal_lines jl JOIN public.funds f ON f.id=jl.fund_id
      WHERE jl.entry_id=NEW.source_entry_id AND f.code='company_box' AND f.branch_id=v_proposal.source_branch_id
      AND jl.amount_minor=NEW.amount_minor AND jl.side::text=CASE NEW.direction WHEN 'to_company' THEN 'D' ELSE 'C' END) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.journal_lines jl JOIN public.funds f ON f.id=jl.fund_id
      WHERE jl.entry_id=NEW.source_entry_id AND f.code=NEW.fund_code AND f.branch_id=v_proposal.source_branch_id
      AND jl.amount_minor=NEW.amount_minor AND jl.side::text=CASE NEW.direction WHEN 'to_company' THEN 'C' ELSE 'D' END)
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_proposal.payload->'legs') leg
      WHERE leg->>'sourceEntryId'=NEW.source_entry_id::text AND leg->>'fundCode'=NEW.fund_code
      AND leg->>'direction'=NEW.direction AND leg->'amount'->>'minor'=NEW.amount_minor::text
      AND leg->'sourceEntry'->>'id'=NEW.source_entry_id::text
      AND leg->'sourceEntry'->>'branchId'=v_proposal.source_branch_id::text
      AND leg->'sourceEntry'->>'eventType'='restoration'
      AND leg->'sourceEntry'->>'occurrenceKey'=v_source.occurrence_key
      AND leg->'sourceEntry'->>'businessDate'=v_source.business_date::text)
  THEN RAISE EXCEPTION 'proposal leg must name its immutable actual branch restoration journal'
    USING ERRCODE='23514', CONSTRAINT='company_restoration_proposal_leg_guard'; END IF;
  RETURN NEW;
END $$;
