-- Human-approved reclassification of WHOLE linked historical restoration groups.
-- Original cash journals, branch runs and frozen cutover baselines remain immutable.
-- The new event can touch exactly two HQ SYP accounts, never cash or profit accounts.
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'company_historical_restoration_reclass';

CREATE TABLE company_historical_restoration_settlements (
  id uuid PRIMARY KEY,
  company_branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  source_branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK(version>0),
  cutover_watermark_entry_id bigint NOT NULL CHECK(cutover_watermark_entry_id>=0),
  evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  business_date date NOT NULL CHECK(business_date>=DATE '2000-01-01'),
  reason text NOT NULL CHECK(ash_has_visible_text(reason) AND length(reason)<=500),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE(source_branch_id,version), CHECK(company_branch_id<>source_branch_id)
);
CREATE TABLE company_historical_restoration_settlement_groups (
  settlement_id uuid NOT NULL REFERENCES company_historical_restoration_settlements(id) ON DELETE RESTRICT,
  restoration_id bigint NOT NULL UNIQUE REFERENCES restorations(id) ON DELETE RESTRICT,
  business_date date NOT NULL CHECK(business_date>=DATE '2000-01-01'),
  branch_net_minor bigint NOT NULL,
  company_net_minor bigint NOT NULL,
  variance_minor bigint NOT NULL,
  PRIMARY KEY(settlement_id,restoration_id),
  CHECK(variance_minor::numeric=branch_net_minor::numeric-company_net_minor::numeric)
);
CREATE TABLE company_historical_restoration_settlement_sources (
  settlement_id uuid NOT NULL,
  restoration_id bigint NOT NULL,
  source_entry_id bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK(direction IN('to_company','from_company')),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  PRIMARY KEY(settlement_id,source_entry_id),
  FOREIGN KEY(settlement_id,restoration_id) REFERENCES company_historical_restoration_settlement_groups(settlement_id,restoration_id) ON DELETE RESTRICT
);
CREATE TABLE company_historical_restoration_settlement_legs (
  settlement_id uuid NOT NULL,
  restoration_id bigint NOT NULL,
  source_reference text NOT NULL UNIQUE REFERENCES company_historical_import_receipts(source_reference) ON DELETE RESTRICT,
  historical_journal_entry_id bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK(direction IN('to_company','from_company')),
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  journal_entry_id bigint NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  PRIMARY KEY(settlement_id,historical_journal_entry_id),
  FOREIGN KEY(settlement_id,restoration_id) REFERENCES company_historical_restoration_settlement_groups(settlement_id,restoration_id) ON DELETE RESTRICT,
  CHECK(historical_journal_entry_id<>journal_entry_id)
);
CREATE INDEX company_historical_settlements_branch_idx ON company_historical_restoration_settlements(company_branch_id,source_branch_id,version);

