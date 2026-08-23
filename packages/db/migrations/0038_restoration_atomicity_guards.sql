-- 0038 — restoration evidence is append-only and inseparable from its journals
--
-- Journal entries and the restoration fact are written by one FinancialUnitOfWork. Enforce that
-- boundary in PostgreSQL too: a caller may not publish an attributed restoration directly, point
-- it at another branch/day's count, bless an unsealed count, or reserve a canonical daily journal
-- key without completing the immutable restoration fact in the same transaction.

ALTER TABLE restorations
  ALTER COLUMN cash_count_id SET NOT NULL;

ALTER TABLE restorations
  ADD CONSTRAINT restorations_reason_nonblank_ck
  CHECK (ash_has_visible_text(reason) AND char_length(reason) <= 500);

-- There is one canonical movement for each office box/day. Without this partial uniqueness a
-- poisoned first journal did not conflict with the real run because shift_id is NULL and the
-- original journal idempotency index only covers shift-scoped entries.
CREATE UNIQUE INDEX je_restoration_daily_key_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL AND event_type = 'restoration';

CREATE UNIQUE INDEX je_cash_count_reconciliation_key_uq
  ON journal_entries (branch_id, event_type, occurrence_key)
  WHERE shift_id IS NULL
    AND event_type = 'correction'
    AND occurrence_key LIKE 'cash-count:%';

