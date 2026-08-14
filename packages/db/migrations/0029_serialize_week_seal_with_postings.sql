-- 0029 — serialize a week seal with concurrent ledger postings
--
-- 0018 made the INSERT trigger reject an entry whose accounting week or business-date week was
-- already closed. Its check was still subject to one READ COMMITTED race:
--
--   poster                                  sealer
--   ------                                  ------
--   trigger reads closed_at = NULL
--                                           locks week_locks row
--                                           UPDATE journal_entries (cannot see uncommitted poster)
--                                           sets closed_at and commits
--   commits a week_lock_id = NULL entry
--
-- The entry then belongs to the sealed week but can never be stamped, because a closed lock cannot
-- be reopened. A row lock in the trigger would fix the common case but not a posting that begins
-- before the week_locks row exists. Instead both operations take the same transaction-level
-- advisory lock. Posters take it SHARED, so ordinary ledger traffic remains concurrent. Sealing
-- takes it EXCLUSIVE, so it either waits for all earlier postings (and then sees them in the later
-- UPDATE statement) or makes later postings wait until closed_at is visible and refused.
--
-- The lock is branch-scoped rather than week-scoped deliberately. A journal header carries two
-- dates and 0018 guards both; a malformed/migrating writer can point them at different weeks.
-- Taking two retained advisory locks would admit cross-week lock-order deadlocks in a batch. One
-- branch key has no such cycle, and week sealing is rare enough that serializing two seals in the
-- same branch is the safer trade-off. Hash collisions only serialize unrelated branches; they do
-- not weaken correctness.

CREATE OR REPLACE FUNCTION fin_week_seal_guard_key(p_branch_id uuid)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT hashtextextended('ash:week-seal:' || p_branch_id::text, 0);
$$;

REVOKE ALL ON FUNCTION fin_week_seal_guard_key(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fin_week_seal_guard_key(uuid) TO app_user;

CREATE OR REPLACE FUNCTION assert_posting_week_open() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_closed_at timestamptz;
  v_start     date;
BEGIN
  -- Only fin_seal_week() sets this, and only by UPDATE. Preserve 0018's behaviour for that internal
  -- path: it is already protected by the exclusive side of this protocol.
  IF NEW.week_lock_id IS NOT NULL THEN RETURN NEW; END IF;

  -- Held through COMMIT. fin_seal_week() cannot take its exclusive lock between this check and the
  -- visibility of the inserted row.
  PERFORM pg_advisory_xact_lock_shared(public.fin_week_seal_guard_key(NEW.branch_id));

  -- (1) The week the entry is ACCOUNTED INTO must still be open.
  SELECT closed_at INTO v_closed_at
    FROM public.week_locks
   WHERE branch_id = NEW.branch_id AND week_start_date = NEW.week_start_date;
  IF v_closed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'week % is closed (%): post a dated correction into the open week instead',
      NEW.week_start_date, v_closed_at
      USING ERRCODE = '25006';
  END IF;

  -- (2) The business date must not belong to a different sealed week either.
  SELECT week_start_date, closed_at INTO v_start, v_closed_at
    FROM public.week_locks
   WHERE branch_id = NEW.branch_id
     AND NEW.business_date BETWEEN week_start_date AND week_end_date
     AND closed_at IS NOT NULL;
  IF FOUND THEN
    RAISE EXCEPTION
      'business date % falls inside sealed week % (%): post a dated correction instead',
      NEW.business_date, v_start, v_closed_at
      USING ERRCODE = '25006';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION assert_posting_week_open() IS
  'BR7: rejects sealed-week inserts and holds the shared half of the posting/week-seal race lock.';

CREATE OR REPLACE FUNCTION fin_seal_week(p_week_lock_id bigint, p_closed_by uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_branch  uuid;
  v_start   date;
  v_end     date;
  v_count   integer;
BEGIN
  SELECT branch_id, week_start_date, week_end_date
    INTO v_branch, v_start, v_end
    FROM public.week_locks WHERE id = p_week_lock_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such week lock %', p_week_lock_id USING ERRCODE = '23503';
  END IF;

  -- Existing posters hold the shared form until commit, so this waits before the UPDATE statement
  -- takes its READ COMMITTED snapshot. Once acquired, no new posting can pass its trigger check
  -- until closed_at has committed.
  PERFORM pg_advisory_xact_lock(public.fin_week_seal_guard_key(v_branch));

  UPDATE public.journal_entries
     SET week_lock_id = p_week_lock_id
   WHERE branch_id = v_branch
     AND business_date BETWEEN v_start AND v_end
     AND week_lock_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.week_locks
     SET closed_at = now(), closed_by = p_closed_by
   WHERE id = p_week_lock_id;

  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION fin_seal_week(bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fin_seal_week(bigint, uuid) TO app_user;

COMMENT ON FUNCTION fin_seal_week(bigint, uuid) IS
  'Stamps and closes one week while holding the exclusive half of the posting/week-seal race lock.';
