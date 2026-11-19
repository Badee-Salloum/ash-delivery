-- 0087: actual branch restoration, immutable HQ proposal, reviewed HQ-only confirmation.
-- Additive and disabled by the API feature flag until explicit cutover/testing approval.
-- The existing company_restoration_mirror event is reused with a distinct review: occurrence
-- namespace and a separately guarded fact. Old mirror rows/journals are NEVER changed.

CREATE TABLE company_restoration_proposals (
  id uuid PRIMARY KEY,
  restoration_id bigint NOT NULL UNIQUE REFERENCES restorations(id) ON DELETE RESTRICT,
  source_branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  company_branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  business_date date NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX company_restoration_proposals_company_date_idx ON company_restoration_proposals (company_branch_id,business_date,id);
CREATE TABLE company_restoration_proposal_legs (
  proposal_id uuid NOT NULL REFERENCES company_restoration_proposals(id) ON DELETE RESTRICT,
  source_entry_id bigint PRIMARY KEY REFERENCES journal_entries(id) ON DELETE RESTRICT,
  fund_code text NOT NULL CHECK (fund_code IN ('office_cash','office_wallet')),
  direction text NOT NULL CHECK (direction IN ('to_company','from_company')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  UNIQUE (proposal_id,source_entry_id)
);
CREATE TABLE company_restoration_review_revisions (
  id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL REFERENCES company_restoration_proposals(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('revise','defer','confirm','correct')),
  reason text NOT NULL CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500),
  occurred_on date NOT NULL CHECK (occurred_on >= DATE '2000-01-01'),
  business_date date NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (occurred_on <= business_date),
  UNIQUE (proposal_id,version)
);
CREATE TABLE company_restoration_review_legs (
  revision_id uuid NOT NULL REFERENCES company_restoration_review_revisions(id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL REFERENCES company_restoration_proposals(id) ON DELETE RESTRICT,
  source_entry_id bigint NOT NULL REFERENCES company_restoration_proposal_legs(source_entry_id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  journal_entry_id bigint UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversal_entry_id bigint UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  PRIMARY KEY (revision_id,source_entry_id)
);
CREATE TRIGGER company_restoration_proposals_immutable BEFORE UPDATE OR DELETE ON company_restoration_proposals FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_restoration_proposal_legs_immutable BEFORE UPDATE OR DELETE ON company_restoration_proposal_legs FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_restoration_review_revisions_immutable BEFORE UPDATE OR DELETE ON company_restoration_review_revisions FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_restoration_review_legs_immutable BEFORE UPDATE OR DELETE ON company_restoration_review_legs FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER audit_company_restoration_proposals AFTER INSERT OR UPDATE OR DELETE ON company_restoration_proposals FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_restoration_proposal_legs AFTER INSERT OR UPDATE OR DELETE ON company_restoration_proposal_legs FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_restoration_review_revisions AFTER INSERT OR UPDATE OR DELETE ON company_restoration_review_revisions FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_restoration_review_legs AFTER INSERT OR UPDATE OR DELETE ON company_restoration_review_legs FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE FUNCTION guard_company_restoration_proposal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_run public.restorations%ROWTYPE; v_actor uuid := public.ash_current_actor();
BEGIN
  SELECT * INTO v_run FROM public.restorations WHERE id=NEW.restoration_id;
  IF v_actor IS NULL OR v_actor IS DISTINCT FROM NEW.created_by
    OR v_run.performed_by IS DISTINCT FROM v_actor
    OR v_run.branch_id IS DISTINCT FROM NEW.source_branch_id
    OR v_run.business_date IS DISTINCT FROM NEW.business_date
    OR (v_run.plan->>'schemaVersion')::integer IS DISTINCT FROM 4
    OR NEW.payload->'snapshot' IS DISTINCT FROM jsonb_build_object('openingBalances',v_run.plan->'openingBalances','legs',v_run.plan->'legs')
    OR NOT EXISTS (SELECT 1 FROM public.company_ledger_cutovers c
      WHERE c.branch_id=NEW.source_branch_id AND c.company_branch_id=NEW.company_branch_id)
    OR NOT EXISTS (SELECT 1 FROM public.users u JOIN public.role_permissions rp ON rp.role_key=u.role_key
      WHERE u.id=v_actor AND u.active AND rp.permission_key='journal.manual.write'
      AND (rp.scope='all' OR (rp.scope='branch' AND u.branch_id=NEW.source_branch_id)))
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
CREATE TRIGGER company_restoration_proposals_insert_guard BEFORE INSERT ON company_restoration_proposals FOR EACH ROW EXECUTE FUNCTION guard_company_restoration_proposal();

CREATE FUNCTION guard_company_restoration_proposal_leg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_proposal public.company_restoration_proposals%ROWTYPE; v_source public.journal_entries%ROWTYPE; v_expected jsonb;
BEGIN
  SELECT * INTO v_proposal FROM public.company_restoration_proposals WHERE id=NEW.proposal_id;
  SELECT * INTO v_source FROM public.journal_entries WHERE id=NEW.source_entry_id;
  IF v_source.branch_id IS DISTINCT FROM v_proposal.source_branch_id OR v_source.event_type::text IS DISTINCT FROM 'restoration'
    OR v_source.business_date IS DISTINCT FROM v_proposal.business_date
    OR NOT EXISTS (SELECT 1 FROM public.company_ledger_cutovers c WHERE c.branch_id=v_proposal.source_branch_id
      AND NEW.source_entry_id>c.watermark_entry_id)
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
CREATE TRIGGER company_restoration_proposal_legs_insert_guard BEFORE INSERT ON company_restoration_proposal_legs FOR EACH ROW EXECUTE FUNCTION guard_company_restoration_proposal_leg();

-- A source leg has exactly ONE counterparty workflow, including offsetting runs whose net is zero.
CREATE FUNCTION refuse_legacy_mirror_for_reviewed_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.company_restoration_proposal_legs WHERE source_entry_id=NEW.source_entry_id)
  THEN RAISE EXCEPTION 'reviewed source cannot also receive a legacy direct cash mirror'
    USING ERRCODE='23514', CONSTRAINT='company_restoration_workflow_exclusive_guard'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_restoration_mirrors_01_review_exclusive BEFORE INSERT ON company_restoration_mirrors
  FOR EACH ROW EXECUTE FUNCTION refuse_legacy_mirror_for_reviewed_source();

CREATE FUNCTION guard_company_restoration_revision() RETURNS trigger
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
  IF NEW.version <> v_current+1 OR (NEW.kind IN ('confirm','revise') AND v_confirmed)
    OR (NEW.kind='correct' AND NOT v_confirmed)
  THEN RAISE EXCEPTION 'restoration review version or confirmation state conflict'
    USING ERRCODE='23514', CONSTRAINT='company_restoration_review_version_guard'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_restoration_review_revisions_insert_guard BEFORE INSERT ON company_restoration_review_revisions FOR EACH ROW EXECUTE FUNCTION guard_company_restoration_revision();

CREATE FUNCTION guard_company_restoration_review_leg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_revision public.company_restoration_review_revisions%ROWTYPE;
  v_proposal public.company_restoration_proposals%ROWTYPE; v_source public.company_restoration_proposal_legs%ROWTYPE;
  v_previous public.company_restoration_review_legs%ROWTYPE; v_role text; v_clearing text;
  v_cash_side text; v_other_side text; v_key text;
BEGIN
  SELECT * INTO v_revision FROM public.company_restoration_review_revisions WHERE id=NEW.revision_id;
  SELECT * INTO v_proposal FROM public.company_restoration_proposals WHERE id=NEW.proposal_id;
  SELECT * INTO v_source FROM public.company_restoration_proposal_legs WHERE source_entry_id=NEW.source_entry_id;
  IF v_revision.proposal_id IS DISTINCT FROM NEW.proposal_id OR v_source.proposal_id IS DISTINCT FROM NEW.proposal_id
  THEN RAISE EXCEPTION 'review leg source/proposal mismatch' USING ERRCODE='23514', CONSTRAINT='company_restoration_review_leg_guard'; END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.branch_id=v_proposal.source_branch_id
    AND je.event_type::text='correction' AND je.occurrence_key='reversal-of-'||NEW.source_entry_id::text)
  THEN RAISE EXCEPTION 'restoration source was corrected and needs accountant review'
    USING ERRCODE='23514', CONSTRAINT='company_restoration_review_source_corrected'; END IF;
  SELECT l.* INTO v_previous FROM public.company_restoration_review_legs l
    JOIN public.company_restoration_review_revisions r ON r.id=l.revision_id
    WHERE r.proposal_id=NEW.proposal_id AND r.version<v_revision.version AND r.kind IN ('confirm','correct')
      AND l.source_entry_id=NEW.source_entry_id ORDER BY r.version DESC LIMIT 1;
  v_role := CASE v_source.direction WHEN 'to_company' THEN 'kaish_mirror' ELSE 'shahn_mirror' END;
  v_cash_side := CASE v_source.direction WHEN 'to_company' THEN 'D' ELSE 'C' END;
  v_other_side := CASE v_source.direction WHEN 'to_company' THEN 'C' ELSE 'D' END;
  v_clearing := 'branch_clearing:'||v_proposal.source_branch_id::text;
  IF v_revision.kind NOT IN ('confirm','correct') THEN
    IF NEW.journal_entry_id IS NOT NULL OR NEW.reversal_entry_id IS NOT NULL
    THEN RAISE EXCEPTION 'unconfirmed review cannot create cash entries' USING ERRCODE='23514'; END IF;
  ELSE
    IF (NEW.amount_minor>0) IS DISTINCT FROM (NEW.journal_entry_id IS NOT NULL)
      OR (v_revision.kind='correct' AND COALESCE(v_previous.amount_minor,0)>0) IS DISTINCT FROM (NEW.reversal_entry_id IS NOT NULL)
    THEN RAISE EXCEPTION 'HQ confirmation entry presence differs from actual amounts' USING ERRCODE='23514'; END IF;
    IF NEW.journal_entry_id IS NOT NULL AND (
      NOT public.ash_company_entry_is(NEW.journal_entry_id,v_proposal.company_branch_id,'company_restoration_mirror',
        'review:'||v_revision.id::text||':'||NEW.source_entry_id::text,v_revision.business_date,v_revision.reason,v_revision.created_by,NULL)
      OR NOT public.ash_company_lines_match(NEW.journal_entry_id,v_proposal.company_branch_id,jsonb_build_array(
        public.ash_company_line('company_cash:SYP_NEW','company_cash','SYP_NEW',v_cash_side,NEW.amount_minor,v_role),
        public.ash_company_line(v_clearing,'branch_clearing','SYP_NEW',v_other_side,NEW.amount_minor,v_role))))
    THEN RAISE EXCEPTION 'HQ confirmation differs from its exact guarded line set' USING ERRCODE='23514', CONSTRAINT='company_restoration_review_journal_guard'; END IF;
    IF NEW.reversal_entry_id IS NOT NULL AND (
      NOT public.ash_company_entry_is(NEW.reversal_entry_id,v_proposal.company_branch_id,'company_restoration_mirror',
        'review-reverse:'||v_revision.id::text||':'||NEW.source_entry_id::text,v_revision.business_date,v_revision.reason,v_revision.created_by,NULL)
      OR NOT public.ash_company_lines_match(NEW.reversal_entry_id,v_proposal.company_branch_id,jsonb_build_array(
        public.ash_company_line('company_cash:SYP_NEW','company_cash','SYP_NEW',v_other_side,v_previous.amount_minor,v_role),
        public.ash_company_line(v_clearing,'branch_clearing','SYP_NEW',v_cash_side,v_previous.amount_minor,v_role))))
    THEN RAISE EXCEPTION 'HQ correction must reverse only the previous HQ confirmation' USING ERRCODE='23514', CONSTRAINT='company_restoration_review_journal_guard'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_revision.payload->'legs') leg
    WHERE leg->>'sourceEntryId'=NEW.source_entry_id::text AND leg->'amount'->>'minor'=NEW.amount_minor::text
      AND (leg->>'journalEntryId') IS NOT DISTINCT FROM NEW.journal_entry_id::text
      AND (leg->>'reversalEntryId') IS NOT DISTINCT FROM NEW.reversal_entry_id::text)
  THEN RAISE EXCEPTION 'review payload does not match its leg' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_restoration_review_legs_insert_guard BEFORE INSERT ON company_restoration_review_legs FOR EACH ROW EXECUTE FUNCTION guard_company_restoration_review_leg();

