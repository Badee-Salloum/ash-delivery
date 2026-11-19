-- 0088 — reviewed historical intake and append-only expense corrections.
-- Does not rewrite any old journal, opening balance, or branch cash.

CREATE TABLE company_historical_intake_sessions (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT company_intake_identity_ck CHECK (
    payload->>'id'=id::text AND payload->>'branchId'=branch_id::text
    AND payload->>'reviewedSourceUnits'='true' AND payload->>'reviewedExistingEntries'='true'
    AND payload->>'from' >= '2000-01-01' AND payload->>'from' <= payload->>'to'
    AND ash_has_visible_text(payload->>'reason') AND ash_has_visible_text(payload->>'reconciliationNote')
  )
);

CREATE TABLE company_movement_metadata (
  command_id uuid PRIMARY KEY,
  -- Generic audit_row_change names records by id; retain the command identity in that trace.
  id uuid GENERATED ALWAYS AS (command_id) STORED,
  branch_id uuid NOT NULL REFERENCES branches(id),
  payload jsonb NOT NULL,
  CONSTRAINT company_metadata_identity_ck CHECK (
    payload->>'commandId'=command_id::text AND payload->>'branchId'=branch_id::text
    AND payload->>'occurredPrecision' IN ('day','month')
    AND (payload->>'rateBasis' IS NULL OR payload->>'rateBasis' IN ('documented','estimated'))
    AND ((payload->>'occurredPrecision'='day' AND payload->>'occurredMonth' IS NULL)
      OR (payload->>'occurredPrecision'='month' AND payload->>'occurredMonth' ~ '^[0-9]{4}-[0-9]{2}$'))
  )
);

CREATE TABLE company_movement_correction_versions (
  id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  branch_id uuid NOT NULL REFERENCES branches(id),
  target_id uuid NOT NULL,
  target_version integer NOT NULL CHECK(target_version>0),
  action_id uuid NOT NULL UNIQUE,
  status text NOT NULL CHECK(status IN ('draft','confirmed')),
  reversal_entry_id bigint REFERENCES journal_entries(id),
  replacement_entry_id bigint REFERENCES journal_entries(id),
  created_by uuid NOT NULL REFERENCES users(id),
  acted_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(id,version),
  CONSTRAINT company_correction_identity_ck CHECK (
    payload->>'id'=id::text AND (payload->>'version')::integer=version
    AND payload->>'branchId'=branch_id::text AND payload->>'targetId'=target_id::text
    AND (payload->>'targetVersion')::integer=target_version
    AND payload->>'actionId'=action_id::text AND payload->>'status'=status
    AND payload->>'createdBy'=created_by::text AND payload->>'actedBy'=acted_by::text
    AND ash_has_visible_text(payload->>'reason')
    AND payload->>'financial' IN('true','false')
    AND (payload->'values'->>'amount') ~ '^[0-9]+\.[0-9]{2}$'
    AND replace(payload->'values'->>'amount','.','')::bigint>0
  ),
  CONSTRAINT company_correction_pair_ck CHECK (
    (status='draft' AND reversal_entry_id IS NULL AND replacement_entry_id IS NULL)
    OR (status='confirmed' AND (
      (payload->>'financial'='true' AND reversal_entry_id IS NOT NULL AND replacement_entry_id IS NOT NULL)
      OR (payload->>'financial'='false' AND reversal_entry_id IS NULL AND replacement_entry_id IS NULL)
    ))
  )
);

CREATE UNIQUE INDEX company_correction_confirmed_target_uq
  ON company_movement_correction_versions(branch_id,target_id,target_version) WHERE status='confirmed';

REVOKE UPDATE,DELETE,TRUNCATE ON company_movement_metadata,company_movement_correction_versions FROM app_user;
GRANT SELECT,INSERT ON company_movement_metadata,company_movement_correction_versions TO app_user;
REVOKE DELETE,TRUNCATE ON company_historical_intake_sessions FROM app_user;
GRANT SELECT,INSERT,UPDATE ON company_historical_intake_sessions TO app_user;