CREATE FUNCTION guard_company_historical_settlement_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_actor uuid:=public.ash_current_actor(); v_version integer; v_cutover public.company_ledger_cutovers%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NEW.created_by IS DISTINCT FROM v_actor
    OR NEW.created_xid IS DISTINCT FROM pg_current_xact_id()
    OR NOT public.ash_actor_holds_all(v_actor,'company_fund.manage')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=v_actor AND active AND role_key IN('general_manager','system_admin'))
    OR NOT EXISTS(SELECT 1 FROM public.branches WHERE id=NEW.company_branch_id AND kind='company')
    OR NOT EXISTS(SELECT 1 FROM public.branches WHERE id=NEW.source_branch_id AND kind='branch')
  THEN RAISE EXCEPTION 'historical settlement requires an attributed owner-level manager and operating branch'
    USING ERRCODE='23514',CONSTRAINT='company_historical_settlement_actor_guard'; END IF;
  -- Same branch -> HQ ordering as restoration/cutover; the version read is serialized.
  PERFORM pg_advisory_xact_lock(hashtextextended('ash:financial:receivables:'||NEW.source_branch_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ash:financial:receivables:'||NEW.company_branch_id::text,0));
  SELECT * INTO v_cutover FROM public.company_ledger_cutovers WHERE branch_id=NEW.source_branch_id;
  IF v_cutover.mode IS DISTINCT FROM 'link_only' OR v_cutover.company_branch_id IS DISTINCT FROM NEW.company_branch_id
    OR v_cutover.watermark_entry_id IS DISTINCT FROM NEW.cutover_watermark_entry_id
  THEN RAISE EXCEPTION 'settlement must use the immutable link-only cutover'
    USING ERRCODE='23514',CONSTRAINT='company_historical_settlement_cutover_guard'; END IF;
  SELECT COALESCE(max(version),0) INTO v_version FROM public.company_historical_restoration_settlements WHERE source_branch_id=NEW.source_branch_id;
  IF NEW.version<>v_version+1 THEN RAISE EXCEPTION 'historical settlement version changed'
    USING ERRCODE='23514',CONSTRAINT='company_historical_settlement_version_guard'; END IF;
  IF NEW.payload->>'id' IS DISTINCT FROM NEW.id::text
    OR NEW.payload->>'companyBranchId' IS DISTINCT FROM NEW.company_branch_id::text
    OR NEW.payload->>'sourceBranchId' IS DISTINCT FROM NEW.source_branch_id::text
    OR NEW.payload->>'version' IS DISTINCT FROM NEW.version::text
    OR NEW.payload->>'cutoverWatermarkEntryId' IS DISTINCT FROM NEW.cutover_watermark_entry_id::text
    OR NEW.payload->>'evidenceHash' IS DISTINCT FROM NEW.evidence_hash
    OR NEW.payload->>'requestHash' IS DISTINCT FROM NEW.request_hash
    OR NEW.payload->>'businessDate' IS DISTINCT FROM NEW.business_date::text
    OR NEW.payload->>'reason' IS DISTINCT FROM NEW.reason
    OR NEW.payload->>'createdBy' IS DISTINCT FROM NEW.created_by::text
    OR (NEW.payload->>'createdAtMs')::numeric IS DISTINCT FROM extract(epoch FROM NEW.created_at)*1000
    OR jsonb_typeof(NEW.payload->'groups') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.payload->'legs') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.payload->'groups')=0 OR jsonb_array_length(NEW.payload->'legs')=0
  THEN RAISE EXCEPTION 'settlement columns differ from approved immutable evidence'
    USING ERRCODE='23514',CONSTRAINT='company_historical_settlement_payload_guard'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_historical_settlements_insert_guard BEFORE INSERT ON company_historical_restoration_settlements
  FOR EACH ROW EXECUTE FUNCTION guard_company_historical_settlement_insert();

-- Child evidence may be inserted only beside its NEW header, by the same actor, in one transaction.
-- This makes one deferred full-batch validation sufficient; append-after-approval is impossible.
CREATE FUNCTION guard_company_historical_settlement_child_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_payload jsonb; v_expected integer; v_count bigint;
BEGIN
  SELECT s.payload INTO v_payload FROM public.company_historical_restoration_settlements s WHERE s.id=NEW.settlement_id
    AND s.created_xid=pg_current_xact_id() AND s.created_by=public.ash_current_actor();
  IF v_payload IS NULL
  THEN RAISE EXCEPTION 'historical settlement evidence must be created atomically with its header'
    USING ERRCODE='23514',CONSTRAINT='company_historical_settlement_same_transaction_guard'; END IF;
  -- Even SET CONSTRAINTS ALL IMMEDIATE cannot allow an extra child after the header's proof.
  -- Header/children are immutable, so only INSERT can change cardinality; cap it BEFORE every insert.
  IF TG_TABLE_NAME='company_historical_restoration_settlement_groups' THEN
    v_expected:=jsonb_array_length(v_payload->'groups');
    SELECT count(*) INTO v_count FROM public.company_historical_restoration_settlement_groups WHERE settlement_id=NEW.settlement_id;
  ELSIF TG_TABLE_NAME='company_historical_restoration_settlement_legs' THEN
    v_expected:=jsonb_array_length(v_payload->'legs');
    SELECT count(*) INTO v_count FROM public.company_historical_restoration_settlement_legs WHERE settlement_id=NEW.settlement_id;
  ELSE
    SELECT COALESCE(sum(jsonb_array_length(item->'branchSourceEntries')),0)::integer INTO v_expected FROM jsonb_array_elements(v_payload->'groups') item;
    SELECT count(*) INTO v_count FROM public.company_historical_restoration_settlement_sources WHERE settlement_id=NEW.settlement_id;
  END IF;
  IF v_count>=v_expected THEN RAISE EXCEPTION 'settlement cannot append evidence beyond its approved immutable set'
    USING ERRCODE='23514',CONSTRAINT='company_historical_settlement_cardinality_guard'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_historical_settlement_groups_insert_guard BEFORE INSERT ON company_historical_restoration_settlement_groups FOR EACH ROW EXECUTE FUNCTION guard_company_historical_settlement_child_insert();