-- Signed unresolved counterpart, not income/expense and never a second branch restoration.
CREATE FUNCTION ash_restoration_pending_difference(p_branch uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(sum((CASE s.direction WHEN 'to_company' THEN 1 ELSE -1 END)::numeric *
    (s.amount_minor::numeric-COALESCE(c.amount_minor,0)::numeric)),0)
  FROM public.company_restoration_proposal_legs s
  JOIN public.company_restoration_proposals p ON p.id=s.proposal_id
  LEFT JOIN LATERAL (SELECT l.amount_minor FROM public.company_restoration_review_legs l
    JOIN public.company_restoration_review_revisions r ON r.id=l.revision_id
    WHERE l.source_entry_id=s.source_entry_id AND r.kind IN ('confirm','correct')
    ORDER BY r.version DESC LIMIT 1) c ON true WHERE p.source_branch_id=p_branch
$$;

CREATE OR REPLACE FUNCTION assert_company_box_mirrored() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_type text; v_fund_branch uuid; v_code text; v_branch uuid; v_cutover public.company_ledger_cutovers%ROWTYPE;
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
    AND NOT EXISTS (SELECT 1 FROM public.company_restoration_mirrors WHERE source_entry_id=NEW.entry_id)
    AND NOT EXISTS (SELECT 1 FROM public.company_restoration_proposal_legs WHERE source_entry_id=NEW.entry_id)
  THEN RAISE EXCEPTION 'company_box entry needs existing mirror or actual-restoration proposal'
    USING ERRCODE='23514', CONSTRAINT='company_box_mirror_guard'; END IF;
  IF public.ash_fund_balance(v_branch,'company_box')+
    public.ash_fund_balance(v_cutover.company_branch_id,'branch_clearing:'||v_branch::text)
    <> public.ash_restoration_pending_difference(v_branch)
  THEN RAISE EXCEPTION 'clearing imbalance not explained by immutable pending restoration differences'
    USING ERRCODE='23514', CONSTRAINT='company_clearing_invariant_guard'; END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION assert_company_cutover_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_branch uuid; v_company uuid;
BEGIN
  IF TG_TABLE_NAME='company_ledger_cutovers' THEN v_branch:=NEW.branch_id; v_company:=NEW.company_branch_id;
  ELSE v_branch:=NEW.source_branch_id; SELECT company_branch_id INTO v_company FROM public.company_ledger_cutovers WHERE branch_id=v_branch; END IF;
  IF public.ash_fund_balance(v_branch,'company_box')+public.ash_fund_balance(v_company,'branch_clearing:'||v_branch::text)
    <>public.ash_restoration_pending_difference(v_branch)
  THEN RAISE EXCEPTION 'clearing difference not explained by immutable review evidence'
    USING ERRCODE='23514', CONSTRAINT='company_clearing_invariant_guard'; END IF;
  RETURN NULL;
END $$;

-- Keep the latest original company-fact trigger function (also extended by asset/debt migrations)
-- untouched; direct mirror entries continue to require their exact existing mirror fact.
DROP TRIGGER journal_entries_company_fact ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_company_fact AFTER INSERT OR UPDATE OF event_type,branch_id,shift_id ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (ash_is_company_event(NEW.event_type::text) AND NEW.occurrence_key !~ '^review(-reverse)?:')
  EXECUTE FUNCTION assert_company_journal_fact();
CREATE FUNCTION assert_company_restoration_review_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.event_type::text IS DISTINCT FROM 'company_restoration_mirror' OR NEW.shift_id IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM public.company_restoration_review_legs l
      WHERE l.journal_entry_id=NEW.id OR l.reversal_entry_id=NEW.id)
  THEN RAISE EXCEPTION 'review journal requires its exact immutable HQ review fact'
    USING ERRCODE='23514', CONSTRAINT='company_restoration_review_fact_guard'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entries_restoration_review_fact AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.occurrence_key ~ '^review(-reverse)?:')
  EXECUTE FUNCTION assert_company_restoration_review_fact();

