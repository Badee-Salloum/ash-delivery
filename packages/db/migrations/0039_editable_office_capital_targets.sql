-- 0039 - effective-dated, manager-editable office-capital targets
--
-- Owner decision 2026-08-23: restore office cash to SYP 50,000 and the office wallet to SYP
-- 10,000, and allow an authorised manager to publish later targets from the treasury screen.
-- Money is stored in hundredths, hence 5,000,000 and 1,000,000 minor units below.

-- Publishing a target inside a period that has already been restored would change what an old
-- restoration appears to have meant. Refuse every mutation that overlaps one immutable
-- restoration. Identity/date changes are always expressed as a new effective row.
CREATE FUNCTION guard_office_capital_target_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_branch_id uuid;
  v_fund_code text;
  v_effective_from date;
  v_next_effective_from date;
  v_actor uuid;
BEGIN
  v_branch_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.branch_id ELSE NEW.branch_id END;
  v_fund_code := CASE WHEN TG_OP = 'DELETE' THEN OLD.fund_code ELSE NEW.fund_code END;
  v_effective_from := CASE WHEN TG_OP = 'DELETE' THEN OLD.effective_from ELSE NEW.effective_from END;

  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  IF v_actor IS NULL
     OR (TG_OP <> 'DELETE' AND NEW.created_by IS DISTINCT FROM v_actor)
     OR (
       TG_OP <> 'DELETE'
       AND (NOT public.ash_has_visible_text(NEW.note) OR char_length(NEW.note) > 500)
     )
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
            OR (rp.scope = 'branch' AND u.branch_id = v_branch_id)
          )
     )
  THEN
    RAISE EXCEPTION 'capital target publication requires its attributed active manager'
      USING ERRCODE = '23514', CONSTRAINT = 'office_capital_targets_actor_guard';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       NEW.branch_id IS DISTINCT FROM OLD.branch_id
       OR NEW.fund_code IS DISTINCT FROM OLD.fund_code
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     )
  THEN
    RAISE EXCEPTION 'capital target identity and effective date are immutable; publish a successor'
      USING ERRCODE = '55000', CONSTRAINT = 'office_capital_targets_history_guard';
  END IF;

  -- The same lock is held by restoration, ledger and receivable commands. This closes the race in
  -- which a target update and restoration both observed no completed restoration and committed.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ash:financial:receivables:' || v_branch_id::text, 0)
  );

  SELECT MIN(t.effective_from)
    INTO v_next_effective_from
    FROM public.office_capital_targets t
   WHERE t.branch_id = v_branch_id
     AND t.fund_code = v_fund_code
     AND t.effective_from > v_effective_from;

  -- Deliberately no target_minor-only fast path. Status, note, creator and timestamps are all part
  -- of the audited historical row and must be frozen once any restoration used its period.
  IF EXISTS (
    SELECT 1
      FROM public.restorations r
     WHERE r.branch_id = v_branch_id
       AND r.business_date >= v_effective_from
       AND (v_next_effective_from IS NULL OR r.business_date < v_next_effective_from)
  ) THEN
    RAISE EXCEPTION 'capital target is frozen by an immutable restoration in its effective period'
      USING ERRCODE = '55000', CONSTRAINT = 'office_capital_targets_history_guard';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER office_capital_targets_history_guard
  BEFORE INSERT OR UPDATE OR DELETE ON office_capital_targets
  FOR EACH ROW EXECUTE FUNCTION guard_office_capital_target_history();

-- Runtime has no delete operation. Removing a target can make restoration silently infeasible, so
-- app_user may publish/update an effective row but cannot delete or truncate target history.
REVOKE DELETE, TRUNCATE ON office_capital_targets FROM app_user;
GRANT SELECT, INSERT, UPDATE ON office_capital_targets TO app_user;

-- This coordinated release is effective today. If today's/future restoration already exists,
-- choosing a new target after the fact is unsafe; stop the release instead of restating it.
DO $$
DECLARE
  v_seed_actor uuid;
  v_previous_actor text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.restorations WHERE business_date >= DATE '2026-08-23'
  ) THEN
    RAISE EXCEPTION 'new office-capital targets overlap an immutable restoration'
      USING ERRCODE = '55000', CONSTRAINT = 'office_capital_targets_history_guard';
  END IF;

  SELECT u.id
    INTO v_seed_actor
    FROM public.users u
    JOIN public.role_permissions rp
      ON rp.role_key = u.role_key
     AND rp.permission_key = 'journal.manual.write'
     AND rp.scope = 'all'
   WHERE u.active
   ORDER BY (u.role_key = 'system_admin') DESC, u.created_at, u.id
   LIMIT 1;

  IF v_seed_actor IS NULL AND EXISTS (SELECT 1 FROM public.branches) THEN
    RAISE EXCEPTION 'office-capital target seed requires one active organisation-wide publisher'
      USING ERRCODE = '23514', CONSTRAINT = 'office_capital_targets_actor_guard';
  END IF;

  IF v_seed_actor IS NOT NULL THEN
    v_previous_actor := current_setting('app.actor_id', true);
    PERFORM set_config('app.actor_id', v_seed_actor::text, true);

    INSERT INTO public.office_capital_targets
      (branch_id, fund_code, target_minor, effective_from, status, note, created_by)
    SELECT b.id,
           v.fund_code,
           v.target_minor,
           DATE '2026-08-23',
           'active',
           'Owner decision: editable restoration targets — 2026-08-23',
           v_seed_actor
      FROM public.branches b
     CROSS JOIN (
       VALUES
         ('office_cash', 5000000::bigint),
         ('office_wallet', 1000000::bigint)
     ) AS v(fund_code, target_minor)
    ON CONFLICT (branch_id, fund_code, effective_from) DO UPDATE
    SET target_minor = EXCLUDED.target_minor,
        status = 'active',
        note = EXCLUDED.note,
        created_by = EXCLUDED.created_by,
        created_at = now();

    PERFORM set_config('app.actor_id', COALESCE(v_previous_actor, ''), true);
  END IF;
END
$$;

COMMENT ON FUNCTION guard_office_capital_target_history() IS
  'Authenticates branch-scoped publication and prevents any target-row mutation from restating an immutable restoration.';