CREATE FUNCTION reject_company_movement_review_mutation() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'company movement evidence and correction versions are append-only'
    USING ERRCODE='23514', CONSTRAINT='company_movement_review_append_only';
END $$;

CREATE FUNCTION guard_company_movement_metadata() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE command_branch uuid; command_actor uuid; actor uuid := public.ash_current_actor();
BEGIN
  SELECT branch_id,created_by INTO command_branch,command_actor FROM (
    SELECT id,branch_id,created_by FROM company_moves UNION ALL SELECT id,branch_id,created_by FROM company_expenses
    UNION ALL SELECT id,branch_id,created_by FROM company_incomes UNION ALL SELECT id,branch_id,created_by FROM company_fx_exchanges
    UNION ALL SELECT id,branch_id,created_by FROM company_reversals
  ) commands WHERE id=NEW.command_id;
  IF command_branch IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'metadata must describe an existing HQ command' USING ERRCODE='23514';
  END IF;
  IF command_actor IS DISTINCT FROM actor OR NOT public.ash_actor_holds_all(actor,'company_fund.manage')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor AND active AND role_key IN('general_manager','system_admin')) THEN
    RAISE EXCEPTION 'historical evidence requires its attributed owner-level reviewer' USING ERRCODE='23514';
  END IF;
  IF NEW.payload->>'intakeSessionId' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM company_historical_intake_sessions s WHERE s.id=(NEW.payload->>'intakeSessionId')::uuid
      AND s.branch_id=NEW.branch_id
  ) THEN RAISE EXCEPTION 'metadata intake session is not owned by HQ' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_company_movement_correction_version() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous company_movement_correction_versions%ROWTYPE; target_branch uuid; confirmed_count integer;
  actor uuid := public.ash_current_actor(); effective_id uuid; effective_entry_id bigint;