CREATE FUNCTION guard_restoration_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor              uuid;
  v_count_branch       uuid;
  v_count_date         date;
  v_count_proof        text;
  v_count_sealed_at    timestamptz;
  v_reconciliation_ids integer;
  v_restoration_ids    integer;
  v_expected_reconciliations integer;
  v_expected_restorations    integer;
  v_net_numeric        numeric;
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
    RAISE EXCEPTION 'restoration requires its attributed active manager'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_actor_guard';
  END IF;

  -- This is the same lock namespace used by FinancialUnitOfWork and every branch-money writer.
  -- Taking it in the trigger means direct SQL cannot race a restoration against a target edit.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ash:financial:receivables:' || NEW.branch_id::text, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ash:cash-count:' || NEW.cash_count_id::text, 0)
  );

  SELECT c.branch_id, c.business_date, c.proof_sha256, c.sealed_at
    INTO v_count_branch, v_count_date, v_count_proof, v_count_sealed_at
    FROM public.cash_counts c
   WHERE c.id = NEW.cash_count_id;

  IF NOT FOUND
     OR v_count_branch IS DISTINCT FROM NEW.branch_id
     OR v_count_date IS DISTINCT FROM NEW.business_date
  THEN
    RAISE EXCEPTION 'restoration count identity must match its branch and business date'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_cash_count_guard';
  END IF;

  IF v_count_sealed_at IS NULL
     OR v_count_proof IS NULL
     OR v_count_proof !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'restoration requires a final sealed cash count with SHA-256 proof'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_cash_count_sealed_guard';
  END IF;

  -- The API proof is SHA-256 over its exact JSON wire serialization (including JavaScript string
  -- escaping), so byte-for-byte proof recomputation remains in the service/integrity checker.
  -- PostgreSQL still pins the complete canonical line set and its arithmetic before accepting the
  -- supplied proof identity: exactly cash+wallet, no duplicates/extras, and no invented variance.
  IF (SELECT count(*) FROM public.cash_count_lines ccl WHERE ccl.cash_count_id = NEW.cash_count_id) <> 2
     OR (
       SELECT count(DISTINCT f.code)
         FROM public.cash_count_lines ccl
         JOIN public.funds f ON f.id = ccl.fund_id
        WHERE ccl.cash_count_id = NEW.cash_count_id
          AND f.branch_id = NEW.branch_id
          AND f.code IN ('office_cash', 'office_wallet')
          AND f.type::text = f.code
          AND f.owner_kind = 'none'
          AND f.owner_id IS NULL
     ) <> 2
     OR EXISTS (
       SELECT 1
         FROM public.cash_count_lines ccl
        WHERE ccl.cash_count_id = NEW.cash_count_id
          AND ccl.variance_minor::numeric
                <> ccl.counted_minor::numeric - ccl.computed_minor::numeric
     )
     OR EXISTS (
       SELECT 1
         FROM public.cash_count_lines ccl
         JOIN public.funds f ON f.id = ccl.fund_id
        WHERE ccl.cash_count_id = NEW.cash_count_id
          AND f.branch_id = NEW.branch_id
          AND f.code = 'office_cash'
          AND ccl.counted_minor < 0
     )
     OR EXISTS (
       SELECT 1
         FROM public.cash_count_lines ccl
        WHERE ccl.cash_count_id = NEW.cash_count_id
          AND ccl.variance_minor <> 0
          AND (ccl.resolution IS NULL OR btrim(ccl.resolution) = '')
     )
  THEN
    RAISE EXCEPTION 'restoration requires exactly two canonical cash-count lines with valid variance formulas and nonnegative physical cash'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_cash_count_lines_guard';
  END IF;

  IF jsonb_typeof(NEW.plan) IS DISTINCT FROM 'object'
     OR NEW.plan->>'schemaVersion' IS DISTINCT FROM '2'
     OR NEW.plan->>'cashCountProofSha256' IS DISTINCT FROM v_count_proof
     OR jsonb_typeof(NEW.plan->'countReconciliation') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.plan->'reconciliationJournalEntryIds') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.plan->'restorationJournalEntryIds') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.plan->'legs') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'restoration plan schema or count proof is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_plan_guard';
  END IF;

  BEGIN
    IF (NEW.plan->>'cashCountSealedAt')::timestamptz IS DISTINCT FROM v_count_sealed_at THEN
      RAISE EXCEPTION 'sealed timestamp mismatch';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'restoration plan must preserve the exact sealed-count timestamp'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_plan_guard';
  END;

  IF (SELECT count(*) FROM jsonb_array_elements(NEW.plan->'legs')) <> 2
     OR (
       SELECT count(DISTINCT leg->>'fundCode')
         FROM jsonb_array_elements(NEW.plan->'legs') leg
     ) <> 2
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(NEW.plan->'legs') leg
        WHERE jsonb_typeof(leg) IS DISTINCT FROM 'object'
           OR leg->>'fundCode' NOT IN ('office_cash', 'office_wallet')
           OR leg->>'counted' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR leg->>'receivables' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR leg->>'position' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR leg->>'capitalTarget' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR leg->>'delta' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR leg->>'amount' !~ '^[0-9]+\.[0-9]{2}$'
           OR jsonb_typeof(leg->'feasible') IS DISTINCT FROM 'boolean'
           OR (leg->>'feasible')::boolean IS DISTINCT FROM true
           OR jsonb_typeof(leg->'refusals') IS DISTINCT FROM 'array'
           OR jsonb_array_length(leg->'refusals') <> 0
     )
  THEN
    RAISE EXCEPTION 'restoration plan must contain one feasible leg for each office fund'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_plan_guard';
  END IF;

  -- Preserve the sealed count, live receivable assets, target effective on that day and all
  -- derived arithmetic. Numeric comparisons avoid overflowing bigint on adversarial plan JSON.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.plan->'legs') leg
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.cash_count_lines ccl
         JOIN public.funds counted_fund ON counted_fund.id = ccl.fund_id
        WHERE ccl.cash_count_id = NEW.cash_count_id
          AND counted_fund.branch_id = NEW.branch_id
          AND counted_fund.code = leg->>'fundCode'
          AND counted_fund.type::text = leg->>'fundCode'
          AND counted_fund.owner_kind = 'none'
          AND counted_fund.owner_id IS NULL
          AND ccl.counted_minor::numeric = (leg->>'counted')::numeric * 100
     )
       OR (leg->>'position')::numeric
            <> (leg->>'counted')::numeric + (leg->>'receivables')::numeric
       OR (leg->>'delta')::numeric
            <> (leg->>'position')::numeric - (leg->>'capitalTarget')::numeric
       OR (leg->>'amount')::numeric <> abs((leg->>'delta')::numeric)
       OR (
         leg->>'direction' = 'to_company'
         AND (leg->>'amount')::numeric > (leg->>'counted')::numeric
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
  ) THEN
    RAISE EXCEPTION 'restoration plan differs from its sealed count, receivables, or effective targets'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_plan_guard';
  END IF;

  IF (SELECT count(*) FROM jsonb_array_elements(NEW.plan->'countReconciliation')) <> 2
     OR (
       SELECT count(DISTINCT item->>'fundCode')
         FROM jsonb_array_elements(NEW.plan->'countReconciliation') item
     ) <> 2
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(NEW.plan->'countReconciliation') item
        WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR item->>'fundCode' NOT IN ('office_cash', 'office_wallet')
           OR item->>'variance' !~ '^-?[0-9]+\.[0-9]{2}$'
           OR NOT EXISTS (
             SELECT 1
               FROM public.cash_count_lines ccl
               JOIN public.funds counted_fund ON counted_fund.id = ccl.fund_id
              WHERE ccl.cash_count_id = NEW.cash_count_id
                AND counted_fund.branch_id = NEW.branch_id
                AND counted_fund.code = item->>'fundCode'
                AND counted_fund.type::text = item->>'fundCode'
                AND counted_fund.owner_kind = 'none'
                AND counted_fund.owner_id IS NULL
                AND ccl.variance_minor::numeric = (item->>'variance')::numeric * 100
                AND item->>'resolution' IS NOT DISTINCT FROM ccl.resolution
           )
     )
  THEN
    RAISE EXCEPTION 'restoration reconciliation differs from its sealed cash-count lines'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_plan_guard';
  END IF;

  IF EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(NEW.plan->'reconciliationJournalEntryIds') id(value)
        WHERE id.value !~ '^[0-9]+$'
     )
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(NEW.plan->'restorationJournalEntryIds') id(value)
        WHERE id.value !~ '^[0-9]+$'
     )
  THEN
    RAISE EXCEPTION 'restoration journal ids must be positive database identities'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_journal_guard';
  END IF;

  SELECT count(*)::integer INTO v_reconciliation_ids
    FROM jsonb_array_elements_text(NEW.plan->'reconciliationJournalEntryIds');
  SELECT count(*)::integer INTO v_restoration_ids
    FROM jsonb_array_elements_text(NEW.plan->'restorationJournalEntryIds');
  SELECT count(*)::integer INTO v_expected_reconciliations
    FROM jsonb_array_elements(NEW.plan->'countReconciliation') item
   WHERE (item->>'variance')::numeric <> 0;
  SELECT count(*)::integer INTO v_expected_restorations
    FROM jsonb_array_elements(NEW.plan->'legs') leg
   WHERE (leg->>'amount')::numeric <> 0;

  IF v_reconciliation_ids <> v_expected_reconciliations
     OR v_restoration_ids <> v_expected_restorations
     OR v_reconciliation_ids <> (
       SELECT count(DISTINCT id.value)
         FROM jsonb_array_elements_text(NEW.plan->'reconciliationJournalEntryIds') id(value)
     )
     OR v_restoration_ids <> (
       SELECT count(DISTINCT id.value)
         FROM jsonb_array_elements_text(NEW.plan->'restorationJournalEntryIds') id(value)
     )
  THEN
    RAISE EXCEPTION 'restoration plan journal cardinality does not match its moving legs'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_journal_guard';
  END IF;

  -- Every nonzero reconciliation line must name exactly one correction journal with the canonical
  -- count/proof/fund key and its exact two-line recipe.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.plan->'countReconciliation') item
     WHERE (item->>'variance')::numeric <> 0
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(NEW.plan->'reconciliationJournalEntryIds') plan_id(value)
           JOIN public.journal_entries je ON je.id::numeric = plan_id.value::numeric
          WHERE je.branch_id = NEW.branch_id
            AND je.event_type = 'correction'
            AND je.shift_id IS NULL
            AND je.occurrence_key =
              'cash-count:' || NEW.cash_count_id::text || ':' || v_count_proof || ':' || (item->>'fundCode')
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
                 AND jl.amount_minor::numeric = abs((item->>'variance')::numeric * 100)
                 AND (
                   (
                     f.branch_id = NEW.branch_id
                     AND f.code = item->>'fundCode'
                     AND f.type::text = item->>'fundCode'
                     AND f.owner_kind = 'none'
                     AND f.owner_id IS NULL
                     AND jl.side = CASE WHEN (item->>'variance')::numeric > 0 THEN 'D' ELSE 'C' END
                     AND jl.line_role = 'cash_count_reconciled_fund'
                   )
                   OR
                   (
                     f.branch_id = NEW.branch_id
                     AND f.code = 'cost_center:cash_count_variance:' || NEW.branch_id::text || ':' || (item->>'fundCode')
                     AND f.type::text = 'cost_center'
                     AND f.owner_kind = 'none'
                     AND f.owner_id IS NULL
                     AND jl.side = CASE WHEN (item->>'variance')::numeric > 0 THEN 'C' ELSE 'D' END
                     AND jl.line_role = 'cash_count_variance_counterpart'
                   )
                 )
            ) = 2
       )
  ) THEN
    RAISE EXCEPTION 'restoration reconciliation journal does not match its plan and count'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_journal_guard';
  END IF;

  -- Every moving leg must name one canonical restoration journal with the exact box, company
  -- account, direction, amount, roles, date, reason and attributed actor.
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
  ) THEN
    RAISE EXCEPTION 'restoration journal does not match its plan'
      USING ERRCODE = '23514', CONSTRAINT = 'restorations_journal_guard';
  END IF;

  -- At this point the exact reconciliation/restoration journals have already been inserted under
  -- the branch lock. Prove the accounting postcondition directly from the canonical office funds:
  -- the physical box after posting plus live receivables must equal the frozen capital target.
  -- This also binds the cash-count computed value to the pre-posting ledger balance and rejects a
  -- stale/forged count even when every JSON field and journal recipe is otherwise well formed.
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
  ) THEN
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

