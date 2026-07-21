-- 0006 — the database-level guards
--
-- ⚠⚠ NOT YET EXECUTED, AND LOAD-BEARING. ⚠⚠
--   Three claims in this file hold up the whole architecture:
--     (a) an unbalanced entry is rejected at COMMIT;
--     (b) app_user genuinely cannot UPDATE or DELETE the ledger;
--     (c) a write into a locked week raises 25006.
--   None has been executed — the dev machine has no Docker and no psql. Each must be PROVEN by
--   attempting the illegal write and observing the refusal, not by reading this file. The tests
--   are named in TESTS.md; the procedure is in RUNBOOK.md › "Verifying the database guards".
--
-- Why guards live here at all: the kickoff brief requires immutability "in the app layer AND a
-- DB-level guard". An application check protects against the code you wrote. A database check
-- also protects against the psql session you will open at 2am to fix something.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- (a) Double-entry balance — Σ debits = Σ credits, per entry, checked at COMMIT
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- It MUST be deferred: lines are inserted one at a time, so an entry is legitimately
-- unbalanced in the middle of its own transaction. A non-deferred trigger would reject every
-- multi-line posting on its first line.
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry_id bigint;
  v_debits   bigint;
  v_credits  bigint;
  v_lines    integer;
BEGIN
  v_entry_id := COALESCE(NEW.entry_id, OLD.entry_id);

  SELECT COALESCE(SUM(amount_minor) FILTER (WHERE side = 'D'), 0),
         COALESCE(SUM(amount_minor) FILTER (WHERE side = 'C'), 0),
         COUNT(*)
    INTO v_debits, v_credits, v_lines
    FROM journal_lines
   WHERE entry_id = v_entry_id;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'journal entry % has no lines', v_entry_id
      USING ERRCODE = '23514';
  END IF;

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %', v_entry_id, v_debits, v_credits
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- (b) Locked-week immutability (BR7)
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Guarding journal_entries alone is not enough: with lines unguarded, the AMOUNTS of a locked
-- week stay mutable while the header looks frozen. Both tables are guarded.
CREATE OR REPLACE FUNCTION assert_week_not_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry_id     bigint;
  v_week_lock_id bigint;
  v_closed_at    timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    -- OLD only, deliberately. The rule is "an entry that ALREADY belongs to a closed week may
    -- not change" — not "may not be assigned to a lock". Using COALESCE(OLD, NEW) here would
    -- make the guard order-dependent: fin_seal_week() stamps week_lock_id onto entries and
    -- only then sets closed_at, so a NEW-based check would pass or fail depending on which of
    -- those two statements ran first. That is precisely the kind of coupling that works in
    -- testing and breaks the day someone reorders two lines.
    v_week_lock_id := OLD.week_lock_id;
  ELSE
    v_entry_id := COALESCE(OLD.entry_id, NEW.entry_id);
    SELECT week_lock_id INTO v_week_lock_id FROM journal_entries WHERE id = v_entry_id;
  END IF;

  IF v_week_lock_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT closed_at INTO v_closed_at FROM week_locks WHERE id = v_week_lock_id;
  IF v_closed_at IS NOT NULL THEN
    -- 25006 = read_only_sql_transaction. The application maps it to a 409 with the Arabic
    -- message "this week is closed; post a dated correction entry instead".
    RAISE EXCEPTION 'week lock % is closed (%): entries are immutable, post a correction instead',
      v_week_lock_id, v_closed_at
      USING ERRCODE = '25006';
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER journal_entries_week_locked
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_week_not_locked();

CREATE TRIGGER journal_lines_week_locked
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION assert_week_not_locked();

-- A week lock, once closed, cannot be reopened by an UPDATE. Reopening is a deliberate,
-- audited administrative act — not something a stray UPDATE can do.
CREATE OR REPLACE FUNCTION assert_week_lock_not_reopened() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL AND (NEW.closed_at IS NULL OR NEW.closed_at <> OLD.closed_at) THEN
    RAISE EXCEPTION 'week lock % is already closed and cannot be reopened by UPDATE', OLD.id
      USING ERRCODE = '25006';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER week_locks_no_reopen
  BEFORE UPDATE ON week_locks
  FOR EACH ROW EXECUTE FUNCTION assert_week_lock_not_reopened();

-- The week must start on a Sunday. A CHECK cannot call EXTRACT on a non-immutable basis in all
-- versions, so this is a trigger — and it is worth having, because an off-by-one here is an
-- off-by-one in the boundary where money becomes immutable.
CREATE OR REPLACE FUNCTION assert_week_starts_sunday() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- EXTRACT(DOW) is 0 = Sunday.
  IF EXTRACT(DOW FROM NEW.week_start_date) <> 0 THEN
    RAISE EXCEPTION 'week_start_date % is not a Sunday (BR7)', NEW.week_start_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER week_locks_sunday_start
  BEFORE INSERT OR UPDATE ON week_locks
  FOR EACH ROW EXECUTE FUNCTION assert_week_starts_sunday();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- (c) The ledger is append-only for the application role
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- This is the guard that survives a future maintainer with a psql prompt and good intentions.
REVOKE UPDATE, DELETE ON journal_entries FROM app_user;
REVOKE UPDATE, DELETE ON journal_lines   FROM app_user;
GRANT  SELECT, INSERT  ON journal_entries TO app_user;
GRANT  SELECT, INSERT  ON journal_lines   TO app_user;

