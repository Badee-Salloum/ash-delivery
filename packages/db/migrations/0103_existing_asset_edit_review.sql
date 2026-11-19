-- Audited card edit approval. No cash entry, no replacement of completed depreciation rows.
ALTER TABLE company_existing_asset_events DROP CONSTRAINT company_existing_asset_events_kind_check;
ALTER TABLE company_existing_asset_events ADD CONSTRAINT company_existing_asset_events_kind_check CHECK(kind IN('register','edit','edit_confirm','edit_reject','depreciation_activate','recognition_link','sale_draft','sale_confirm','sale_documentary','evidence_link'));

CREATE FUNCTION ash_existing_calculation_schedule(p_card jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_result jsonb:='[]'; v_policy jsonb:=p_card->'depreciation'; v_count integer; v_base bigint; v_total bigint; v_month date; v_start date;
BEGIN
  IF p_card ? 'depreciationSchedule' THEN RETURN p_card->'depreciationSchedule'; END IF;
  IF v_policy IS NULL OR v_policy='null'::jsonb THEN RETURN v_result; END IF;
  v_count:=(v_policy->>'usefulMonths')::integer;
  v_total:=(p_card->>'price')::bigint-(v_policy->>'residualValue')::bigint;
  v_base:=v_total/v_count; v_start:=(v_policy->>'startsOn')::date;
  FOR i IN 0..v_count-1 LOOP
    v_month:=(date_trunc('month',v_start)+make_interval(months=>i))::date;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('period',i+1,'periodMonth',to_char(v_month,'YYYY-MM-DD'),
      'startsOn',to_char(CASE WHEN i=0 THEN v_start ELSE v_month END,'YYYY-MM-DD'),
      'endsOn',to_char((v_month+interval '1 month'-interval '1 day')::date,'YYYY-MM-DD'),
      'amount',(CASE WHEN i=v_count-1 THEN v_total-v_base*(v_count-1) ELSE v_base END)::text));
  END LOOP; RETURN v_result;
END $$;
CREATE FUNCTION ash_existing_revised_schedule(p_card jsonb,p_price bigint,p_effective date) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_schedule jsonb:=public.ash_existing_calculation_schedule(p_card); v_result jsonb:='[]'; v_row jsonb;
  v_frozen numeric; v_count integer; v_remaining bigint; v_base bigint; v_index integer:=0;
BEGIN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_schedule) r WHERE (r->>'startsOn')::date<p_effective AND (r->>'endsOn')::date>=p_effective)
  THEN RAISE EXCEPTION 'calculation revision requires an untouched period boundary' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum((r->>'amount')::bigint),0) INTO v_frozen FROM jsonb_array_elements(v_schedule) r WHERE (r->>'endsOn')::date<p_effective;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(v_schedule) r WHERE (r->>'startsOn')::date>=p_effective;
  v_remaining:=p_price-v_frozen-(p_card->'depreciation'->>'residualValue')::bigint;
  IF v_remaining<0 THEN RAISE EXCEPTION 'new price is below frozen depreciation and residual' USING ERRCODE='23514'; END IF;
  v_base:=CASE WHEN v_count=0 THEN 0 ELSE v_remaining/v_count END;
  FOR v_row IN SELECT value FROM jsonb_array_elements(v_schedule) LOOP
    IF (v_row->>'startsOn')::date>=p_effective THEN
      v_index:=v_index+1;
      v_row:=jsonb_set(v_row,'{amount}',to_jsonb((CASE WHEN v_index=v_count THEN v_remaining-v_base*(v_count-1) ELSE v_base END)::text));
    END IF;
    v_result:=v_result||jsonb_build_array(v_row);
  END LOOP; RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION guard_existing_asset_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp
AS $$
DECLARE
  v_actor uuid := public.ash_current_actor();
  v_prior public.company_existing_assets%ROWTYPE;
  v_vehicle uuid := (NEW.snapshot->>'vehicleId')::uuid;
  v_policy jsonb := NEW.snapshot->'depreciation';
  v_recognition jsonb := NEW.snapshot->'recognition';
  v_sale jsonb := NEW.snapshot->'sale';
  v_account text;
  v_cost bigint;
  v_amount bigint;