CREATE TRIGGER restorations_insert_guard
  BEFORE INSERT ON restorations
  FOR EACH ROW EXECUTE FUNCTION guard_restoration_insert();

-- The normal unit of work posts journals first and the immutable restoration second. Check the
-- inverse at transaction end so that ordering remains valid but an orphan canonical journal
-- (including a key-poisoning attempt) can never commit.
CREATE FUNCTION check_restoration_journal_fact() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.event_type = 'restoration' THEN
    IF NEW.shift_id IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
           FROM public.restorations r
           CROSS JOIN LATERAL jsonb_array_elements_text(
             r.plan->'restorationJournalEntryIds'
           ) plan_id(value)
          WHERE plan_id.value ~ '^[0-9]+$'
            AND plan_id.value::numeric = NEW.id::numeric
            AND r.branch_id = NEW.branch_id
            AND r.business_date = NEW.business_date
            AND r.performed_by = NEW.created_by
       )
    THEN
      RAISE EXCEPTION 'restoration journal requires one immutable restoration fact in the same transaction'
        USING ERRCODE = '23514', CONSTRAINT = 'restoration_journal_fact_guard';
    END IF;
  ELSIF NEW.event_type = 'correction' AND NEW.occurrence_key LIKE 'cash-count:%' THEN
    IF NEW.shift_id IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
           FROM public.restorations r
           CROSS JOIN LATERAL jsonb_array_elements_text(
             r.plan->'reconciliationJournalEntryIds'
           ) plan_id(value)
          WHERE plan_id.value ~ '^[0-9]+$'
            AND plan_id.value::numeric = NEW.id::numeric
            AND r.branch_id = NEW.branch_id
            AND r.business_date = NEW.business_date
            AND r.performed_by = NEW.created_by
       )
    THEN
      RAISE EXCEPTION 'cash-count reconciliation journal requires its immutable restoration fact'
        USING ERRCODE = '23514', CONSTRAINT = 'restoration_journal_fact_guard';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER restoration_journal_fact_from_entry
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_restoration_journal_fact();