BEGIN
  -- Serializes even a writer that bypasses the route's financial lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('ash:company-correction:'||NEW.target_id::text,0));
  IF NEW.acted_by IS DISTINCT FROM actor OR NOT public.ash_actor_holds_all(actor,'company_fund.manage') THEN
    RAISE EXCEPTION 'correction revision requires its attributed company-fund manager' USING ERRCODE='23514';
  END IF;
  SELECT branch_id INTO target_branch FROM company_expenses WHERE id=NEW.target_id;
  IF target_branch IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'correction target must be an HQ expense' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM company_movement_correction_versions
    WHERE status='confirmed' AND payload->>'financial'='true' AND (payload->>'replacementId')::uuid=NEW.target_id) THEN
    RAISE EXCEPTION 'correction target must be the original business event, not a replacement command'
      USING ERRCODE='23514',CONSTRAINT='company_correction_canonical_target_guard';
  END IF;
  SELECT * INTO previous FROM company_movement_correction_versions WHERE id=NEW.id ORDER BY version DESC LIMIT 1;
  IF (previous.id IS NULL AND NEW.version<>1) OR
    (previous.id IS NOT NULL AND (NEW.version<>previous.version+1 OR previous.status='confirmed'
      OR previous.branch_id<>NEW.branch_id OR previous.target_id<>NEW.target_id
      OR previous.target_version<>NEW.target_version OR previous.created_by<>NEW.created_by)) THEN
    RAISE EXCEPTION 'stale or immutable correction version' USING ERRCODE='23514', CONSTRAINT='company_movement_version_guard';
  END IF;
  IF NEW.status='confirmed' THEN
    IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor AND active AND role_key IN('general_manager','system_admin')) THEN
      RAISE EXCEPTION 'financial correction confirmation requires an owner-level reviewer' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO confirmed_count FROM company_movement_correction_versions
      WHERE target_id=NEW.target_id AND branch_id=NEW.branch_id AND status='confirmed';
    IF NEW.target_version<>confirmed_count+1 THEN
      RAISE EXCEPTION 'stale effective expense version' USING ERRCODE='23514', CONSTRAINT='company_movement_version_guard';
    END IF;
    SELECT (payload->>'replacementId')::uuid INTO effective_id FROM company_movement_correction_versions
      WHERE target_id=NEW.target_id AND status='confirmed' AND payload->>'financial'='true'
      ORDER BY target_version DESC LIMIT 1;
    effective_id:=COALESCE(effective_id,NEW.target_id);
    SELECT journal_entry_id INTO effective_entry_id FROM company_expenses WHERE id=effective_id AND branch_id=NEW.branch_id;
    IF NEW.payload->>'effectiveCommandId' IS DISTINCT FROM effective_id::text THEN
      RAISE EXCEPTION 'correction must use the current effective command' USING ERRCODE='23514';
    END IF;
    IF NEW.payload->>'financial'='false' AND NOT EXISTS (
      SELECT 1 FROM company_expenses e WHERE e.id=effective_id
        AND e.currency=NEW.payload->'values'->>'currency'
        AND e.amount_minor=replace(NEW.payload->'values'->>'amount','.','')::bigint
        AND e.paid_from=NEW.payload->'values'->>'paidFrom'
        AND e.cost_center_kind=NEW.payload->'values'->>'costCenterKind'
        AND e.vehicle_id IS NOT DISTINCT FROM (NEW.payload->'values'->>'vehicleId')::uuid
        AND e.asset_id IS NOT DISTINCT FROM (NEW.payload->'values'->>'assetId')::uuid
        AND e.syp_minor_per_usd IS NOT DISTINCT FROM (NEW.payload->'values'->>'sypMinorPerUsd')::bigint
    ) THEN RAISE EXCEPTION 'metadata-only correction cannot change financial values' USING ERRCODE='23514'; END IF;
    IF NEW.payload->>'financial'='true' AND (
      NOT EXISTS(SELECT 1 FROM company_reversals WHERE id=(NEW.payload->>'reversalId')::uuid
        AND branch_id=NEW.branch_id AND target_id=effective_id AND target_entry_id=effective_entry_id
        AND journal_entry_id=NEW.reversal_entry_id)
      OR NOT EXISTS(SELECT 1 FROM company_expenses WHERE id=(NEW.payload->>'replacementId')::uuid
        AND branch_id=NEW.branch_id AND journal_entry_id=NEW.replacement_entry_id
        AND currency=NEW.payload->'values'->>'currency'
        AND amount_minor=replace(NEW.payload->'values'->>'amount','.','')::bigint
        AND paid_from=NEW.payload->'values'->>'paidFrom'
        AND category_id=(NEW.payload->'values'->>'categoryId')::uuid
        AND cost_center_kind=NEW.payload->'values'->>'costCenterKind'
        AND vehicle_id IS NOT DISTINCT FROM (NEW.payload->'values'->>'vehicleId')::uuid
        AND asset_id IS NOT DISTINCT FROM (NEW.payload->'values'->>'assetId')::uuid
        AND receipt_media_id IS NOT DISTINCT FROM (NEW.payload->'values'->>'receiptMediaId')::uuid
        AND syp_minor_per_usd IS NOT DISTINCT FROM (NEW.payload->'values'->>'sypMinorPerUsd')::bigint
        AND occurred_on=(NEW.payload->'values'->>'occurredOn')::date
        AND description=NEW.payload->'values'->>'description')
    ) THEN RAISE EXCEPTION 'correction requires its exact inverse and replacement commands' USING ERRCODE='23514'; END IF;
    IF NEW.payload->>'financial'='true' AND EXISTS (
      SELECT 1 FROM journal_entries WHERE id IN (NEW.reversal_entry_id,NEW.replacement_entry_id) AND branch_id<>NEW.branch_id
    ) THEN RAISE EXCEPTION 'correction must not modify branch journal' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_company_historical_intake_update() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'intake session history cannot be deleted' USING ERRCODE='23514'; END IF;
  IF OLD.payload->>'closedAtMs' IS NOT NULL OR NEW.id<>OLD.id OR NEW.branch_id<>OLD.branch_id
    OR NEW.created_at<>OLD.created_at OR NEW.payload->>'closedAtMs' IS NULL
    OR NOT ash_has_visible_text(NEW.payload->>'closureReason')
    OR (NEW.payload-'closedBy'-'closedAtMs'-'closureReason') IS DISTINCT FROM (OLD.payload-'closedBy'-'closedAtMs'-'closureReason') THEN
    RAISE EXCEPTION 'only one reasoned intake-session closure is allowed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_company_historical_intake_actor() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=public.ash_current_actor();
