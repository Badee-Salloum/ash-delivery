-- verify-guards.sql — PROVE the database-level guards, by attempting the illegal writes.
--
-- Reading a trigger definition is not evidence that it fires. This script attempts each
-- forbidden operation and fails loudly if the database ALLOWS it. Run after the migrations:
--
--   psql -v ON_ERROR_STOP=1 -f packages/db/verify-guards.sql
--
-- Each check raises its own P0001 'GUARD FAILED' if the illegal write succeeds. The expected
-- error is caught by SQLSTATE, deliberately narrow — catching WHEN others would let a typo in
-- this very script masquerade as a passing guard.
--
-- Transaction control lives at the psql level (BEGIN … ROLLBACK around each DO block), never
-- inside the DO blocks: plpgsql forbids COMMIT/ROLLBACK inside a block that has an EXCEPTION
-- handler, and every block here has one.

\set ON_ERROR_STOP on

-- ── Fixtures ─────────────────────────────────────────────────────────────────────────────
BEGIN;

INSERT INTO branches (id, code, name_ar, name_en)
VALUES ('11111111-1111-1111-1111-111111111111', 'DAM', 'دمشق', 'Damascus')
ON CONFLICT (code) DO NOTHING;

INSERT INTO roles (key, name_ar, name_en) VALUES ('system_admin', 'مدير النظام', 'System Admin')
ON CONFLICT (key) DO NOTHING;

INSERT INTO users (id, branch_id, role_key, username, full_name_ar, password_hash)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
        'system_admin', 'guardtest', 'اختبار', 'x')
ON CONFLICT (username) DO NOTHING;

INSERT INTO fx_days (business_date, syp_minor_per_usd) VALUES (DATE '2026-07-20', 13000)
ON CONFLICT (business_date) DO NOTHING;

INSERT INTO funds (id, branch_id, type, owner_kind, code, name_ar)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
        'office_cash', 'none', 'OFFICE_CASH', 'صندوق كاش المكتب'),
       ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
        'office_wallet', 'none', 'OFFICE_WALLET', 'صندوق محفظة المكتب')
ON CONFLICT (branch_id, code) DO NOTHING;

INSERT INTO vehicle_types (id, code, name_ar, name_en)
VALUES ('66666666-6666-6666-6666-666666666666', 'e_motorbike', 'دراجة كهربائية', 'E-Motorbike')
ON CONFLICT (code) DO NOTHING;

INSERT INTO drivers (id, branch_id, code, full_name_ar)
VALUES ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111',
        'DRV-GUARD', 'سائق اختبار')
ON CONFLICT (code) DO NOTHING;

INSERT INTO vehicles (id, branch_id, vehicle_type_id, code)
VALUES ('88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111',
        '66666666-6666-6666-6666-666666666666', 'VEH-GUARD')
ON CONFLICT (code) DO NOTHING;

INSERT INTO shifts (id, branch_id, driver_id, vehicle_id, shift_no, business_date, week_start_date)
VALUES ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111',
        '77777777-7777-7777-7777-777777777777', '88888888-8888-8888-8888-888888888888',
        1, DATE '2026-07-20', DATE '2026-07-19')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ── GUARD 1: an unbalanced entry must be rejected ────────────────────────────────────────
BEGIN;
DO $$
DECLARE v_entry bigint;
BEGIN
  BEGIN
    INSERT INTO journal_entries
      (branch_id, event_type, business_date, posting_date, week_start_date, fx_day_id, created_by, reason)
    VALUES ('11111111-1111-1111-1111-111111111111', 'manual', DATE '2026-07-20', DATE '2026-07-20',
            DATE '2026-07-19', (SELECT id FROM fx_days WHERE business_date = DATE '2026-07-20'),
            '22222222-2222-2222-2222-222222222222', 'guard 1')
    RETURNING id INTO v_entry;

    -- One debit, no matching credit.
    INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor)
    VALUES (v_entry, '33333333-3333-3333-3333-333333333333', 'D', 5000);

    -- Force the DEFERRED constraint trigger to evaluate now.
    SET CONSTRAINTS ALL IMMEDIATE;

    RAISE EXCEPTION 'GUARD FAILED: an unbalanced journal entry was accepted';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'PASS  guard 1: unbalanced entry rejected (%)', SQLERRM;
  END;
END
$$;
ROLLBACK;

-- ── GUARD 2: a BALANCED entry must be accepted (a guard must not block correct work) ─────
BEGIN;
DO $$
DECLARE v_entry bigint;
BEGIN
  INSERT INTO journal_entries
    (branch_id, event_type, business_date, posting_date, week_start_date, fx_day_id, created_by, reason)
  VALUES ('11111111-1111-1111-1111-111111111111', 'manual', DATE '2026-07-20', DATE '2026-07-20',
          DATE '2026-07-19', (SELECT id FROM fx_days WHERE business_date = DATE '2026-07-20'),
          '22222222-2222-2222-2222-222222222222', 'guard 2')
  RETURNING id INTO v_entry;

  INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor)
  VALUES (v_entry, '33333333-3333-3333-3333-333333333333', 'D', 5000),
         (v_entry, '44444444-4444-4444-4444-444444444444', 'C', 5000);

  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'PASS  guard 2: balanced entry accepted';