-- journal_entries/journal_lines are append-only for app_user, but INSERT privilege is required for
-- normal postings. Recheck canonical line cardinality at commit so nobody can append a balanced
-- extra pair to an already-published restoration or cash-count correction entry.
CREATE FUNCTION check_restoration_journal_line_fact() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_entry public.journal_entries%ROWTYPE;
  v_linked boolean;
BEGIN
  SELECT * INTO v_entry FROM public.journal_entries je WHERE je.id = NEW.entry_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_entry.event_type = 'restoration' THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.restorations r
        CROSS JOIN LATERAL jsonb_array_elements_text(r.plan->'restorationJournalEntryIds') id(value)
       WHERE id.value ~ '^[0-9]+$' AND id.value::numeric = v_entry.id::numeric
    ) INTO v_linked;
  ELSIF v_entry.event_type = 'correction' AND v_entry.occurrence_key LIKE 'cash-count:%' THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.restorations r
        CROSS JOIN LATERAL jsonb_array_elements_text(r.plan->'reconciliationJournalEntryIds') id(value)
       WHERE id.value ~ '^[0-9]+$' AND id.value::numeric = v_entry.id::numeric
    ) INTO v_linked;
  ELSE
    RETURN NEW;
  END IF;

  IF NOT v_linked
     OR (SELECT count(*) FROM public.journal_lines jl WHERE jl.entry_id = NEW.entry_id) <> 2
  THEN
    RAISE EXCEPTION 'restoration/cash-count journal requires one immutable fact and exactly two canonical lines'
      USING ERRCODE = '23514', CONSTRAINT = 'restoration_journal_lines_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER restoration_journal_line_fact_from_line
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_restoration_journal_line_fact();

