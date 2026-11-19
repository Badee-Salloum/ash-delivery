-- 0086 — register existing motors without purchasing, paying, funding or opening a debt.
-- The legacy fixed_assets purchase facts and their 36-month schedules are not rewritten.
-- Cards are a guarded projection of immutable revisions; evidence has no monetary allocation.

CREATE TABLE company_existing_assets (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (ash_has_visible_text(name) AND char_length(name) <= 160),
  currency text NOT NULL CHECK (currency IN ('SYP_NEW','USD')),
  price_minor bigint CHECK (price_minor > 0),
  purchased_on date,
  use_started_on date,
  funding_source text NOT NULL CHECK (funding_source IN ('company','owner_outside','unknown')),
  description text NOT NULL CHECK (char_length(description) <= 500),
  status text NOT NULL CHECK (status IN ('draft','registered','sold')),
  accounting_status text NOT NULL CHECK (accounting_status IN ('pending_review','approved','needs_correction')),
  version integer NOT NULL CHECK (version >= 1),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL,
  CHECK (purchased_on IS NULL OR purchased_on >= DATE '2000-01-01'),
  CHECK (use_started_on IS NULL OR use_started_on >= DATE '2000-01-01'),
  CHECK (purchased_on IS NULL OR use_started_on IS NULL OR purchased_on <= use_started_on),
  CHECK (status = 'draft' OR (price_minor IS NOT NULL AND use_started_on IS NOT NULL))
);
CREATE UNIQUE INDEX company_existing_assets_active_vehicle_uq
  ON company_existing_assets (vehicle_id) WHERE status <> 'sold';
CREATE INDEX company_existing_assets_branch_idx ON company_existing_assets (branch_id,created_at,id);
CREATE UNIQUE INDEX company_existing_assets_disposal_entry_uq
  ON company_existing_assets ((snapshot->'sale'->>'disposalEntryId')) WHERE status='sold';
CREATE UNIQUE INDEX company_existing_assets_sale_receipt_uq
  ON company_existing_assets ((snapshot->'sale'->>'receiptEntryId'))
  WHERE status='sold' AND snapshot->'sale'->>'receiptEntryId' IS NOT NULL;

CREATE TABLE company_existing_asset_events (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES company_existing_assets(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('register','edit','depreciation_activate','recognition_link','sale_draft','sale_confirm','evidence_link')),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  version integer NOT NULL CHECK (version = expected_version + 1),
  request_fingerprint text NOT NULL CHECK (char_length(request_fingerprint) BETWEEN 1 AND 20000),
  reason text NOT NULL CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  UNIQUE (asset_id,version)
);

CREATE TABLE company_existing_asset_evidence (
  id uuid PRIMARY KEY REFERENCES company_existing_asset_events(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  asset_id uuid NOT NULL REFERENCES company_existing_assets(id) ON DELETE RESTRICT,
  operation_id uuid,
  journal_entry_id bigint REFERENCES journal_entries(id) ON DELETE RESTRICT,
  media_id uuid REFERENCES media(id) ON DELETE RESTRICT,
  description text NOT NULL CHECK (ash_has_visible_text(description) AND char_length(description) <= 500),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  CHECK (operation_id IS NOT NULL OR journal_entry_id IS NOT NULL OR media_id IS NOT NULL)
);
CREATE INDEX company_existing_asset_evidence_operation_idx ON company_existing_asset_evidence(operation_id);
CREATE INDEX company_existing_asset_evidence_journal_idx ON company_existing_asset_evidence(journal_entry_id);

CREATE TRIGGER company_existing_assets_00_branch_guard BEFORE INSERT OR UPDATE OF branch_id
  ON company_existing_assets FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER company_existing_asset_events_00_branch_guard BEFORE INSERT OR UPDATE OF branch_id
  ON company_existing_asset_events FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');

CREATE FUNCTION guard_existing_asset_event() RETURNS trigger
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
      OR (NEW.kind NOT IN ('sale_draft','sale_confirm') AND NEW.snapshot->'sale' IS DISTINCT FROM v_prior.snapshot->'sale')
      OR (NEW.kind NOT IN ('edit','sale_confirm') AND NEW.snapshot->>'status' IS DISTINCT FROM v_prior.status)
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
  RETURN NEW;
END $$;
CREATE TRIGGER company_existing_asset_events_guard BEFORE INSERT ON company_existing_asset_events
  FOR EACH ROW EXECUTE FUNCTION guard_existing_asset_event();

CREATE FUNCTION guard_existing_asset_projection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE v_event public.company_existing_asset_events%ROWTYPE;
BEGIN
  SELECT * INTO v_event FROM public.company_existing_asset_events WHERE asset_id=NEW.id AND version=NEW.version;
  IF v_event.id IS NULL OR v_event.snapshot IS DISTINCT FROM NEW.snapshot
    OR v_event.created_by IS DISTINCT FROM public.ash_current_actor()
    OR NEW.snapshot->>'vehicleId' IS DISTINCT FROM NEW.vehicle_id::text
    OR NEW.snapshot->>'name' IS DISTINCT FROM NEW.name
    OR NEW.snapshot->>'currency' IS DISTINCT FROM NEW.currency
    OR (NEW.snapshot->>'price')::bigint IS DISTINCT FROM NEW.price_minor
    OR (NEW.snapshot->>'purchasedOn')::date IS DISTINCT FROM NEW.purchased_on
    OR (NEW.snapshot->>'useStartedOn')::date IS DISTINCT FROM NEW.use_started_on
    OR NEW.snapshot->>'fundingSource' IS DISTINCT FROM NEW.funding_source
    OR NEW.snapshot->>'description' IS DISTINCT FROM NEW.description
    OR NEW.snapshot->>'status' IS DISTINCT FROM NEW.status
    OR NEW.snapshot->>'accountingStatus' IS DISTINCT FROM NEW.accounting_status
    OR NEW.snapshot->>'createdBy' IS DISTINCT FROM NEW.created_by::text
    OR NEW.snapshot->>'updatedBy' IS DISTINCT FROM NEW.updated_by::text THEN
    RAISE EXCEPTION 'existing asset projection must exactly match its immutable revision'
      USING ERRCODE='23514', CONSTRAINT='existing_asset_projection_guard';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.version<>OLD.version+1 OR v_event.expected_version<>OLD.version) THEN
    RAISE EXCEPTION 'existing asset immutable identity or version changed'
      USING ERRCODE='23514', CONSTRAINT='existing_asset_projection_identity_guard';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_existing_assets_projection_guard BEFORE INSERT OR UPDATE ON company_existing_assets
  FOR EACH ROW EXECUTE FUNCTION guard_existing_asset_projection();