BEGIN
  IF NOT public.ash_actor_holds_all(actor,'company_fund.manage')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor AND active AND role_key IN('general_manager','system_admin'))
    OR (TG_OP='INSERT' AND NEW.payload->>'createdBy' IS DISTINCT FROM actor::text)
    OR (TG_OP='UPDATE' AND NEW.payload->>'closedBy' IS DISTINCT FROM actor::text) THEN
    RAISE EXCEPTION 'historical intake requires its attributed owner-level reviewer' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- Preserve ordinary insufficient-cash protection. Only observed historical facts, or the exact
-- approved correction pair, may show a real negative cash balance. A receipt label alone cannot
-- grant this authority. Reserve overdrafts remain refused for all paths.
CREATE OR REPLACE FUNCTION assert_company_pocket_not_negative() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fund_type text; v_event_type text;
BEGIN
  SELECT type::text INTO fund_type FROM public.funds WHERE id=NEW.fund_id;
  IF fund_type IS NULL OR fund_type NOT IN('company_cash','depreciation_reserve') THEN RETURN NULL; END IF;
  SELECT je.event_type::text INTO v_event_type FROM public.journal_entries je WHERE je.id=NEW.entry_id;
  IF v_event_type IS NULL OR v_event_type='company_restoration_mirror' THEN RETURN NULL; END IF;
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

CREATE TRIGGER company_intake_hq_guard BEFORE INSERT OR UPDATE ON company_historical_intake_sessions
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER company_intake_actor_guard BEFORE INSERT OR UPDATE ON company_historical_intake_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_company_historical_intake_actor();
CREATE TRIGGER company_metadata_hq_guard BEFORE INSERT ON company_movement_metadata
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER company_correction_hq_guard BEFORE INSERT ON company_movement_correction_versions
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER company_metadata_command_guard BEFORE INSERT ON company_movement_metadata
  FOR EACH ROW EXECUTE FUNCTION guard_company_movement_metadata();
CREATE TRIGGER company_metadata_append_only BEFORE UPDATE OR DELETE ON company_movement_metadata
  FOR EACH ROW EXECUTE FUNCTION reject_company_movement_review_mutation();
CREATE TRIGGER company_correction_version_guard BEFORE INSERT ON company_movement_correction_versions
  FOR EACH ROW EXECUTE FUNCTION guard_company_movement_correction_version();
CREATE TRIGGER company_correction_append_only BEFORE UPDATE OR DELETE ON company_movement_correction_versions
  FOR EACH ROW EXECUTE FUNCTION reject_company_movement_review_mutation();
CREATE TRIGGER company_intake_closure_guard BEFORE UPDATE OR DELETE ON company_historical_intake_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_company_historical_intake_update();
CREATE TRIGGER audit_company_movement_metadata AFTER INSERT OR UPDATE OR DELETE ON company_movement_metadata
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_historical_intake_sessions AFTER INSERT OR UPDATE OR DELETE ON company_historical_intake_sessions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_movement_correction_versions AFTER INSERT OR UPDATE OR DELETE ON company_movement_correction_versions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
