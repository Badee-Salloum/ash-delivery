-- One immutable source receipt for every accepted line of a historical worksheet. A linked HQ
-- journal is required for cash movements; owner-direct purchases stay outside HQ cash and P&L.
-- The batch's deferred guard makes a partial import impossible to commit.

CREATE TABLE company_historical_import_batches (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  source_sha256 text NOT NULL UNIQUE CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_name text NOT NULL CHECK (ash_has_visible_text(source_name) AND length(source_name)<=300),
  cutoff_date date NOT NULL CHECK (cutoff_date >= DATE '2000-01-01'),
  expected_rows integer NOT NULL CHECK (expected_rows > 0),
  expected_posted_rows integer NOT NULL CHECK (expected_posted_rows BETWEEN 0 AND expected_rows),
  expected_syp_minor bigint NOT NULL,
  expected_usd_minor bigint NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE company_historical_import_receipts (
  source_reference text PRIMARY KEY CHECK (source_reference ~ '^HQ-SRC-[0-9]+(?:[–-][0-9]+)?$'),
  batch_id uuid NOT NULL REFERENCES company_historical_import_batches(id) ON DELETE RESTRICT,
  source_position integer NOT NULL CHECK (source_position > 0),
  occurred_on date NOT NULL CHECK (occurred_on >= DATE '2000-01-01'),
  movement_type text NOT NULL CHECK (movement_type IN
    ('branch_receipt','branch_payment','expense','asset_payment','exchange','refund')),
  paid_from text NOT NULL CHECK (paid_from IN ('pocket','owner_outside')),
  source_branch_id uuid REFERENCES branches(id) ON DELETE RESTRICT,
  journal_entry_id bigint UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  branch_journal_entry_id bigint REFERENCES journal_entries(id) ON DELETE RESTRICT,
  restoration_id bigint REFERENCES restorations(id) ON DELETE RESTRICT,
  original_evidence jsonb NOT NULL CHECK (jsonb_typeof(original_evidence)='object'),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, source_position),
  CHECK ((movement_type IN ('branch_receipt','branch_payment')) = (source_branch_id IS NOT NULL)),
  CHECK (paid_from='owner_outside' OR movement_type<>'asset_payment'),
  CHECK ((paid_from='pocket') = (journal_entry_id IS NOT NULL)),
  CHECK (restoration_id IS NULL OR movement_type IN ('branch_receipt','branch_payment')),
  CHECK (branch_journal_entry_id IS NULL OR movement_type='branch_payment')
);
CREATE INDEX company_historical_receipts_day_idx
  ON company_historical_import_receipts(batch_id,occurred_on,source_position);

CREATE FUNCTION guard_company_historical_import_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_batch company_historical_import_batches%ROWTYPE; v_actor uuid:=public.ash_current_actor();
  v_event text; v_entry_branch uuid; v_entry_date date; v_entry_ref text;
BEGIN
  SELECT * INTO v_batch FROM public.company_historical_import_batches WHERE id=NEW.batch_id;
  IF v_batch.id IS NULL OR NEW.created_by IS DISTINCT FROM v_actor OR v_batch.created_by IS DISTINCT FROM v_actor
     OR NOT public.ash_actor_holds_all(v_actor,'company_fund.manage')
     OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=v_actor AND active AND
       role_key IN('general_manager','system_admin')) THEN
    RAISE EXCEPTION 'historical import requires its attributed owner-level manager'
      USING ERRCODE='23514',CONSTRAINT='historical_import_actor_guard';
  END IF;
  IF NEW.occurred_on>v_batch.cutoff_date OR NEW.original_evidence->>'sourceId' IS DISTINCT FROM
     substring(NEW.source_reference from '^HQ-SRC-(.*)$') OR
     NEW.original_evidence->'payload'->>'occurredOn' IS DISTINCT FROM NEW.occurred_on::text OR
     NEW.original_evidence->'payload'->>'type' IS DISTINCT FROM NEW.movement_type THEN
    RAISE EXCEPTION 'historical source receipt does not match its evidence or cutoff'
      USING ERRCODE='23514',CONSTRAINT='historical_import_source_guard';
  END IF;
  IF NEW.source_branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.branches
      WHERE id=NEW.source_branch_id AND kind='branch') THEN
    RAISE EXCEPTION 'historical source branch is invalid'
      USING ERRCODE='23514',CONSTRAINT='historical_import_branch_guard';
  END IF;
  IF NEW.journal_entry_id IS NOT NULL THEN
    SELECT event_type::text,branch_id,business_date,external_reference
      INTO v_event,v_entry_branch,v_entry_date,v_entry_ref
      FROM public.journal_entries WHERE id=NEW.journal_entry_id;
    IF v_entry_branch IS DISTINCT FROM v_batch.branch_id OR v_entry_date IS DISTINCT FROM NEW.occurred_on
      OR v_entry_ref IS DISTINCT FROM NEW.source_reference OR v_event IS DISTINCT FROM (CASE NEW.movement_type
        WHEN 'branch_receipt' THEN 'company_historical_transfer'
        WHEN 'branch_payment' THEN 'company_historical_transfer'
        WHEN 'expense' THEN 'company_expense'
        WHEN 'exchange' THEN 'company_fx_exchange'
        WHEN 'refund' THEN 'company_correction'
        ELSE NULL END) THEN
      RAISE EXCEPTION 'historical receipt does not name its exact financial-day HQ journal'
        USING ERRCODE='23514',CONSTRAINT='historical_import_journal_guard';
    END IF;
  END IF;
  IF NEW.branch_journal_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.journal_entries
      WHERE id=NEW.branch_journal_entry_id AND branch_id=NEW.source_branch_id) THEN
    RAISE EXCEPTION 'linked branch receipt belongs to another branch'
      USING ERRCODE='23514',CONSTRAINT='historical_import_branch_entry_guard';
  END IF;
  IF NEW.restoration_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.restorations
      WHERE id=NEW.restoration_id AND branch_id=NEW.source_branch_id) THEN
    RAISE EXCEPTION 'linked restoration belongs to another branch'
      USING ERRCODE='23514',CONSTRAINT='historical_import_restoration_guard';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION assert_company_historical_import_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_rows integer; v_posted integer; v_syp bigint; v_usd bigint;