-- week_lock_id must still be settable when a week closes, so that one column is delegated to a
-- SECURITY DEFINER function rather than by granting UPDATE back on the whole table.
CREATE OR REPLACE FUNCTION fin_seal_week(p_week_lock_id bigint, p_closed_by uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_branch  uuid;
  v_start   date;
  v_end     date;
  v_count   integer;
BEGIN
  SELECT branch_id, week_start_date, week_end_date
    INTO v_branch, v_start, v_end
    FROM week_locks WHERE id = p_week_lock_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such week lock %', p_week_lock_id USING ERRCODE = '23503';
  END IF;

  UPDATE journal_entries
     SET week_lock_id = p_week_lock_id
   WHERE branch_id = v_branch
     AND business_date BETWEEN v_start AND v_end
     AND week_lock_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE week_locks
     SET closed_at = now(), closed_by = p_closed_by
   WHERE id = p_week_lock_id;

  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION fin_seal_week(bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fin_seal_week(bigint, uuid) TO app_user;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- (d) Audit trigger (A-5 / س79)
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- The actor comes from a per-transaction GUC set by the API.
--
-- It deliberately does NOT raise when the actor is absent. The 5-failed-attempt lockout writes
-- users.failed_attempts on the UNAUTHENTICATED login path, where there is no actor by
-- definition — a trigger that raised there would make the lockout impossible to implement and
-- turn every failed login into a 500. Instead the row is recorded with actor_kind='system' or
-- 'anonymous', and a separate integration test asserts that authenticated mutations always
-- carry a real actor.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor   uuid;
  v_kind    text;
  v_request text;
  v_record  text;
BEGIN
  BEGIN
    v_actor := NULLIF(current_setting('app.actor_id', true), '')::uuid;
  EXCEPTION WHEN others THEN
    v_actor := NULL;
  END;
  v_request := NULLIF(current_setting('app.request_id', true), '');
  v_kind := CASE
              WHEN v_actor IS NOT NULL THEN 'user'
              WHEN v_request IS NOT NULL THEN 'anonymous'
              ELSE 'system'
            END;

  v_record := CASE TG_OP WHEN 'DELETE' THEN (to_jsonb(OLD) ->> 'id') ELSE (to_jsonb(NEW) ->> 'id') END;

  INSERT INTO audit_log (table_name, record_id, action, actor_id, actor_kind, request_id, before, after)
  VALUES (
    TG_TABLE_NAME,
    COALESCE(v_record, '<none>'),
    TG_OP,
    v_actor,
    v_kind,
    v_request,
    -- to_jsonb, not row_to_json: read back as jsonb::text and parsed losslessly, so a bigint
    -- amount is never silently rounded inside the audit trail itself.
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END
  );

  RETURN COALESCE(NEW, OLD);
END
$$;

-- Attached to every table holding money, identity, or authority. `scripts/check-sql.mjs`
-- enumerates business tables and fails the build when one is missing from this list.
CREATE TRIGGER audit_users            AFTER INSERT OR UPDATE OR DELETE ON users            FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_role_permissions AFTER INSERT OR UPDATE OR DELETE ON role_permissions FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_settings         AFTER INSERT OR UPDATE OR DELETE ON settings         FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_approval_ceilings AFTER INSERT OR UPDATE OR DELETE ON approval_ceilings FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_drivers          AFTER INSERT OR UPDATE OR DELETE ON drivers          FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_vehicles         AFTER INSERT OR UPDATE OR DELETE ON vehicles         FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_documents        AFTER INSERT OR UPDATE OR DELETE ON documents        FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_funds            AFTER INSERT OR UPDATE OR DELETE ON funds            FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_fx_days          AFTER INSERT OR UPDATE OR DELETE ON fx_days          FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_week_locks       AFTER INSERT OR UPDATE OR DELETE ON week_locks       FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_journal_entries  AFTER INSERT OR UPDATE OR DELETE ON journal_entries  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_journal_lines    AFTER INSERT OR UPDATE OR DELETE ON journal_lines    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_cash_counts      AFTER INSERT OR UPDATE OR DELETE ON cash_counts      FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_expenses         AFTER INSERT OR UPDATE OR DELETE ON expenses         FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_shifts           AFTER INSERT OR UPDATE OR DELETE ON shifts           FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_shift_orders     AFTER INSERT OR UPDATE OR DELETE ON shift_orders     FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_float_tranches   AFTER INSERT OR UPDATE OR DELETE ON float_tranches   FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER audit_tier_rules       AFTER INSERT OR UPDATE OR DELETE ON tier_rules       FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- The audit log itself is append-only, for everyone.
REVOKE UPDATE, DELETE ON audit_log FROM app_user;
GRANT  SELECT, INSERT  ON audit_log TO app_user;
