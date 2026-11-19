-- Administrative revisions of immutable imported evidence. No journal or cash rewrite.
CREATE TABLE company_historical_source_corrections (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  source_reference text NOT NULL REFERENCES company_historical_import_receipts(source_reference) ON DELETE RESTRICT,
  version integer NOT NULL CHECK(version>=2),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND payload ?&
    ARRAY['id','branchId','sourceReference','version','createdBy','reason','fingerprint','before','values','createdAtMs']),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_reference,version),
  CHECK(payload->>'id'=id::text AND payload->>'branchId'=branch_id::text
    AND payload->>'sourceReference'=source_reference AND (payload->>'version')::int=version
    AND payload->>'createdBy'=created_by::text AND ash_has_visible_text(payload->>'reason'))
);
CREATE FUNCTION guard_company_historical_source_correction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_actor uuid:=public.ash_current_actor(); v_source public.company_historical_import_receipts%ROWTYPE;
  v_branch uuid; v_version integer; v_previous jsonb; v_values jsonb; v_payload jsonb; v_rate text;
BEGIN
  IF NEW.payload->>'id' IS DISTINCT FROM NEW.id::text
    OR NEW.payload->>'branchId' IS DISTINCT FROM NEW.branch_id::text
    OR NEW.payload->>'sourceReference' IS DISTINCT FROM NEW.source_reference
    OR NEW.payload->>'version' IS DISTINCT FROM NEW.version::text
    OR NEW.payload->>'createdBy' IS DISTINCT FROM NEW.created_by::text
    OR jsonb_typeof(NEW.payload->'reason') IS DISTINCT FROM 'string'
    OR NOT COALESCE(public.ash_has_visible_text(NEW.payload->>'reason'),false)
    OR length(NEW.payload->>'reason')>1000
    OR NOT COALESCE(NEW.payload->>'fingerprint' ~ '^[0-9a-f]{64}$',false) THEN
    RAISE EXCEPTION 'source correction attribution snapshot mismatch' USING ERRCODE='23514';
  END IF;
  IF v_actor IS DISTINCT FROM NEW.created_by OR NOT public.ash_actor_holds_all(v_actor,'company_fund.manage')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=v_actor AND active AND role_key IN('general_manager','system_admin')) THEN
    RAISE EXCEPTION 'historical correction requires attributed reviewer' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_source FROM public.company_historical_import_receipts WHERE source_reference=NEW.source_reference FOR UPDATE;
  SELECT branch_id INTO v_branch FROM public.company_historical_import_batches WHERE id=v_source.batch_id;
  IF v_branch IS DISTINCT FROM NEW.branch_id THEN RAISE EXCEPTION 'source correction must belong to HQ' USING ERRCODE='23514'; END IF;
  SELECT version,payload->'values' INTO v_version,v_previous FROM public.company_historical_source_corrections
    WHERE source_reference=NEW.source_reference ORDER BY version DESC LIMIT 1;
  IF NEW.version<>COALESCE(v_version,1)+1 THEN RAISE EXCEPTION 'stale source correction' USING ERRCODE='23514'; END IF;
  IF v_previous IS NULL THEN
    v_payload:=v_source.original_evidence->'payload';
    SELECT syp_minor_per_usd::text INTO v_rate FROM public.journal_entries WHERE id=v_source.journal_entry_id;
    IF v_rate IS NULL AND jsonb_typeof(v_payload->'historicalRate')='string' THEN
      v_rate:=((v_payload->>'historicalRate')::numeric*100)::bigint::text;
    END IF;
    v_previous:=jsonb_build_object('currency',CASE WHEN v_payload->>'currency' IN('SYP_NEW','USD') THEN v_payload->>'currency' ELSE NULL END,
      'amount',CASE WHEN v_payload->>'currency' IN('SYP_NEW','USD') THEN ((v_payload->>'amount')::numeric(20,2))::text ELSE NULL END,
      'occurredOn',v_source.occurred_on::text,'description',COALESCE(v_payload->>'description',''),'excluded',false,
      'sypMinorPerUsd',v_rate,'rateBasis',CASE WHEN v_payload->>'rateBasis' IN('documented','estimated') THEN v_payload->>'rateBasis' ELSE NULL END);
  END IF;
  IF NEW.payload->'before' IS DISTINCT FROM v_previous THEN
    RAISE EXCEPTION 'source correction before snapshot mismatch' USING ERRCODE='23514';
  END IF;
  v_values:=NEW.payload->'values';
  IF jsonb_typeof(v_values) IS DISTINCT FROM 'object'
    OR NOT (v_values ?& ARRAY['currency','amount','occurredOn','description','excluded','sypMinorPerUsd','rateBasis'])
    OR jsonb_typeof(v_values->'excluded') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(v_values->'description') IS DISTINCT FROM 'string'
    OR NOT public.ash_has_visible_text(v_values->>'description')
    OR length(v_values->>'description')>2000
    OR NOT COALESCE(v_values->>'occurredOn' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$',false) THEN
    RAISE EXCEPTION 'invalid historical correction snapshot' USING ERRCODE='23514';
  END IF;
  IF (v_values->>'occurredOn')::date<DATE '2000-01-01' OR (v_values->>'occurredOn')::date>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Damascus')::date THEN
    RAISE EXCEPTION 'invalid historical correction date' USING ERRCODE='23514';
  END IF;
  IF v_values->'currency' IS DISTINCT FROM 'null'::jsonb THEN
    IF v_values->>'currency' NOT IN('SYP_NEW','USD') OR jsonb_typeof(v_values->'amount') IS DISTINCT FROM 'string'
      OR NOT COALESCE(v_values->>'amount' ~ '^[0-9]+[.][0-9]{2}$',false)
      OR (v_values->>'amount')::numeric<=0 OR (v_values->>'amount')::numeric*100>9223372036854775807 THEN
      RAISE EXCEPTION 'invalid historical correction money' USING ERRCODE='23514';
    END IF;
  ELSIF v_values->'amount' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'currency is required for historical amount' USING ERRCODE='23514';
  END IF;
  IF v_values->'sypMinorPerUsd' IS DISTINCT FROM 'null'::jsonb THEN
    IF v_values->>'currency' IS DISTINCT FROM 'USD' OR jsonb_typeof(v_values->'sypMinorPerUsd') IS DISTINCT FROM 'string'
      OR NOT COALESCE(v_values->>'sypMinorPerUsd' ~ '^[0-9]+$',false)
      OR (v_values->>'sypMinorPerUsd')::numeric<=0 OR (v_values->>'sypMinorPerUsd')::numeric>9223372036854775807
      OR NOT COALESCE(v_values->>'rateBasis' IN('documented','estimated'),false) THEN
      RAISE EXCEPTION 'invalid historical correction rate' USING ERRCODE='23514';
    END IF;
  ELSIF v_values->'rateBasis' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'rate basis requires a frozen rate' USING ERRCODE='23514';
  END IF;
  IF v_source.journal_entry_id IS NOT NULL OR v_source.branch_journal_entry_id IS NOT NULL THEN
    IF NEW.payload->'values'->>'excluded'='true'
      OR NEW.payload->'values'->'currency' IS DISTINCT FROM NEW.payload->'before'->'currency'
      OR NEW.payload->'values'->'amount' IS DISTINCT FROM NEW.payload->'before'->'amount'
      OR NEW.payload->'values'->'sypMinorPerUsd' IS DISTINCT FROM NEW.payload->'before'->'sypMinorPerUsd'
      OR NEW.payload->'values'->'rateBasis' IS DISTINCT FROM NEW.payload->'before'->'rateBasis' THEN
      RAISE EXCEPTION 'cash-backed source requires financial correction' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_historical_source_corrections_guard BEFORE INSERT ON company_historical_source_corrections
  FOR EACH ROW EXECUTE FUNCTION guard_company_historical_source_correction();
CREATE TRIGGER company_historical_source_corrections_immutable BEFORE UPDATE OR DELETE ON company_historical_source_corrections
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER audit_company_historical_source_corrections AFTER INSERT OR UPDATE OR DELETE ON company_historical_source_corrections
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
REVOKE UPDATE,DELETE,TRUNCATE ON company_historical_source_corrections FROM app_user;
GRANT SELECT,INSERT ON company_historical_source_corrections TO app_user;