BEGIN
  SELECT count(*)::integer,count(journal_entry_id)::integer INTO v_rows,v_posted
    FROM public.company_historical_import_receipts WHERE batch_id=NEW.id;
  IF v_rows<>NEW.expected_rows OR v_posted<>NEW.expected_posted_rows THEN
    RAISE EXCEPTION 'historical batch has % of % rows and % of % HQ postings',
      v_rows,NEW.expected_rows,v_posted,NEW.expected_posted_rows
      USING ERRCODE='23514',CONSTRAINT='historical_import_count_guard';
  END IF;
  SELECT COALESCE(sum(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END),0)::bigint
    INTO v_syp FROM public.journal_lines jl JOIN public.funds f ON f.id=jl.fund_id
    JOIN public.journal_entries je ON je.id=jl.entry_id
    WHERE je.branch_id=NEW.branch_id AND je.business_date<=NEW.cutoff_date
      AND f.code='company_cash:SYP_NEW';
  SELECT COALESCE(sum(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END),0)::bigint
    INTO v_usd FROM public.journal_lines jl JOIN public.funds f ON f.id=jl.fund_id
    JOIN public.journal_entries je ON je.id=jl.entry_id
    WHERE je.branch_id=NEW.branch_id AND je.business_date<=NEW.cutoff_date
      AND f.code='company_cash:USD';
  IF v_syp<>NEW.expected_syp_minor OR v_usd<>NEW.expected_usd_minor THEN
    RAISE EXCEPTION 'historical cutoff cash (% SYP minor, % USD cents) differs from source (% and %)',
      v_syp,v_usd,NEW.expected_syp_minor,NEW.expected_usd_minor
      USING ERRCODE='23514',CONSTRAINT='historical_import_closing_guard';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER company_historical_import_batches_hq_guard BEFORE INSERT ON company_historical_import_batches
  FOR EACH ROW EXECUTE FUNCTION assert_branch_kind('company');
CREATE TRIGGER company_historical_import_receipts_insert_guard BEFORE INSERT ON company_historical_import_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_company_historical_import_receipt();
CREATE CONSTRAINT TRIGGER company_historical_import_batch_complete AFTER INSERT ON company_historical_import_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_company_historical_import_batch();
CREATE TRIGGER company_historical_import_batches_immutable BEFORE UPDATE OR DELETE ON company_historical_import_batches
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_historical_import_receipts_immutable BEFORE UPDATE OR DELETE ON company_historical_import_receipts
  FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER audit_company_historical_import_batches AFTER INSERT OR UPDATE OR DELETE ON company_historical_import_batches
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_historical_import_receipts AFTER INSERT OR UPDATE OR DELETE ON company_historical_import_receipts
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
REVOKE UPDATE,DELETE,TRUNCATE ON company_historical_import_batches,company_historical_import_receipts FROM app_user;
GRANT SELECT,INSERT ON company_historical_import_batches,company_historical_import_receipts TO app_user;
