-- 0061 — «الترميم» more than once a day.
--
-- Owner, 2026-09-02 at 02:27: «اجعل خيار الترميم متاح دوما بغض النظر عن الوقت و هل يوجد نوبة
-- مفتوحة او لا».
--
-- WHAT HE WAS ACTUALLY HITTING, which was neither the time nor an open shift. The business day
-- starts at 04:00 (`DAY_START_MINUTES`), so at 02:27 the system's business date was still
-- 2026-09-01 — and 2026-09-01 had been restored that morning at 09:10. `restorations_once_per_day`
-- allows one per business date, so the screen showed «تم الترميم ✓» with no button, while a whole
-- day of work had since landed in the boxes: a cash surplus of 5,880.11 and a wallet shortfall of
-- 3,958.11 waiting on a clock.
--
-- WHAT IS DELIBERATELY NOT CHANGED: the 04:00 boundary. It exists so a shift closed at 01:30 books
-- to the day it was WORKED, and moving it would split a Saturday night across two FINANCIAL WEEKS
-- — the one place BR7 makes entries immutable. الترميم now runs as often as he likes; it simply
-- books to the business day the fleet is actually in.
--
-- The once-a-day rule was never the safety property. What stops a double posting is the ledger's
-- idempotency key `(shift_id, event_type, occurrence_key)`, and that keeps working because each run
-- gets its own key.

ALTER TABLE restorations
  ADD COLUMN run_no integer NOT NULL DEFAULT 1;

-- Existing rows are run 1 of their day, which is exactly what they were.
ALTER TABLE restorations
  ADD CONSTRAINT restorations_run_no_positive_ck CHECK (run_no >= 1);

-- One row per run, still. Dropping the old index removes the LIMIT, not the uniqueness: two
-- concurrent managers racing the same run number still collide here, inside the branch-money lock
-- both of them hold, and the loser gets a clean unique violation rather than a second posting.
-- A CONSTRAINT, not a bare index — `DROP INDEX` is refused because the constraint owns it, and the
-- successor is declared the same way so the next person finds the same shape.
ALTER TABLE restorations
  DROP CONSTRAINT restorations_once_per_day;

ALTER TABLE restorations
  ADD CONSTRAINT restorations_run_per_day UNIQUE (branch_id, business_date, run_no);

-- The guard, re-emitted from the LIVE definition (`pg_get_functiondef`) with exactly ONE hunk,
-- proved by diff: the occurrence key it demands of every moving leg's journal now carries the run
-- number. Everything else — the opening balances pinned to the live ledger, the receivables and
-- advances terms, the effective target, the journal cardinality, the net, the postcondition, the
-- attributed active manager — is byte-identical.
--
-- The plan SHAPE is unchanged, so this stays schema version 4 rather than becoming a v5: nothing
-- about what a restoration means has moved, only how many of them a day may hold.
--
-- Rolling the API back past this migration makes الترميم refuse rather than double-post: an older
-- API emits `<date>:<fund>` keys, this guard demands `<date>#<run>:<fund>`, and the insert fails
-- loudly. That is the safe direction, and it is why the key is validated here at all.

CREATE OR REPLACE FUNCTION public.guard_ledger_restoration_insert_v4()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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

  IF NEW.plan->>'schemaVersion' IS DISTINCT FROM '4'
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
             'fundCode', 'officeBalance', 'receivables', 'advances', 'position', 'capitalTarget',
             'delta', 'direction', 'amount', 'feasible', 'refusals'
           ])
           OR leg - ARRAY[
             'fundCode', 'officeBalance', 'receivables', 'advances', 'position', 'capitalTarget',
             'delta', 'direction', 'amount', 'feasible', 'refusals'
           ] <> '{}'::jsonb
           OR leg->>'fundCode' NOT IN ('office_cash', 'office_wallet')
           OR leg->>'officeBalance' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR leg->>'receivables' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR leg->>'advances' !~ '^-?[0-9]+\.[0-9]{2}$'
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
             + (leg->>'advances')::numeric
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
       OR (leg->>'advances')::numeric * 100 <> COALESCE((
         SELECT sum(CASE jl.side WHEN 'D' THEN jl.amount_minor ELSE -jl.amount_minor END)::numeric
           FROM public.journal_lines jl
           JOIN public.funds af ON af.id = jl.fund_id
          WHERE af.branch_id = NEW.branch_id
            AND af.owner_kind = 'none'
            AND af.owner_id IS NULL
            AND EXISTS (
              SELECT 1
                FROM public.advances advance_row
               WHERE advance_row.branch_id = NEW.branch_id
                 AND af.code = af.type::text || ':' || advance_row.id::text
            )
            AND (
              (leg->>'fundCode' = 'office_cash'
                AND af.type::text = 'advance_receivable_cash')
              OR
              (leg->>'fundCode' = 'office_wallet'
                AND af.type::text = 'advance_receivable_wallet')
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
            AND je.occurrence_key =
              NEW.business_date::text || '#' || NEW.run_no::text || ':' || (leg->>'fundCode')
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
           <> (leg->>'receivables')::numeric * 100
            + (leg->>'advances')::numeric * 100 + COALESCE((
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
    RAISE EXCEPTION 'restoration journals do not leave office balance plus receivables and advances at target'
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
$function$;


COMMENT ON FUNCTION guard_ledger_restoration_insert_v4() IS
  'Pins schema-v4 opening office balances to the live ledger and requires exact receivables, '
  'outstanding advances, targets, journals, net, and postcondition. Since 0061 the journal '
  'occurrence key it demands carries the run number, so a business date may hold several runs.';
