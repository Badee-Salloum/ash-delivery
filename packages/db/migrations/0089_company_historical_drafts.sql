-- Administrative historical evidence only. No journal, expense, owner funding or treasury write.
CREATE TABLE company_historical_drafts (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  CONSTRAINT company_historical_draft_identity_ck CHECK (COALESCE(
    jsonb_typeof(payload)='object' AND payload ?& ARRAY['id','companyBranchId','createdBy','createdAtMs','status']
    AND payload->>'id'=id::text AND payload->>'companyBranchId'=branch_id::text
    AND payload->>'createdBy'=created_by::text AND payload->>'status'='draft'
    AND (payload->>'createdAtMs')::bigint=(extract(epoch FROM created_at)*1000)::bigint,false))
);

CREATE TABLE company_historical_draft_revisions (
  request_id uuid PRIMARY KEY,
  id uuid GENERATED ALWAYS AS (request_id) STORED,
  draft_id uuid NOT NULL REFERENCES company_historical_drafts(id),
  version integer NOT NULL CHECK(version>0),
  expected_version integer NOT NULL CHECK(expected_version>=0 AND version=expected_version+1),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  actor_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE(draft_id,version),
  CONSTRAINT company_historical_draft_revision_identity_ck CHECK (COALESCE(
    jsonb_typeof(payload)='object' AND payload ?& ARRAY['draftId','version','expectedVersion','requestId','requestHash','actorId','createdAtMs','payload']
    AND payload->>'draftId'=draft_id::text AND (payload->>'version')::integer=version
    AND (payload->>'expectedVersion')::integer=expected_version AND payload->>'requestId'=request_id::text
    AND payload->>'requestHash'=request_hash AND payload->>'actorId'=actor_id::text
    AND (payload->>'createdAtMs')::bigint=(extract(epoch FROM created_at)*1000)::bigint
    AND jsonb_typeof(payload->'payload')='object',false))
);
CREATE INDEX company_historical_drafts_branch_idx ON company_historical_drafts(branch_id,created_at,id);