CREATE TRIGGER company_historical_settlement_sources_insert_guard BEFORE INSERT ON company_historical_restoration_settlement_sources FOR EACH ROW EXECUTE FUNCTION guard_company_historical_settlement_child_insert();
CREATE TRIGGER company_historical_settlement_legs_insert_guard BEFORE INSERT ON company_historical_restoration_settlement_legs FOR EACH ROW EXECUTE FUNCTION guard_company_historical_settlement_child_insert();

CREATE FUNCTION assert_company_historical_settlement_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_batch public.company_historical_restoration_settlements%ROWTYPE; v_group record; v_source record; v_leg record;
  v_payload jsonb; v_group_payload jsonb; v_branch_net numeric; v_company_net numeric;
BEGIN
  IF TG_TABLE_NAME='company_historical_restoration_settlements' THEN
    SELECT * INTO v_batch FROM public.company_historical_restoration_settlements WHERE id=NEW.id;
  ELSE
    SELECT * INTO v_batch FROM public.company_historical_restoration_settlements WHERE id=NEW.settlement_id;
  END IF;
  IF v_batch.id IS NULL THEN RAISE EXCEPTION 'settlement evidence requires its immutable header' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM public.company_historical_restoration_settlement_groups WHERE settlement_id=v_batch.id)
       <>jsonb_array_length(v_batch.payload->'groups')
    OR (SELECT count(*) FROM public.company_historical_restoration_settlement_legs WHERE settlement_id=v_batch.id)
       <>jsonb_array_length(v_batch.payload->'legs')
  THEN RAISE EXCEPTION 'settlement requires every approved group and HQ leg'
    USING ERRCODE='23514',CONSTRAINT='company_historical_settlement_complete_guard'; END IF;
  FOR v_group IN SELECT * FROM public.company_historical_restoration_settlement_groups WHERE settlement_id=v_batch.id LOOP
    SELECT item INTO v_group_payload FROM jsonb_array_elements(v_batch.payload->'groups') item WHERE item->>'restorationId'=v_group.restoration_id::text;
    IF v_group_payload IS NULL OR NOT EXISTS(SELECT 1 FROM public.restorations r
      WHERE r.id=v_group.restoration_id AND r.branch_id=v_batch.source_branch_id AND r.business_date=v_group.business_date
        AND r.plan->>'schemaVersion' IN('3','4') AND r.net_to_company_minor=v_group.branch_net_minor)
      OR v_group_payload->>'businessDate' IS DISTINCT FROM v_group.business_date::text
      OR v_group_payload->'branchNet'->>'minor' IS DISTINCT FROM v_group.branch_net_minor::text
      OR v_group_payload->'companyNet'->>'minor' IS DISTINCT FROM v_group.company_net_minor::text
      OR v_group_payload->'variance'->>'minor' IS DISTINCT FROM v_group.variance_minor::text
      OR jsonb_typeof(v_group_payload->'branchSourceEntries') IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_group_payload->'sourceReferences') IS DISTINCT FROM 'array'
      OR EXISTS(SELECT 1 FROM public.company_restoration_proposals p WHERE p.restoration_id=v_group.restoration_id)
      OR (SELECT count(*) FROM public.company_historical_restoration_settlement_sources s WHERE s.settlement_id=v_batch.id AND s.restoration_id=v_group.restoration_id)=0
      OR (SELECT count(*) FROM public.company_historical_restoration_settlement_legs l WHERE l.settlement_id=v_batch.id AND l.restoration_id=v_group.restoration_id)=0
    THEN RAISE EXCEPTION 'settlement group differs from its original run or already has a proposal'
      USING ERRCODE='23514',CONSTRAINT='company_historical_settlement_group_guard'; END IF;
    -- Exact set equality, not merely matching a total: multi-source groups cannot be split.
    IF EXISTS(SELECT 1 FROM public.company_historical_import_receipts r WHERE r.source_branch_id=v_batch.source_branch_id
        AND r.restoration_id=v_group.restoration_id AND r.journal_entry_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM public.company_historical_restoration_settlement_legs l WHERE l.settlement_id=v_batch.id
          AND l.restoration_id=v_group.restoration_id AND l.source_reference=r.source_reference AND l.historical_journal_entry_id=r.journal_entry_id))
      OR jsonb_array_length(v_group_payload->'sourceReferences')<>(SELECT count(*) FROM public.company_historical_restoration_settlement_legs l WHERE l.settlement_id=v_batch.id AND l.restoration_id=v_group.restoration_id)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_group_payload->'sourceReferences') ref
        WHERE NOT EXISTS(SELECT 1 FROM public.company_historical_restoration_settlement_legs l WHERE l.settlement_id=v_batch.id AND l.restoration_id=v_group.restoration_id AND l.source_reference=ref))
      OR EXISTS(SELECT 1 FROM public.company_historical_restoration_settlement_legs l WHERE l.settlement_id=v_batch.id
        AND l.restoration_id=v_group.restoration_id AND NOT (v_group_payload->'sourceReferences' @> to_jsonb(l.source_reference)))
      OR jsonb_array_length(v_group_payload->'branchSourceEntries')<>(SELECT count(*) FROM public.company_historical_restoration_settlement_sources s WHERE s.settlement_id=v_batch.id AND s.restoration_id=v_group.restoration_id)
      OR EXISTS(SELECT 1 FROM public.restorations r CROSS JOIN LATERAL jsonb_array_elements_text(r.plan->'restorationJournalEntryIds') entry
        WHERE r.id=v_group.restoration_id AND EXISTS(SELECT 1 FROM public.journal_lines jl JOIN public.funds f ON f.id=jl.fund_id WHERE jl.entry_id=entry::bigint AND f.code='company_box' AND f.branch_id=v_batch.source_branch_id)
          AND NOT EXISTS(SELECT 1 FROM public.company_historical_restoration_settlement_sources s WHERE s.settlement_id=v_batch.id AND s.restoration_id=v_group.restoration_id AND s.source_entry_id=entry::bigint))
    THEN RAISE EXCEPTION 'partial historical restoration group is not permitted'
      USING ERRCODE='23514',CONSTRAINT='company_historical_settlement_whole_group_guard'; END IF;
    SELECT COALESCE(sum(CASE direction WHEN 'to_company' THEN amount_minor::numeric ELSE -amount_minor::numeric END),0)
      INTO v_branch_net FROM public.company_historical_restoration_settlement_sources WHERE settlement_id=v_batch.id AND restoration_id=v_group.restoration_id;
    SELECT COALESCE(sum(CASE direction WHEN 'to_company' THEN amount_minor::numeric ELSE -amount_minor::numeric END),0)
      INTO v_company_net FROM public.company_historical_restoration_settlement_legs WHERE settlement_id=v_batch.id AND restoration_id=v_group.restoration_id;
    IF v_branch_net<>v_group.branch_net_minor::numeric OR v_company_net<>v_group.company_net_minor::numeric
      OR v_branch_net-v_company_net<>v_group.variance_minor::numeric
    THEN RAISE EXCEPTION 'settlement must disclose the actual signed source difference'
      USING ERRCODE='23514',CONSTRAINT='company_historical_settlement_net_guard'; END IF;
    FOR v_source IN SELECT * FROM public.company_historical_restoration_settlement_sources WHERE settlement_id=v_batch.id AND restoration_id=v_group.restoration_id LOOP
      IF v_source.source_entry_id>v_batch.cutover_watermark_entry_id
        OR NOT EXISTS(SELECT 1 FROM public.journal_entries e JOIN public.restorations r ON r.id=v_group.restoration_id
          WHERE e.id=v_source.source_entry_id AND e.branch_id=v_batch.source_branch_id AND e.event_type::text='restoration'
            AND e.business_date=v_group.business_date AND r.plan->'restorationJournalEntryIds' @> to_jsonb(v_source.source_entry_id))
        OR EXISTS(SELECT 1 FROM public.company_restoration_mirrors WHERE source_entry_id=v_source.source_entry_id)
        OR (SELECT count(*) FROM public.journal_lines WHERE entry_id=v_source.source_entry_id)<>2
        OR (SELECT count(*) FROM public.journal_lines jl JOIN public.funds f ON f.id=jl.fund_id
          WHERE jl.entry_id=v_source.source_entry_id AND f.branch_id=v_batch.source_branch_id AND f.code='company_box'
            AND f.currency='SYP_NEW' AND jl.amount_minor=v_source.amount_minor AND jl.side::text=CASE v_source.direction WHEN 'to_company' THEN 'D' ELSE 'C' END)<>1
        OR (SELECT count(*) FROM public.journal_lines jl JOIN public.funds f ON f.id=jl.fund_id
          WHERE jl.entry_id=v_source.source_entry_id AND f.branch_id=v_batch.source_branch_id AND f.code IN('office_cash','office_wallet')
            AND f.currency='SYP_NEW' AND jl.amount_minor=v_source.amount_minor AND jl.side::text=CASE v_source.direction WHEN 'to_company' THEN 'C' ELSE 'D' END)<>1
        OR EXISTS(SELECT 1 FROM public.journal_entries e WHERE e.branch_id=v_batch.source_branch_id AND e.event_type::text='correction' AND e.shift_id IS NULL AND e.occurrence_key='reversal-of-'||v_source.source_entry_id::text)
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_group_payload->'branchSourceEntries') item
          WHERE item->>'sourceEntryId'=v_source.source_entry_id::text AND item->>'direction'=v_source.direction AND item->'amount'->>'minor'=v_source.amount_minor::text)
      THEN RAISE EXCEPTION 'settlement branch evidence must name an exact pre-cutover restoration entry'
        USING ERRCODE='23514',CONSTRAINT='company_historical_settlement_branch_source_guard'; END IF;
    END LOOP;
  END LOOP;
  FOR v_leg IN SELECT * FROM public.company_historical_restoration_settlement_legs WHERE settlement_id=v_batch.id LOOP
    IF v_leg.historical_journal_entry_id>v_batch.cutover_watermark_entry_id
      OR NOT EXISTS(SELECT 1 FROM public.company_historical_import_receipts r JOIN public.company_historical_transfers t ON t.journal_entry_id=r.journal_entry_id
      JOIN public.journal_entries e ON e.id=t.journal_entry_id
      WHERE r.source_reference=v_leg.source_reference AND r.journal_entry_id=v_leg.historical_journal_entry_id
        AND r.source_branch_id=v_batch.source_branch_id AND r.restoration_id=v_leg.restoration_id AND r.paid_from='pocket'
        AND t.branch_id=v_batch.company_branch_id AND t.source_branch_id=v_batch.source_branch_id
        AND t.restoration_id=v_leg.restoration_id AND t.source_reference=v_leg.source_reference
        AND t.amount_minor=v_leg.amount_minor AND t.direction=v_leg.direction
        AND e.branch_id=v_batch.company_branch_id AND e.event_type::text='company_historical_transfer' AND e.external_reference=v_leg.source_reference
        AND e.business_date=t.business_date AND e.posting_date=t.business_date AND e.business_date=r.occurred_on)
      OR EXISTS(SELECT 1 FROM public.company_reversals WHERE target_entry_id=v_leg.historical_journal_entry_id)
      OR EXISTS(SELECT 1 FROM public.journal_entries e WHERE e.branch_id=v_batch.company_branch_id AND e.event_type::text='correction' AND e.shift_id IS NULL AND e.occurrence_key='reversal-of-'||v_leg.historical_journal_entry_id::text)
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_batch.payload->'legs') item
        WHERE item->>'restorationId'=v_leg.restoration_id::text AND item->>'sourceReference'=v_leg.source_reference
          AND item->>'historicalJournalEntryId'=v_leg.historical_journal_entry_id::text
          AND item->>'direction'=v_leg.direction AND item->'amount'->>'minor'=v_leg.amount_minor::text AND item->>'journalEntryId'=v_leg.journal_entry_id::text)
      OR NOT public.ash_company_entry_is(v_leg.journal_entry_id,v_batch.company_branch_id,'company_historical_restoration_reclass',
        'historical-reclass:'||v_batch.id::text||':'||v_leg.historical_journal_entry_id::text,v_batch.business_date,v_batch.reason,v_batch.created_by,NULL)
      OR NOT public.ash_company_lines_match(v_leg.journal_entry_id,v_batch.company_branch_id,jsonb_build_array(
        public.ash_company_line('historical_branch_transit:'||v_batch.source_branch_id::text,'historical_branch_transit','SYP_NEW',
          CASE v_leg.direction WHEN 'to_company' THEN 'D' ELSE 'C' END,v_leg.amount_minor,'historical_restoration_reclass'),
        public.ash_company_line('branch_clearing:'||v_batch.source_branch_id::text,'branch_clearing','SYP_NEW',
          CASE v_leg.direction WHEN 'to_company' THEN 'C' ELSE 'D' END,v_leg.amount_minor,'historical_restoration_reclass')))
    THEN RAISE EXCEPTION 'settlement must exactly reclassify its original HQ source without moving cash or profit'
      USING ERRCODE='23514',CONSTRAINT='company_historical_settlement_hq_source_guard'; END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER company_historical_settlements_complete AFTER INSERT ON company_historical_restoration_settlements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_company_historical_settlement_complete();