CREATE FUNCTION assert_restoration_review_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_proposal uuid; v_expected integer; v_actual integer;
BEGIN
  IF TG_TABLE_NAME='company_restoration_proposals' THEN
    v_proposal:=NEW.id;
    SELECT jsonb_array_length(r.plan->'restorationJournalEntryIds') INTO v_expected FROM public.restorations r WHERE r.id=NEW.restoration_id;
    SELECT count(*) INTO v_actual FROM public.company_restoration_proposal_legs WHERE proposal_id=v_proposal;
    IF v_actual<>v_expected OR jsonb_array_length(NEW.payload->'legs')<>v_expected
    THEN RAISE EXCEPTION 'proposal must retain every actual branch leg including offsetting legs' USING ERRCODE='23514'; END IF;
  ELSE
    v_proposal:=NEW.proposal_id;
    SELECT count(*) INTO v_expected FROM public.company_restoration_proposal_legs WHERE proposal_id=v_proposal;
    SELECT count(*) INTO v_actual FROM public.company_restoration_review_legs WHERE revision_id=NEW.id;
    IF v_actual<>v_expected OR jsonb_array_length(NEW.payload->'legs')<>v_expected
    THEN RAISE EXCEPTION 'review must retain every source leg' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER company_restoration_proposals_complete AFTER INSERT ON company_restoration_proposals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_restoration_review_complete();
CREATE CONSTRAINT TRIGGER company_restoration_review_revisions_complete AFTER INSERT ON company_restoration_review_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_restoration_review_complete();