END
$$;
ROLLBACK;

-- ── GUARD 3: the ledger is append-only for app_user ──────────────────────────────────────
-- Seed one committed entry to attempt tampering against.
BEGIN;
DO $$
DECLARE v_entry bigint;
BEGIN
  INSERT INTO journal_entries
    (branch_id, event_type, business_date, posting_date, week_start_date, fx_day_id, created_by, reason)
  VALUES ('11111111-1111-1111-1111-111111111111', 'manual', DATE '2026-07-20', DATE '2026-07-20',
          DATE '2026-07-19', (SELECT id FROM fx_days WHERE business_date = DATE '2026-07-20'),
          '22222222-2222-2222-2222-222222222222', 'guard 3 target')
  RETURNING id INTO v_entry;
  INSERT INTO journal_lines (entry_id, fund_id, side, amount_minor)
  VALUES (v_entry, '33333333-3333-3333-3333-333333333333', 'D', 7000),
         (v_entry, '44444444-4444-4444-4444-444444444444', 'C', 7000);
END
$$;
COMMIT;

BEGIN;
SET LOCAL ROLE app_user;
DO $$
BEGIN
  BEGIN
    UPDATE journal_entries SET reason = 'tampered' WHERE reason = 'guard 3 target';
    RAISE EXCEPTION 'GUARD FAILED: app_user was able to UPDATE journal_entries';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS  guard 3a: app_user cannot UPDATE journal_entries';
  END;

  BEGIN
    DELETE FROM journal_lines WHERE amount_minor = 7000;
    RAISE EXCEPTION 'GUARD FAILED: app_user was able to DELETE journal_lines';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS  guard 3b: app_user cannot DELETE journal_lines';
  END;

  BEGIN
    DELETE FROM audit_log WHERE table_name = 'users';
    RAISE EXCEPTION 'GUARD FAILED: app_user was able to DELETE from audit_log';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS  guard 3c: the audit log is append-only';
  END;
END
$$;
ROLLBACK;

-- ── GUARD 4: week_start_date must be a Sunday (BR7) ──────────────────────────────────────
BEGIN;
DO $$
BEGIN
  BEGIN
    -- 2026-07-20 is a MONDAY: exactly what date_trunc('week') would have produced.
    INSERT INTO week_locks (branch_id, week_start_date, week_end_date)
    VALUES ('11111111-1111-1111-1111-111111111111', DATE '2026-07-20', DATE '2026-07-26');
    RAISE EXCEPTION 'GUARD FAILED: a Monday-starting week lock was accepted';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'PASS  guard 4: non-Sunday week_start_date rejected (%)', SQLERRM;
  END;
END
$$;
ROLLBACK;

-- ── GUARD 5: a locked week is immutable, and the LINES are locked too ────────────────────
BEGIN;
DO $$
DECLARE v_lock bigint; v_entry bigint; v_sealed integer;
BEGIN
  INSERT INTO week_locks (branch_id, week_start_date, week_end_date)
  VALUES ('11111111-1111-1111-1111-111111111111', DATE '2026-07-19', DATE '2026-07-25')
  RETURNING id INTO v_lock;

  v_sealed := fin_seal_week(v_lock, '22222222-2222-2222-2222-222222222222');
  IF v_sealed < 1 THEN
    RAISE EXCEPTION 'GUARD FAILED: fin_seal_week sealed % entries — the fixture is wrong', v_sealed;
  END IF;

  SELECT id INTO v_entry FROM journal_entries WHERE week_lock_id = v_lock LIMIT 1;

  BEGIN
    UPDATE journal_entries SET reason = 'tampered' WHERE id = v_entry;
    RAISE EXCEPTION 'GUARD FAILED: a locked-week entry was updated';
  EXCEPTION
    WHEN read_only_sql_transaction THEN
      RAISE NOTICE 'PASS  guard 5a: locked-week entry is immutable';
  END;

  BEGIN
    -- The one the design review caught: guarding entries alone leaves AMOUNTS mutable.
    UPDATE journal_lines SET amount_minor = 999999 WHERE entry_id = v_entry;
    RAISE EXCEPTION 'GUARD FAILED: a locked-week LINE amount was updated';
  EXCEPTION
    WHEN read_only_sql_transaction THEN
      RAISE NOTICE 'PASS  guard 5b: locked-week line amounts are immutable';
  END;

  BEGIN
    UPDATE week_locks SET closed_at = NULL WHERE id = v_lock;
    RAISE EXCEPTION 'GUARD FAILED: a closed week was reopened by UPDATE';
  EXCEPTION
    WHEN read_only_sql_transaction THEN
      RAISE NOTICE 'PASS  guard 5c: a closed week cannot be reopened by UPDATE';
  END;
END
$$;
ROLLBACK;

