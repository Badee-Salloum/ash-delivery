-- 0096 — documentary sale for unrecognized motor cards only.
-- No cash, debt, disposal, gain or recognition entry is generated.
-- Existing immutable revisions, projection checks, receipt uniqueness and financial-sale rules stay in force.
ALTER TABLE company_existing_asset_events DROP CONSTRAINT company_existing_asset_events_kind_check;
ALTER TABLE company_existing_asset_events ADD CONSTRAINT company_existing_asset_events_kind_check
  CHECK (kind IN ('register','edit','depreciation_activate','recognition_link','sale_draft','sale_confirm','sale_documentary','evidence_link'));

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
  IF v_prior.id IS NOT NULL THEN
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

-- Do not reverse a receipt behind the confirmed card that documents its sale.
-- The original financial reversal guard remains; a linked correction requires its own review.
CREATE FUNCTION guard_existing_asset_sale_receipt_reversal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.company_existing_assets c
    WHERE c.branch_id=NEW.branch_id AND c.status='sold'
      AND c.snapshot->'sale'->>'status'='confirmed'
      AND (c.snapshot->'sale'->>'receiptEntryId')::bigint=NEW.target_entry_id) THEN
    RAISE EXCEPTION 'existing_asset_sale_receipt_correction_guard'
      USING ERRCODE='23514', CONSTRAINT='existing_asset_sale_receipt_correction_guard';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER existing_asset_sale_receipt_reversal_guard
BEFORE INSERT ON company_reversals
FOR EACH ROW EXECUTE FUNCTION guard_existing_asset_sale_receipt_reversal();
