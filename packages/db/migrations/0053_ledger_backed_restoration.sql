-- 0053 - ledger-backed restoration without a physical cash count
--
-- Schema-v2 restoration facts remain count-backed and continue through the original 0038 guard.
-- New schema-v3 facts freeze the live office-ledger balances immediately before their restoration
-- journals. This is a forward-only change: old evidence and its cash-count immutability are not
-- rewritten, while new facts must not claim a cash-count identity that does not exist.

ALTER TABLE restorations
  ALTER COLUMN cash_count_id DROP NOT NULL;

-- Replace the unconditional v2 trigger with an explicit version dispatcher. PostgreSQL executes
-- same-kind triggers by name, hence the numeric prefixes: the schema discriminator always fails
-- closed before either version-specific evidence guard runs.
DROP TRIGGER restorations_insert_guard ON restorations;

CREATE FUNCTION guard_restoration_schema_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF jsonb_typeof(NEW.plan) IS DISTINCT FROM 'object'
     OR COALESCE(NEW.plan->>'schemaVersion', '') NOT IN ('2', '3')
  THEN
    RAISE EXCEPTION 'restoration plan must use a supported schema version'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_plan_version_guard';
  END IF;

  IF (NEW.plan->>'schemaVersion' = '2' AND NEW.cash_count_id IS NULL)
     OR (NEW.plan->>'schemaVersion' = '3' AND NEW.cash_count_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'restoration evidence source does not match its schema version'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_evidence_source_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER restorations_00_schema_guard
  BEFORE INSERT ON restorations
  FOR EACH ROW EXECUTE FUNCTION guard_restoration_schema_insert();

-- This is the original, historically exact v2 implementation from migration 0038. Its function
-- is deliberately not replaced; only its trigger becomes conditional.
CREATE TRIGGER restorations_10_v2_guard
  BEFORE INSERT ON restorations
  FOR EACH ROW
  WHEN ((NEW.plan->>'schemaVersion') = '2')
  EXECUTE FUNCTION guard_restoration_insert();

CREATE FUNCTION guard_ledger_restoration_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor                 uuid;
  v_restoration_ids       integer;
  v_expected_restorations integer;
  v_net_numeric           numeric;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  IF v_actor IS NULL
     OR NEW.performed_by IS DISTINCT FROM v_actor
     OR NOT EXISTS (
       SELECT 1
         FROM public.users u
         JOIN public.role_permissions rp
           ON rp.role_key = u.role_key
          AND rp.permission_key = 'journal.manual.write'
        WHERE u.id = v_actor
          AND u.active
          AND (
            rp.scope = 'all'
            OR (rp.scope = 'branch' AND u.branch_id = NEW.branch_id)
          )
     )
  THEN
    RAISE EXCEPTION 'ledger restoration requires its attributed active manager'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_actor_guard';
  END IF;

  -- Serialize direct SQL with FinancialUnitOfWork and every branch-money writer. The journal rows,
  -- receivables, target and postcondition below therefore describe one branch-money history.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ash:financial:receivables:' || NEW.branch_id::text, 0)
  );

  IF NEW.plan->>'schemaVersion' IS DISTINCT FROM '3'
     OR NEW.plan->>'source' IS DISTINCT FROM 'live_ledger'
     OR jsonb_typeof(NEW.plan->'openingBalances') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.plan->'restorationJournalEntryIds') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.plan->'legs') IS DISTINCT FROM 'array'
     OR NEW.plan - ARRAY[
       'schemaVersion', 'source', 'openingBalances', 'restorationJournalEntryIds', 'legs'
     ] <> '{}'::jsonb
  THEN
    RAISE EXCEPTION 'ledger restoration plan schema is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_plan_guard';
  END IF;

  -- The opening snapshot is intentionally independent from the derived legs. Keeping both makes
  -- the exact live-ledger observation auditable and lets this guard reject a forged calculation.
  IF (SELECT count(*) FROM jsonb_array_elements(NEW.plan->'openingBalances')) <> 2
     OR (
       SELECT count(DISTINCT item->>'fundCode')
         FROM jsonb_array_elements(NEW.plan->'openingBalances') item
     ) <> 2
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(NEW.plan->'openingBalances') item
        WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR NOT (item ?& ARRAY['fundCode', 'balance'])
           OR item - ARRAY['fundCode', 'balance'] <> '{}'::jsonb
           OR item->>'fundCode' NOT IN ('office_cash', 'office_wallet')
           OR item->>'balance' !~ '^-?[0-9]+\.[0-9]{2}$'
     )
  THEN
    RAISE EXCEPTION 'ledger restoration requires one exact opening balance for each office fund'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_opening_balance_guard';
  END IF;

  IF (SELECT count(*) FROM jsonb_array_elements(NEW.plan->'legs')) <> 2
     OR (
       SELECT count(DISTINCT leg->>'fundCode')
         FROM jsonb_array_elements(NEW.plan->'legs') leg
     ) <> 2
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(NEW.plan->'legs') leg
        WHERE jsonb_typeof(leg) IS DISTINCT FROM 'object'
           OR NOT (leg ?& ARRAY[
             'fundCode', 'officeBalance', 'receivables', 'position', 'capitalTarget', 'delta',
             'direction', 'amount', 'feasible', 'refusals'
           ])
           OR leg - ARRAY[
             'fundCode', 'officeBalance', 'receivables', 'position', 'capitalTarget', 'delta',
             'direction', 'amount', 'feasible', 'refusals'
           ] <> '{}'::jsonb
           OR leg->>'fundCode' NOT IN ('office_cash', 'office_wallet')
           OR leg->>'officeBalance' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR leg->>'receivables' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR leg->>'position' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR leg->>'capitalTarget' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR leg->>'delta' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR leg->>'amount' !~ '^[0-9]+\.[0-9]{2}$'
           OR jsonb_typeof(leg->'feasible') IS DISTINCT FROM 'boolean'
           OR (leg->>'feasible')::boolean IS DISTINCT FROM true
           OR jsonb_typeof(leg->'refusals') IS DISTINCT FROM 'array'
           OR jsonb_array_length(leg->'refusals') <> 0
           OR jsonb_typeof(leg->'direction') NOT IN ('string', 'null')
     )
  THEN
    RAISE EXCEPTION 'ledger restoration must contain one feasible leg for each office fund'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_plan_guard';
  END IF;

  -- Validate identities before casting them anywhere below. The cardinality check makes the ids a
  -- bijection with nonzero legs; no unrelated journal can hide in the frozen evidence array.
  IF EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(NEW.plan->'restorationJournalEntryIds') id(value)
        WHERE id.value !~ '^[1-9][0-9]*$'
     )
  THEN
    RAISE EXCEPTION 'restoration journal ids must be positive database identities'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_journal_guard';
  END IF;

  SELECT count(*)::integer INTO v_restoration_ids
    FROM jsonb_array_elements_text(NEW.plan->'restorationJournalEntryIds');
  SELECT count(*)::integer INTO v_expected_restorations
    FROM jsonb_array_elements(NEW.plan->'legs') leg
   WHERE (leg->>'amount')::numeric <> 0;

  IF v_restoration_ids <> v_expected_restorations
     OR v_restoration_ids <> (
       SELECT count(DISTINCT id.value)
         FROM jsonb_array_elements_text(NEW.plan->'restorationJournalEntryIds') id(value)
     )
  THEN
    RAISE EXCEPTION 'restoration journal cardinality does not match its moving legs'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_journal_guard';
  END IF;

  -- Freeze exact snapshot, live receivable assets, effective targets, and all derived arithmetic.
  -- Numeric comparisons avoid bigint overflow from adversarial JSON; journal amounts themselves
  -- remain bigint-constrained by the ledger schema.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.plan->'legs') leg
     WHERE NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(NEW.plan->'openingBalances') opening
        WHERE opening->>'fundCode' = leg->>'fundCode'
          AND (opening->>'balance')::numeric = (leg->>'officeBalance')::numeric
     )
       OR (leg->>'position')::numeric
            <> (leg->>'officeBalance')::numeric + (leg->>'receivables')::numeric
       OR (leg->>'delta')::numeric
            <> (leg->>'position')::numeric - (leg->>'capitalTarget')::numeric
       OR (leg->>'amount')::numeric <> abs((leg->>'delta')::numeric)
       OR (
         leg->>'direction' = 'to_company'
         AND (leg->>'amount')::numeric > (leg->>'officeBalance')::numeric
       )
       OR CASE
            WHEN (leg->>'delta')::numeric > 0 THEN leg->>'direction' IS DISTINCT FROM 'to_company'
            WHEN (leg->>'delta')::numeric < 0 THEN leg->>'direction' IS DISTINCT FROM 'from_company'
            ELSE leg->>'direction' IS NOT NULL
          END
       OR NOT EXISTS (
         SELECT 1
           FROM public.office_capital_targets target
          WHERE target.id = (
            SELECT resolved.id
              FROM public.office_capital_targets resolved
             WHERE resolved.branch_id = NEW.branch_id
               AND resolved.fund_code = leg->>'fundCode'
               AND resolved.effective_from <= NEW.business_date
               AND resolved.status IN ('active', 'superseded')
             ORDER BY resolved.effective_from DESC
             LIMIT 1
          )
            AND target.target_minor::numeric = (leg->>'capitalTarget')::numeric * 100
       )
       OR (leg->>'receivables')::numeric * 100 <> COALESCE((
         SELECT sum(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END)::numeric
           FROM public.journal_lines jl
           JOIN public.funds rf ON rf.id = jl.fund_id
          WHERE rf.branch_id = NEW.branch_id
            AND rf.owner_kind = 'driver'
            AND rf.owner_id IS NOT NULL
            AND rf.code = rf.type::text || ':' || rf.owner_id::text
            AND EXISTS (
              SELECT 1
                FROM public.drivers receivable_driver
               WHERE receivable_driver.id = rf.owner_id
                 AND receivable_driver.branch_id = NEW.branch_id
            )
            AND (
              (leg->>'fundCode' = 'office_cash'
                AND rf.type::text IN ('driver_receivable_cash', 'driver_shift_funding_cash'))
              OR
              (leg->>'fundCode' = 'office_wallet'
                AND rf.type::text IN ('driver_receivable_wallet', 'driver_shift_funding_wallet'))
            )
       ), 0::numeric)
  )
  THEN
    RAISE EXCEPTION 'restoration plan differs from its opening ledger balances, receivables, targets, or arithmetic'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_plan_guard';
  END IF;

  -- Every moving leg names one canonical restoration journal with the exact fund, company
  -- counterpart, direction, amount, roles, date, reason, and attributed actor.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.plan->'legs') leg
     WHERE (leg->>'amount')::numeric <> 0
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(NEW.plan->'restorationJournalEntryIds') plan_id(value)
           JOIN public.journal_entries je ON je.id::numeric = plan_id.value::numeric
          WHERE je.branch_id = NEW.branch_id
            AND je.event_type = 'restoration'
            AND je.shift_id IS NULL
            AND je.occurrence_key = NEW.business_date::text || ':' || (leg->>'fundCode')
            AND je.business_date = NEW.business_date
            AND je.posting_date = NEW.business_date
            AND je.week_start_date =
              (NEW.business_date - extract(dow FROM NEW.business_date)::integer)
            AND je.reason IS NOT DISTINCT FROM NEW.reason
            AND je.created_by = NEW.performed_by
            AND (SELECT count(*) FROM public.journal_lines all_lines WHERE all_lines.entry_id = je.id) = 2
            AND (
              SELECT count(*)
                FROM public.journal_lines jl
                JOIN public.funds f ON f.id = jl.fund_id
               WHERE jl.entry_id = je.id
                 AND jl.amount_minor::numeric = (leg->>'amount')::numeric * 100
                 AND (
                   (
                     f.branch_id = NEW.branch_id
                     AND f.code = leg->>'fundCode'
                     AND f.type::text = leg->>'fundCode'
                     AND f.owner_kind = 'none'
                     AND f.owner_id IS NULL
                     AND jl.side = CASE WHEN leg->>'direction' = 'to_company' THEN 'C' ELSE 'D' END
                     AND jl.line_role IS NOT DISTINCT FROM
                       CASE WHEN leg->>'direction' = 'from_company' THEN 'shahn' ELSE NULL END
                   )
                   OR
                   (
                     f.branch_id = NEW.branch_id
                     AND f.code = 'company_box'
                     AND f.type::text = 'company_box'
                     AND f.owner_kind = 'none'
                     AND f.owner_id IS NULL
                     AND jl.side = CASE WHEN leg->>'direction' = 'to_company' THEN 'D' ELSE 'C' END
                     AND jl.line_role IS NOT DISTINCT FROM
                       CASE WHEN leg->>'direction' = 'to_company' THEN 'kaish' ELSE NULL END
                   )
                 )
            ) = 2
       )
  )
  THEN
    RAISE EXCEPTION 'restoration journal does not match its ledger-backed plan'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_journal_guard';
  END IF;

  -- The live balance at trigger time already includes the exact journals above. Reverse each
  -- frozen movement and it must reproduce the opening snapshot; then independently prove the
  -- owner's final invariant: office balance after posting plus receivables equals the target.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.plan->'legs') leg
     WHERE (leg->>'officeBalance')::numeric * 100
           <> COALESCE((
                SELECT sum(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END)::numeric
                  FROM public.journal_lines jl
                  JOIN public.funds office_fund ON office_fund.id = jl.fund_id
                 WHERE office_fund.branch_id = NEW.branch_id
                   AND office_fund.code = leg->>'fundCode'
                   AND office_fund.type::text = leg->>'fundCode'
                   AND office_fund.owner_kind = 'none'
                   AND office_fund.owner_id IS NULL
              ), 0::numeric)
              + CASE leg->>'direction'
                  WHEN 'to_company' THEN (leg->>'amount')::numeric * 100
                  WHEN 'from_company' THEN -((leg->>'amount')::numeric * 100)
                  ELSE 0::numeric
                END
  )
  THEN
    RAISE EXCEPTION 'restoration opening snapshot does not match the pre-posting live ledger'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_opening_balance_guard';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.plan->'legs') leg
     WHERE (leg->>'capitalTarget')::numeric * 100
           <> (leg->>'receivables')::numeric * 100 + COALESCE((
             SELECT sum(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END)::numeric
               FROM public.journal_lines jl
               JOIN public.funds office_fund ON office_fund.id = jl.fund_id
              WHERE office_fund.branch_id = NEW.branch_id
                AND office_fund.code = leg->>'fundCode'
                AND office_fund.type::text = leg->>'fundCode'
                AND office_fund.owner_kind = 'none'
                AND office_fund.owner_id IS NULL
           ), 0::numeric)
  )
  THEN
    RAISE EXCEPTION 'restoration journals do not leave office balance plus receivables at target'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_postcondition_guard';
  END IF;

  SELECT COALESCE(sum(
    CASE leg->>'direction'
      WHEN 'to_company' THEN (leg->>'amount')::numeric * 100
      WHEN 'from_company' THEN -((leg->>'amount')::numeric * 100)
      ELSE 0::numeric
    END
  ), 0::numeric)
    INTO v_net_numeric
    FROM jsonb_array_elements(NEW.plan->'legs') leg;

  IF NEW.net_to_company_minor::numeric <> v_net_numeric THEN
    RAISE EXCEPTION 'restoration net differs from its exact journal-backed legs'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_journal_guard';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER restorations_10_v3_guard
  BEFORE INSERT ON restorations
  FOR EACH ROW
  WHEN ((NEW.plan->>'schemaVersion') = '3')
  EXECUTE FUNCTION guard_ledger_restoration_insert();

COMMENT ON COLUMN restorations.cash_count_id IS
  'Required sealed-count evidence for schema v2; NULL by design for schema v3 live-ledger restoration.';

COMMENT ON FUNCTION guard_ledger_restoration_insert() IS
  'Pins schema-v3 opening office balances to the live ledger and requires exact receivables, targets, journals, net, and postcondition.';

COMMENT ON TRIGGER restorations_immutable ON restorations IS
  'Every restoration is immutable: schema v2 preserves count evidence and schema v3 preserves its opening ledger snapshot.';