-- ── GUARD 6: idempotency — and that multi-tranche float STILL WORKS ──────────────────────
-- This pair is the point. The kickoff brief's (shift_id, event_type) key would make 6b
-- impossible; occurrence_key is what lets a second float tranche post while still blocking a
-- genuine double-post.
BEGIN;
DO $$
DECLARE
  v_shift uuid := '55555555-5555-5555-5555-555555555555';
  v_fx    bigint := (SELECT id FROM fx_days WHERE business_date = DATE '2026-07-20');
BEGIN
  INSERT INTO journal_entries
    (branch_id, event_type, shift_id, occurrence_key, business_date, posting_date, week_start_date, fx_day_id, created_by)
  VALUES ('11111111-1111-1111-1111-111111111111', 'share_split', v_shift, '1',
          DATE '2026-07-20', DATE '2026-07-20', DATE '2026-07-19', v_fx,
          '22222222-2222-2222-2222-222222222222');

  BEGIN
    INSERT INTO journal_entries
      (branch_id, event_type, shift_id, occurrence_key, business_date, posting_date, week_start_date, fx_day_id, created_by)
    VALUES ('11111111-1111-1111-1111-111111111111', 'share_split', v_shift, '1',
            DATE '2026-07-20', DATE '2026-07-20', DATE '2026-07-19', v_fx,
            '22222222-2222-2222-2222-222222222222');
    RAISE EXCEPTION 'GUARD FAILED: a duplicate posting was accepted — double-approve would double-post';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'PASS  guard 6a: duplicate (shift, event, occurrence) refused';
  END;
END
$$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  v_shift uuid := '55555555-5555-5555-5555-555555555555';
  v_fx    bigint := (SELECT id FROM fx_days WHERE business_date = DATE '2026-07-20');
BEGIN
  -- Two float tranches on the same shift MUST both post (SRS C-5 / ASSUMPTIONS A-10).
  INSERT INTO journal_entries
    (branch_id, event_type, shift_id, occurrence_key, business_date, posting_date, week_start_date, fx_day_id, created_by)
  VALUES ('11111111-1111-1111-1111-111111111111', 'float_out', v_shift, '1',
          DATE '2026-07-20', DATE '2026-07-20', DATE '2026-07-19', v_fx,
          '22222222-2222-2222-2222-222222222222'),
         ('11111111-1111-1111-1111-111111111111', 'float_out', v_shift, '2',
          DATE '2026-07-20', DATE '2026-07-20', DATE '2026-07-19', v_fx,
          '22222222-2222-2222-2222-222222222222');
  RAISE NOTICE 'PASS  guard 6b: a second float tranche posts (occurrence_key does its job)';
END
$$;
ROLLBACK;

-- ── GUARD 7: the audit trigger tolerates a missing actor ─────────────────────────────────
-- The 5-attempt lockout writes users.failed_attempts on the unauthenticated path, where there
-- is no actor by definition. A trigger that raised there would make the lockout impossible to
-- implement and turn every failed login into a 500.
BEGIN;
DO $$
DECLARE v_before bigint;
BEGIN
  SELECT count(*) INTO v_before FROM audit_log;
  PERFORM set_config('app.actor_id', '', true);
  UPDATE users SET failed_attempts = failed_attempts + 1 WHERE username = 'guardtest';

  IF (SELECT count(*) FROM audit_log) <= v_before THEN
    RAISE EXCEPTION 'GUARD FAILED: the audit trigger did not record an actorless mutation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit_log
     WHERE table_name = 'users' AND actor_kind = 'system' AND actor_id IS NULL
  ) THEN
    RAISE EXCEPTION 'GUARD FAILED: an actorless mutation was not recorded as actor_kind = system';
  END IF;
  RAISE NOTICE 'PASS  guard 7: actorless mutation audited as system, not rejected';
END
$$;
ROLLBACK;

-- ── GUARD 8: the audit trigger captures before/after on a normal mutation ────────────────
BEGIN;
DO $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  PERFORM set_config('app.actor_id', '22222222-2222-2222-2222-222222222222', true);
  UPDATE users SET full_name_ar = 'اسم جديد' WHERE username = 'guardtest';

  SELECT before, after INTO v_before, v_after
    FROM audit_log
   WHERE table_name = 'users' AND action = 'UPDATE' AND actor_id = '22222222-2222-2222-2222-222222222222'
   ORDER BY id DESC LIMIT 1;

  IF v_before IS NULL OR v_after IS NULL THEN
    RAISE EXCEPTION 'GUARD FAILED: audit_log recorded no before/after snapshot';
  END IF;
  IF (v_after ->> 'full_name_ar') <> 'اسم جديد' THEN
    RAISE EXCEPTION 'GUARD FAILED: the audit "after" snapshot does not reflect the change';
  END IF;
  RAISE NOTICE 'PASS  guard 8: before/after snapshots captured with the actor';
END
$$;
ROLLBACK;

\echo ''
\echo '========================================================'
\echo '  ALL DATABASE GUARDS VERIFIED'
\echo '========================================================'