CREATE FUNCTION prevent_restoration_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'restorations are immutable; post an explicit balanced correction'
    USING ERRCODE = '55000', CONSTRAINT = 'restorations_immutable_guard';
END;
$$;

CREATE TRIGGER restorations_immutable
  BEFORE UPDATE OR DELETE ON restorations
  FOR EACH ROW EXECUTE FUNCTION prevent_restoration_mutation();

-- A sealed count is the restoration's physical evidence. Once referenced, neither its header nor
-- any line may be added, rewritten or removed, including through direct SQL after publication.
CREATE FUNCTION prevent_referenced_cash_count_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_old_cash_count_id bigint;
  v_new_cash_count_id bigint;
  v_lock_cash_count_id bigint;
BEGIN
  IF TG_TABLE_NAME = 'cash_counts' THEN
    IF TG_OP <> 'INSERT' THEN
      v_old_cash_count_id := NULLIF(to_jsonb(OLD)->>'id', '')::bigint;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_new_cash_count_id := NULLIF(to_jsonb(NEW)->>'id', '')::bigint;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      v_old_cash_count_id := NULLIF(to_jsonb(OLD)->>'cash_count_id', '')::bigint;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_new_cash_count_id := NULLIF(to_jsonb(NEW)->>'cash_count_id', '')::bigint;
    END IF;
  END IF;

  -- Serialize against restoration validation before checking whether the count is referenced.
  -- For a line moved between counts, lock both identities in stable order to avoid a cross-move
  -- deadlock. After a concurrent restoration commits, the waiter wakes and rejects the mutation.
  FOR v_lock_cash_count_id IN
    SELECT DISTINCT ids.cash_count_id
      FROM (VALUES (v_old_cash_count_id), (v_new_cash_count_id)) ids(cash_count_id)
     WHERE ids.cash_count_id IS NOT NULL
     ORDER BY ids.cash_count_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ash:cash-count:' || v_lock_cash_count_id::text, 0)
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM public.restorations r
     WHERE r.cash_count_id = v_old_cash_count_id
        OR r.cash_count_id = v_new_cash_count_id
  ) THEN
    RAISE EXCEPTION 'cash-count evidence referenced by a restoration is immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'restorations_cash_count_immutable_guard';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER referenced_cash_count_immutable
  BEFORE UPDATE OR DELETE ON cash_counts
  FOR EACH ROW EXECUTE FUNCTION prevent_referenced_cash_count_mutation();

CREATE TRIGGER referenced_cash_count_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON cash_count_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_referenced_cash_count_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON restorations FROM app_user;
GRANT SELECT, INSERT ON restorations TO app_user;

COMMENT ON TRIGGER restorations_immutable ON restorations IS
  'A restoration is the immutable daily link between sealed cash-count evidence and its balanced journals.';

COMMENT ON FUNCTION guard_restoration_insert() IS
  'Requires one authorised actor, same-branch/date sealed count, exact plan arithmetic and exact journal evidence.';