CREATE TRIGGER company_historical_settlements_immutable BEFORE UPDATE OR DELETE ON company_historical_restoration_settlements FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_historical_settlement_groups_immutable BEFORE UPDATE OR DELETE ON company_historical_restoration_settlement_groups FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_historical_settlement_sources_immutable BEFORE UPDATE OR DELETE ON company_historical_restoration_settlement_sources FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER company_historical_settlement_legs_immutable BEFORE UPDATE OR DELETE ON company_historical_restoration_settlement_legs FOR EACH ROW EXECUTE FUNCTION refuse_company_command_change();
CREATE TRIGGER audit_company_historical_restoration_settlements AFTER INSERT OR UPDATE OR DELETE ON company_historical_restoration_settlements FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_historical_restoration_settlement_groups AFTER INSERT OR UPDATE OR DELETE ON company_historical_restoration_settlement_groups FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_historical_restoration_settlement_sources AFTER INSERT OR UPDATE OR DELETE ON company_historical_restoration_settlement_sources FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_company_historical_restoration_settlement_legs AFTER INSERT OR UPDATE OR DELETE ON company_historical_restoration_settlement_legs FOR EACH ROW EXECUTE FUNCTION audit_row_change();
REVOKE UPDATE,DELETE,TRUNCATE ON company_historical_restoration_settlements,company_historical_restoration_settlement_groups,company_historical_restoration_settlement_sources,company_historical_restoration_settlement_legs FROM app_user;
GRANT SELECT,INSERT ON company_historical_restoration_settlements,company_historical_restoration_settlement_groups,company_historical_restoration_settlement_sources,company_historical_restoration_settlement_legs TO app_user;