BEGIN
  IF v_actor IS NULL OR NEW.created_by IS DISTINCT FROM v_actor
    OR NOT public.ash_actor_holds_all(v_actor,'company_fund.manage') THEN
    RAISE EXCEPTION 'existing asset revision requires its attributed company manager'
      USING ERRCODE='23514', CONSTRAINT='existing_asset_actor_guard';
  END IF;
  SELECT * INTO v_prior FROM public.company_existing_assets WHERE id=NEW.asset_id FOR UPDATE;
  IF NEW.expected_version IS DISTINCT FROM COALESCE(v_prior.version,0)
    OR ((v_prior.id IS NULL) IS DISTINCT FROM (NEW.kind='register'))
    OR NEW.snapshot->>'id' IS DISTINCT FROM NEW.asset_id::text
    OR NEW.snapshot->>'branchId' IS DISTINCT FROM NEW.branch_id::text
    OR (NEW.snapshot->>'version')::integer IS DISTINCT FROM NEW.version
    OR NEW.snapshot->>'updatedBy' IS DISTINCT FROM v_actor::text
    OR (v_prior.id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM v_prior.branch_id) THEN
    RAISE EXCEPTION 'existing asset revision differs from its expected source'
      USING ERRCODE='23514', CONSTRAINT='existing_asset_version_guard';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ash:asset_vehicle:'||v_vehicle::text,0));
  IF EXISTS (SELECT 1 FROM public.fixed_assets WHERE vehicle_id=v_vehicle) THEN
    RAISE EXCEPTION 'vehicle already has a purchased asset'
      USING ERRCODE='23514', CONSTRAINT='existing_asset_legacy_vehicle_guard';
  END IF;
  IF NEW.kind='register' AND (NEW.snapshot->>'accountingStatus'<>'pending_review'
    OR NEW.snapshot->>'status' NOT IN ('draft','registered')
    OR v_policy IS DISTINCT FROM 'null'::jsonb
    OR v_recognition IS DISTINCT FROM 'null'::jsonb OR v_sale IS DISTINCT FROM 'null'::jsonb) THEN
    RAISE EXCEPTION 'registration must not activate accounting, depreciation or sale'
      USING ERRCODE='23514', CONSTRAINT='existing_asset_neutral_registration_guard';
  END IF;
  IF v_prior.id IS NOT NULL AND NEW.kind NOT IN ('edit_confirm','edit_reject') THEN
    IF NEW.snapshot->>'createdBy' IS DISTINCT FROM v_prior.snapshot->>'createdBy'
      OR NEW.snapshot->>'createdAtMs' IS DISTINCT FROM v_prior.snapshot->>'createdAtMs'
      OR (NEW.kind<>'edit' AND (NEW.snapshot - ARRAY['version','updatedBy','updatedAtMs','depreciation','recognition','accountingStatus','sale','status'])
         IS DISTINCT FROM (v_prior.snapshot - ARRAY['version','updatedBy','updatedAtMs','depreciation','recognition','accountingStatus','sale','status']))
      OR (NEW.kind<>'depreciation_activate' AND NEW.snapshot->'depreciation' IS DISTINCT FROM v_prior.snapshot->'depreciation')
      OR (NEW.kind<>'recognition_link' AND NEW.snapshot->'recognition' IS DISTINCT FROM v_prior.snapshot->'recognition')
      OR (NEW.kind NOT IN ('sale_draft','sale_confirm','sale_documentary') AND NEW.snapshot->'sale' IS DISTINCT FROM v_prior.snapshot->'sale')
      OR (NEW.kind NOT IN ('edit','sale_confirm','sale_documentary') AND NEW.snapshot->>'status' IS DISTINCT FROM v_prior.status)
      OR (NEW.kind NOT IN ('edit','recognition_link') AND NEW.snapshot->>'accountingStatus' IS DISTINCT FROM v_prior.accounting_status)
      OR (NEW.kind='edit' AND NEW.snapshot->>'accountingStatus' NOT IN (v_prior.accounting_status,'needs_correction')) THEN
      RAISE EXCEPTION 'asset command changed unrelated or immutable state'
        USING ERRCODE='23514', CONSTRAINT='existing_asset_command_scope_guard';
    END IF;
  END IF;

  IF NEW.kind='edit_reject' THEN
    IF COALESCE(v_prior.snapshot->'pendingEdit','null'::jsonb)='null'::jsonb
      OR NEW.snapshot->'pendingEdit' IS DISTINCT FROM 'null'::jsonb
      OR (NEW.snapshot-ARRAY['version','updatedBy','updatedAtMs','pendingEdit'])
         IS DISTINCT FROM (v_prior.snapshot-ARRAY['version','updatedBy','updatedAtMs','pendingEdit'])
    THEN RAISE EXCEPTION 'rejection only clears an existing edit proposal' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.kind='edit_confirm' THEN
    IF v_prior.id IS NULL OR v_prior.status='sold'
      OR COALESCE(v_prior.snapshot->'pendingEdit','null'::jsonb)='null'::jsonb
      OR NEW.snapshot->'pendingEdit' IS DISTINCT FROM 'null'::jsonb
      OR NEW.snapshot->>'currency' IS DISTINCT FROM v_prior.currency
      OR NEW.snapshot->>'accountingStatus' IS DISTINCT FROM v_prior.accounting_status
      OR NEW.snapshot->>'status' IS DISTINCT FROM v_prior.status
      OR NEW.snapshot->'depreciation' IS DISTINCT FROM v_prior.snapshot->'depreciation'
      OR NEW.snapshot->'sale' IS DISTINCT FROM v_prior.snapshot->'sale'
      OR NEW.snapshot->>'createdBy' IS DISTINCT FROM v_prior.snapshot->>'createdBy'
      OR NEW.snapshot->>'createdAtMs' IS DISTINCT FROM v_prior.snapshot->>'createdAtMs'
      OR (NEW.snapshot->>'price')::bigint IS NULL OR (NEW.snapshot->>'price')::bigint<=0
      OR NEW.snapshot->>'useStartedOn' IS NULL
      OR NEW.snapshot->'lastEditReview'->>'requestId' IS DISTINCT FROM v_prior.snapshot->'pendingEdit'->>'requestId'
      OR NEW.snapshot->'lastEditReview'->>'reason' IS DISTINCT FROM NEW.reason
      OR (NEW.snapshot->'lastEditReview'->>'effectiveOn')::date IS NULL
      OR (NEW.snapshot->'lastEditReview'->>'effectiveOn')::date<(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Damascus')::date
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['vehicleId','name','currency','price','purchasedOn','useStartedOn','fundingSource','description']) k
        WHERE NEW.snapshot->k IS DISTINCT FROM v_prior.snapshot->'pendingEdit'->k)
      OR (NEW.snapshot-ARRAY['version','updatedBy','updatedAtMs','pendingEdit','vehicleId','name','currency','price','purchasedOn','useStartedOn','fundingSource','description','recognition','depreciationSchedule','lastEditReview'])
        IS DISTINCT FROM (v_prior.snapshot-ARRAY['version','updatedBy','updatedAtMs','pendingEdit','vehicleId','name','currency','price','purchasedOn','useStartedOn','fundingSource','description','recognition','depreciationSchedule','lastEditReview'])
    THEN RAISE EXCEPTION 'edit confirmation differs from its attributed proposal' USING ERRCODE='23514'; END IF;
    IF v_policy IS DISTINCT FROM 'null'::jsonb THEN
      IF (NEW.snapshot->>'useStartedOn')::date>(v_policy->>'startsOn')::date
        OR NEW.snapshot->'depreciationSchedule' IS DISTINCT FROM public.ash_existing_revised_schedule(v_prior.snapshot,
          (NEW.snapshot->>'price')::bigint,(NEW.snapshot->'lastEditReview'->>'effectiveOn')::date)
      THEN RAISE EXCEPTION 'edit must preserve completed calculation rows' USING ERRCODE='23514'; END IF;
    ELSIF NEW.snapshot->'depreciationSchedule' IS DISTINCT FROM v_prior.snapshot->'depreciationSchedule' THEN
      RAISE EXCEPTION 'edit cannot invent depreciation' USING ERRCODE='23514';
    END IF;
    IF (v_prior.snapshot->'recognition'->>'cost')::bigint IS DISTINCT FROM (v_recognition->>'cost')::bigint THEN
      v_account:='fixed_asset:'||v_prior.currency||':'||NEW.asset_id::text;
      v_cost:=(v_recognition->>'cost')::bigint;
      IF v_prior.snapshot->'recognition'='null'::jsonb OR v_recognition='null'::jsonb
        OR v_cost IS DISTINCT FROM (NEW.snapshot->>'price')::bigint
        OR (v_recognition->>'accumulatedDepreciation')::bigint>(NEW.snapshot->>'price')::bigint
        OR (v_recognition-ARRAY['cost','journalEntryId','asOf','approvedBy','approvedAtMs','reason'])
          IS DISTINCT FROM (v_prior.snapshot->'recognition'-ARRAY['cost','journalEntryId','asOf','approvedBy','approvedAtMs','reason'])
        OR v_recognition->>'approvedBy' IS DISTINCT FROM v_actor::text
        OR v_recognition->>'reason' IS DISTINCT FROM NEW.reason
        OR v_recognition->>'asOf' IS DISTINCT FROM NEW.snapshot->'lastEditReview'->>'effectiveOn'
        OR v_recognition->>'journalEntryId' IS DISTINCT FROM NEW.snapshot->'lastEditReview'->>'journalEntryId'
        OR public.ash_fund_balance(NEW.branch_id,v_account) IS DISTINCT FROM v_cost-(v_recognition->>'accumulatedDepreciation')::bigint
        OR NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=(v_recognition->>'journalEntryId')::bigint
          AND j.branch_id=NEW.branch_id AND j.shift_id IS NULL AND j.business_date=(v_recognition->>'asOf')::date)
        OR EXISTS(SELECT 1 FROM public.company_reversals WHERE target_entry_id=(v_recognition->>'journalEntryId')::bigint)
        OR EXISTS(SELECT 1 FROM public.journal_lines l JOIN public.funds f ON f.id=l.fund_id
          WHERE l.entry_id=(v_recognition->>'journalEntryId')::bigint AND f.type::text IN('company_cash','company_custody'))
        OR (SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_minor ELSE -l.amount_minor END),0)
          FROM public.journal_lines l JOIN public.funds f ON f.id=l.fund_id WHERE l.entry_id=(v_recognition->>'journalEntryId')::bigint
          AND f.branch_id=NEW.branch_id AND f.code=v_account) IS DISTINCT FROM v_cost-(v_prior.snapshot->'recognition'->>'cost')::bigint
      THEN RAISE EXCEPTION 'recognized price correction requires exact reviewed noncash journal' USING ERRCODE='23514'; END IF;
    ELSIF v_recognition IS DISTINCT FROM v_prior.snapshot->'recognition'
      OR NEW.snapshot->'lastEditReview'->'journalEntryId' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'no invented recognition or journal on card edit' USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW.kind='edit' AND v_prior.accounting_status='approved'
    AND (NEW.snapshot->>'price' IS DISTINCT FROM v_prior.snapshot->>'price'
      OR NEW.snapshot->>'currency' IS DISTINCT FROM v_prior.currency
      OR NEW.snapshot->>'vehicleId' IS DISTINCT FROM v_prior.vehicle_id::text
      OR NEW.snapshot->>'useStartedOn' IS DISTINCT FROM v_prior.snapshot->>'useStartedOn'
      OR NEW.snapshot->>'purchasedOn' IS DISTINCT FROM v_prior.snapshot->>'purchasedOn')
    AND NEW.snapshot->>'accountingStatus'<>'needs_correction' THEN
    RAISE EXCEPTION 'changing approved valuation requires accounting correction review'
      USING ERRCODE='23514', CONSTRAINT='existing_asset_edit_review_guard';
  END IF;
  IF NEW.kind='depreciation_activate' THEN
    IF v_policy IS NULL OR v_policy='null'::jsonb
      OR v_prior.snapshot->'depreciation' IS DISTINCT FROM 'null'::jsonb
      OR NEW.snapshot->>'status'='sold'
      OR (v_policy->>'usefulMonths')::integer NOT BETWEEN 1 AND 600
      OR (v_policy->>'residualValue')::bigint NOT BETWEEN 0 AND (NEW.snapshot->>'price')::bigint
      OR (v_policy->>'startsOn')::date < (NEW.snapshot->>'useStartedOn')::date
      OR (v_policy->>'activatedOn')::date IS NULL
      OR (v_policy->>'startsOn')::date < (v_policy->>'activatedOn')::date
      OR v_policy->>'activatedBy' IS DISTINCT FROM v_actor::text THEN
      RAISE EXCEPTION 'invalid or silently replaced depreciation policy'
        USING ERRCODE='23514', CONSTRAINT='existing_asset_depreciation_guard';
    END IF;
  END IF;
  IF NEW.kind='recognition_link' THEN
    v_account := 'fixed_asset:'||(NEW.snapshot->>'currency')||':'||(v_recognition->>'accountAssetId');
    v_cost := (v_recognition->>'cost')::bigint;
    IF v_recognition IS NULL OR v_recognition='null'::jsonb
      OR NEW.snapshot->>'accountingStatus'<>'approved'
      OR v_cost IS DISTINCT FROM (NEW.snapshot->>'price')::bigint
      OR (v_recognition->>'accumulatedDepreciation')::bigint NOT BETWEEN 0 AND v_cost
      OR v_recognition->>'approvedBy' IS DISTINCT FROM v_actor::text
      OR v_recognition->>'accountAssetId' IS DISTINCT FROM NEW.asset_id::text
      OR public.ash_fund_balance(NEW.branch_id,v_account) IS DISTINCT FROM v_cost-(v_recognition->>'accumulatedDepreciation')::bigint
      OR NOT EXISTS (SELECT 1 FROM public.journal_entries j JOIN public.journal_lines l ON l.entry_id=j.id
        JOIN public.funds f ON f.id=l.fund_id WHERE j.id=(v_recognition->>'journalEntryId')::bigint
        AND j.branch_id=NEW.branch_id AND f.branch_id=NEW.branch_id AND f.code=v_account
        AND f.currency=NEW.snapshot->>'currency' AND l.side='D' AND l.amount_minor=v_cost) THEN
      RAISE EXCEPTION 'recognition must link this asset cost already recorded in its company ledger'
        USING ERRCODE='23514', CONSTRAINT='existing_asset_recognition_guard';
    END IF;
  END IF;
  IF NEW.kind='sale_confirm' THEN
    v_account := 'fixed_asset:'||(NEW.snapshot->>'currency')||':'||(v_recognition->>'accountAssetId');
    v_amount := (v_sale->>'bookValue')::bigint;
    IF v_prior.accounting_status<>'approved' OR v_recognition IS NULL OR v_recognition='null'::jsonb
      OR NEW.snapshot->>'status'<>'sold' OR v_sale->>'status'<>'confirmed'
      OR v_sale->>'confirmedBy' IS DISTINCT FROM v_actor::text
      OR v_amount<0 OR v_sale->>'currency' IS DISTINCT FROM NEW.snapshot->>'currency'
      OR (v_prior.snapshot->'sale'->>'status')<>'draft'
      OR (v_sale - ARRAY['status','disposalEntryId','bookValue','confirmedBy','confirmedAtMs']) IS DISTINCT FROM
         (v_prior.snapshot->'sale' - ARRAY['status','disposalEntryId','bookValue','confirmedBy','confirmedAtMs'])
      OR v_amount IS DISTINCT FROM (v_recognition->>'cost')::bigint-(v_recognition->>'accumulatedDepreciation')::bigint
      OR public.ash_fund_balance(NEW.branch_id,v_account)<>0
      OR NOT EXISTS (SELECT 1 FROM public.journal_entries j WHERE j.id=(v_sale->>'disposalEntryId')::bigint AND j.branch_id=NEW.branch_id)
      OR (v_amount>0 AND NOT EXISTS (SELECT 1 FROM public.journal_lines l JOIN public.funds f ON f.id=l.fund_id
        WHERE l.entry_id=(v_sale->>'disposalEntryId')::bigint AND f.branch_id=NEW.branch_id AND f.code=v_account
        AND f.currency=NEW.snapshot->>'currency' AND l.side='C' AND l.amount_minor=v_amount)) THEN
      RAISE EXCEPTION 'sale confirmation requires reviewed book value and existing disposal entry'
        USING ERRCODE='23514', CONSTRAINT='existing_asset_sale_guard';
    END IF;
    IF (v_sale->>'receivedAmount')::bigint>0 AND (v_sale->>'receiptDestination'<>'company'
      OR v_sale->>'receiptEntryId' IS DISTINCT FROM v_sale->>'disposalEntryId'
      OR NOT EXISTS (SELECT 1 FROM public.journal_entries j JOIN public.journal_lines l ON l.entry_id=j.id
        JOIN public.funds f ON f.id=l.fund_id WHERE j.id=(v_sale->>'receiptEntryId')::bigint AND j.branch_id=NEW.branch_id
        AND f.code='company_cash:'||(v_sale->>'currency') AND f.branch_id=NEW.branch_id
        AND l.side='D' AND l.amount_minor=(v_sale->>'receivedAmount')::bigint)) THEN
      RAISE EXCEPTION 'received sale cash must link its existing exact company receipt'
        USING ERRCODE='23514', CONSTRAINT='existing_asset_sale_receipt_guard';
    END IF;
  END IF;
  IF NEW.kind='sale_documentary' THEN
    IF v_prior.status IS DISTINCT FROM 'registered'
      OR v_prior.accounting_status IS DISTINCT FROM 'pending_review'
      OR v_prior.snapshot->'recognition' IS DISTINCT FROM 'null'::jsonb
      OR COALESCE(v_prior.snapshot->'pendingEdit','null'::jsonb) IS DISTINCT FROM 'null'::jsonb
      OR NEW.snapshot->>'status' IS DISTINCT FROM 'sold'
      OR v_sale->>'kind' IS DISTINCT FROM 'documentary'
      OR v_sale->>'id' IS DISTINCT FROM NEW.id::text
      OR NOT COALESCE(public.ash_has_visible_text(v_sale->>'buyer'),false)
      OR v_sale->>'status' IS DISTINCT FROM 'confirmed'
      OR v_sale->>'confirmedBy' IS DISTINCT FROM v_actor::text
      OR v_sale->>'receiptDestination' IS DISTINCT FROM 'company'
      OR v_sale->'disposalEntryId' IS DISTINCT FROM 'null'::jsonb
      OR v_sale->'bookValue' IS DISTINCT FROM 'null'::jsonb
      OR v_sale->'debtId' IS DISTINCT FROM 'null'::jsonb
      OR (v_sale->>'price')::bigint IS NULL OR (v_sale->>'price')::bigint<=0
      OR (v_sale->>'receivedAmount')::bigint IS DISTINCT FROM (v_sale->>'price')::bigint
      OR (v_sale->>'occurredOn')::date IS NULL
      OR (v_sale->>'occurredOn')::date < v_prior.use_started_on
      OR (v_sale->>'occurredOn')::date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Damascus')::date
      OR public.ash_fund_balance(NEW.branch_id,'fixed_asset:'||v_prior.currency||':'||NEW.asset_id::text)<>0
      OR NOT EXISTS (SELECT 1 FROM public.journal_entries j
        WHERE j.id=(v_sale->>'receiptEntryId')::bigint AND j.branch_id=NEW.branch_id AND j.shift_id IS NULL)
      OR EXISTS (SELECT 1 FROM public.company_reversals r
        WHERE r.target_entry_id=(v_sale->>'receiptEntryId')::bigint)
      OR EXISTS (SELECT 1 FROM public.journal_lines l JOIN public.funds f ON f.id=l.fund_id
        WHERE l.entry_id=(v_sale->>'receiptEntryId')::bigint AND f.code LIKE 'fixed_asset:%')
      OR (SELECT COALESCE(SUM(CASE l.side WHEN 'D' THEN l.amount_minor ELSE -l.amount_minor END),0)
        FROM public.journal_lines l JOIN public.funds f ON f.id=l.fund_id
        WHERE l.entry_id=(v_sale->>'receiptEntryId')::bigint AND f.branch_id=NEW.branch_id
          AND f.code='company_cash:'||(v_sale->>'currency') AND f.currency=v_sale->>'currency')
          IS DISTINCT FROM (v_sale->>'price')::bigint THEN
      RAISE EXCEPTION 'documentary sale requires an unrecognized card and one exact existing company receipt'
        USING ERRCODE='23514', CONSTRAINT='existing_asset_documentary_sale_guard';
    END IF;
  END IF;
  RETURN NEW;
END $$;
