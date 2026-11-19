-- New branch restorations confirm their exact HQ counterpart in the same transaction.
-- The only additional authority is the first, exact confirmation of this transaction's run.
-- Old proposals and all later changes still require company_fund.manage.
CREATE OR REPLACE FUNCTION guard_company_restoration_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_current integer; v_confirmed boolean; v_direct boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.company_restoration_proposals p
    JOIN public.restorations r ON r.id=p.restoration_id
    JOIN public.users u ON u.id=NEW.created_by AND u.active
    JOIN public.role_permissions rp ON rp.role_key=u.role_key
    WHERE p.id=NEW.proposal_id AND NEW.kind='confirm' AND NEW.version=1
      AND r.xmin::text=(txid_current() % 4294967296)::text
      AND p.xmin::text=(txid_current() % 4294967296)::text
      AND r.performed_by=NEW.created_by AND p.created_by=NEW.created_by
      AND NEW.business_date=p.business_date AND NEW.occurred_on=p.business_date
      AND NEW.reason=r.reason AND rp.permission_key='journal.manual.write'
      AND (rp.scope='all' OR (rp.scope='branch' AND u.branch_id=p.source_branch_id))
      AND jsonb_array_length(NEW.payload->'legs')=(SELECT count(*) FROM public.company_restoration_proposal_legs WHERE proposal_id=p.id)
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.payload->'legs') leg
        LEFT JOIN public.company_restoration_proposal_legs s ON s.proposal_id=p.id
          AND s.source_entry_id::text=leg->>'sourceEntryId'
        WHERE s.source_entry_id IS NULL OR s.amount_minor::text IS DISTINCT FROM leg->'amount'->>'minor'
          OR leg->>'reversalEntryId' IS NOT NULL
      )
  ) INTO v_direct;
  IF NEW.created_by IS DISTINCT FROM public.ash_current_actor()
    OR NOT (public.ash_actor_holds_all(NEW.created_by,'company_fund.manage') OR v_direct)
    OR NEW.payload->>'id' IS DISTINCT FROM NEW.id::text
    OR NEW.payload->>'proposalId' IS DISTINCT FROM NEW.proposal_id::text
    OR NEW.payload->>'kind' IS DISTINCT FROM NEW.kind
    OR NEW.payload->>'version' IS DISTINCT FROM NEW.version::text
    OR NEW.payload->>'reason' IS DISTINCT FROM NEW.reason
    OR NEW.payload->>'createdBy' IS DISTINCT FROM NEW.created_by::text
    OR NEW.payload->>'occurredOn' IS DISTINCT FROM NEW.occurred_on::text
    OR NEW.payload->>'businessDate' IS DISTINCT FROM NEW.business_date::text
  THEN RAISE EXCEPTION 'HQ correction requires a company manager; direct restoration requires an exact same-transaction source'
    USING ERRCODE='23514', CONSTRAINT='company_restoration_review_actor_guard'; END IF;
  SELECT COALESCE(max(version),0),COALESCE(bool_or(kind IN ('confirm','correct')),false)
    INTO v_current,v_confirmed FROM public.company_restoration_review_revisions WHERE proposal_id=NEW.proposal_id;
  IF NEW.version <> v_current+1 OR (NEW.kind IN ('confirm','revise') AND v_confirmed)
    OR (NEW.kind='correct' AND NOT v_confirmed)
  THEN RAISE EXCEPTION 'restoration review version or confirmation state conflict'
    USING ERRCODE='23514', CONSTRAINT='company_restoration_review_version_guard'; END IF;
  RETURN NEW;
END $$;