-- Offset is the signed ORIGINAL HQ amount, not the branch amount. The disclosed variance stays.
CREATE FUNCTION ash_historical_restoration_settlement_offset(p_branch uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT COALESCE(sum(CASE l.direction WHEN 'to_company' THEN l.amount_minor::numeric ELSE -l.amount_minor::numeric END),0)
    FROM public.company_historical_restoration_settlement_legs l JOIN public.company_historical_restoration_settlements s ON s.id=l.settlement_id
    WHERE s.source_branch_id=p_branch
$$;

-- Preserve function OIDs and every older permission for warmed PostgreSQL connections.
CREATE OR REPLACE FUNCTION ash_is_company_event(p_event text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_event IN (
    'company_opening_transfer','company_restoration_mirror','company_historical_transfer','company_historical_restoration_reclass',
    'company_deposit','company_withdrawal','company_expense','company_income','company_fx_exchange',
    'company_debt_open','company_debt_payment','company_debt_writeoff','asset_purchase',
    'depreciation_transfer','depreciation_release','company_correction')
$$;
CREATE OR REPLACE FUNCTION ash_company_fund_event_allowed(p_type text,p_event text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_event='company_historical_restoration_reclass' THEN p_type IN('historical_branch_transit','branch_clearing') ELSE CASE p_type
    WHEN 'company_cash' THEN p_event IN('company_deposit','company_withdrawal','company_expense','company_income',
      'company_fx_exchange','company_opening_transfer','company_restoration_mirror','company_historical_transfer',
      'company_debt_open','company_debt_payment','asset_purchase','depreciation_transfer','depreciation_release','company_correction')
    WHEN 'depreciation_reserve' THEN p_event IN('depreciation_transfer','depreciation_release','company_expense','company_debt_payment','asset_purchase','company_correction')
    WHEN 'company_fx_position' THEN p_event IN('company_fx_exchange','company_correction')
    WHEN 'branch_clearing' THEN p_event IN('company_opening_transfer','company_restoration_mirror')
    WHEN 'historical_branch_transit' THEN p_event='company_historical_transfer'
    WHEN 'company_payable' THEN p_event IN('company_debt_open','company_debt_payment','company_debt_writeoff','asset_purchase','company_correction')
    WHEN 'company_receivable' THEN p_event IN('company_debt_open','company_debt_payment','company_debt_writeoff','asset_purchase','company_correction')
    WHEN 'fixed_asset' THEN p_event IN('asset_purchase','company_correction')
    WHEN 'company_expense' THEN p_event IN('company_expense','company_debt_open','company_debt_writeoff','company_correction')
    WHEN 'company_income' THEN p_event IN('company_income','company_debt_open','company_debt_writeoff','company_correction')
    WHEN 'company_equity' THEN p_event IN('company_deposit','company_withdrawal','company_expense','company_debt_open','company_debt_payment','asset_purchase','company_correction')
    ELSE false END END
$$;
-- Trigger dependencies use the same original function OID; CREATE OR REPLACE is deliberate.
CREATE OR REPLACE FUNCTION assert_company_journal_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_ok boolean;
BEGIN
  IF NOT public.ash_is_company_event(NEW.event_type::text) THEN RETURN NULL; END IF;
  v_ok:=NEW.shift_id IS NULL AND CASE NEW.event_type::text
    WHEN 'company_deposit' THEN EXISTS(SELECT 1 FROM public.company_moves WHERE journal_entry_id=NEW.id AND kind='deposit')
    WHEN 'company_withdrawal' THEN EXISTS(SELECT 1 FROM public.company_moves WHERE journal_entry_id=NEW.id AND kind='withdrawal')
    WHEN 'company_expense' THEN EXISTS(SELECT 1 FROM public.company_expenses WHERE journal_entry_id=NEW.id)
    WHEN 'company_income' THEN EXISTS(SELECT 1 FROM public.company_incomes WHERE journal_entry_id=NEW.id)
    WHEN 'company_fx_exchange' THEN EXISTS(SELECT 1 FROM public.company_fx_exchanges WHERE journal_entry_id=NEW.id)
    WHEN 'company_correction' THEN EXISTS(SELECT 1 FROM public.company_reversals WHERE journal_entry_id=NEW.id)
    WHEN 'company_opening_transfer' THEN EXISTS(SELECT 1 FROM public.company_ledger_cutovers WHERE opening_entry_id=NEW.id)
    WHEN 'company_restoration_mirror' THEN EXISTS(SELECT 1 FROM public.company_restoration_mirrors WHERE mirror_entry_id=NEW.id)
    WHEN 'company_historical_transfer' THEN EXISTS(SELECT 1 FROM public.company_historical_transfers WHERE journal_entry_id=NEW.id)
    WHEN 'company_historical_restoration_reclass' THEN EXISTS(SELECT 1 FROM public.company_historical_restoration_settlement_legs WHERE journal_entry_id=NEW.id)
    WHEN 'company_debt_open' THEN EXISTS(SELECT 1 FROM public.company_debts WHERE journal_entry_id=NEW.id)
    WHEN 'company_debt_payment' THEN EXISTS(SELECT 1 FROM public.company_debt_events WHERE journal_entry_id=NEW.id AND kind='payment')
    WHEN 'company_debt_writeoff' THEN EXISTS(SELECT 1 FROM public.company_debt_events WHERE journal_entry_id=NEW.id AND kind='writeoff')
    WHEN 'asset_purchase' THEN EXISTS(SELECT 1 FROM public.fixed_assets WHERE journal_entry_id=NEW.id)
    WHEN 'depreciation_transfer' THEN EXISTS(SELECT 1 FROM public.depreciation_transfers WHERE journal_entry_id=NEW.id)
    WHEN 'depreciation_release' THEN EXISTS(SELECT 1 FROM public.depreciation_releases WHERE journal_entry_id=NEW.id)
    ELSE false END;
  IF NOT COALESCE(v_ok,false) THEN RAISE EXCEPTION 'company journal requires its immutable command in the same transaction'
    USING ERRCODE='23514',CONSTRAINT='company_journal_fact_guard'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION assert_company_box_mirrored() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_type text; v_fund_branch uuid; v_code text; v_branch uuid; v_cutover public.company_ledger_cutovers%ROWTYPE;
BEGIN
  SELECT f.type::text,f.branch_id,f.code INTO v_type,v_fund_branch,v_code FROM public.funds f WHERE f.id=NEW.fund_id;
  IF v_type='company_box' THEN v_branch:=v_fund_branch;
  ELSIF v_type='branch_clearing' THEN
    IF v_code !~ '^branch_clearing:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'invalid clearing branch' USING ERRCODE='23514'; END IF;
    v_branch:=substr(v_code,17)::uuid;
  ELSE RETURN NULL; END IF;
  SELECT * INTO v_cutover FROM public.company_ledger_cutovers WHERE branch_id=v_branch;
  IF v_cutover.branch_id IS NULL THEN
    IF v_type='branch_clearing' THEN RAISE EXCEPTION 'clearing without cutover' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;
  IF v_type='branch_clearing' AND v_fund_branch IS DISTINCT FROM v_cutover.company_branch_id THEN RAISE EXCEPTION 'clearing outside HQ' USING ERRCODE='23514'; END IF;
  IF v_type='company_box' AND NEW.entry_id>v_cutover.watermark_entry_id
    AND NOT EXISTS(SELECT 1 FROM public.company_restoration_mirrors WHERE source_entry_id=NEW.entry_id)
    AND NOT EXISTS(SELECT 1 FROM public.company_restoration_proposal_legs WHERE source_entry_id=NEW.entry_id)
  THEN RAISE EXCEPTION 'company_box entry needs existing mirror or actual-restoration proposal' USING ERRCODE='23514',CONSTRAINT='company_box_mirror_guard'; END IF;
  IF public.ash_fund_balance(v_branch,'company_box')+public.ash_fund_balance(v_cutover.company_branch_id,'branch_clearing:'||v_branch::text)
    <>v_cutover.baseline_difference_minor::numeric+public.ash_restoration_pending_difference(v_branch)
      -public.ash_restoration_historical_offset(v_branch)-public.ash_historical_restoration_settlement_offset(v_branch)
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
    <>COALESCE(v_baseline,0)+public.ash_restoration_pending_difference(v_branch)
      -public.ash_restoration_historical_offset(v_branch)-public.ash_historical_restoration_settlement_offset(v_branch)
  THEN RAISE EXCEPTION 'difference changed without frozen baseline or reviewed source evidence'
    USING ERRCODE='23514',CONSTRAINT='company_clearing_invariant_guard'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER company_historical_settlements_balanced AFTER INSERT ON company_historical_restoration_settlements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_company_cutover_balanced();

-- A sealed source cannot subsequently be silently reversed behind the reviewed evidence.
CREATE FUNCTION guard_company_historical_settled_source_reversal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_source bigint; v_branch uuid;
BEGIN
  IF TG_TABLE_NAME='company_reversals' THEN v_source:=NEW.target_entry_id;
  ELSIF NEW.event_type::text='correction' AND NEW.shift_id IS NULL AND NEW.occurrence_key ~ '^reversal-of-[1-9][0-9]*$'
    THEN v_source:=substr(NEW.occurrence_key,13)::bigint;
  ELSE RETURN NEW; END IF;
  SELECT branch_id INTO v_branch FROM public.journal_entries WHERE id=v_source;
  IF v_branch IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('ash:financial:receivables:'||v_branch::text,0)); END IF;
  IF EXISTS(SELECT 1 FROM public.company_historical_restoration_settlement_sources WHERE source_entry_id=v_source)
    OR EXISTS(SELECT 1 FROM public.company_historical_restoration_settlement_legs WHERE historical_journal_entry_id=v_source OR journal_entry_id=v_source)
  THEN RAISE EXCEPTION 'settled source requires a separately reviewed accounting correction, not a silent reversal'
    USING ERRCODE='23514',CONSTRAINT='company_historical_settled_source_reversal_guard'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_historical_settled_source_journal_guard BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION guard_company_historical_settled_source_reversal();
CREATE TRIGGER company_historical_settled_source_command_guard BEFORE INSERT ON company_reversals FOR EACH ROW EXECUTE FUNCTION guard_company_historical_settled_source_reversal();