CREATE FUNCTION ash_historical_draft_positive_money(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT CASE WHEN value ~ '^[0-9]+\.[0-9]{2}$' THEN replace(value,'.','')::bigint>0 ELSE false END
$$;

CREATE FUNCTION guard_company_historical_draft_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid := public.ash_current_actor();
BEGIN
  IF NEW.created_by IS DISTINCT FROM actor OR NOT public.ash_actor_holds_all(actor,'company_fund.manage')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor AND active AND role_key IN('general_manager','system_admin')) THEN
    RAISE EXCEPTION 'historical draft requires its attributed owner-level creator' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_company_historical_draft_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid := public.ash_current_actor(); previous_version integer; root company_historical_drafts%ROWTYPE;
  body jsonb := NEW.payload->'payload'; kind text; usd_cents bigint; syp_minor bigint; frozen bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ash:historical-draft:'||NEW.draft_id::text,0));
  IF NEW.actor_id IS DISTINCT FROM actor OR NOT public.ash_actor_holds_all(actor,'company_fund.manage')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor AND active AND role_key IN('general_manager','system_admin')) THEN
    RAISE EXCEPTION 'historical draft revision requires its attributed owner-level reviewer' USING ERRCODE='23514';
  END IF;
  SELECT * INTO root FROM company_historical_drafts WHERE id=NEW.draft_id;
  IF root.id IS NULL OR (NEW.version=1 AND (NEW.request_id<>NEW.draft_id OR NEW.actor_id<>root.created_by)) THEN
    RAISE EXCEPTION 'historical draft first revision must own its immutable identity' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(max(version),0) INTO previous_version FROM company_historical_draft_revisions WHERE draft_id=NEW.draft_id;
  IF previous_version<>NEW.expected_version OR NEW.version<>previous_version+1 THEN
    RAISE EXCEPTION 'stale historical draft version' USING ERRCODE='23514',CONSTRAINT='company_historical_draft_version_guard';
  END IF;
  IF (body ?& ARRAY['type','occurredOn','occurredPrecision','occurredMonth','description','currency','amount',
    'paidFrom','categoryId','account','historicalRate','sypMinorPerUsd','rateBasis','fromCurrency','fromAmount',
    'toCurrency','toAmount','sourceUnit','receiptReference','branchId','assetId']) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'historical draft payload is incomplete' USING ERRCODE='23514';
  END IF;
  kind:=body->>'type';
  IF (kind IN('deposit','withdrawal','expense','income','exchange','branch_receipt','branch_payment','asset_payment','refund')
    AND public.ash_has_visible_text(body->>'description')
    AND length(body->>'description')<=500 AND body->>'occurredOn' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND (body->>'occurredOn')::date >= DATE '2000-01-01' AND body->>'occurredPrecision' IN('day','month')
    AND body->>'paidFrom' IN('pocket','owner_outside')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'historical draft source/date/type is invalid' USING ERRCODE='23514';
  END IF;
  IF (body->>'occurredPrecision'='day' AND body->>'occurredMonth' IS NOT NULL)
    OR (body->>'occurredPrecision'='month' AND ((body->>'occurredMonth' ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') IS DISTINCT FROM true
      OR body->>'occurredOn' IS DISTINCT FROM ((body->>'occurredMonth')||'-01'))) THEN
    RAISE EXCEPTION 'historical month evidence must not invent a day' USING ERRCODE='23514';
  END IF;
  IF kind NOT IN('expense','branch_payment','asset_payment') AND body->>'paidFrom'<>'pocket' THEN
    RAISE EXCEPTION 'invalid historical source' USING ERRCODE='23514';
  END IF;
  IF (kind IN('branch_receipt','branch_payment') AND body->>'branchId' IS NULL)
    OR (body->>'branchId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM branches b
      WHERE b.id=(body->>'branchId')::uuid AND b.kind='branch')) THEN
    RAISE EXCEPTION 'historical branch evidence must reference an operating branch' USING ERRCODE='23514';
  END IF;
  IF body->>'assetId' IS NOT NULL AND (kind<>'asset_payment' OR NOT (
    EXISTS(SELECT 1 FROM company_existing_assets WHERE id=(body->>'assetId')::uuid AND branch_id=root.branch_id)
    OR EXISTS(SELECT 1 FROM fixed_assets WHERE id=(body->>'assetId')::uuid AND branch_id=root.branch_id))) THEN
    RAISE EXCEPTION 'invalid historical asset evidence link' USING ERRCODE='23514';
  END IF;
  IF body->>'categoryId' IS NOT NULL AND (
    (kind='expense' AND NOT EXISTS(SELECT 1 FROM expense_categories WHERE id=(body->>'categoryId')::uuid))
    OR (kind='income' AND NOT EXISTS(SELECT 1 FROM income_categories WHERE id=(body->>'categoryId')::uuid))
    OR kind NOT IN('expense','income')) THEN RAISE EXCEPTION 'invalid draft category' USING ERRCODE='23514'; END IF;
  IF (kind='deposit' AND body->>'account' IS NOT NULL AND (body->>'account' IN('owner_funding','opening')) IS DISTINCT FROM true)
    OR (kind<>'deposit' AND body->>'account' IS NOT NULL) THEN RAISE EXCEPTION 'invalid draft account' USING ERRCODE='23514'; END IF;
  IF body->>'sourceUnit' IS NOT NULL AND (NOT public.ash_has_visible_text(body->>'sourceUnit') OR length(body->>'sourceUnit')>100)
    OR body->>'receiptReference' IS NOT NULL AND (NOT public.ash_has_visible_text(body->>'receiptReference') OR length(body->>'receiptReference')>200) THEN
    RAISE EXCEPTION 'invalid historical source evidence' USING ERRCODE='23514';
  END IF;
  IF kind='exchange' THEN
    IF (body->>'fromCurrency' IN('USD','SYP_NEW') AND body->>'toCurrency' IN('USD','SYP_NEW')
      AND body->>'fromCurrency'<>body->>'toCurrency'
      AND public.ash_historical_draft_positive_money(body->>'fromAmount')
      AND public.ash_historical_draft_positive_money(body->>'toAmount')) IS DISTINCT FROM true
      OR body->>'currency' IS NOT NULL OR body->>'amount' IS NOT NULL
      OR body->>'historicalRate' IS NOT NULL OR body->>'rateBasis' IS NOT NULL THEN
      RAISE EXCEPTION 'invalid actual historical exchange amounts' USING ERRCODE='23514';
    END IF;
    usd_cents:=replace(CASE WHEN body->>'fromCurrency'='USD' THEN body->>'fromAmount' ELSE body->>'toAmount' END,'.','')::bigint;
    syp_minor:=replace(CASE WHEN body->>'fromCurrency'='SYP_NEW' THEN body->>'fromAmount' ELSE body->>'toAmount' END,'.','')::bigint;
    frozen:=(body->>'sypMinorPerUsd')::bigint;
    IF frozen IS NULL OR frozen<=0 OR frozen::numeric<>div(200*syp_minor::numeric+usd_cents::numeric,2*usd_cents::numeric) THEN
      RAISE EXCEPTION 'historical exchange rate must derive from its exact two amounts' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (body->>'currency' IN('USD','SYP_NEW') AND public.ash_historical_draft_positive_money(body->>'amount')) IS DISTINCT FROM true
      OR body->>'fromCurrency' IS NOT NULL OR body->>'fromAmount' IS NOT NULL OR body->>'toCurrency' IS NOT NULL OR body->>'toAmount' IS NOT NULL THEN
      RAISE EXCEPTION 'invalid positive historical amount' USING ERRCODE='23514';
    END IF;
    IF body->>'currency'='USD' THEN
      IF public.ash_historical_draft_positive_money(body->>'historicalRate') IS DISTINCT FROM true
        OR (body->>'rateBasis' IN('documented','estimated')) IS DISTINCT FROM true
        OR (body->>'sypMinorPerUsd')::bigint IS DISTINCT FROM replace(body->>'historicalRate','.','')::bigint THEN
        RAISE EXCEPTION 'USD historical evidence needs its frozen rate' USING ERRCODE='23514';
      END IF;
    ELSIF body->>'historicalRate' IS NOT NULL OR body->>'sypMinorPerUsd' IS NOT NULL OR body->>'rateBasis' IS NOT NULL THEN
      RAISE EXCEPTION 'SYP historical evidence has no dollar rate' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION reject_company_historical_draft_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'historical draft identities and versions are append-only' USING ERRCODE='23514'; END $$;

REVOKE UPDATE,DELETE,TRUNCATE ON company_historical_drafts,company_historical_draft_revisions FROM app_user;
GRANT SELECT,INSERT ON company_historical_drafts,company_historical_draft_revisions TO app_user;
CREATE TRIGGER company_historical_draft_hq_guard BEFORE INSERT ON company_historical_drafts FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER company_historical_draft_creator_guard BEFORE INSERT ON company_historical_drafts FOR EACH ROW EXECUTE FUNCTION guard_company_historical_draft_identity();
CREATE TRIGGER company_historical_draft_revision_guard BEFORE INSERT ON company_historical_draft_revisions FOR EACH ROW EXECUTE FUNCTION guard_company_historical_draft_revision();
CREATE TRIGGER company_historical_draft_identity_append_only BEFORE UPDATE OR DELETE ON company_historical_drafts FOR EACH ROW EXECUTE FUNCTION reject_company_historical_draft_mutation();
CREATE TRIGGER company_historical_draft_revision_append_only BEFORE UPDATE OR DELETE ON company_historical_draft_revisions FOR EACH ROW EXECUTE FUNCTION reject_company_historical_draft_mutation();
CREATE TRIGGER audit_company_historical_drafts AFTER INSERT OR UPDATE OR DELETE ON company_historical_drafts FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_historical_draft_revisions AFTER INSERT OR UPDATE OR DELETE ON company_historical_draft_revisions FOR EACH ROW EXECUTE FUNCTION audit_row_change();