CREATE FUNCTION assert_existing_asset_event_projected() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.company_existing_assets WHERE id=NEW.asset_id AND version>=NEW.version) THEN
    RAISE EXCEPTION 'asset revision must update its projection in the same transaction'
      USING ERRCODE='23514', CONSTRAINT='existing_asset_event_projection_guard';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER company_existing_asset_event_projection_guard AFTER INSERT ON company_existing_asset_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_existing_asset_event_projected();

CREATE FUNCTION guard_existing_asset_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF NEW.created_by IS DISTINCT FROM public.ash_current_actor()
    OR NOT public.ash_actor_holds_all(NEW.created_by,'company_fund.manage')
    OR NOT EXISTS (SELECT 1 FROM public.company_existing_asset_events e
      WHERE e.id=NEW.id AND e.asset_id=NEW.asset_id AND e.kind='evidence_link' AND e.created_by=NEW.created_by) THEN
    RAISE EXCEPTION 'asset evidence requires its attributed immutable revision'
      USING ERRCODE='23514', CONSTRAINT='existing_asset_evidence_guard';
  END IF;
  IF NEW.journal_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.journal_entries j JOIN public.company_existing_assets a ON a.id=NEW.asset_id
      WHERE j.id=NEW.journal_entry_id AND j.branch_id=a.branch_id AND j.shift_id IS NULL) THEN
    RAISE EXCEPTION 'asset evidence entry must belong to the same company ledger'
      USING ERRCODE='23514', CONSTRAINT='existing_asset_evidence_entry_guard';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_existing_asset_evidence_guard BEFORE INSERT ON company_existing_asset_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_existing_asset_evidence();

-- Share the vehicle lock with both old purchase and neutral registration, including non-API writers.
CREATE FUNCTION guard_legacy_asset_against_existing_card() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF NEW.vehicle_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('ash:asset_vehicle:'||NEW.vehicle_id::text,0));
    IF EXISTS (SELECT 1 FROM public.company_existing_assets WHERE vehicle_id=NEW.vehicle_id AND status<>'sold') THEN
      RAISE EXCEPTION 'vehicle already has an existing asset card'
        USING ERRCODE='23514', CONSTRAINT='legacy_asset_existing_vehicle_guard';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixed_assets_01_existing_card_guard BEFORE INSERT ON fixed_assets
  FOR EACH ROW EXECUTE FUNCTION guard_legacy_asset_against_existing_card();

CREATE TRIGGER company_existing_asset_events_immutable BEFORE UPDATE OR DELETE ON company_existing_asset_events
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_existing_asset_evidence_immutable BEFORE UPDATE OR DELETE ON company_existing_asset_evidence
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_existing_assets_no_delete BEFORE DELETE ON company_existing_assets
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER audit_company_existing_assets AFTER INSERT OR UPDATE OR DELETE ON company_existing_assets
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_existing_asset_events AFTER INSERT OR UPDATE OR DELETE ON company_existing_asset_events
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_existing_asset_evidence AFTER INSERT OR UPDATE OR DELETE ON company_existing_asset_evidence
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
REVOKE DELETE,TRUNCATE ON company_existing_assets FROM app_user;
GRANT SELECT,INSERT,UPDATE ON company_existing_assets TO app_user;
REVOKE UPDATE,DELETE,TRUNCATE ON company_existing_asset_events,company_existing_asset_evidence FROM app_user;
GRANT SELECT,INSERT ON company_existing_asset_events,company_existing_asset_evidence TO app_user;

COMMENT ON TABLE company_existing_assets IS 'Operational motor cards. Registration has no cash, debt, owner funding or automatic depreciation effect; guarded projection of immutable revisions.';
COMMENT ON TABLE company_existing_asset_evidence IS 'Documentation links only, never amounts allocated or payments inferred.';
